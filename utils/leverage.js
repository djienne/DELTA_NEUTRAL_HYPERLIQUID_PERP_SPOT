import HyperliquidConnector from '../hyperliquid.js';

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

  const nonce = Date.now();

  // Sign action
  const signature = await hyperliquid.signAction(action, nonce, options.vaultAddress, options.expiresAfter);

  // Create payload
  const payload = {
    action,
    nonce,
    signature
  };

  if (options.vaultAddress) {
    payload.vaultAddress = typeof hyperliquid.normalizeVaultAddress === 'function'
      ? hyperliquid.normalizeVaultAddress(options.vaultAddress)
      : options.vaultAddress;
  }

  if (options.expiresAfter !== null && options.expiresAfter !== undefined) {
    payload.expiresAfter = options.expiresAfter;
  }

  // Send request
  try {
    const requestFetch = hyperliquid.fetch || fetch;
    const response = await requestFetch(hyperliquid.exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();

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

/**
 * Set leverage to 1x for multiple coins (parallel execution)
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string[]} coins - Array of coin symbols
 * @param {boolean} isCross - True for cross margin, false for isolated
 * @param {Object} options - Additional options
 * @returns {Promise<Object[]>} Array of results
 */
export async function setLeverageTo1xForAll(hyperliquid, coins, isCross = false, options = {}) {
  const { verbose = false } = options;

  if (verbose) {
    console.log(`[Leverage] Setting leverage to 1x for ${coins.length} coins in parallel...`);
  }

  // Execute all leverage updates in parallel
  const promises = coins.map(async (coin) => {
    try {
      const result = await setLeverageTo1x(hyperliquid, coin, isCross, { verbose });
      return result;
    } catch (error) {
      console.error(`[Leverage] ❌ Failed to set leverage for ${coin}:`, error.message);
      return {
        success: false,
        coin: coin,
        error: error.message
      };
    }
  });

  const results = await Promise.all(promises);

  if (verbose) {
    const successful = results.filter(r => r.success).length;
    console.log(`[Leverage] ✅ Set leverage for ${successful}/${coins.length} coins`);
  }

  return results;
}

/**
 * Get current leverage settings for user
 * Note: This information is included in the clearinghouse state
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string} user - User wallet address
 * @returns {Promise<Object>} Leverage information
 */
export async function getLeverageSettings(hyperliquid, user = null) {
  user = user || hyperliquid.wallet;

  if (!user) {
    throw new Error('User address required');
  }

  // Fetch clearinghouse state
  const data = await hyperliquid.infoRequest({
    type: 'clearinghouseState',
    user: user
  }, 2);

  // Get meta for symbol mapping
  const meta = await hyperliquid.getMeta();

  const leverageSettings = [];

  // Extract leverage from asset positions
  if (data.assetPositions && data.assetPositions.length > 0) {
    for (const position of data.assetPositions) {
      const asset = position.position;
      const assetIndex = asset.coin;

      // Get symbol name from meta
      let symbol;
      if (typeof assetIndex === 'string') {
        symbol = assetIndex;
      } else {
        const assetInfo = meta.universe[assetIndex];
        symbol = assetInfo ? assetInfo.name : `Asset${assetIndex}`;
      }

      // Get leverage info
      const leverage = asset.leverage;

      leverageSettings.push({
        symbol: symbol,
        leverage: parseFloat(leverage.value || '1'),
        type: leverage.type // 'cross' or 'isolated'
      });
    }
  }

  return leverageSettings;
}

/**
 * Format leverage settings for display
 * @param {Object[]} settings - Leverage settings from getLeverageSettings
 * @returns {string} Formatted string
 */
export function formatLeverageSettings(settings) {
  if (!settings || settings.length === 0) {
    return 'No positions with leverage settings';
  }

  const lines = [];
  lines.push('Leverage Settings:');

  for (const setting of settings) {
    lines.push(`  ${setting.symbol}: ${setting.leverage}x (${setting.type})`);
  }

  return lines.join('\n');
}
