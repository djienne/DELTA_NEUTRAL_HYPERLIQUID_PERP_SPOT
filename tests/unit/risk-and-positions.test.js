import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getManagedSpotSymbols,
  getMaxBidAskSpreadPercent,
  getMaxHedgeMismatchPercent,
  getMaxOpenHedgeMismatchPercent,
  getMinFillRatio
} from '../../utils/risk.js';
import { analyzeDeltaNeutral } from '../../utils/positions.js';

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
});

test('managed spot symbols derive from configured pairs and current state', () => {
  const managed = getManagedSpotSymbols({
    trading: { pairs: ['BTC', 'ETH'] }
  }, { spotSymbol: 'PURR' });

  assert.deepEqual([...managed].sort(), ['PURR', 'UBTC', 'UETH']);
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
});
