import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import HyperliquidConnector from '../../hyperliquid.js';
import { PaperConnector, walkBook, liquidationPx } from '../../utils/paper-exchange.js';
import { openDeltaNeutralPosition, closeDeltaNeutralPosition } from '../../utils/trade.js';

const HOUR = 3600000;
const MINUTE = 60000;

const config = {
  trading: { minOrderSizeUSD: { BTC: 20 }, balanceUtilizationPercent: 95, maxSlippagePercent: 5, takerFeeRate: 0.00045, spotTakerFeeRate: 0.0007 },
  risk: { minFillRatio: 0.999, maxHedgeMismatchPercent: 10 },
  bot: { maxBalanceImbalancePercent: 10 },
  paper: { startPerpUSDC: 500, startSpotUSDC: 500, transferDelayMinutes: 60 }
};

const dirs = [];
after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

// Public market data served by a fake fetch (BTC perp + UBTC spot "@142", book 99.9 / 100.1)
function makePaper(market = {}) {
  const m = {
    mids: { BTC: '100', '@142': '100' },
    book: { coin: 'BTC', levels: [[{ px: '99.9', sz: '10', n: 1 }], [{ px: '100.1', sz: '10', n: 1 }]] },
    candles: [],
    funding: [],
    requests: [],
    ...market
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    m.requests.push({ url, type: body.type });
    const data = {
      meta: { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] },
      spotMeta: {
        tokens: [{ name: 'USDC', index: 0, szDecimals: 8, weiDecimals: 8 }, { name: 'UBTC', index: 1, szDecimals: 5, weiDecimals: 10 }],
        universe: [{ name: '@142', tokens: [1, 0], index: 142 }]
      },
      allMids: m.mids,
      l2Book: m.book,
      candleSnapshot: m.candles,
      fundingHistory: m.funding
    }[body.type];
    if (data === undefined) throw new Error(`unexpected request ${body.type} to ${url}`);
    return { ok: true, status: 200, json: async () => data };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-'));
  dirs.push(dir);
  const paper = new PaperConnector(config, { dir, fetch });
  paper.restRateLimiter.waitForSlot = async () => {};
  return { paper, market: m, dir };
}

const events = dir => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('real open + close run through the paper exchange: flat afterwards, USDC = start - fees - spread', async () => {
  const { paper, market, dir } = makePaper();
  const opportunity = { symbol: 'BTC', bidAsk: { perpMid: 100, spotMid: 100 }, funding: { fundingRate: 0.0000125 }, avgFundingRate: 0.11 };

  const open = await openDeltaNeutralPosition(paper, opportunity, { perpBalance: 500, spotBalance: 500 }, config);
  assert.equal(open.success, true, open.error);
  assert.ok(paper.ledger.positions.BTC.szi < 0);
  assert.ok(paper.ledger.spotTokens.UBTC > 0);

  const close = await closeDeltaNeutralPosition(paper, { ...open, perpSymbol: 'BTC', spotSymbol: 'UBTC', openTime: Date.now() }, config);
  assert.equal(close.success, true, close.error);
  assert.deepEqual(paper.ledger.positions, {});

  const fills = events(dir).filter(e => e.type === 'fill');
  assert.equal(fills.length, 4);
  const costs = fills.reduce((s, f) => s + f.feeUSD + Math.abs(f.px - f.mid) * f.sz, 0);
  const dust = (paper.ledger.spotTokens.UBTC ?? 0) * 100;
  assert.ok(Math.abs(paper.ledger.perpUSDC + paper.ledger.spotUSDC + dust - (1000 - costs)) < 0.01);
  assert.ok(!market.requests.some(r => r.url.includes('/exchange')), 'nothing may reach the real exchange');
});

test('walkBook fills level by level up to the limit; exchange order checks; responses carry no fee field (like live)', async () => {
  const asks = [{ px: '100', sz: '1' }, { px: '101', sz: '1' }, { px: '103', sz: '5' }];
  const partial = walkBook([[], asks], true, 102, 3);
  assert.equal(partial.filled, 2);
  assert.equal(partial.avgPx, 100.5);
  assert.equal(walkBook([[], asks], true, 99, 1).filled, 0);

  const { paper } = makePaper();
  const ok = await paper.fillOrder({ a: 0, b: false, p: '95', s: '1', r: false });
  assert.deepEqual(Object.keys(ok.filled).sort(), ['avgPx', 'oid', 'totalSz']);
  const none = await paper.fillOrder({ a: 0, b: true, p: '99', s: '1', r: false });
  assert.match(none.error, /could not immediately match/);

  // Rejected like the exchange (BTC szDecimals 5: perp price <= 1 decimal; UBTC spot "@142" = asset 10142)
  assert.match((await paper.fillOrder({ a: 0, b: false, p: '95', s: '1.000001', r: false })).error, /invalid size/);
  assert.match((await paper.fillOrder({ a: 0, b: false, p: '95.05', s: '1', r: false })).error, /invalid price/);
  assert.match((await paper.fillOrder({ a: 0, b: false, p: '95', s: '0.05', r: false })).error, /minimum value of \$10/);
  assert.match((await paper.fillOrder({ a: 10142, b: false, p: '95', s: '1', r: true })).error, /Reduce only/);
  assert.equal(paper.ledger.nextOid, 2);  // only the first order filled
});

test('funding: a short is paid at the hour it was held, even if closed right after; replay after restart pays once', async () => {
  const { paper, market, dir } = makePaper();
  const h = Math.floor(Date.now() / HOUR) + 10;
  paper.mutate(L => { L.positions.BTC = { szi: -2, entryPx: 100, margin: 200, leverage: 1 }; L.perpUSDC -= 200; }, h * HOUR - 30 * MINUTE);
  paper.mutate(L => { delete L.positions.BTC; L.perpUSDC += 200; }, h * HOUR + 30000);  // closed 30 s after the hour

  market.funding = [{ coin: 'BTC', fundingRate: '0.0001', premium: '0', time: h * HOUR + 40 }];
  market.candles = [{ t: (h - 1) * HOUR, c: '100', h: '100', l: '100' }];
  await paper.resolveFunding(h * HOUR + 2 * MINUTE);
  assert.ok(Math.abs(paper.ledger.perpUSDC - (500 + 2 * 100 * 0.0001)) < 1e-12);

  const reloaded = new PaperConnector(config, { dir, fetch: paper.fetch });
  await reloaded.resolveFunding(h * HOUR + 5 * MINUTE);
  reloaded.mutate(null, (h + 1) * HOUR + MINUTE);
  assert.equal(reloaded.ledger.perpUSDC, paper.ledger.perpUSDC);
  assert.equal(events(dir).filter(e => e.type === 'funding').length, 1);
  assert.deepEqual(reloaded.ledger.pendingFunding, []);
});

test('outage liquidation: a candle high above the 1x short liquidation price removes the position before later funding', async () => {
  const { paper, market } = makePaper();
  const h = Math.floor(Date.now() / HOUR) + 10;
  const pos = { szi: -1, entryPx: 100, margin: 100, leverage: 1 };
  const liq = liquidationPx(pos, 40);
  assert.ok(Math.abs(liq - 200 / (1 + 1 / 80)) < 1e-9);  // 2 entry / (1 + mmr)

  paper.mutate(L => { L.positions.BTC = { ...pos }; L.perpUSDC -= 100; L.lastLiqCheck = h * HOUR + 5 * MINUTE; }, h * HOUR + 5 * MINUTE);
  market.candles = [
    { t: h * HOUR + 15 * MINUTE, h: '150', l: '100', c: '150' },
    { t: h * HOUR + 30 * MINUTE, h: String(liq + 1), l: '150', c: '190' }
  ];
  await paper.scanLiquidations((h + 3) * HOUR);

  assert.deepEqual(paper.ledger.positions, {});
  assert.equal(paper.ledger.perpUSDC, 400);  // the whole isolated margin is lost
  assert.ok(paper.ledger.pendingFunding.every(f => f.hour <= h));
});

test('simulated manual transfer: does what rebalance-status.json asks, one at a time; lands after the delay, counts in equity', () => {
  const { paper, dir } = makePaper();
  const mids = { BTC: '100', '@142': '100' };
  const now = Date.now();
  const ask = (direction, amountUSDC, updated = now) => fs.writeFileSync(path.join(dir, 'rebalance-status.json'),
    JSON.stringify({ rebalanceNeeded: !!direction, direction, amountUSDC, updated: new Date(updated).toISOString() }));

  paper.mutate(L => { L.perpUSDC = 400; L.spotUSDC = 600; });
  assert.deepEqual(paper.mutate(L => paper.operator(L, now)), []);  // no request file yet
  ask(null, 0);
  assert.deepEqual(paper.mutate(L => paper.operator(L, now)), []);  // status OK

  ask('SPOT_TO_PERP', 100);
  const started = paper.mutate(L => paper.operator(L, now));
  assert.equal(started[0].amount, 100);
  assert.equal(paper.ledger.spotUSDC, 500);
  assert.equal(paper.ledger.perpUSDC, 400);                      // in transit: bot still sees 400 / 500 and holds
  assert.equal(paper.equity(mids).equity, 1000);                  // no fake drawdown
  assert.deepEqual(paper.mutate(L => paper.operator(L, now)), []);  // one transfer at a time

  paper.mutate(L => paper.landTransfers(L, now + 59 * MINUTE));
  assert.equal(paper.ledger.perpUSDC, 400);
  paper.mutate(L => paper.landTransfers(L, now + 60 * MINUTE));
  assert.equal(paper.ledger.perpUSDC, 500);
  assert.deepEqual(paper.mutate(L => paper.operator(L, now + 60 * MINUTE)), []);  // request older than the landing: stale

  paper.mutate(L => { L.spotUSDC = 50; });
  ask('SPOT_TO_PERP', 100, now + 61 * MINUTE);                    // a new request, more than the source holds
  assert.equal(paper.mutate(L => paper.operator(L, now + 61 * MINUTE))[0].amount, 50);
});

test('WebSocket reconnects call connect() again: the paper ticker is not duplicated', async () => {
  const { paper } = makePaper();
  const connect = HyperliquidConnector.prototype.connect;
  HyperliquidConnector.prototype.connect = async () => {};
  paper.tick = async () => {};
  try {
    await paper.connect();
    const ticker = paper.ticker;
    await paper.connect();  // what handleReconnect / the REST-fallback probe do
    assert.equal(paper.ticker, ticker);
  } finally {
    HyperliquidConnector.prototype.connect = connect;
    paper.disconnect();
  }
  assert.equal(paper.ticker, null);
});

test('safety: WebSocket orders go to the simulator, user queries fail closed, no credentials are loaded', async () => {
  const { paper, market } = makePaper();
  assert.equal(paper.exchangeUrl, 'paper://exchange');
  assert.equal(paper.vaultAddress, null);
  assert.notEqual(paper.wallet, makePaper().paper.wallet);  // fresh random key, not hyperliquid.env

  paper.connected = true;
  paper.ws = { send: () => { throw new Error('paper orders must not use the WebSocket'); } };
  const result = await paper.createMarketOrder('BTC', 'sell', 0.5, { overrideMidPrice: 100 });
  assert.ok(result.response.data.statuses[0].filled);

  await assert.rejects(() => paper.infoRequest({ type: 'userFills', user: paper.wallet }), /not simulated/);
  assert.ok(!market.requests.some(r => r.url.includes('/exchange')));
});
