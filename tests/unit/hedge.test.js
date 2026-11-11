import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHedgeNeeds, createHedge } from '../../utils/hedge.js';
import { exchange } from './fake-exchange.js';

test('hedge analysis emits a spot-strengthen action for excess PERP short', async () => {
  const analysis = await analyzeHedgeNeeds(exchange({ BTC: -2 }, { UBTC: 1 }), {
    managedPerpSymbols: ['BTC'],
    managedSpotSymbols: ['UBTC']
  });

  assert.equal(analysis.hedgeNeeds.length, 1);
  assert.equal(analysis.hedgeNeeds[0].type, 'STRENGTHEN_SPOT_LONG');
  assert.equal(analysis.hedgeNeeds[0].targetMarket, 'SPOT');
  assert.equal(analysis.hedgeNeeds[0].targetSide, 'buy');
  assert.equal(analysis.hedgeNeeds[0].targetSize, 1);
});

test('hedge order partial fill is not reported as success', async () => {
  const hyperliquid = exchange({}, { UBTC: 1 });
  hyperliquid.execution = () => ({ size: 0.5, price: 100 });

  const result = await createHedge(hyperliquid, {
    type: 'SPOT_NEEDS_PERP_SHORT',
    targetSymbol: 'BTC',
    targetMarket: 'PERP',
    targetSide: 'sell',
    targetSize: 1,
    valueUSD: 100,
    reason: 'test'
  }, {
    trading: { maxSlippagePercent: 5 },
    risk: { minFillRatio: 0.999 }
  });

  assert.equal(result.success, false);
  assert.match(result.error, /below/);
});
