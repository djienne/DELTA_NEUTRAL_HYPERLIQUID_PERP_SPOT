import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDeltaNeutralPosition, openDeltaNeutralPosition } from '../../utils/trade.js';

const baseOpportunity = {
  symbol: 'BTC',
  bidAsk: {
    perpMid: 100,
    spotMid: 100
  },
  funding: {
    fundingRate: 0.001
  },
  predictedFunding: null,
  predictedFundingRate: null,
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

function filled(totalSz = '1', avgPx = '100') {
  return {
    response: {
      data: {
        statuses: [{ filled: { totalSz, avgPx, oid: 1 } }]
      }
    }
  };
}

function failed(error = 'boom') {
  return {
    response: {
      data: {
        statuses: [{ error }]
      }
    }
  };
}

function makeHyperliquid(handler, options = {}) {
  const calls = [];

  return {
    wallet: '0x0000000000000000000000000000000000000001',
    signer: {},
    exchangeUrl: 'https://example.invalid/exchange',
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    calls,
    async signAction() {
      return { r: '0x1', s: '0x2', v: 27 };
    },
    async getAssetId(symbol, isSpot) {
      return isSpot ? 100 : 1;
    },
    getAssetInfo() {
      return { szDecimals: 4 };
    },
    getCoinForOrderbook(symbol, assetId) {
      return assetId >= 100 ? '@1' : symbol;
    },
    async subscribeOrderbook() {},
    getBidAsk(coin) {
      const price = options.prices?.[coin] ?? 100;
      return { bid: price - 1, ask: price + 1, mid: price, timestamp: Date.now() };
    },
    async getMeta() {
      return { universe: [{ name: 'BTC' }] };
    },
    async infoRequest(payload) {
      if (payload.type === 'clearinghouseState') {
        return { assetPositions: options.perpPositions || [] };
      }
      if (payload.type === 'spotClearinghouseState') {
        return { balances: options.spotBalances || [] };
      }
      return {};
    },
    async getUserFundingHistory() {
      return { accumulated: {}, totalAccumulated: 0 };
    },
    roundSize(size, decimals) {
      return Number(size).toFixed(decimals);
    },
    async createMarketOrder(symbol, side, size, options) {
      calls.push({ symbol, side, size, options });
      return handler({ symbol, side, size, options, index: calls.length - 1 });
    }
  };
}

test('SPOT cleanup after PERP failure is not reduce-only and uses override price', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });

  const hyperliquid = makeHyperliquid(({ symbol, side }) => {
    if (symbol === 'BTC' && side === 'sell') return failed('perp failed');
    if (symbol === 'UBTC' && side === 'buy') return filled('1');
    if (symbol === 'UBTC' && side === 'sell') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /PERP order failed/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'UBTC');
  assert.equal(cleanup.side, 'sell');
  assert.equal(cleanup.options.isSpot, true);
  assert.equal(cleanup.options.reduceOnly, false);
  assert.equal(cleanup.options.overrideMidPrice, 100);

  global.fetch = originalFetch;
});

test('PERP cleanup after SPOT failure is reduce-only and uses override price', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });

  const hyperliquid = makeHyperliquid(({ symbol, side }) => {
    if (symbol === 'BTC' && side === 'sell') return filled('1');
    if (symbol === 'UBTC' && side === 'buy') return failed('spot failed');
    if (symbol === 'BTC' && side === 'buy') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /SPOT order failed/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'BTC');
  assert.equal(cleanup.side, 'buy');
  assert.equal(cleanup.options.isSpot, false);
  assert.equal(cleanup.options.reduceOnly, true);
  assert.equal(cleanup.options.overrideMidPrice, 100);

  global.fetch = originalFetch;
});

test('imbalanced partial fills are closed with actual filled sizes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });

  const hyperliquid = makeHyperliquid(({ symbol, side, index }) => {
    if (index === 0 && symbol === 'BTC' && side === 'sell') return filled('1');
    if (index === 1 && symbol === 'UBTC' && side === 'buy') return filled('0.5');
    if (symbol === 'UBTC' && side === 'sell') return filled('0.5');
    if (symbol === 'BTC' && side === 'buy') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /Partial open fills were imbalanced/
  );

  const cleanupSpot = hyperliquid.calls.find(call => call.symbol === 'UBTC' && call.side === 'sell');
  const cleanupPerp = hyperliquid.calls.find(call => call.symbol === 'BTC' && call.side === 'buy');
  assert.equal(cleanupSpot.size, 0.5);
  assert.equal(cleanupSpot.options.reduceOnly, false);
  assert.equal(cleanupPerp.size, 1);
  assert.equal(cleanupPerp.options.reduceOnly, true);

  global.fetch = originalFetch;
});

test('rejected PERP open request reconciles and closes filled SPOT leg', async () => {
  const hyperliquid = makeHyperliquid(({ symbol, side }) => {
    if (symbol === 'BTC' && side === 'sell') throw new Error('network down');
    if (symbol === 'UBTC' && side === 'buy') return filled('1');
    if (symbol === 'UBTC' && side === 'sell') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /PERP order failed: network down/
  );

  const cleanup = hyperliquid.calls.at(-1);
  assert.equal(cleanup.symbol, 'UBTC');
  assert.equal(cleanup.side, 'sell');
  assert.equal(cleanup.size, 1);
});

test('both rejected open requests use on-chain reconciliation for cleanup', async () => {
  const hyperliquid = makeHyperliquid(({ symbol, side, index }) => {
    if (index === 0 && symbol === 'BTC' && side === 'sell') throw new Error('perp timeout');
    if (index === 1 && symbol === 'UBTC' && side === 'buy') throw new Error('spot timeout');
    if (symbol === 'UBTC' && side === 'sell') return filled('1');
    if (symbol === 'BTC' && side === 'buy') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  }, {
    perpPositions: [
      { position: { coin: 'BTC', szi: '-1', entryPx: '100', positionValue: '100' } }
    ],
    spotBalances: [
      { coin: 'UBTC', total: '1', hold: '0' }
    ]
  });

  await assert.rejects(
    () => openDeltaNeutralPosition(hyperliquid, baseOpportunity, baseBalances, baseConfig),
    /Both orders failed/
  );

  assert.ok(hyperliquid.calls.some(call => call.symbol === 'UBTC' && call.side === 'sell' && call.size === 1));
  assert.ok(hyperliquid.calls.some(call => call.symbol === 'BTC' && call.side === 'buy' && call.size === 1));
});

test('close retries remaining on-chain PERP exposure after rejected close request', async () => {
  const hyperliquid = makeHyperliquid(({ symbol, side, index }) => {
    if (index === 0 && symbol === 'BTC' && side === 'buy') throw new Error('perp close timeout');
    if (index === 1 && symbol === 'UBTC' && side === 'sell') return filled('1');
    if (symbol === 'BTC' && side === 'buy') return filled('1');
    throw new Error(`Unexpected order ${symbol} ${side}`);
  }, {
    perpPositions: [
      { position: { coin: 'BTC', szi: '-1', entryPx: '100', positionValue: '100' } }
    ],
    spotBalances: []
  });

  const result = await closeDeltaNeutralPosition(hyperliquid, {
    symbol: 'BTC',
    perpSymbol: 'BTC',
    spotSymbol: 'UBTC',
    perpSize: 1,
    spotSize: 1,
    perpEntryPrice: 100,
    spotEntryPrice: 100,
    openTime: Date.now() - 1000
  }, baseConfig);

  assert.equal(result.success, true);
  assert.equal(hyperliquid.calls.filter(call => call.symbol === 'BTC' && call.side === 'buy').length, 2);
});
