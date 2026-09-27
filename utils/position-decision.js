import { getTakerFees } from './risk.js';

// Funding signal of the held position: its trailing 7-day average (annualized), whether or not the
// symbol still passes the opportunity filters.
export function getCurrentPositionFundingSignal(position, analysis) {
  if (!position || !analysis) {
    return { available: false, reason: 'missing position or analysis' };
  }

  const ranked = analysis.rankedOpportunities?.find(o => o.symbol === position.symbol);
  const raw = analysis.marketData?.fundingRates?.find(f => f.symbol === position.symbol);
  const fundingRate = ranked ? ranked.avgFundingRate : (raw?.history?.avg?.annualized ?? raw?.annualizedRate);

  if (!Number.isFinite(fundingRate)) {
    return { available: false, symbol: position.symbol, reason: raw?.error || `No finite 7d funding for ${position.symbol}` };
  }

  return { available: true, symbol: position.symbol, fundingRate, fundingPercent: fundingRate * 100 };
}

/**
 * Expected gain (fraction of notional) of moving from the held position to `candidate`
 * (null = close and stay flat), net of trading cost. Act only when it is > 0.
 *
 *   gain = (candidate 7d avg - incumbent 7d avg) * H - cost
 *   H    = config.bot.switchHorizonDays. How much of today's 7d-avg funding gap is actually earned:
 *          on 2y of Hyperliquid data a gap pays ~8 days' worth over the next 14 days (regression
 *          slope; small gaps fade faster). Re-estimate with tests/check-switch-calibration.js.
 *   cost = taker fees on both legs to close the incumbent (+ open the candidate) + crossing half the
 *          bid-ask spread on each leg (candidate's spread stands in for the incumbent's).
 * At base-tier fees this means switching needs a ~12+ APY-point gap, and a negative position is only
 * closed when its expected loss over H exceeds the cost of closing.
 */
export function switchEdge(incumbentAnnual, candidate, config = {}) {
  const fees = getTakerFees(config);
  const horizonYears = (config.bot?.switchHorizonDays ?? 8) / 365;
  const legFees = fees.perp + fees.spot;

  if (!candidate) {
    return -incumbentAnnual * horizonYears - legFees;
  }

  const spreadCost = ((candidate.bidAsk?.perpSpreadPercent ?? 0) + (candidate.bidAsk?.spotSpreadPercent ?? 0)) / 100;
  return (candidate.avgFundingRate - incumbentAnnual) * horizonYears - 2 * legFees - spreadCost;
}
