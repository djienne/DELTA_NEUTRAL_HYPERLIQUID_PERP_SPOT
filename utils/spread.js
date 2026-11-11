import HyperliquidConnector from '../hyperliquid.js';

/**
 * Bid-Ask spread utility functions for Hyperliquid trading
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
 * Calculate spread percentage from bid and ask
 * @param {number} bid - Bid price
 * @param {number} ask - Ask price
 * @returns {number} Spread percentage (e.g., 0.15 for 0.15%)
 */
function calculateSpreadPercent(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  const spread = ((ask - bid) / mid) * 100;
  return spread;
}

/**
 * Get bid-ask spread for a single symbol
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} symbol - Symbol (perp or spot format)
 * @param {boolean} isSpot - Whether this is a spot symbol
 * @returns {Promise<Object>} Spread data
 */
async function getSingleSpread(hyperliquid, symbol, isSpot) {
  try {
    // For spot, we need to use the orderbook coin format
    let coin = symbol;
    if (isSpot) {
      const assetId = await hyperliquid.getAssetId(symbol, true);
      coin = hyperliquid.getCoinForOrderbook(symbol, assetId);
    }

    // Get L2 book snapshot
    const l2Book = await hyperliquid.infoRequest(
      hyperliquid.buildL2BookPayload(coin),
      2
    );

    if (!l2Book.levels || l2Book.levels.length !== 2) {
      throw new Error('Invalid L2 book format');
    }

    const [bids, asks] = l2Book.levels;

    if (bids.length === 0 || asks.length === 0) {
      throw new Error('Empty orderbook');
    }

    const bid = parseFloat(bids[0].px);
    const ask = parseFloat(asks[0].px);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new Error('Invalid bid/ask price');
    }
    const mid = (bid + ask) / 2;
    const spreadPercent = calculateSpreadPercent(bid, ask);

    return {
      symbol: symbol,
      isSpot: isSpot,
      bid: bid,
      ask: ask,
      mid: mid,
      spread: ask - bid,
      spreadPercent: spreadPercent,
      bidSize: parseFloat(bids[0].sz),
      askSize: parseFloat(asks[0].sz)
    };
  } catch (error) {
    return {
      symbol: symbol,
      isSpot: isSpot,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      spreadPercent: null,
      bidSize: null,
      askSize: null,
      error: error.message
    };
  }
}

/**
 * Get bid-ask spreads for multiple symbols
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Array<string>} perpSymbols - Array of perp symbols
 * @param {Object} options - Options
 * @param {number} options.concurrency - Number of pairs to fetch concurrently (overrides config)
 * @param {number} options.delayBetweenBatches - Delay in ms between batches (overrides config)
 * @param {boolean} options.verbose - Whether to log progress (default: true)
 * @param {Object} options.config - Config object with rateLimit settings
 * @returns {Promise<Array>} Array of spread results for both perp and spot
 */
export async function getBidAskSpreads(hyperliquid, perpSymbols, options = {}) {
  const {
    concurrency,
    delayBetweenBatches,
    verbose = true,
    config
  } = options;

  // Use config rate limits if provided, otherwise use defaults
  const rateLimitConfig = config?.rateLimit || {};
  const finalConcurrency = concurrency ?? rateLimitConfig.maxConcurrentRequests ?? 10;
  const finalDelay = delayBetweenBatches ?? rateLimitConfig.delayBetweenBatches ?? 200;

  // Create all fetch promises for both perp and spot
  const fetchTasks = perpSymbols.flatMap(perpSymbol => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

    if (verbose) {
      console.log(`Checking spreads for ${perpSymbol} / ${spotSymbol}...`);
    }

    return [
      () => getSingleSpread(hyperliquid, perpSymbol, false),
      () => getSingleSpread(hyperliquid, spotSymbol, true)
    ];
  });

  // Execute with concurrency limit
  const results = await fetchWithConcurrencyLimit(fetchTasks, finalConcurrency, finalDelay);

  return results;
}
