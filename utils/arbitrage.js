import { perpToSpot } from './symbols.js';
import { fetchWithConcurrencyLimit } from './spread.js';

/**
 * PERP-SPOT arbitrage/spread utilities for Hyperliquid trading
 * Checks price differences between PERP and SPOT markets for the same asset
 */

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
    const spotSymbol = perpToSpot(perpSymbol);

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

    return {
      perpSymbol: perpSymbol,
      spotSymbol: spotSymbol,
      perpMid: perpMid,
      spotMid: spotMid,
      spreadPercent: spreadPercent,
      error: null
    };
  } catch (error) {
    return {
      perpSymbol: perpSymbol,
      spotSymbol: perpToSpot(perpSymbol),
      perpMid: null,
      spotMid: null,
      spreadPercent: null,
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
    const spotSymbol = perpToSpot(perpSymbol);

    if (verbose) {
      console.log(`Checking spread for ${perpSymbol} vs ${spotSymbol}...`);
    }

    return await getSinglePerpSpotSpread(hyperliquid, perpSymbol, priceMap);
  });

  return await fetchWithConcurrencyLimit(tasks, finalConcurrency, finalDelay);
}
