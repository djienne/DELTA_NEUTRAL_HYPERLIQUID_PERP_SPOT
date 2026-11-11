/**
 * Set a perp's leverage (the bot uses 1x isolated). Hyperliquid answers HTTP 200 with the error in the body, so the
 * status and every per-action status are checked: opening at a leftover 20x would liquidate the short on a ~5% move.
 * A timeout is a plain error (no unknownOnTimeout), so it cannot block the hedge fallback close.
 */
export async function updateLeverage(hyperliquid, coin, leverage, isCross = false) {
  if (!hyperliquid.wallet || !hyperliquid.signer) {
    throw new Error('Wallet and private key required to update leverage');
  }
  const action = { type: 'updateLeverage', asset: await hyperliquid.getAssetId(coin, false), isCross, leverage };
  const result = await hyperliquid.postAction(action, hyperliquid.nextNonce?.() ?? Date.now());
  const error = result?.status !== 'ok' ? JSON.stringify(result?.response ?? result)
    : result.response?.data?.statuses?.find?.(s => s?.error)?.error;
  if (error) throw new Error(`Leverage update rejected for ${coin}: ${error}`);
  return result;
}

export const setLeverageTo1x = (hyperliquid, coin, isCross = false) => updateLeverage(hyperliquid, coin, 1, isCross);
