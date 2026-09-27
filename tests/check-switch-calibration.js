import fs from 'fs';
import { switchEdge } from '../utils/position-decision.js';
import { getTakerFees } from '../utils/risk.js';

/**
 * Re-estimate the switch-rule parameters from public Hyperliquid funding history (read-only, no wallet).
 *
 * 1. beta(14d): regression slope of the realized 14-day funding gap (best coin vs each other coin) on
 *    today's 7d-average gap, in days. This is the physical "how much of a gap is actually earned"
 *    horizon -> config.bot.switchHorizonDays. Stable across halves = trustworthy.
 * 2. Replays the production decision (utils/position-decision.js switchEdge) hour by hour and reports
 *    net APY after fees for each half, against the old rule and against never switching.
 *    Pick parameters on the flat part of the scans, not the peak: each half has only ~5-30 switches.
 * Assumptions: realized hourly funding stands in for the rate the bot sees; spreads are a fixed
 * SPREAD_PCT; volume/spread filters are ignored (all configured pairs always eligible).
 *
 * Usage: node tests/check-switch-calibration.js [days=730]
 */

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const COINS = config.trading.pairs;
const DAYS = Number(process.argv[2] || 730);
const D = 24, W = 7 * D, YEAR = 8760;
const MIN_APY = (config.thresholds?.minFundingRatePercent ?? 5) / 100;
const SPREAD_PCT = 0.05;  // perp + spot bid-ask spread, percent (typical for the filtered pairs)
const fees = getTakerFees(config);
const LEG = fees.perp + fees.spot, SPREAD = SPREAD_PCT / 100;

async function fundingHistory(coin) {
  const out = new Map();
  const end = Date.now();
  let start = end - DAYS * 864e5;
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
    await new Promise(r => setTimeout(r, 1100));  // fundingHistory weighs 20 of 1200/min
    if (!page?.length) break;
    for (const p of page) out.set(Math.round(p.time / 36e5), parseFloat(p.fundingRate));
    start = page[page.length - 1].time + 1;
    if (page.length < 500) break;
  }
  return out;
}

console.log(`Fetching ${DAYS}d hourly funding for ${COINS.join(', ')} ...`);
const raw = {};
for (const c of COINS) raw[c] = await fundingHistory(c);
const all = COINS.flatMap(c => [...raw[c].keys()]);
const h0 = Math.min(...all), T = Math.max(...all) - h0 + 1, MID = Math.floor(T / 2);
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
  return `${((earned - cost) / (hours / YEAR) * 100).toFixed(1).padStart(6)}% (${String(switches).padStart(3)} opens)`;
}

const row = (label, rule, opts) => console.log(`${label.padEnd(38)}${simulate(rule, 0, MID, opts)}  |${simulate(rule, MID, T, opts)}`);
console.log(`\nSpan ${(T / D).toFixed(0)} days, halves of ${(MID / D).toFixed(0)} days. Round-trip cost ${((2 * LEG + SPREAD) * 100).toFixed(2)}%.`);
console.log(`beta(14d), effective days of a 7d-avg gap earned over 14 days:  H1 ${beta14(0, MID).toFixed(1)}  H2 ${beta14(MID, T).toFixed(1)}  full ${beta14(0, T).toFixed(1)}  (config switchHorizonDays = ${config.bot?.switchHorizonDays ?? 8})`);
console.log(`\n${'Net APY after fees'.padEnd(38)}${'first half'.padEnd(24)}|second half`);
row('configured rule', 'config');
row('old rule (hour rate, 2x, hold 14d)', 'old');
row('never switch (first pick)', 'never');
for (const d of [1, 3, 7, 14, 30]) row(`  min hold ${d}d`, 'config', { minHoldDays: d });
for (const h of [4, 8, 12, 16]) row(`  switch horizon ${h}d`, 'config', { horizonDays: h });
