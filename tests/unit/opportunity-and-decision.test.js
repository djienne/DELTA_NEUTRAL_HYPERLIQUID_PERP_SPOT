import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOpportunities } from '../../utils/opportunity.js';
import {
  getCurrentPositionFundingSignal,
  getPositiveReopenOpportunity,
  isNegativeFundingSignal
} from '../../utils/position-decision.js';
import { fetchWithConcurrencyLimit as limitVolumeTasks } from '../../utils/volume.js';
import { fetchWithConcurrencyLimit as limitSpreadTasks } from '../../utils/spread.js';
import { fetchWithConcurrencyLimit as limitArbitrageTasks } from '../../utils/arbitrage.js';

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
    predictedFundingRates: new Map([
      ['BTC', { predictedAnnualizedRate: 0.12 }]
    ]),
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
  assert.equal(result.opportunities[0].primaryFundingPercent, 12);
});

test('opportunity filtering rejects non-finite predicted funding', () => {
  const result = filterOpportunities(baseMarketData({
    predictedFundingRates: new Map([
      ['BTC', { predictedAnnualizedRate: NaN }]
    ])
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

test('position funding signal detects negative funding independently of hold time', () => {
  const analysis = {
    rankedOpportunities: [],
    best: { symbol: 'ETH', primaryFundingPercent: 8 },
    marketData: {
      fundingRates: [
        {
          symbol: 'BTC',
          annualizedRate: 0.1,
          history: { avg: { annualized: 0.1 } }
        }
      ],
      predictedFundingRates: new Map([
        ['BTC', { predictedAnnualizedRate: -0.02 }]
      ])
    }
  };

  const signal = getCurrentPositionFundingSignal({ symbol: 'BTC' }, analysis);

  assert.equal(signal.available, true);
  assert.equal(signal.fundingPercent, -2);
  assert.equal(signal.fundingType, 'predicted');
  assert.equal(isNegativeFundingSignal(signal), true);
  assert.equal(getPositiveReopenOpportunity(analysis).symbol, 'ETH');
});

async function assertLimiterCapsConcurrency(limiter) {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return index;
  });

  const results = await limiter(tasks, 2, 0);

  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
}

test('volume concurrency helper starts only the configured number of tasks', async () => {
  await assertLimiterCapsConcurrency(limitVolumeTasks);
});

test('spread concurrency helper starts only the configured number of tasks', async () => {
  await assertLimiterCapsConcurrency(limitSpreadTasks);
});

test('arbitrage concurrency helper starts only the configured number of tasks', async () => {
  await assertLimiterCapsConcurrency(limitArbitrageTasks);
});
