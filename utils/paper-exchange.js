/**
 * Paper trading: a simulated Hyperliquid account behind the real connector (PAPER_TRADING=1).
 *
 * The bot code runs unchanged (bot.js, trade.js, hedge.js, positions.js, order construction, rounding, min notional,
 * IOC limit price, signing). Only the exchange's ACCOUNT and EXECUTION side is simulated; market data is live.
 *
 * What is simulated, and how:
 *  - Orders: every signed request goes through fetchJsonWithTimeout(exchangeUrl) (WebSocket orders are routed to REST).
 *    Rejected like the exchange when the size has more than szDecimals decimals, the price more than 5 significant
 *    figures (integers exempt) or (6 perp | 8 spot) - szDecimals decimals, size x mid < $10, or reduceOnly on spot.
 *    IOC fill = walk the live L2 book (full precision) up to the order's limit price; level-by-level VWAP, partial fills
 *    possible; unfilled rest cancelled. Response shape as the exchange: {filled: {totalSz, avgPx, oid}} (no fee field,
 *    like live) or {error}.
 *  - Fees (config trading.takerFeeRate / spotTakerFeeRate): perp in USDC; spot taken from the RECEIVED asset
 *    (token on buy, USDC on sell). Token balances are truncated to the token's weiDecimals.
 *  - Isolated perp margin: margin = notional / leverage, moved out of free (withdrawable) USDC.
 *    Liquidation when equity(P) = margin + szi (P - entry) <= mmr |szi| P, mmr = 1 / (2 maxLeverage)
 *    => liqPx = (side entry - margin / |szi|) / (side - mmr)  (short at 1x: 2 entry / (1 + mmr)). The whole isolated
 *    margin is lost. Checked on 15m candle highs/lows (trade prices; the exchange uses mark: slightly conservative).
 *  - Funding: every hour boundary crossed while a position is open is recorded with the position held AT that hour
 *    (all ledger changes go through mutate()). Payment = -szi x px x rate, rate = realized fundingHistory rate,
 *    px = close of the 1h candle ending at that hour (oracle-price proxy). Credited to the isolated margin, not
 *    withdrawable (verified live 2026-09-27: PUMP rawUsd +0.001858 = the userFunding row, withdrawable unchanged).
 *  - Outages / PC off: the exchange keeps paying funding and can liquidate. On restart the missed hours are replayed
 *    from public history (funding exactly once: marker and credits are written in the same atomic ledger write), and
 *    liquidation is scanned first, before any bot order is simulated or account state is served.
 *  - Manual PERP<->SPOT transfer (the live API key cannot transfer): a simulated human reads the bot's request in
 *    rebalance-status.json, the file a live user reads, and makes that transfer, one at a time. The operator acts
 *    after paper.transferDelayMinutes, then debit and credit happen atomically. Until then both
 *    balances stay unchanged and the bot stays on hold. Older, already-debited transfers still settle once.
 *
 * Known limitations: own orders do not move the book; oracle price proxied by candles; whether spot buys are checked
 * at the limit price is unverified (logged as `would_reject_strict` instead of rejecting); whether the $10 minimum uses
 * mid or limit price is unverified (mid, the bot's own rule); funding still pending when an outage liquidation is
 * replayed goes to free USDC, not the lost margin (a few hours of funding, slightly optimistic).
 *
 * Files (next to the bot state, ./data-paper by default): paper-ledger.json (account, atomic writes; a corrupt file
 * throws, it is never reset) and events.jsonl (append-only log read by paper_stats.py).
 */
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import HyperliquidConnector from '../hyperliquid.js';
import { getStateFilePath, writeJsonAtomic } from './state.js';
import { getTakerFees } from './risk.js';
import { MIN_NOTIONAL_USD } from './positions.js';

const HOUR = 3600000;
const MINUTE = 60000;
const USDC_DECIMALS = 8;

const truncate = (x, decimals) => Math.floor(x * 10 ** decimals + 1e-9) / 10 ** decimals;

/** IOC taker fill against book levels [[bids], [asks]] ({px, sz} strings) up to limitPx. */
export function walkBook(levels, isBuy, limitPx, size) {
  let filled = 0;
  let notional = 0;
  for (const level of levels[isBuy ? 1 : 0] || []) {
    const px = parseFloat(level.px);
    if (isBuy ? px > limitPx : px < limitPx) break;
    const take = Math.min(parseFloat(level.sz), size - filled);
    filled += take;
    notional += take * px;
    if (filled >= size - 1e-12) break;
  }
  return { filled, avgPx: filled > 0 ? notional / filled : 0 };
}

/**
 * Apply a signed perp fill to an isolated position {szi, entryPx, margin, leverage} (null = flat).
 * @returns {{pos, realizedPnl, marginDelta}} marginDelta = USDC moved from free balance into margin (< 0: released)
 */
export function applyPerpFill(pos, signedSz, px, leverage) {
  const szi = pos?.szi ?? 0;
  if (szi === 0 || Math.sign(szi) === Math.sign(signedSz)) {
    const newSzi = szi + signedSz;
    const entryPx = (Math.abs(szi) * (pos?.entryPx ?? 0) + Math.abs(signedSz) * px) / Math.abs(newSzi);
    const addMargin = Math.abs(signedSz) * px / leverage;
    return { pos: { szi: newSzi, entryPx, margin: (pos?.margin ?? 0) + addMargin, leverage }, realizedPnl: 0, marginDelta: addMargin };
  }

  const closeSz = Math.min(Math.abs(signedSz), Math.abs(szi));
  const realizedPnl = closeSz * (px - pos.entryPx) * Math.sign(szi);
  const released = pos.margin * closeSz / Math.abs(szi);
  const rest = szi - Math.sign(szi) * closeSz;
  const remaining = Math.abs(rest) < 1e-12 ? null : { ...pos, szi: rest, margin: pos.margin - released };
  const flipSz = Math.abs(signedSz) - closeSz;
  if (flipSz <= 1e-12) {
    return { pos: remaining, realizedPnl, marginDelta: -released };
  }
  const opened = applyPerpFill(null, Math.sign(signedSz) * flipSz, px, leverage);
  return { pos: opened.pos, realizedPnl, marginDelta: opened.marginDelta - released };
}

/**
 * Exchange-side order checks (see header), so a rounding or sizing regression fails in paper as it would live.
 * @param {{p: string, s: string, r: boolean}} o - signed order wire fields; asset from decodeAsset
 * @returns {string|null} exchange-style error, or null if the order is valid
 */
export function orderError(o, asset, mid) {
  const decimals = x => (x.split('.')[1] ?? '').length;
  const sigFigs = o.p.replace('.', '').replace(/^0+/, '').length;
  if (!(+o.s > 0) || decimals(o.s) > asset.szDecimals) return 'Order has invalid size.';
  if (!(+o.p > 0) || decimals(o.p) > (asset.isSpot ? 8 : 6) - asset.szDecimals || (o.p.includes('.') && sigFigs > 5)) {
    return 'Order has invalid price.';
  }
  if (asset.isSpot && o.r) return 'Reduce only order is not supported for spot.';
  if (+o.s * mid < MIN_NOTIONAL_USD) return `Order must have minimum value of $${MIN_NOTIONAL_USD}.`;
  return null;
}

/** Isolated liquidation price: solves margin + szi (P - entry) = mmr |szi| P, mmr = 1 / (2 maxLeverage). */
export function liquidationPx(pos, maxLeverage) {
  const mmr = 1 / (2 * maxLeverage);
  const side = Math.sign(pos.szi);
  return (side * pos.entryPx - pos.margin / Math.abs(pos.szi)) / (side - mmr);
}

export function newLedger(config, now = Date.now()) {
  return {
    version: 1,
    createdAt: now,
    perpUSDC: config.paper?.startPerpUSDC ?? 500,   // free (withdrawable) perp USDC
    spotUSDC: config.paper?.startSpotUSDC ?? 500,
    spotTokens: {},                                   // token name -> amount
    positions: {},                                    // perp coin -> {szi, entryPx, margin, leverage}
    leverage: {},                                     // perp coin -> {type, value}
    transfers: [],                                    // {amount, to, startedAt, eta, debited:false}; absent flag = legacy in transit
    lastBoundaryHour: Math.floor(now / HOUR),
    pendingFunding: [],                               // {hour, coin, szi} awaiting the published rate
    funding: [],                                      // paid rows, served as userFunding (last 90 days kept)
    lastLiqCheck: now,
    nextOid: 1
  };
}

export class PaperConnector extends HyperliquidConnector {
  constructor(config, options = {}) {
    // Ephemeral key with no Hyperliquid account: hyperliquid.env is never read, and a signature that somehow leaked
    // would be rejected. exchangeUrl is not http, so nothing can reach the real /exchange endpoint.
    const key = ethers.Wallet.createRandom();
    super({ ...options, wallet: key.address, privateKey: key.privateKey, vaultAddress: null });
    this.exchangeUrl = 'paper://exchange';
    // A third of the per-IP 1200 weight/min budget. A live bot on the same host has its own 1200 limiter, so together
    // they can exceed the budget; 429s are retried with backoff.
    this.restRateLimiter.maxRequests = 400;

    this.fees = getTakerFees(config);
    this.transferDelayMs = (config.paper?.transferDelayMinutes ?? 60) * MINUTE;
    const dir = options.dir ?? path.dirname(getStateFilePath());
    this.ledgerFile = path.join(dir, 'paper-ledger.json');
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.statusFile = path.join(dir, 'rebalance-status.json');  // written by bot.js checkRebalance

    if (fs.existsSync(this.ledgerFile)) {
      this.ledger = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));  // corrupt -> throw, never reset capital
    } else {
      this.ledger = newLedger(config);
      writeJsonAtomic(this.ledgerFile, this.ledger);
      this.event({ type: 'start', perpUSDC: this.ledger.perpUSDC, spotUSDC: this.ledger.spotUSDC,
        fees: this.fees, transferDelayMinutes: this.transferDelayMs / MINUTE });
    }
    this.lastCatchUp = 0;
    this.lastEquityAt = 0;
  }

  // ---------------------------------------------------------------- persistence

  event(obj) {
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true });
    fs.appendFileSync(this.eventsFile, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
  }

  /** The only way to change the ledger: record positions at every hour boundary up to `at`, apply fn, save. */
  mutate(fn, at = Date.now()) {
    const L = this.ledger;
    for (let hour = L.lastBoundaryHour + 1; hour <= Math.floor(at / HOUR); hour++) {
      for (const [coin, p] of Object.entries(L.positions)) {
        L.pendingFunding.push({ hour, coin, szi: p.szi });
      }
      L.lastBoundaryHour = hour;
    }
    const result = fn ? fn(L) : undefined;
    writeJsonAtomic(this.ledgerFile, L);
    return result;
  }

  // ---------------------------------------------------------------- lifecycle

  async connect() {
    await super.connect();
    this.ticker ??= setInterval(() => this.tick(), MINUTE);  // WebSocket reconnects call connect() again: one ticker
    await this.tick();
  }

  disconnect() {
    clearInterval(this.ticker);
    this.ticker = null;
    super.disconnect();
  }

  /** Every minute; never throws. Replays funding/liquidations, lands transfers, plays the operator, logs equity. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.loadMeta();
      const now = Date.now();
      const fundingDue = this.ledger.pendingFunding.some(f => f.hour * HOUR <= now - 30000);
      if (fundingDue || now - this.lastCatchUp >= 5 * MINUTE || Math.floor(now / HOUR) > this.ledger.lastBoundaryHour) {
        await this.ensureCaughtUp(true);
      }
      const mids = await this.getAllMids();
      const events = this.mutate(L => [...this.landTransfers(L, now), ...this.operator(L, now)]);
      events.forEach(e => this.event(e));
      if (now - this.lastEquityAt >= 15 * MINUTE) {
        this.lastEquityAt = now;
        this.event({ type: 'equity', ...this.equity(mids) });
      }
    } catch (error) {
      console.error(`[Paper] tick error (will retry): ${error.message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Liquidation scan first, then funding: one shared run; orders and account reads wait for it. */
  ensureCaughtUp(force = false) {
    if (!force && Date.now() - this.lastCatchUp < MINUTE) {
      return this.catchUpPromise ?? Promise.resolve();
    }
    this.catchUpPromise ??= (async () => {
      await this.loadMeta();
      await this.scanLiquidations();
      await this.resolveFunding();
      this.lastCatchUp = Date.now();
    })().finally(() => { this.catchUpPromise = null; });
    return this.catchUpPromise;
  }

  // ---------------------------------------------------------------- exchange-side processes

  async scanLiquidations(now = Date.now()) {
    await this.loadMeta();
    const L = this.ledger;
    for (const [coin, p] of Object.entries(L.positions)) {
      const liqPx = liquidationPx(p, this.assetMeta(coin).maxLeverage);
      // 5000 candles per call = 52 days of 15m candles; loop for longer outages. The candle straddling the last
      // check is included (it may hold the extreme).
      const chunk = 5000 * 15 * MINUTE;
      for (let start = L.lastLiqCheck - 15 * MINUTE; start < now; start += chunk) {
        const candles = await this.infoRequest({ type: 'candleSnapshot', req: { coin, interval: '15m', startTime: start, endTime: Math.min(start + chunk, now) } }, 20);
        const hit = candles.find(c => c.t + 15 * MINUTE > L.lastLiqCheck && (p.szi < 0 ? +c.h >= liqPx : +c.l <= liqPx));
        if (hit) {
          this.mutate(led => { delete led.positions[coin]; }, hit.t);
          this.event({ type: 'liquidation', coin, szi: p.szi, entryPx: p.entryPx, liqPx, pnl: -p.margin, at: hit.t });
          console.error(`[Paper] 💥 ${coin} isolated position LIQUIDATED at ~${liqPx.toFixed(4)} (margin $${p.margin.toFixed(2)} lost)`);
          break;
        }
      }
    }
    this.mutate(led => { led.lastLiqCheck = now; });
  }

  async resolveFunding(now = Date.now()) {
    const due = this.ledger.pendingFunding.filter(f => f.hour * HOUR <= now - 30000);
    for (const coin of new Set(due.map(f => f.coin))) {
      const hours = due.filter(f => f.coin === coin).map(f => f.hour);
      const from = (Math.min(...hours) - 1) * HOUR;
      const to = (Math.max(...hours) + 1) * HOUR;
      const rates = new Map();
      for (let start = from; ;) {  // 500 rows per call
        const page = await this.infoRequest({ type: 'fundingHistory', coin, startTime: start, endTime: to }, 20);
        page.forEach(r => rates.set(Math.floor(r.time / HOUR), parseFloat(r.fundingRate)));
        if (page.length < 500) break;
        start = page[page.length - 1].time + 1;
      }
      const candles = await this.infoRequest({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: from - HOUR, endTime: to } }, 20);
      const closeAt = new Map(candles.map(c => [Math.round((c.t + HOUR) / HOUR), parseFloat(c.c)]));

      const events = this.mutate(L => {
        const out = [];
        L.pendingFunding = L.pendingFunding.filter(f => {
          if (f.coin !== coin || !hours.includes(f.hour)) return true;
          const rate = rates.get(f.hour);
          const px = closeAt.get(f.hour);
          if (rate === undefined || px === undefined) {
            if (now - f.hour * HOUR < 3 * HOUR) return true;  // not published yet: retry later
            out.push({ type: 'funding_missing', coin, hour: f.hour });
            return false;
          }
          const usdc = -f.szi * px * rate;
          if (L.positions[coin]) L.positions[coin].margin += usdc;  // isolated funding lands in margin (verified live)
          else L.perpUSDC += usdc;                                  // position closed since that hour
          L.funding.push({ time: f.hour * HOUR, coin, usdc, szi: f.szi, fundingRate: rate });
          out.push({ type: 'funding', coin, hour: f.hour, rate, px, szi: f.szi, usdc });
          return false;
        });
        // The bot only reads the held position's rows (since its open): keep those however old, prune the rest at 90 days
        L.funding = L.funding.filter(r => r.time >= now - 90 * 24 * HOUR || L.positions[r.coin]);
        return out;
      });
      events.forEach(e => this.event(e));
    }
  }

  landTransfers(L, now) {
    const landed = L.transfers.filter(t => t.eta <= now);
    L.transfers = L.transfers.filter(t => t.eta > now);
    for (const t of landed) {
      if (t.debited === false) {
        const source = t.to === 'perp' ? 'spotUSDC' : 'perpUSDC';
        t.amount = Math.max(0, Math.min(t.amount, L[source]));
        L[source] -= t.amount;
      }
      if (t.to === 'perp') L.perpUSDC += t.amount; else L.spotUSDC += t.amount;
      L.lastTransferLanded = now;
    }
    return landed.map(t => ({ type: 'transfer_done', amount: t.amount, to: t.to, startedAt: t.startedAt }));
  }

  /**
   * Simulated human: makes the transfer the bot asks for in rebalance-status.json, one at a time. A request written
   * before the last transfer landed is stale (the bot re-checks within 2 minutes and writes a new one or OK).
   */
  operator(L, now) {
    let ask;
    try {
      ask = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
    } catch {
      return [];  // no request yet (or being written)
    }
    if (!ask.rebalanceNeeded || L.transfers.length || !(Date.parse(ask.updated) > (L.lastTransferLanded ?? 0))) return [];

    const to = ask.direction === 'PERP_TO_SPOT' ? 'spot' : 'perp';
    const amount = truncate(Math.min(ask.amountUSDC, to === 'spot' ? L.perpUSDC : L.spotUSDC), USDC_DECIMALS);
    if (!(amount > 0)) return [];
    L.transfers.push({ amount, to, startedAt: now, eta: now + this.transferDelayMs, debited: false });
    console.log(`[Paper] Simulated operator will transfer ${amount.toFixed(2)} USDC to ${to.toUpperCase()} in ${this.transferDelayMs / MINUTE} min`);
    return [{ type: 'transfer_start', amount, to, eta: now + this.transferDelayMs }];
  }

  equity(mids) {
    const L = this.ledger;
    let perp = L.perpUSDC;
    const positions = {};
    for (const [coin, p] of Object.entries(L.positions)) {
      const mark = +mids[coin] || p.entryPx;
      perp += p.margin + p.szi * (mark - p.entryPx);
      positions[coin] = { szi: p.szi, entryPx: p.entryPx, mark, margin: p.margin };
    }
    let spot = L.spotUSDC;
    const tokens = {};
    for (const [token, amt] of Object.entries(L.spotTokens)) {
      const mid = +mids[this.spotBookCoin(token)] || 0;
      spot += amt * mid;
      tokens[token] = { amount: amt, mid };
    }
    const transit = L.transfers.filter(t => t.debited !== false).reduce((s, t) => s + t.amount, 0);
    return { equity: perp + spot + transit, perp, spot, transit,
      pendingOperatorTransfer: L.transfers.some(t => t.debited === false),
      perpUSDC: L.perpUSDC, spotUSDC: L.spotUSDC, positions, tokens };
  }

  // ---------------------------------------------------------------- simulated exchange endpoints

  async createOrderWebSocket(...args) {
    return this.createOrderRest(...args);  // paper orders never touch the WebSocket
  }

  async fetchJsonWithTimeout(url, init, options) {
    if (url !== this.exchangeUrl) {
      return super.fetchJsonWithTimeout(url, init, options);
    }
    return this.simulateExchange(JSON.parse(init.body));
  }

  async simulateExchange({ action }) {
    await this.ensureCaughtUp(true);
    if (action.type === 'updateLeverage') {
      const { coin } = await this.decodeAsset(action.asset);
      this.mutate(L => { L.leverage[coin] = { type: action.isCross ? 'cross' : 'isolated', value: action.leverage }; });
      this.event({ type: 'leverage', coin, leverage: action.leverage, isCross: action.isCross });
      return { status: 'ok', response: { type: 'default' } };
    }
    if (action.type !== 'order') {
      return { status: 'err', response: `[Paper] action ${action.type} is not simulated` };
    }
    const statuses = [];
    for (const order of action.orders) {
      statuses.push(await this.fillOrder(order));
    }
    return { status: 'ok', response: { type: 'order', data: { statuses } } };
  }

  async fillOrder(o) {
    const asset = await this.decodeAsset(o.a);
    const book = await this.requestL2BookRest(asset.bookCoin, { nSigFigs: null });
    const [bids, asks] = book.levels;
    const isBuy = o.b;
    const limitPx = parseFloat(o.p);
    const bookMid = (parseFloat(bids[0]?.px) + parseFloat(asks[0]?.px)) / 2;  // NaN if one side is empty
    let size = parseFloat(o.s);
    const reject = reason => {
      this.event({ type: 'reject', coin: asset.coin, market: asset.isSpot ? 'spot' : 'perp', side: isBuy ? 'buy' : 'sell', sz: size, reason });
      return { error: `${reason} asset=${o.a}` };
    };

    const invalid = orderError(o, asset, Number.isFinite(bookMid) ? bookMid : limitPx);
    if (invalid) return reject(invalid);

    if (!asset.isSpot && o.r) {
      const pos = this.ledger.positions[asset.coin];
      if (!pos || Math.sign(pos.szi) === (isBuy ? 1 : -1)) return reject('Reduce only order would increase position.');
      size = Math.min(size, Math.abs(pos.szi));
    }

    const { filled, avgPx } = walkBook(book.levels, isBuy, limitPx, size);
    if (filled <= 0) return reject('Order could not immediately match against any resting orders.');
    const notional = filled * avgPx;

    // Everything below is synchronous: check and apply atomically (parallel PERP/SPOT orders interleave only above).
    const mid = Number.isFinite(bookMid) ? bookMid : avgPx;
    const fill = { type: 'fill', market: asset.isSpot ? 'spot' : 'perp', coin: asset.coin, side: isBuy ? 'buy' : 'sell', sz: filled, px: avgPx, mid };
    const apply = L => {
      if (!asset.isSpot) {
        const fee = notional * this.fees.perp;
        const lev = L.leverage[asset.coin]?.value ?? 1;  // the bot always sets 1x before opening
        const r = applyPerpFill(L.positions[asset.coin], isBuy ? filled : -filled, avgPx, lev);
        const freeDelta = -r.marginDelta + r.realizedPnl - fee;
        if (L.perpUSDC + freeDelta < -1e-9) return 'Insufficient margin to place order.';
        L.perpUSDC += freeDelta;
        if (r.pos) L.positions[asset.coin] = r.pos; else delete L.positions[asset.coin];
        Object.assign(fill, { feeUSD: fee, realizedPnl: r.realizedPnl });
        return null;
      }
      const held = L.spotTokens[asset.coin] ?? 0;
      if (isBuy) {
        if (notional > L.spotUSDC + 1e-9) return 'Insufficient spot balance.';
        if (size * limitPx > L.spotUSDC) {
          this.event({ type: 'would_reject_strict', coin: asset.coin, sz: size, limitPx, spotUSDC: L.spotUSDC });
        }
        L.spotUSDC -= notional;
        L.spotTokens[asset.coin] = truncate(held + filled * (1 - this.fees.spot), asset.weiDecimals);
        Object.assign(fill, { feeUSD: notional * this.fees.spot, feeToken: filled * this.fees.spot, cashFlow: -notional });
      } else {
        if (filled > held + 1e-12) return 'Insufficient spot balance.';
        const proceeds = truncate(notional * (1 - this.fees.spot), USDC_DECIMALS);
        L.spotTokens[asset.coin] = truncate(held - filled, asset.weiDecimals);
        if (L.spotTokens[asset.coin] <= 0) delete L.spotTokens[asset.coin];
        L.spotUSDC += proceeds;
        Object.assign(fill, { feeUSD: notional * this.fees.spot, cashFlow: proceeds });
      }
      return null;
    };
    const error = this.mutate(L => {
      const err = apply(L);
      if (!err) fill.oid = L.nextOid++;
      return err;
    });
    if (error) return reject(error);

    this.event(fill);
    return { filled: { totalSz: filled.toFixed(asset.szDecimals), avgPx: String(Number(avgPx.toPrecision(8))), oid: fill.oid } };
  }

  // ---------------------------------------------------------------- simulated account reads

  async infoRequest(payload, weight) {
    if (payload.type === 'clearinghouseState') return this.perpState();
    if (payload.type === 'spotClearinghouseState') return this.spotState();
    if (payload.type === 'userFunding') {
      return this.ledger.funding
        .filter(r => r.time >= (payload.startTime ?? 0) && r.time <= (payload.endTime ?? Infinity))
        .sort((a, b) => a.time - b.time)
        .slice(0, 500)  // API page size
        .map(r => ({ time: r.time, hash: '0x0', delta: { type: 'funding', coin: r.coin, usdc: String(r.usdc), szi: String(r.szi), fundingRate: String(r.fundingRate), nSamples: null } }));
    }
    if (payload.user) {
      throw new Error(`[Paper] user query "${payload.type}" is not simulated`);  // fail closed, never ask mainnet
    }
    return super.infoRequest(payload, weight);
  }

  async perpState() {
    await this.ensureCaughtUp();
    const mids = await this.getAllMids();
    const L = this.ledger;
    let accountValue = L.perpUSDC;
    let ntl = 0;
    let marginUsed = 0;
    const assetPositions = Object.entries(L.positions).map(([coin, p]) => {
      const mark = +mids[coin] || p.entryPx;
      const upnl = p.szi * (mark - p.entryPx);
      const { maxLeverage } = this.assetMeta(coin);
      accountValue += p.margin + upnl;
      ntl += Math.abs(p.szi) * mark;
      marginUsed += p.margin + upnl;
      return {
        type: 'oneWay',
        position: {
          coin, szi: String(p.szi), entryPx: String(p.entryPx), positionValue: String(Math.abs(p.szi) * mark),
          unrealizedPnl: String(upnl), returnOnEquity: String(upnl / p.margin),
          liquidationPx: String(liquidationPx(p, maxLeverage)), marginUsed: String(p.margin + upnl), maxLeverage,
          leverage: { type: 'isolated', value: p.leverage, rawUsd: String(p.margin - p.szi * p.entryPx) }
        }
      };
    });
    const summary = { accountValue: String(accountValue), totalNtlPos: String(ntl), totalRawUsd: String(L.perpUSDC), totalMarginUsed: String(marginUsed) };
    return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0', withdrawable: String(L.perpUSDC), assetPositions, time: Date.now() };
  }

  async spotState() {
    await this.ensureCaughtUp();
    await this.loadMeta();
    const L = this.ledger;
    const tokens = Object.entries(L.spotTokens).filter(([, amt]) => amt > 0).map(([coin, amt]) => ({
      coin, token: this.spotMetaCache.tokens.find(t => t.name === coin)?.index, total: String(amt), hold: '0.0', entryNtl: '0.0'
    }));
    return { balances: [{ coin: 'USDC', token: 0, total: String(L.spotUSDC), hold: '0.0', entryNtl: '0.0' }, ...tokens] };
  }

  // ---------------------------------------------------------------- asset mapping (from the cached exchange meta)

  /** Perp + spot meta caches (asset ids, decimals, max leverage); loaded once by the base connector. */
  async loadMeta() {
    if (!this.metaCache || !this.spotMetaCache) await this.getAssetId('BTC');
  }

  async decodeAsset(a) {
    await this.loadMeta();
    if (a < 10000) {
      const u = this.metaCache.universe[a];
      return { coin: u.name, bookCoin: u.name, isSpot: false, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage };
    }
    const pair = this.spotMetaCache.universe.find(u => u.index === a - 10000);
    const token = this.spotMetaCache.tokens.find(t => t.index === pair.tokens[0]);
    return { coin: token.name, bookCoin: pair.name, isSpot: true, szDecimals: token.szDecimals, weiDecimals: token.weiDecimals };
  }

  assetMeta(coin) {
    return this.metaCache.universe.find(u => u.name === coin);
  }

  spotBookCoin(token) {
    const t = this.spotMetaCache.tokens.find(x => x.name === token);
    return this.spotMetaCache.universe.find(u => u.tokens[0] === t?.index && u.tokens[1] === 0)?.name;
  }
}
