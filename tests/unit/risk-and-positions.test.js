import test from 'node:test';
import assert from 'node:assert/strict';
import { getManagedSpotSymbols, getManagedPerpSymbols, getStartupCleanupMode } from '../../utils/risk.js';
import { analyzeDeltaNeutral, getPerpPositions, getSpotBalances } from '../../utils/positions.js';
import { rebalanceNeeded } from '../../utils/balance.js';

test('startup cleanup mode is allowlisted', () => {
  assert.equal(getStartupCleanupMode({ risk: { startupCleanupMode: 'unexpected' } }), 'hedge-only');
});

test('managed perp and spot symbols derive from configured pairs and current state', () => {
  const config = { trading: { pairs: ['BTC', 'ETH'] } };
  assert.deepEqual([...getManagedSpotSymbols(config, { spotSymbol: 'PURR' })].sort(), ['PURR', 'UBTC', 'UETH']);
  assert.deepEqual([...getManagedPerpSymbols(config, { perpSymbol: 'PURR' })].sort(), ['BTC', 'ETH', 'PURR']);
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
  assert.equal(analysis.imbalancedPairs.find(pair => pair.symbol === 'ETH').imbalanceType, 'DOUBLE_LONG');
  assert.equal(analysis.imbalancedPairs.find(pair => pair.symbol === 'SOL').imbalanceType, 'EXCESS_PERP_SHORT');
});

test('exposure below the $10 order minimum is ignored as untradeable dust', async () => {
  const hyperliquid = {
    wallet: '0x1',
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

test('rebalance hold threshold: maxBalanceImbalancePercent 10 = 50/50 +-5 points', () => {
  const split = perp => ({ perpBalance: perp, spotBalance: 100 - perp, totalBalance: 100 });
  assert.equal(rebalanceNeeded(split(44), 10).onHold, true);   // 12% imbalance: ON HOLD
  assert.equal(rebalanceNeeded(split(56), 10).onHold, true);
  assert.equal(rebalanceNeeded(split(46), 10).onHold, false);  // 8% imbalance: trade
  assert.equal(rebalanceNeeded(split(54), 10).onHold, false);
  const ask = rebalanceNeeded(split(44), 10);                  // the transfer that restores 50/50
  assert.equal(ask.amount, 6); assert.equal(ask.fromPerpToSpot, false);
  assert.equal(rebalanceNeeded({ perpBalance: 0, spotBalance: 0, totalBalance: 0 }, 10).onHold, false);
});
