import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDeltaNeutralPosition, openDeltaNeutralPosition } from '../../utils/trade.js';
import { getOrderFees } from '../../utils/order-fill.js';
import { exchange } from './fake-exchange.js';

const baseOpportunity = {
  symbol: 'BTC',
  bidAsk: {
    perpMid: 100,
    spotMid: 100
  },
  funding: {
    fundingRate: 0.001
  },
  avgFundingRate: 0.1
};

const baseBalances = {
  perpBalance: 1000,
  spotBalance: 1000
};

const baseConfig = {
  trading: {
    minOrderSizeUSD: { BTC: 20 },
    balanceUtilizationPercent: 10,
    maxSlippagePercent: 5
  },
  risk: {
    minFillRatio: 0.999,
    maxHedgeMismatchPercent: 10
  }
};

test('order fee accounting reads only known fill fee fields', () => {
  const result = {
    response: {
      data: {
        statuses: [{
          filled: {
            totalSz: '1',
            avgPx: '100',
            fee: '0.12',
            nested: { fee: '99' }
          }
        }]
      }
    },
    someOtherFee: 42
  };

  assert.equal(getOrderFees(result), 0.12);
});

// Orders fill in full at 100 unless a test's execution says otherwise (fake-exchange.js); call 0 is the perp leg.
test('SPOT cleanup after PERP failure is not reduce-only and requires connector pricing', async () => {
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => c.symbol === 'BTC' ? { reject: true } : { size: c.size, price: 100 };

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /PERP order failed/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'UBTC');
  assert.equal(cleanup.side, 'sell');
  assert.equal(cleanup.options.isSpot, true);
  assert.equal(cleanup.options.reduceOnly, false);
});

test('PERP cleanup after SPOT failure is reduce-only and requires connector pricing', async () => {
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => c.symbol === 'UBTC' ? { reject: true } : { size: c.size, price: 100 };

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /SPOT order failed/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'BTC');
  assert.equal(cleanup.side, 'buy');
  assert.equal(cleanup.options.isSpot, false);
  assert.equal(cleanup.options.reduceOnly, true);
});

test('imbalanced partial fills are closed with actual filled sizes', async () => {
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => ({ size: c.symbol === 'UBTC' ? 0.5 : 1, price: 100 });  // the spot buy half-fills

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /SPOT order failed or under-filled/
  );

  const cleanupSpot = hyperliquid.calls.find(call => call.symbol === 'UBTC' && call.side === 'sell');
  const cleanupPerp = hyperliquid.calls.find(call => call.symbol === 'BTC' && call.side === 'buy');
  assert.equal(cleanupSpot.size, 0.5);
  assert.equal(cleanupSpot.options.reduceOnly, false);
  assert.equal(cleanupPerp.size, 1);
  assert.equal(cleanupPerp.options.reduceOnly, true);
});

test('equal partial open fills below threshold are closed instead of accepted', async () => {
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => ({ size: c.index < 2 ? 0.5 : c.size, price: 100 });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /minimum fill ratio/
  );

  const cleanupSpot = hyperliquid.calls.find(call => call.symbol === 'UBTC' && call.side === 'sell');
  const cleanupPerp = hyperliquid.calls.find(call => call.symbol === 'BTC' && call.side === 'buy');
  assert.equal(cleanupSpot.size, 0.5);
  assert.equal(cleanupPerp.size, 0.5);
});

test('rejected PERP open request reconciles and closes filled SPOT leg', async () => {
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => c.index === 0 ? { error: new Error('network down') } : { size: c.size, price: 100 };

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /PERP order failed or under-filled: network down/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'UBTC');
  assert.equal(cleanup.side, 'sell');
  assert.equal(cleanup.size, 1);
});

test('both rejected open requests use on-chain reconciliation for cleanup', async () => {
  // Both requests time out, yet both orders landed on-chain
  const hyperliquid = exchange({}, {});
  hyperliquid.execution = c => {
    if (c.index > 1) return { size: c.size, price: 100 };
    if (c.options.isSpot) hyperliquid.spots.UBTC = 1; else hyperliquid.perps.BTC = -1;
    return { error: new Error('timeout') };
  };

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /minimum fill ratio/
  );

  assert.ok(hyperliquid.calls.some(call => call.symbol === 'UBTC' && call.side === 'sell' && call.size === 1));
  assert.ok(hyperliquid.calls.some(call => call.symbol === 'BTC' && call.side === 'buy' && call.size === 1));
});

const position = { symbol: 'BTC', perpSymbol: 'BTC', spotSymbol: 'UBTC', perpSize: 1, spotSize: 1,
  perpEntryPrice: 100, spotEntryPrice: 100, openTime: Date.now() - 1000 };

test('close retries remaining on-chain PERP exposure after rejected close request', async () => {
  const hyperliquid = exchange({ BTC: -1 }, {});
  hyperliquid.execution = c => c.index === 0 ? { error: new Error('perp close timeout') } : { size: c.size, price: 100 };

  const result = await closeDeltaNeutralPosition(hyperliquid, position, baseConfig);

  assert.equal(result.success, true);
  assert.equal(hyperliquid.calls.filter(call => call.symbol === 'BTC' && call.side === 'buy').length, 2);
});

test('close sizes from on-chain balances and succeeds after a partial fill plus retry', async () => {
  // Spot buy fee was taken in UBTC, so the wallet holds less than the recorded fill
  const hyperliquid = exchange({ BTC: -1 }, { UBTC: 0.9993 });
  hyperliquid.execution = c => ({ size: c.options.isSpot ? c.size : 0.5, price: 100 });

  const result = await closeDeltaNeutralPosition(hyperliquid, position, baseConfig);

  assert.equal(result.success, true);
  assert.equal(hyperliquid.calls.find(call => call.symbol === 'UBTC').size, 0.9993);
  assert.equal(hyperliquid.calls.filter(call => call.symbol === 'BTC' && call.side === 'buy').length, 2);
});
