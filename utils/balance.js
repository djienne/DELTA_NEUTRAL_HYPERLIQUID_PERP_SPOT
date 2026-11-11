/**
 * Free PERP / SPOT USDC, and whether the split needs a manual transfer before the next open (an API key cannot move funds).
 */
export async function getBalances(hyperliquid, user = null) {
  user = user || hyperliquid.wallet;
  if (!user) throw new Error('User address required');
  const [perpState, spotState] = await Promise.all([
    hyperliquid.infoRequest({ type: 'clearinghouseState', user }, 2),
    hyperliquid.infoRequest({ type: 'spotClearinghouseState', user }, 2)
  ]);
  const perpBalance = parseFloat(perpState.withdrawable || '0');
  const spotBalance = parseFloat((spotState.balances || []).find(b => b.coin === 'USDC')?.total || '0');
  return { perpBalance, spotBalance, totalBalance: perpBalance + spotBalance };
}

// Hold when |PERP - SPOT| > maxPct % of the total (10 = 50/50 +-5 points); the transfer that restores 50/50.
export function rebalanceNeeded({ perpBalance, spotBalance, totalBalance }, maxPct) {
  const imbalancePercent = totalBalance > 0 ? Math.abs(perpBalance - spotBalance) / totalBalance * 100 : 0;
  return { imbalancePercent, onHold: imbalancePercent > maxPct, amount: Math.abs(perpBalance - spotBalance) / 2,
    fromPerpToSpot: perpBalance > spotBalance };
}
