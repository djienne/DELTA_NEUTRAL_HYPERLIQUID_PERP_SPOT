import HyperliquidConnector from '../hyperliquid.js';

/**
 * PERP-SPOT arbitrage/spread utilities for Hyperliquid trading
 * Checks price differences between PERP and SPOT markets for the same asset
 */

/**
 * Helper function to limit concurrent requests
 * @param {Array<Function>} tasks - Array of promise-returning functions
 * @param {number} limit - Maximum number of concurrent requests
 * @param {number} delayBetweenBatches - Delay in ms between batches
 * @returns {Promise<Array>} Results array
 */
export async function fetchWithConcurrencyLimit(tasks, limit = 10, delayBetweenBatches = 200) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(task => task()));
    results.push(...batchResults);
    // Small delay between batches to respect rate limits
    if (i + limit < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }
  return results;
}

/**
 * Calculate spread percentage between perp and spot mid prices
 * @param {number} perpMid - Perp mid price
 * @param {number} spotMid - Spot mid price
 * @returns {number} Spread percentage (e.g., 0.25 for 0.25%)
 */
function calculatePerpSpotSpreadPercent(perpMid, spotMid) {
  if (!Number.isFinite(perpMid) || !Number.isFinite(spotMid) || perpMid <= 0 || spotMid <= 0) return null;
  const spread = ((spotMid - perpMid) / perpMid) * 100;
  return spread;
}

/**
 * Get PERP-SPOT spread for a single symbol pair
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} perpSymbol - Perp symbol
 * @param {Object} priceMap - Map of all mid prices
 * @returns {Promise<Object>} Spread data
 */
async function getSinglePerpSpotSpread(hyperliquid, perpSymbol, priceMap) {
  try {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

    // Get mid prices from the price map
    const perpMid = priceMap[perpSymbol];

    // For spot, we need to get the orderbook coin name (e.g., "@142" for UBTC)
    const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
    const spotCoin = hyperliquid.getCoinForOrderbook(spotSymbol, spotAssetId);
    const spotMid = priceMap[spotCoin];

    if (!Number.isFinite(perpMid)) {
      throw new Error(`No price data for PERP ${perpSymbol}`);
    }

    if (!Number.isFinite(spotMid)) {
      throw new Error(`No price data for SPOT ${spotSymbol} (coin: ${spotCoin})`);
    }

    const spreadPercent = calculatePerpSpotSpreadPercent(perpMid, spotMid);
    const spreadAbs = spotMid - perpMid;

    return {
      perpSymbol: perpSymbol,
      spotSymbol: spotSymbol,
      perpMid: perpMid,
      spotMid: spotMid,
      spreadAbs: spreadAbs,
      spreadPercent: spreadPercent,
      isPremium: spreadAbs > 0, // true if spot is more expensive
      error: null
    };
  } catch (error) {
    return {
      perpSymbol: perpSymbol,
      spotSymbol: HyperliquidConnector.perpToSpot(perpSymbol),
      perpMid: null,
      spotMid: null,
      spreadAbs: null,
      spreadPercent: null,
      isPremium: null,
      error: error.message
    };
  }
}

/**
 * Get PERP-SPOT spreads for multiple symbols
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Array<string>} perpSymbols - Array of perp symbols
 * @param {Object} options - Options
 * @param {boolean} options.verbose - Whether to log progress (default: true)
 * @param {Object} options.config - Config object with settings
 * @returns {Promise<Array>} Array of spread results
 */
export async function getPerpSpotSpreads(hyperliquid, perpSymbols, options = {}) {
  const {
    concurrency,
    delayBetweenBatches,
    verbose = true,
    config
  } = options;

  if (verbose) {
    console.log('Fetching all mid prices...');
  }

  // Fetch all mid prices at once
  const allMids = await hyperliquid.getAllMids();

  // Convert string prices to numbers
  const priceMap = {};
  for (const [symbol, priceStr] of Object.entries(allMids)) {
    priceMap[symbol] = parseFloat(priceStr);
  }

  if (verbose) {
    console.log(`✅ Fetched prices for ${Object.keys(priceMap).length} symbols`);
    console.log();
  }

  const rateLimitConfig = config?.rateLimit || {};
  const finalConcurrency = concurrency ?? rateLimitConfig.maxConcurrentRequests ?? 10;
  const finalDelay = delayBetweenBatches ?? rateLimitConfig.delayBetweenBatches ?? 200;

  // Calculate spreads for each pair
  const tasks = perpSymbols.map(perpSymbol => async () => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

    if (verbose) {
      console.log(`Checking spread for ${perpSymbol} vs ${spotSymbol}...`);
    }

    return await getSinglePerpSpotSpread(hyperliquid, perpSymbol, priceMap);
  });

  return await fetchWithConcurrencyLimit(tasks, finalConcurrency, finalDelay);
}

/**
 * Filter spreads by maximum spread percentage
 * @param {Array} spreadResults - Results from getPerpSpotSpreads()
 * @param {number} maxSpreadPercent - Maximum spread percentage (absolute value)
 * @returns {Object} Object with wideSpread and narrowSpread arrays
 */
export function filterByPerpSpotSpread(spreadResults, maxSpreadPercent) {
  const wideSpread = [];
  const narrowSpread = [];

  for (const result of spreadResults) {
    if (result.error || result.spreadPercent === null) {
      continue;
    }

    // Use absolute value for comparison
    if (Math.abs(result.spreadPercent) > maxSpreadPercent) {
      wideSpread.push(result);
    } else {
      narrowSpread.push(result);
    }
  }

  return { wideSpread, narrowSpread };
}

/**
 * Format PERP-SPOT spread results as a table string
 * @param {Array} spreadResults - Results from getPerpSpotSpreads()
 * @returns {string} Formatted table
 */
export function formatPerpSpotSpreadTable(spreadResults) {
  const lines = [];

  lines.push('┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┐');
  lines.push('│ Perp Symbol  │ Spot Symbol  │ Perp Mid     │ Spot Mid     │ Spread Abs   │ Spread % │');
  lines.push('├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────┤');

  for (const result of spreadResults) {
    if (result.error) {
      lines.push(
        `│ ${result.perpSymbol.padEnd(12)} │ ${result.spotSymbol.padEnd(12)} │ ${('ERROR: ' + result.error).padEnd(49)} │`
      );
      continue;
    }

    const perpStr = result.perpMid !== null ? result.perpMid.toFixed(6).padStart(12) : 'N/A'.padStart(12);
    const spotStr = result.spotMid !== null ? result.spotMid.toFixed(6).padStart(12) : 'N/A'.padStart(12);
    const absStr = result.spreadAbs !== null ? result.spreadAbs.toFixed(6).padStart(12) : 'N/A'.padStart(12);

    let spreadStr = 'N/A'.padStart(8);
    if (result.spreadPercent !== null) {
      const sign = result.spreadPercent >= 0 ? '+' : '';
      spreadStr = (sign + result.spreadPercent.toFixed(4) + '%').padStart(8);
    }

    lines.push(
      `│ ${result.perpSymbol.padEnd(12)} │ ${result.spotSymbol.padEnd(12)} │ ` +
      `${perpStr} │ ${spotStr} │ ${absStr} │ ${spreadStr} │`
    );
  }

  lines.push('└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────┘');

  return lines.join('\n');
}

/**
 * Save PERP-SPOT spread results to CSV file
 * @param {Array} spreadResults - Results from getPerpSpotSpreads()
 * @returns {string} CSV content
 */
export function perpSpotSpreadToCSV(spreadResults) {
  const lines = ['perpSymbol,spotSymbol,perpMid,spotMid,spreadAbs,spreadPercent,isPremium,error'];

  for (const result of spreadResults) {
    lines.push(
      `${result.perpSymbol},${result.spotSymbol},` +
      `${result.perpMid || ''},${result.spotMid || ''},` +
      `${result.spreadAbs || ''},${result.spreadPercent || ''},` +
      `${result.isPremium !== null ? result.isPremium : ''},` +
      `${result.error || ''}`
    );
  }

  return lines.join('\n') + '\n';
}
