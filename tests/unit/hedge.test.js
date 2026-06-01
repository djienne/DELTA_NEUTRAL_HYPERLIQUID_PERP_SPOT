import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHedgeNeeds, createHedge } from '../../utils/hedge.js';

function makeHedgeHyperliquid(options = {}) {
  return {
    wallet: '0x0000000000000000000000000000000000000001',
    async infoRequest(payload) {
      if (payload.type === 'clearinghouseState') {
        return { assetPositions: options.perpPositions || [] };
      }
      if (payload.type === 'spotClearinghouseState') {
        return { balances: options.spotBalances || [] };
      }
      return {};
    },
    async getMeta() {
      return { universe: [{ name: 'BTC' }, { name: 'ETH' }] };
    },
    async getAllMids() {
      return { BTC: '100', ETH: '100' };
    },
    async getAssetId() {
      return 1;
    },
    getAssetInfo() {
      return { szDecimals: 4 };
    },
    roundSize(size, decimals) {
      return Number(size).toFixed(decimals);
    },
    async createMarketOrder() {
      return options.orderResult;
    }
  };
}

test('hedge analysis emits a spot-strengthen action for excess PERP short', async () => {
  const hyperliquid = makeHedgeHyperliquid({
    perpPositions: [
      { position: { coin: 'BTC', szi: '-2', entryPx: '100', positionValue: '200' } }
    ],
    spotBalances: [
      { coin: 'UBTC', total: '1', hold: '0' }
    ]
  });

  const analysis = await analyzeHedgeNeeds(hyperliquid, {
    minValueUSD: 1,
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
  const hyperliquid = makeHedgeHyperliquid({
    orderResult: {
      response: {
        data: {
          statuses: [{ filled: { totalSz: '0.5', avgPx: '100', oid: 1 } }]
        }
      }
    }
  });

  const result = await createHedge(hyperliquid, {
    type: 'SPOT_NEEDS_PERP_SHORT',
    targetSymbol: 'BTC',
    targetMarket: 'PERP',
    targetSide: 'sell',
    targetSize: 1,
    currentPrice: 100,
    valueUSD: 100,
    reason: 'test'
  }, {
    trading: { maxSlippagePercent: 5 },
    risk: { minFillRatio: 0.999 }
  });

  assert.equal(result.success, false);
  assert.match(result.error, /below/);
});
