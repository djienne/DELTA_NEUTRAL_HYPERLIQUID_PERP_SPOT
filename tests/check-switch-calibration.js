import fs from 'fs';
import zlib from 'zlib';
import { switchEdge } from '../utils/position-decision.js';
import { getTakerFees } from '../utils/risk.js';

/**
 * Re-estimate the switch-rule parameters from public Hyperliquid funding history (read-only, no wallet).
 *
 * 1. beta(14d): regression slope of the realized 14-day funding gap (best coin vs each other coin) on
 *    today's 7d-average gap, in days. This is the physical "how much of a gap is actually earned"
 *    horizon -> config.bot.switchHorizonDays. Stable across halves = trustworthy.
 * 2. Replays the production decision (utils/position-decision.js switchEdge) hour by hour and reports
 *    net APY after fees for each half, against the old rule and against never switching. Each half is the mean
 *    [min..max] of STARTS replays started a day apart: the first pick alone moves a half by up to ~35 points.
 *    Pick parameters on the flat part of the scans, not the peak: each half has only ~5-30 switches.
 * Assumptions: realized hourly funding stands in for the rate the bot sees; spreads are a fixed
 * SPREAD_PCT; volume/spread filters are ignored (all configured pairs always eligible).
 *
 * Usage: node tests/check-switch-calibration.js [days=730]
 * In Docker, use the bot's image and mount only tests/, config.json and data/ (a VOLUME in the image: unmounted, the
 * cache vanishes with --rm); mounting the whole repo loads node_modules over the slow Windows bind mount (+5 s).
 */

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const COINS = config.trading.pairs;
const DAYS = Number(process.argv[2] || 730);
const D = 24, W = 7 * D, YEAR = 8760;
const MIN_APY = (config.thresholds?.minFundingRatePercent ?? 5) / 100;
const SPREAD_PCT = 0.05;  // perp + spot bid-ask spread, percent (typical for the filtered pairs)
const fees = getTakerFees(config);
const LEG = fees.perp + fees.spot, SPREAD = SPREAD_PCT / 100;

// Per coin {from: ms covered since, to: ms fetched up to, rows: [[hour, rate]]}, Brotli JSON (fast to decode).
// Reruns only fetch the hours since `to`; delete the file to rebuild it.
const CACHE = './data/funding-history.json.br';
const cache = fs.existsSync(CACHE) ? JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(CACHE))) : {};

async function fundingHistory(coin) {
  const end = Date.now(), want = end - DAYS * 864e5;
  const c = cache[coin]?.from <= want ? cache[coin] : { from: want, to: want, rows: [] };
  let start = c.to;
  while (start < end) {
    let page;
    for (let i = 0; i < 8; i++) {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin, startTime: start, endTime: end })
      });
      if (res.status !== 429) { page = await res.json(); break; }
      await new Promise(r => setTimeout(r, 5000 * (i + 1)));
    }
    if (!page?.length) break;
    for (const p of page) {  // append only newer hours: an overlapping page adds no duplicate
      const h = Math.round(p.time / 36e5);
      if (h > (c.rows.at(-1)?.[0] ?? -Infinity)) c.rows.push([h, parseFloat(p.fundingRate)]);
    }
    start = c.to = page[page.length - 1].time + 1;
    if (page.length < 500) break;
    // A full page weighs 45 of the 1200/min per-IP limit every bot on this PC shares: 6 s = 450/min
    await new Promise(r => setTimeout(r, 6000));
  }
  cache[coin] = c;
  fs.mkdirSync('./data', { recursive: true });
  // Per coin, so an interrupted run keeps it. Quality 9: 0.25 s and 309 KB per write; the default 11 took 4.4 s for 231 KB
  const q = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } };
  fs.writeFileSync(CACHE, zlib.brotliCompressSync(JSON.stringify(cache), q));
  return new Map(c.rows.filter(([h]) => h >= want / 36e5));
}

console.log(`Fetching ${DAYS}d hourly funding for ${COINS.join(', ')} ...`);
const raw = {};
for (const c of COINS) raw[c] = await fundingHistory(c);
for (const c of COINS) {  // sanity: finite rates within Hyperliquid's 4%/h cap; missing hours stay gaps, never zero
  const hs = [...raw[c].keys()];
  if (!hs.length || [...raw[c].values()].some(r => !Number.isFinite(r) || Math.abs(r) > 0.04)) {
    throw new Error(`${c}: no data or an impossible funding rate (delete ${CACHE} to refetch)`);
  }
  console.log(`  ${c.padEnd(9)}${hs.length} h since ${new Date(hs[0] * 36e5).toISOString().slice(0, 10)}, ${hs.at(-1) - hs[0] + 1 - hs.length} missing`);
}
const all = COINS.flatMap(c => [...raw[c].keys()]);
// reduce, not Math.min(...all): spreading ~140k hours as arguments overflows the stack
const h0 = all.reduce((a, b) => Math.min(a, b)), T = all.reduce((a, b) => Math.max(a, b)) - h0 + 1, MID = Math.floor(T / 2);
const R = {}, S = {}, K = {};  // hourly rates (NaN = missing), prefix sums and counts of present hours
for (const c of COINS) {
  R[c] = new Float64Array(T).fill(NaN); S[c] = new Float64Array(T + 1); K[c] = new Int32Array(T + 1);
  for (let i = 0; i < T; i++) {
    const r = raw[c].get(h0 + i);
    if (r !== undefined) R[c][i] = r;
    S[c][i + 1] = S[c][i] + (r ?? 0); K[c][i + 1] = K[c][i] + (r === undefined ? 0 : 1);
  }
}
const sum = (c, a, b) => (a < 0 || b > T || K[c][b] - K[c][a] !== b - a) ? NaN : S[c][b] - S[c][a];
const avg7 = (c, t) => sum(c, t - W, t) / W * YEAR;  // annualized trailing 7d mean
const now = (c, t) => R[c][t] * YEAR;                 // annualized current hour

function beta14(a, b) {
  let num = 0, den = 0;
  for (let t = Math.max(a, W); t + 14 * D <= b; t += D) {
    const av = COINS.filter(c => Number.isFinite(avg7(c, t)) && Number.isFinite(sum(c, t, t + 14 * D)));
    if (av.length < 2) continue;
    const best = av.reduce((x, y) => avg7(y, t) > avg7(x, t) ? y : x);
    for (const j of av) {
      if (j === best) continue;
      const gap = (avg7(best, t) - avg7(j, t)) / YEAR;
      num += gap * (sum(best, t, t + 14 * D) - sum(j, t, t + 14 * D)); den += gap * gap;
    }
  }
  return num / den / D;
}

// rule: 'config' = production switchEdge; 'old' = hour rate, exit on negative hour, 2x after 14d; 'never' = first pick only
function simulate(rule, a, b, { minHoldDays = config.bot?.minHoldTimeDays ?? 7, horizonDays = config.bot?.switchHorizonDays ?? 8 } = {}) {
  const cfg = { ...config, bot: { ...config.bot, switchHorizonDays: horizonDays } };
  const signal = rule === 'old' ? now : avg7;
  let held = null, since = 0, earned = 0, cost = 0, switches = 0, hours = 0;
  for (let t = Math.max(a, W); t < b; t++) {
    const eligible = COINS.filter(c => signal(c, t) >= MIN_APY);
    // Same tie rule as rankOpportunities (0.0001 APY); config order stands in for its volume tie-break
    const best = eligible.reduce((x, y) => (x === null || signal(y, t) > signal(x, t) + 1e-4 ? y : x), null);
    if (held) {
      const e = signal(held, t);
      let target;  // undefined = hold, null = close, symbol = switch
      if (rule === 'config' && best !== held && Number.isFinite(e) && (t - since >= minHoldDays * D || e < 0)) {
        const cand = best && { avgFundingRate: signal(best, t), bidAsk: { perpSpreadPercent: SPREAD_PCT, spotSpreadPercent: 0 } };
        if (cand && switchEdge(e, cand, cfg) > 0) target = best;
        else if (switchEdge(e, null, cfg) > 0) target = null;
      } else if (rule === 'old') {
        if (e < 0) target = best;
        else if (t - since >= 14 * D && best && best !== held && (e < MIN_APY || signal(best, t) >= 2 * e)) target = best;
      }
      if (target !== undefined) {
        cost += LEG + SPREAD / 2; held = null;
        if (target) { cost += LEG + SPREAD / 2; held = target; since = t; switches++; }
      }
    } else if (best && (rule !== 'never' || switches === 0)) {
      cost += LEG + SPREAD / 2; held = best; since = t; switches++;
    }
    if (held && Number.isFinite(R[held][t])) earned += R[held][t];
    hours++;
  }
  return [(earned - cost) / (hours / YEAR) * 100, switches];  // net APY %, opens
}

const STARTS = 14;
function half(rule, a, b, opts) {
  const runs = Array.from({ length: STARTS }, (_, k) => simulate(rule, Math.max(a, W) + k * D, b, opts));
  const apy = runs.map(r => r[0]), mean = (xs) => xs.reduce((x, y) => x + y) / STARTS;
  return `${mean(apy).toFixed(1).padStart(6)}% [${Math.min(...apy).toFixed(0)}..${Math.max(...apy).toFixed(0)}]`.padEnd(20) +
    `(${mean(runs.map(r => r[1])).toFixed(0).padStart(3)} opens)`;
}
const row = (label, rule, opts) => console.log(`${label.padEnd(38)}${half(rule, 0, MID, opts)}  |${half(rule, MID, T, opts)}`);
console.log(`\nSpan ${(T / D).toFixed(0)} days, halves of ${(MID / D).toFixed(0)} days. Round-trip cost ${((2 * LEG + SPREAD) * 100).toFixed(2)}%.`);
console.log(`beta(14d), effective days of a 7d-avg gap earned over 14 days:  H1 ${beta14(0, MID).toFixed(1)}  H2 ${beta14(MID, T).toFixed(1)}  full ${beta14(0, T).toFixed(1)}  (config switchHorizonDays = ${config.bot?.switchHorizonDays ?? 8})`);
console.log(`\n${'Net APY after fees, mean [range]'.padEnd(38)}${'first half'.padEnd(32)}|second half`);
row('configured rule', 'config');
row('old rule (hour rate, 2x, hold 14d)', 'old');
row('never switch (first pick)', 'never');
for (const d of [1, 3, 7, 14, 30]) row(`  min hold ${d}d`, 'config', { minHoldDays: d });
for (const h of [4, 8, 12, 16]) row(`  switch horizon ${h}d`, 'config', { horizonDays: h });
