// Console status screen: the position part of bot.js's 2-minute displayStatus, and its colors / number formatting.
import { hasPosition, getCurrentPosition, getPositionAge, canClosePosition } from './state.js';
import { formatPrice } from './positions.js';

// ANSI color codes
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m'
};

export function formatKnown(value, decimals = 2) {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'unknown';
}

/**
 * The status screen's position part: the held position (entry, funding, age, minimum hold) or the flat status.
 * bot.js displayStatus prints the header, runs the ON HOLD / recovery re-checks and prints the market table.
 */
export async function printPositionStatus(state, hyperliquid, MIN_HOLD_TIME_MS, CHECK_INTERVAL_MS) {
  if (hasPosition(state)) {
    const position = getCurrentPosition(state);

    // Calculate time info
    const age = getPositionAge(position);
    const ageHours = age / (1000 * 60 * 60);
    const ageDays = age / (1000 * 60 * 60 * 24);
    const canClose = canClosePosition(position, MIN_HOLD_TIME_MS);
    const minHoldDays = MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24);

    // Calculate time until can rebalance
    const timeUntilCanClose = MIN_HOLD_TIME_MS - age;
    const daysUntilCanClose = timeUntilCanClose / (1000 * 60 * 60 * 24);
    const hoursUntilCanClose = timeUntilCanClose / (1000 * 60 * 60);

    console.log(`${colors.bright}Position:${colors.reset} ${colors.cyan}${position.symbol}${colors.reset} Delta-Neutral`);

    const perpValue = Number.isFinite(position.perpEntryPrice) ? position.perpSize * position.perpEntryPrice : NaN;
    const spotValue = Number.isFinite(position.spotEntryPrice) ? position.spotSize * position.spotEntryPrice : NaN;
    const totalValue = perpValue + spotValue;

    console.log(`  PERP:  SHORT ${position.perpSize} @ $${formatPrice(position.perpEntryPrice)} ${colors.dim}($${formatKnown(perpValue)})${colors.reset}`);
    console.log(`  SPOT:  LONG ${position.spotSize} @ $${formatPrice(position.spotEntryPrice)} ${colors.dim}($${formatKnown(spotValue)})${colors.reset}`);
    console.log(`  ${colors.bright}Total Entry Value: $${formatKnown(totalValue)}${colors.reset}`);
    console.log();

    const fundingColor = position.annualizedFunding >= 0 ? colors.green : colors.red;
    console.log(`${colors.bright}Funding at entry:${colors.reset} ${fundingColor}${formatKnown(position.annualizedFunding == null ? null : position.annualizedFunding * 100)}% annualized${colors.reset}`);
    console.log(`  Hourly Rate: ${fundingColor}${formatKnown(position.fundingRate == null ? null : position.fundingRate * 100, 4)}%${colors.reset}`);
    console.log(`  Expected/hour at entry: ${colors.green}$${formatKnown(position.fundingRate == null ? null : position.positionValue * position.fundingRate, 4)}${colors.reset}`);

    // Fetch accumulated funding for current position
    try {
      if (!Number.isFinite(position.openTime)) throw new Error('Opening time unknown');
      const fundingHistory = await hyperliquid.getUserFundingHistory(null, position.openTime);

      // Filter for current position symbol
      const perpSymbol = position.perpSymbol;
      const positionFunding = fundingHistory.accumulated[perpSymbol] || 0;

      if (positionFunding !== 0) {
        const earnedColor = positionFunding >= 0 ? colors.green : colors.red;
        const sign = positionFunding >= 0 ? '+' : '';
        console.log(`  ${colors.bright}Accumulated Earned:${colors.reset} ${earnedColor}${sign}$${positionFunding.toFixed(4)}${colors.reset} ${colors.dim}(since open)${colors.reset}`);
      }
    } catch (error) {
      // Silently fail if funding history unavailable
      console.log(`  ${colors.dim}(Accumulated funding unavailable)${colors.reset}`);
    }

    console.log();

    if (!Number.isFinite(position.openTime)) {
      console.log('Age: unknown');
    } else if (ageDays >= 1) {
      console.log(`${colors.bright}Age:${colors.reset} ${colors.yellow}${ageDays.toFixed(2)} days${colors.reset} ${colors.dim}(${ageHours.toFixed(1)} hours)${colors.reset}`);
    } else {
      console.log(`${colors.bright}Age:${colors.reset} ${colors.yellow}${ageHours.toFixed(1)} hours${colors.reset}`);
    }

    console.log(`${colors.dim}Opened: ${Number.isFinite(position.openTime) ? new Date(position.openTime).toLocaleString() : 'unknown'}${colors.reset}`);
    console.log();

    if (!Number.isFinite(position.openTime)) {
      console.log('Opening time unknown; minimum holding period cannot be verified.');
    } else if (canClose) {
      console.log(`${colors.green}✅ Can Switch/Close: YES${colors.reset} ${colors.dim}(held > ${minHoldDays} days)${colors.reset}`);
      console.log(`   ${colors.dim}Switches only if the expected funding gain beats fees + spread${colors.reset}`);
    } else {
      if (daysUntilCanClose >= 1) {
        console.log(`${colors.yellow}⏳ Can Switch/Close: NO${colors.reset} ${colors.dim}(need ${daysUntilCanClose.toFixed(2)} more days)${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⏳ Can Switch/Close: NO${colors.reset} ${colors.dim}(need ${hoursUntilCanClose.toFixed(1)} more hours)${colors.reset}`);
      }
      console.log(`   ${colors.dim}Min hold: ${minHoldDays} days${colors.reset}`);
      console.log(`   ${colors.dim}Can close at: ${new Date(position.openTime + MIN_HOLD_TIME_MS).toLocaleString()}${colors.reset}`);
    }

  } else {
    console.log(`${colors.bright}Position:${colors.reset} None`);
    console.log(`${colors.bright}Status:${colors.reset} 🔍 Looking for opportunities...`);
    const nextCheck = state.lastOpportunityCheck
      ? new Date(state.lastOpportunityCheck + CHECK_INTERVAL_MS).toLocaleTimeString()
      : 'on next cycle';
    console.log(`${colors.dim}Next check: ${nextCheck}${colors.reset}`);
  }
}
