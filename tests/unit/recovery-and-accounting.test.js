import test from 'node:test';
import assert from 'node:assert/strict';
import HyperliquidConnector from '../../hyperliquid.js';
import { verifyPositionOnChain, reconcilePendingIntent } from '../../bot.js';
import { analyzeHedgeNeeds, autoHedgeAll, createHedge } from '../../utils/hedge.js';
import { closeDeltaNeutralPosition, openDeltaNeutralPosition } from '../../utils/trade.js';
import { getHistoryStats } from '../../utils/state.js';

const config = { trading: { maxSlippagePercent: 5, takerFeeRate: 0, spotTakerFeeRate: 0 }, risk: { maxHedgeMismatchPercent: 2 } };
const original = { symbol: 'BTC', perpSymbol: 'BTC', spotSymbol: 'UBTC', perpSize: 1, spotSize: 1,
  perpEntryPrice: 100, spotEntryPrice: 100, openTime: Date.now() - 86400000, accountingComplete: true };
const initial = (type = null) => ({ position: { ...original }, history: [], pendingIntent: type && {
  type, symbol: 'BTC', perpSymbol: 'BTC', spotSymbol: 'UBTC', createdAt: Date.now(), reason: 'Funding negative'
} });

function exchange(perps = { BTC: -1 }, spots = { UBTC: 1 }) {
  const e = {
    wallet: 'fake-account', signer: {}, exchangeUrl: 'https://example.invalid', perps: { ...perps }, spots: { ...spots }, calls: [], updates: [],
    async infoRequest({ type }) {
      if (type === 'clearinghouseState') return { assetPositions: Object.entries(e.perps).filter(([, q]) => q).map(([coin, q]) =>
        ({ position: { coin, szi: String(q), entryPx: '100', positionValue: String(Math.abs(q) * 100) } })) };
      if (type === 'spotClearinghouseState') return { balances: Object.entries(e.spots).filter(([, q]) => q).map(([coin, q]) => ({ coin, total: String(q), hold: '0' })) };
      throw Error(type);
    },
    async getMeta() { return { universe: [{ name: 'BTC' }, { name: 'ETH' }] }; },
    async getAllMids() { return { BTC: '100', ETH: '100', '@1': '100', '@2': '100' }; },
    async getAssetId(symbol, isSpot) { return (isSpot ? 10000 : 0) + (['BTC','UBTC'].includes(symbol) ? 1 : 2); },
    getCoinForOrderbook(symbol, id) { return id >= 10000 ? '@' + (id - 10000) : symbol; },
    getAssetInfo() { return { szDecimals: 4 }; },
    async getFreshBidAsk() { return { bid: 99.99, ask: 100.01, mid: 100, timestamp: Date.now() }; },
    roundSize: HyperliquidConnector.prototype.roundSize,
    async signAction() { return {}; },
    async fetchJsonWithTimeout(url, init) { e.updates.push(JSON.parse(init.body).action); return e.leverageResponse ?? { status: 'ok' }; },
    async getUserFundingHistory() { return { accumulated: { BTC: 0 } }; },
    async createMarketOrder(symbol, side, size, options) {
      const call = { symbol, side, size, options }; e.calls.push(call);
      const execution = e.execution ? e.execution(call) : { size, price: 100 };
      if (execution.error) throw execution.error;
      if (execution.reject) return { status: 'ok', response: { data: { statuses: [{ error: 'Rejected' }] } } };
      const inventory = options.isSpot ? e.spots : e.perps;
      inventory[symbol] = (inventory[symbol] ?? 0) + execution.size * (side === 'buy' ? 1 : -1);
      if (Math.abs(inventory[symbol]) < 1e-12) delete inventory[symbol];
      return { status: 'ok', response: { data: { statuses: [{ filled: {
        totalSz: String(execution.size), avgPx: String(execution.price), oid: e.calls.length,
        ...(execution.fee === undefined ? {} : { fee: String(execution.fee) })
      } }] } } };
    }
  };
  return e;
}

for (const [label, perps, spots] of [['both legs', {BTC:-1}, {UBTC:1}], ['perp only', {BTC:-1}, {}], ['spot only', {}, {UBTC:1}], ['already flat', {}, {}]]) {
  test(`closing recovery: ${label}, preserves basis and never reopens`, async () => {
    const e = exchange(perps, spots); const writes = [];
    const next = await reconcilePendingIntent(e, initial('closing'), s => writes.push(s));
    assert.equal(next.pendingIntent, null); assert.equal(next.position, null);
    assert.deepEqual(e.perps, {}); assert.deepEqual(e.spots, {});
    assert.ok(e.calls.every(c => c.options.isSpot ? c.side === 'sell' : c.side === 'buy' && c.options.reduceOnly));
    assert.equal(next.history[0].openTime, original.openTime);
    assert.equal(next.history[0].spotEntryPrice, original.spotEntryPrice);
    assert.equal(next.history[0].totalPnl, null); assert.equal(getHistoryStats(next).unavailablePnlCount, 1);
    const count = e.calls.length;
    await reconcilePendingIntent(e, next, s => writes.push(s));
    assert.equal(e.calls.length, count); assert.equal(writes.length, 1);
  });
}

test('failed closing recovery retains the intent and blocks adoption', async () => {
  const e = exchange(); e.execution = () => ({ reject: true });
  const s = initial('closing'); let saved = false;
  await assert.rejects(reconcilePendingIntent(e, s, () => { saved = true; }), /Close incomplete/);
  assert.equal(saved, false); assert.equal(s.pendingIntent.type, 'closing');
  assert.equal(e.updates.length, 0);
});

test('verification never hides orphan legs, multiple pairs or a different recorded symbol', async () => {
  for (const e of [exchange({BTC:-1,ETH:-1},{UBTC:1}), exchange({BTC:-1,ETH:-1},{UBTC:1,UETH:1}), exchange({ETH:-1},{UETH:1})]) {
    assert.equal((await verifyPositionOnChain(e, initial())).status, 'ambiguous');
    const s = { ...initial('opening'), position: null };
    assert.equal((await reconcilePendingIntent(e, s, () => assert.fail('must not adopt'))).pendingIntent.type, 'opening');
    assert.equal(e.calls.length, 0);
  }
});

test('2 percent mismatch boundary and executable dust have different outcomes', async () => {
  const at = await verifyPositionOnChain(exchange({BTC:-100},{UBTC:98}), initial());
  assert.equal(at.status, 'delta_neutral');
  const above = await verifyPositionOnChain(exchange({BTC:-100},{UBTC:97.99}), initial());
  assert.equal(above.status, 'imbalanced');
  const small = exchange({BTC:-1},{UBTC:0.97});
  const snapshot = await analyzeHedgeNeeds(small);
  assert.equal(snapshot.needsHedging, false); assert.equal(snapshot.dust.length, 1);
  assert.equal((await verifyPositionOnChain(small, initial())).status, 'delta_neutral');
  const coarse = exchange({BTC:-1},{UBTC:0.89}); coarse.getAssetInfo = () => ({ szDecimals: 0 });
  assert.equal((await analyzeHedgeNeeds(coarse)).needsHedging, false);
  assert.equal((await autoHedgeAll(coarse, config)).totalProcessed, 0);
});

test('opening adoption preserves original time and basis; absent basis stays unknown', async () => {
  const e = exchange();
  const restored = await reconcilePendingIntent(e, initial('opening'), () => {});
  assert.equal(restored.position.openTime, original.openTime);
  assert.equal(restored.position.spotEntryPrice, 100);
  const adopted = await reconcilePendingIntent(e, { ...initial('opening'), position: null }, () => {});
  assert.equal(adopted.position.spotEntryPrice, null); assert.equal(adopted.position.accountingComplete, false);
});

test('leverage must be explicitly accepted before recovery adds perp exposure', async () => {
  const need = (await analyzeHedgeNeeds(exchange({}, {UBTC:1}))).hedgeNeeds[0];
  for (const response of [{status:'err',response:'denied'}, {}]) {
    const e = exchange({}, {UBTC:1}); e.leverageResponse = response;
    assert.equal((await createHedge(e, need, config)).success, false);
    assert.equal(e.calls.length, 0);
  }
  const e = exchange({}, {UBTC:1}); await createHedge(e, need, config);
  assert.deepEqual(e.updates[0], {type:'updateLeverage',asset:1,isCross:false,leverage:1});
});

test('partial hedge fallback closes only newly measured excess, not the whole original leg', async () => {
  const e = exchange({}, {UBTC:1});
  e.execution = c => ({ size: c.options.isSpot ? c.size : 0.5, price: 100 });
  const result = await autoHedgeAll(e, config, { fallbackToClose: true });
  assert.equal(result.success, true);
  assert.equal(e.calls[1].symbol, 'UBTC'); assert.equal(e.calls[1].size, 0.5);
  assert.equal(e.perps.BTC, -0.5); assert.equal(e.spots.UBTC, 0.5);
});

test('unknown hedge outcome is re-read and does not trigger a blind fallback', async () => {
  const e = exchange({}, {UBTC:1});
  e.execution = () => { e.perps.BTC = -1; return {error:Object.assign(new Error('timeout'),{isUnknownOrderOutcome:true})}; };
  const result = await autoHedgeAll(e, config, { fallbackToClose: true });
  assert.equal(result.success, false); assert.equal(result.postAnalysis.needsHedging, false);
  assert.equal(e.calls.length, 1);
});

test('partial-close VWAP and mixed fee reporting include every fill', async () => {
  const e = exchange(); let buys = 0;
  e.execution = c => c.options.isSpot ? {size:1,price:100,fee:0.1} : {size:0.5,price:++buys===1?100:104};
  const c = await closeDeltaNeutralPosition(e, original, { ...config, trading:{...config.trading,takerFeeRate:0.001} });
  assert.equal(c.pricePnl, -2); assert.equal(c.perpClosePrice, 102);
  assert.equal(c.feesActual, 0.1); assert.ok(Math.abs(c.feesEstimated - 0.102) < 1e-12);
  assert.ok(Math.abs(c.totalPnl + 2.202) < 1e-12);
  assert.equal(c.closeFills.perp.size, 1);
});

test('unknown close fills produce unavailable PnL, not a guessed exit price', async () => {
  const e = exchange(); e.execution = c => {
    if (!c.options.isSpot) { delete e.perps.BTC; return {error:new Error('lost acknowledgement')}; }
    return {size:1,price:100};
  };
  const result = await closeDeltaNeutralPosition(e, original, config);
  assert.equal(result.success, true); assert.equal(result.totalPnl, null);
});

test('fresh opening books reject changed spread or basis before sending either leg', async () => {
  const opportunity={symbol:'BTC',bidAsk:{perpMid:100,spotMid:100},funding:{fundingRate:0.00001},avgFundingRate:0.1};
  for (const bad of ['spread','basis']) {
    const e=exchange({},{});
    e.getFreshBidAsk=async coin => bad==='spread' ? {bid:99,ask:101,mid:100} :
      coin==='@1'?{bid:101.99,ask:102.01,mid:102}:{bid:99.99,ask:100.01,mid:100};
    await assert.rejects(openDeltaNeutralPosition(e, opportunity, {perpBalance:100,spotBalance:100}, config), /Fresh entry/);
    assert.equal(e.calls.length,0);
  }
});
