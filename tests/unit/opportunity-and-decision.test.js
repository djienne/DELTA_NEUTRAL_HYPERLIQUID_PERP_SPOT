import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOpportunities } from '../../utils/opportunity.js';
import { getCurrentPositionFundingSignal, switchEdge } from '../../utils/position-decision.js';
import { fetchWithConcurrencyLimit } from '../../utils/spread.js';

function baseMarketData(overrides = {}) {
  return {
    bidAskSpreads: [
      { symbol: 'BTC', isSpot: false, spreadPercent: 0.02, mid: 100 },
      { symbol: 'UBTC', isSpot: true, spreadPercent: 0.03, mid: 100 }
    ],
    perpSpotSpreads: [
      { perpSymbol: 'BTC', spreadPercent: 0.01, perpMid: 100, spotMid: 100 }
    ],
    volumes: [
      { perpSymbol: 'BTC', perpVolUSDC: 100_000_000, spotVolUSDC: 100_000_000 }
    ],
    fundingRates: [
      {
        symbol: 'BTC',
        fundingRate: 0.001,
        annualizedRate: 0.1,
        history: { avg: { annualized: 0.1 } }
      }
    ],
    ...overrides
  };
}

test('opportunity filtering rejects missing bid-ask leg data instead of treating it as zero', () => {
  const result = filterOpportunities(baseMarketData({
    bidAskSpreads: [
      { symbol: 'BTC', isSpot: false, spreadPercent: 0.02, mid: 100 }
    ]
  }), {
    maxSpreadPercent: 0.15,
    maxPerpSpotSpreadPercent: 0.5,
    minVolumeUSDC: 75_000_000,
    minFundingRatePercent: 5
  });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.rejected.missingData.length, 1);
  assert.deepEqual(result.rejected.missingData[0].missing, ['spotSpread', 'spotMid']);
});

test('opportunity filtering keeps valid complete spread data', () => {
  const result = filterOpportunities(baseMarketData(), {
    maxSpreadPercent: 0.15,
    maxPerpSpotSpreadPercent: 0.5,
    minVolumeUSDC: 75_000_000,
    minFundingRatePercent: 5
  });

  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].symbol, 'BTC');
  assert.equal(result.opportunities[0].avgFundingPercent, 10);
});

test('opportunity filtering rejects non-finite 7d funding', () => {
  const result = filterOpportunities(baseMarketData({
    fundingRates: [{ symbol: 'BTC', fundingRate: 0.001, annualizedRate: NaN, history: { avg: { annualized: NaN } } }]
  }), {
    maxSpreadPercent: 0.15,
    maxPerpSpotSpreadPercent: 0.5,
    minVolumeUSDC: 75_000_000,
    minFundingRatePercent: 5
  });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.rejected.funding.length, 1);
  assert.equal(result.rejected.funding[0].error, 'non-finite funding');
});

test('held position is judged on its 7d average even when filtered out of the ranking', () => {
  const analysis = {
    rankedOpportunities: [],
    marketData: {
      fundingRates: [{ symbol: 'BTC', annualizedRate: 0.3, history: { avg: { annualized: -0.02 } } }]
    }
  };

  const signal = getCurrentPositionFundingSignal({ symbol: 'BTC' }, analysis);

  assert.equal(signal.available, true);
  assert.equal(signal.fundingPercent, -2);
});

test('switchEdge acts only when the expected funding gain beats fees and spread', () => {
  const config = { bot: { switchHorizonDays: 8 } };
  const candidate = apy => ({ avgFundingRate: apy, bidAsk: { perpSpreadPercent: 0.02, spotSpreadPercent: 0.03 } });

  // Switching needs a large gap: 5 APY points does not pay ~0.28% round-trip cost, 20 points does
  assert.ok(switchEdge(0.11, candidate(0.16), config) < 0);
  assert.ok(switchEdge(0.11, candidate(0.31), config) > 0);
  // Closing a negative position: mild -3% APY is cheaper to hold, -30% APY is worth closing
  assert.ok(switchEdge(-0.03, null, config) < 0);
  assert.ok(switchEdge(-0.30, null, config) > 0);
});

test('concurrency helper starts only the configured number of tasks', async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return index;
  });

  const results = await fetchWithConcurrencyLimit(tasks, 2, 0);

  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});
