import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOpportunities, rankOpportunities } from '../../utils/opportunity.js';
import { decide, getCurrentPositionFundingSignal, switchEdge } from '../../utils/position-decision.js';
import { fetchWithConcurrencyLimit } from '../../utils/spread.js';

const THRESHOLDS = { maxSpreadPercent: 0.15, maxPerpSpotSpreadPercent: 0.5, minVolumeUSDC: 75_000_000, minFundingRatePercent: 5 };

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
        annualizedRate: 0.3,  // the current hour; decisions use the 7d average below
        history: { count: 168, avg: { annualized: 0.1 } }
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
  }), THRESHOLDS);

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.rejected.missingData.length, 1);
  assert.deepEqual(result.rejected.missingData[0].missing, ['spotSpread', 'spotMid']);
});

test('filters: the base pair passes on its 7d average; each threshold just crossed rejects it into its bucket', () => {
  assert.deepEqual(filterOpportunities(baseMarketData(), THRESHOLDS).opportunities.map(o => [o.symbol, o.avgFundingPercent]), [['BTC', 10]]);
  for (const [bucket, overrides] of [
    ['bidAskSpread', { bidAskSpreads: [{ symbol: 'BTC', isSpot: false, spreadPercent: 0.02, mid: 100 }, { symbol: 'UBTC', isSpot: true, spreadPercent: 0.16, mid: 100 }] }],
    ['perpSpotSpread', { perpSpotSpreads: [{ perpSymbol: 'BTC', spreadPercent: -0.51, perpMid: 100, spotMid: 100 }] }],
    ['volume', { volumes: [{ perpSymbol: 'BTC', perpVolUSDC: 37_000_000, spotVolUSDC: 37_000_000 }] }],
    ['funding', { fundingRates: [{ symbol: 'BTC', fundingRate: 0.001, annualizedRate: 0.3, history: { count: 168, avg: { annualized: 0.049 } } }] }]]) {
    assert.equal(filterOpportunities(baseMarketData(overrides), THRESHOLDS).rejected[bucket].length, 1, bucket);
  }
});

test('ranking: higher 7d funding first; a tie goes to the higher volume', () => {
  const ranked = (...opps) => rankOpportunities(opps.map(([symbol, avgFundingRate, totalVolumeUSDC]) => ({ symbol, avgFundingRate, totalVolumeUSDC }))).map(o => o.symbol);
  assert.deepEqual(ranked(['A', 0.1, 9e9], ['B', 0.3, 1e8]), ['B', 'A']);
  assert.deepEqual(ranked(['A', 0.1, 1e8], ['B', 0.1, 2e8]), ['B', 'A']);
});

test('opportunity filtering rejects non-finite 7d funding', () => {
  const result = filterOpportunities(baseMarketData({
    fundingRates: [{ symbol: 'BTC', fundingRate: 0.001, annualizedRate: NaN, history: { count: 168, avg: { annualized: NaN } } }]
  }), THRESHOLDS);

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.rejected.funding.length, 1);
  assert.equal(result.rejected.funding[0].error, 'non-finite funding');
});

test('held position is judged on its 7d average even when filtered out of the ranking', () => {
  const analysis = {
    rankedOpportunities: [],
    marketData: {
      fundingRates: [{ symbol: 'BTC', annualizedRate: 0.3, history: { count: 168, avg: { annualized: -0.02 } } }]
    }
  };

  const signal = getCurrentPositionFundingSignal({ symbol: 'BTC' }, analysis);

  assert.equal(signal.available, true);
  assert.equal(signal.fundingPercent, -2);
});

// config.json fees and horizon; a candidate whose PERP + SPOT bid-ask spreads total 0.05%
const config = { trading: { takerFeeRate: 0.00045, spotTakerFeeRate: 0.0007 }, bot: { switchHorizonDays: 8 } };
const candidate = apy => ({ avgFundingRate: apy, bidAsk: { perpSpreadPercent: 0.02, spotSpreadPercent: 0.03 } });

test('switchEdge acts only when the expected funding gain beats fees and spread', () => {
  // Break-even gap = (2 x (0.045% + 0.07%) fees + 0.05% spread) x 365 / 8 days = 12.8 APY points
  assert.ok(switchEdge(0.11, candidate(0.225), config) < 0);
  assert.ok(switchEdge(0.11, candidate(0.25), config) > 0);
  // Closing a negative position: mild -3% APY is cheaper to hold, -30% APY is worth closing
  assert.ok(switchEdge(-0.03, null, config) < 0);
  assert.ok(switchEdge(-0.30, null, config) > 0);
});

test('decide: inside the minimum hold only negative funding acts; after it the same gap switches', () => {
  const { action, blockedByHold } = decide(0.11, candidate(0.5), false, config);
  assert.deepEqual({ action, blockedByHold }, { action: null, blockedByHold: true });
  assert.equal(decide(-0.3, null, false, config).action, 'close');
  assert.equal(decide(0.11, candidate(0.5), true, config).action, 'switch');
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
