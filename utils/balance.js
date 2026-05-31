import HyperliquidConnector from '../hyperliquid.js';

/**
 * Balance Management Utilities
 *
 * Check PERP and SPOT balance distribution and suggest transfers.
 */

/**
 * Get PERP and SPOT balances
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string} user - User wallet address
 * @returns {Promise<Object>} Balance information
 */
export async function getBalances(hyperliquid, user = null) {
  user = user || hyperliquid.wallet;

  if (!user) {
    throw new Error('User address required');
  }

  // Fetch both clearinghouse states in parallel
  const [perpState, spotState] = await Promise.all([
    hyperliquid.infoRequest({
      type: 'clearinghouseState',
      user: user
    }, 2),

    hyperliquid.infoRequest({
      type: 'spotClearinghouseState',
      user: user
    }, 2)
  ]);

  // PERP balance (withdrawable)
  const perpBalance = parseFloat(perpState.withdrawable || '0');

  // SPOT balance (USDC only)
  const spotBalances = spotState.balances || [];
  const usdcBalance = spotBalances.find(b => b.coin === 'USDC');
  const spotBalance = parseFloat(usdcBalance?.total || '0');

  // Total balance
  const totalBalance = perpBalance + spotBalance;

  // Calculate percentages
  const perpPercent = totalBalance > 0 ? (perpBalance / totalBalance) * 100 : 0;
  const spotPercent = totalBalance > 0 ? (spotBalance / totalBalance) * 100 : 0;

  return {
    perpBalance: perpBalance,
    spotBalance: spotBalance,
    totalBalance: totalBalance,
    perpPercent: perpPercent,
    spotPercent: spotPercent
  };
}

/**
 * Check if balances are within acceptable range (50% ±10%)
 * @param {Object} balances - Balance information from getBalances
 * @param {number} tolerance - Tolerance percentage (default 10%)
 * @returns {Object} Balance check result
 */
export function checkBalanceDistribution(balances, tolerance = 10) {
  const target = 50; // Target 50/50 split
  const minPercent = target - tolerance;
  const maxPercent = target + tolerance;

  const perpBalanced = balances.perpPercent >= minPercent && balances.perpPercent <= maxPercent;
  const spotBalanced = balances.spotPercent >= minPercent && balances.spotPercent <= maxPercent;
  const isBalanced = perpBalanced && spotBalanced;

  // Calculate imbalance
  const perpImbalance = balances.perpPercent - target;
  const spotImbalance = balances.spotPercent - target;

  return {
    isBalanced: isBalanced,
    perpBalanced: perpBalanced,
    spotBalanced: spotBalanced,
    perpImbalance: perpImbalance,
    spotImbalance: spotImbalance,
    target: target,
    tolerance: tolerance,
    minPercent: minPercent,
    maxPercent: maxPercent
  };
}

/**
 * Suggest transfer to rebalance funds
 * @param {Object} balances - Balance information from getBalances
 * @param {Object} balanceCheck - Balance check from checkBalanceDistribution
 * @returns {Object|null} Transfer suggestion or null if balanced
 */
export function suggestTransfer(balances, balanceCheck) {
  if (balanceCheck.isBalanced) {
    return null;
  }

  // Determine direction and amount
  let direction;
  let amount;

  if (balances.perpPercent > 50) {
    // Too much in PERP, transfer to SPOT
    direction = 'PERP → SPOT';
    // Calculate amount needed to reach 50/50
    const targetPerpBalance = balances.totalBalance * 0.5;
    amount = balances.perpBalance - targetPerpBalance;
  } else {
    // Too much in SPOT, transfer to PERP
    direction = 'SPOT → PERP';
    // Calculate amount needed to reach 50/50
    const targetSpotBalance = balances.totalBalance * 0.5;
    amount = balances.spotBalance - targetSpotBalance;
  }

  return {
    direction: direction,
    amount: amount,
    fromPerpToSpot: direction === 'PERP → SPOT',
    fromSpotToPerp: direction === 'SPOT → PERP'
  };
}

/**
 * Format balance report for display
 * @param {Object} balances - Balance information
 * @param {Object} balanceCheck - Balance check result
 * @param {Object|null} transferSuggestion - Transfer suggestion
 * @returns {string} Formatted report
 */
export function formatBalanceReport(balances, balanceCheck, transferSuggestion) {
  const lines = [];

  lines.push('Balance Distribution:');
  lines.push(`  PERP Balance: $${balances.perpBalance.toFixed(2)} (${balances.perpPercent.toFixed(1)}%)`);
  lines.push(`  SPOT Balance: $${balances.spotBalance.toFixed(2)} (${balances.spotPercent.toFixed(1)}%)`);
  lines.push(`  Total Balance: $${balances.totalBalance.toFixed(2)}`);
  lines.push('');

  if (balanceCheck.isBalanced) {
    lines.push(`✅ Balanced (within ${balanceCheck.tolerance}% tolerance)`);
  } else {
    lines.push(`⚠️  Imbalanced (target: ${balanceCheck.target}% ±${balanceCheck.tolerance}%)`);
    lines.push(`  PERP: ${balanceCheck.perpImbalance > 0 ? '+' : ''}${balanceCheck.perpImbalance.toFixed(1)}% from target`);
    lines.push(`  SPOT: ${balanceCheck.spotImbalance > 0 ? '+' : ''}${balanceCheck.spotImbalance.toFixed(1)}% from target`);

    if (transferSuggestion) {
      lines.push('');
      lines.push('💡 Suggested Transfer:');
      lines.push(`  Direction: ${transferSuggestion.direction}`);
      lines.push(`  Amount: $${transferSuggestion.amount.toFixed(2)}`);
      lines.push('');
      lines.push('  Note: Bot will proceed with current balance distribution.');
    }
  }

  return lines.join('\n');
}

/**
 * Check balances and generate full report
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {number} tolerance - Tolerance percentage (default 10%)
 * @returns {Promise<Object>} Full balance report
 */
export async function checkAndReportBalances(hyperliquid, tolerance = 10) {
  const balances = await getBalances(hyperliquid);
  const balanceCheck = checkBalanceDistribution(balances, tolerance);
  const transferSuggestion = suggestTransfer(balances, balanceCheck);

  return {
    balances,
    balanceCheck,
    transferSuggestion,
    report: formatBalanceReport(balances, balanceCheck, transferSuggestion)
  };
}
