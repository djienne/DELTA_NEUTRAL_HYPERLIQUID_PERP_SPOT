import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getManagedSpotSymbols,
  getMaxBidAskSpreadPercent,
  getMaxHedgeMismatchPercent,
  getMaxOpenHedgeMismatchPercent,
  getManagedPerpSymbols,
  getMinFillRatio,
  getStartupCleanupMode
} from '../../utils/risk.js';
import { analyzeDeltaNeutral, getPerpPositions, getSpotBalances } from '../../utils/positions.js';
import { checkBalanceDistribution } from '../../utils/balance.js';

test('maxSpreadPercent is the preferred bid-ask spread threshold key', () => {
  assert.equal(getMaxBidAskSpreadPercent({ maxSpreadPercent: 0.25 }), 0.25);
  assert.equal(getMaxBidAskSpreadPercent({ maxBidAskSpreadPercent: 0.2 }), 0.2);
  assert.equal(getMaxBidAskSpreadPercent({ maxSpreadPercent: 0.25, maxBidAskSpreadPercent: 0.2 }), 0.25);
  assert.equal(getMaxBidAskSpreadPercent({}), 0.15);
});

test('risk defaults are stable', () => {
  assert.equal(getMinFillRatio({}), 0.999);
  assert.equal(getMaxOpenHedgeMismatchPercent({}), 2);
  assert.equal(getMaxHedgeMismatchPercent({}), 30);
  assert.equal(getStartupCleanupMode({}), 'hedge-only');
});

test('startup cleanup mode is allowlisted', () => {
  assert.equal(getStartupCleanupMode({ risk: { startupCleanupMode: 'report-only' } }), 'report-only');
  assert.equal(getStartupCleanupMode({ risk: { startupCleanupMode: 'hedge-only' } }), 'hedge-only');
  assert.equal(getStartupCleanupMode({ risk: { startupCleanupMode: 'hedge-or-close' } }), 'hedge-or-close');
  assert.equal(getStartupCleanupMode({ risk: { startupCleanupMode: 'unexpected' } }), 'hedge-only');
});

test('managed spot symbols derive from configured pairs and current state', () => {
  const managed = getManagedSpotSymbols({
    trading: { pairs: ['BTC', 'ETH'] }
  }, { spotSymbol: 'PURR' });

  assert.deepEqual([...managed].sort(), ['PURR', 'UBTC', 'UETH']);
});

test('managed perp symbols derive from configured pairs and current state', () => {
  const managed = getManagedPerpSymbols({
    trading: { pairs: ['BTC', 'ETH'] }
  }, { perpSymbol: 'PURR' });

  assert.deepEqual([...managed].sort(), ['BTC', 'ETH', 'PURR']);
});

test('delta-neutral analysis separates true hedges from imbalanced matches', () => {
  const perpPositions = [
    { symbol: 'BTC', side: 'SHORT', size: 1, sizeRaw: -1 },
    { symbol: 'ETH', side: 'LONG', size: 2, sizeRaw: 2 },
    { symbol: 'SOL', side: 'SHORT', size: 10, sizeRaw: -10 }
  ];
  const spotBalances = [
    { symbol: 'UBTC', total: 1 },
    { symbol: 'UETH', total: 2 },
    { symbol: 'USOL', total: 1 }
  ];

  const analysis = analyzeDeltaNeutral(perpPositions, spotBalances, { maxHedgeMismatchPercent: 30 });

  assert.equal(analysis.deltaNeutralPairs.length, 1);
  assert.equal(analysis.deltaNeutralPairs[0].symbol, 'BTC');
  assert.equal(analysis.imbalancedPairs.length, 2);
  assert.deepEqual(analysis.imbalancedPairs.map(pair => pair.symbol).sort(), ['ETH', 'SOL']);
  assert.equal(analysis.hasDeltaNeutral, true);
  assert.equal(analysis.imbalancedPairs.find(pair => pair.symbol === 'ETH').imbalanceType, 'DOUBLE_LONG');
  assert.equal(analysis.imbalancedPairs.find(pair => pair.symbol === 'SOL').imbalanceType, 'EXCESS_PERP_SHORT');
});

test('exposure below the $10 order minimum is ignored as untradeable dust', async () => {
  const hyperliquid = {
    wallet: '0x1',
    async getMeta() { return { universe: [{ name: 'BTC' }, { name: 'ETH' }] }; },
    async getAllMids() { return { BTC: '100', ETH: '10' }; },
    async infoRequest({ type }) {
      if (type === 'clearinghouseState') {
        return { assetPositions: [
          { position: { coin: 'BTC', szi: '-0.5', positionValue: '50' } },
          { position: { coin: 'ETH', szi: '-0.5', positionValue: '5' } }
        ] };
      }
      return { balances: [
        { coin: 'UBTC', total: '0.5', hold: '0' },     // $50: real exposure
        { coin: 'UETH', total: '0.01', hold: '0' },    // $0.10: dust left after a close
        { coin: 'UNKNOWN', total: '3', hold: '0' }     // no price: kept, never silently dropped
      ] };
    }
  };

  const perps = await getPerpPositions(hyperliquid);
  const spots = await getSpotBalances(hyperliquid);

  assert.deepEqual(perps.map(p => p.symbol), ['BTC']);
  assert.deepEqual(spots.map(b => b.symbol), ['UBTC', 'UNKNOWN']);
  assert.equal(spots[0].valueUSD, 50);
});

test('rebalance hold threshold: maxBalanceImbalancePercent 10 = 50/50 +-5 points (bot.js passes 10 / 2)', () => {
  const split = perpPercent => ({ perpPercent, spotPercent: 100 - perpPercent });
  assert.equal(checkBalanceDistribution(split(44), 10 / 2).isBalanced, false);  // 12% imbalance: ON HOLD
  assert.equal(checkBalanceDistribution(split(56), 10 / 2).isBalanced, false);
  assert.equal(checkBalanceDistribution(split(46), 10 / 2).isBalanced, true);   // 8% imbalance: trade
  assert.equal(checkBalanceDistribution(split(54), 10 / 2).isBalanced, true);
});
