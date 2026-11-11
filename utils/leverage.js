/**
 * Leverage Management Utilities
 *
 * Set and manage leverage for perpetual positions.
 * For delta-neutral trading, we use 1x leverage to minimize risk.
 */

/**
 * Update leverage for a coin
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string} coin - Coin symbol (e.g., 'BTC', 'ETH')
 * @param {number} leverage - Leverage to set (e.g., 1 for 1x)
 * @param {boolean} isCross - True for cross margin, false for isolated
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Result
 */
export async function updateLeverage(hyperliquid, coin, leverage, isCross = false, options = {}) {
  const { verbose = false } = options;

  if (!hyperliquid.wallet || !hyperliquid.signer) {
    throw new Error('Wallet and private key required to update leverage');
  }

  if (verbose) {
    console.log(`[Leverage] Updating leverage for ${coin} to ${leverage}x (${isCross ? 'cross' : 'isolated'})...`);
  }

  // Get asset ID
  const assetId = await hyperliquid.getAssetId(coin, false);

  if (verbose) {
    console.log(`[Leverage] Asset ID: ${assetId}`);
  }

  // Construct action
  const action = {
    type: 'updateLeverage',
    asset: assetId,
    isCross: isCross,
    leverage: leverage
  };

  const nonce = typeof hyperliquid.nextNonce === 'function' ? hyperliquid.nextNonce() : Date.now();

  // Sign action (sub-account/vault: must name the account, or the master account's leverage changes)
  const vaultAddress = options.vaultAddress ?? hyperliquid.vaultAddress;
  const signature = await hyperliquid.signAction(action, nonce, vaultAddress, options.expiresAfter);

  // Create payload
  const payload = {
    action,
    nonce,
    signature
  };

  if (vaultAddress) {
    payload.vaultAddress = hyperliquid.normalizeVaultAddress(vaultAddress);
  }

  if (options.expiresAfter !== null && options.expiresAfter !== undefined) {
    payload.expiresAfter = options.expiresAfter;
  }

  // Send request (with timeout: a stalled request here used to hang the whole trading cycle)
  try {
    const result = await hyperliquid.fetchJsonWithTimeout(hyperliquid.exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, { timeoutMs: hyperliquid.orderTimeoutMs });

    // Hyperliquid returns HTTP 200 with an error BODY. Checking `response.ok`
    // alone is not enough -- and this was the only place in the codebase that
    // relied on the HTTP status instead of the payload's own status field.
    //
    // The consequence was severe and silent: openDeltaNeutralPosition aborts only
    // if setLeverage THROWS, so a rejected leverage update returned success:true
    // and the bot opened at whatever leverage the asset already carried. At a
    // previously-set 20x isolated, a $300 short posts $15 of margin and liquidates
    // on roughly a 5% adverse move -- leaving the spot leg naked, from a position
    // the operator believed was 1x and market-neutral.
    if (result?.status !== 'ok') {
      throw new Error(
        `Leverage update rejected for ${coin}: ${JSON.stringify(result?.response ?? result)}`
      );
    }
    // The nested statuses array carries per-action errors even when status === 'ok'.
    const innerError = result?.response?.data?.statuses?.find?.((s) => s && s.error);
    if (innerError) {
      throw new Error(`Leverage update rejected for ${coin}: ${innerError.error}`);
    }

    if (verbose) {
      console.log('[Leverage] ✅ Leverage updated:', result);
    }

    return {
      success: true,
      coin: coin,
      leverage: leverage,
      isCross: isCross,
      result: result
    };

  } catch (error) {
    console.error('[Leverage] ❌ Error updating leverage:', error.message);
    throw error;
  }
}

/**
 * Set leverage to 1x for a coin
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string} coin - Coin symbol
 * @param {boolean} isCross - True for cross margin, false for isolated (default false)
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Result
 */
export async function setLeverageTo1x(hyperliquid, coin, isCross = false, options = {}) {
  return await updateLeverage(hyperliquid, coin, 1, isCross, options);
}
