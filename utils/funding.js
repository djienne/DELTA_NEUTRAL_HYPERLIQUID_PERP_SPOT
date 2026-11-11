/**
 * Funding Rate Utilities
 *
 * Functions to fetch and analyze perpetual funding rates from Hyperliquid.
 *
 * Key concepts:
 * - Funding rates are ONLY available for PERP symbols (not SPOT)
 * - Hyperliquid pays funding every hour (24 times per day)
 * - Annualized rate = hourly_rate × 24 hours × 365 days
 * - Funding can be positive (longs pay shorts) or negative (shorts pay longs)
 */

// A short or gapped sample is not a seven-day estimator, even if its mean is finite.
export function validateFundingWindow(history, startTime, endTime, expectedHours = 168) {
  if (!Array.isArray(history) || history.length !== expectedHours) {
    throw new Error(`Incomplete funding history: expected ${expectedHours} hourly observations`);
  }
  const hours = history.map(row => {
    const time = Number(row.time);
    if (!Number.isFinite(time) || time < startTime || time > endTime || row.fundingRate === null ||
        String(row.fundingRate).trim() === '' || !Number.isFinite(Number(row.fundingRate))) {
      throw new Error('Invalid funding observation or timestamp outside requested window');
    }
    return Math.floor(time / 3600000);
  }).sort((a, b) => a - b);
  if (hours.some((hour, i) => i > 0 && hour !== hours[i - 1] + 1)) {
    throw new Error('Funding history contains duplicate or missing hours');
  }
}

/**
 * Current funding (from `metaAndAssetCtxs` = [meta, assetCtxs], fetched once per scan by the caller) and each symbol's
 * 7-day average. No current rate: `error`. No complete 168-hour history: `historyError` (the pair is then rejected).
 * @returns {Promise<Array<{symbol, fundingRate, annualizedRate, history?: {count, avg: {annualized}}}>>}
 */
export async function getFundingRatesWithHistory(hyperliquid, symbols, [meta, assetCtxs]) {
  const results = [];
  for (const symbol of symbols) {
    const funding = assetCtxs[meta.universe.findIndex(asset => asset?.name === symbol)]?.funding;
    if (!funding) {
      results.push({ symbol, fundingRate: null, annualizedRate: null, error: `No funding rate data for ${symbol}` });
      continue;
    }
    const current = { symbol, fundingRate: parseFloat(funding), annualizedRate: parseFloat(funding) * 24 * 365 };
    try {
      const endTime = Date.now();
      const startTime = endTime - 7 * 24 * 60 * 60 * 1000;
      const history = await hyperliquid.infoRequest({ type: 'fundingHistory', coin: symbol, startTime, endTime }, 20);
      validateFundingWindow(history, startTime, endTime, 7 * 24);
      const avgHourly = history.reduce((sum, h) => sum + parseFloat(h.fundingRate), 0) / history.length;
      results.push({ ...current, history: { count: history.length, avg: { annualized: avgHourly * 24 * 365 } } });
    } catch (error) {
      console.error(`Error fetching funding history for ${symbol}:`, error.message);  // the report only counts rejections
      results.push({ ...current, historyError: error.message });
    }
  }
  return results;
}
