import HyperliquidConnector from '../hyperliquid.js';

/**
 * Volume utility functions for Hyperliquid trading
 */

/**
 * Helper function to limit concurrent requests
 * @param {Array<Function>} tasks - Array of promise-returning functions
 * @param {number} limit - Maximum number of concurrent requests
 * @param {number} delayBetweenBatches - Delay in ms between batches
 * @returns {Promise<Array>} Results array
 */
export async function fetchWithConcurrencyLimit(tasks, limit = 3, delayBetweenBatches = 200) {
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
 * Fetch 24-hour volumes for a list of pairs
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Array<string>} perpSymbols - Array of perp symbols
 * @param {Object} options - Options
 * @param {number} options.concurrency - Number of pairs to fetch concurrently (overrides config)
 * @param {number} options.delayBetweenBatches - Delay in ms between batches (overrides config)
 * @param {boolean} options.verbose - Whether to log progress (default: true)
 * @param {Object} options.config - Config object with rateLimit settings
 * @returns {Promise<Array>} Array of volume results
 */
export async function get24HourVolumes(hyperliquid, perpSymbols, options = {}) {
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

  // Create all fetch promises
  const fetchTasks = perpSymbols.map((perpSymbol) => async () => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

    if (verbose) {
      console.log(`Checking ${perpSymbol} / ${spotSymbol}...`);
    }

    const result = {
      perpSymbol,
      spotSymbol,
      perpVolume: null,
      spotVolume: null
    };

    // Fetch PERP and SPOT volumes in parallel for this pair
    const [perpResult, spotResult] = await Promise.all([
      // Get PERP volume
      hyperliquid.get24HourVolume(perpSymbol, false)
        .then(data => data.volume24h)
        .catch(error => {
          if (verbose) {
            console.log(`  ⚠️  PERP ${perpSymbol}: ${error.message}`);
          }
          return 'N/A';
        }),
      // Get SPOT volume
      hyperliquid.get24HourVolume(spotSymbol, true)
        .then(data => data.volume24h)
        .catch(error => {
          if (verbose) {
            console.log(`  ⚠️  SPOT ${spotSymbol}: ${error.message}`);
          }
          return 'N/A';
        })
    ]);

    result.perpVolume = perpResult;
    result.spotVolume = spotResult;

    return result;
  });

  // Execute with concurrency limit
  return await fetchWithConcurrencyLimit(fetchTasks, finalConcurrency, finalDelay);
}

/**
 * Filter symbols by minimum 24-hour volume
 * @param {Array} volumeResults - Results from get24HourVolumes()
 * @param {number} minVolume - Minimum volume threshold
 * @param {string} market - Which market to check: 'perp', 'spot', or 'both' (default: 'perp')
 * @returns {Array} Filtered results
 */
export function filterByVolume(volumeResults, minVolume, market = 'perp') {
  return volumeResults.filter(result => {
    const perpVol = typeof result.perpVolume === 'number' ? result.perpVolume : 0;
    const spotVol = typeof result.spotVolume === 'number' ? result.spotVolume : 0;

    switch (market) {
      case 'perp':
        return perpVol >= minVolume;
      case 'spot':
        return spotVol >= minVolume;
      case 'both':
        return perpVol >= minVolume && spotVol >= minVolume;
      case 'either':
        return perpVol >= minVolume || spotVol >= minVolume;
      default:
        return perpVol >= minVolume;
    }
  });
}

/**
 * Get symbols with volume above threshold
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Array<string>} perpSymbols - Array of perp symbols
 * @param {number} minVolume - Minimum volume threshold (default: 100000000 = 100M)
 * @param {Object} options - Options
 * @param {string} options.market - Which market to check: 'perp', 'spot', 'both', 'either' (default: 'perp')
 * @param {number} options.concurrency - Number of pairs to fetch concurrently (overrides config)
 * @param {number} options.delayBetweenBatches - Delay in ms between batches (overrides config)
 * @param {boolean} options.verbose - Whether to log progress (default: false)
 * @param {Object} options.config - Config object with rateLimit settings
 * @returns {Promise<Array>} Filtered results with high volume symbols
 */
export async function getHighVolumeSymbols(hyperliquid, perpSymbols, minVolume = 100000000, options = {}) {
  const { market = 'perp', concurrency, delayBetweenBatches, verbose = false, config } = options;

  // Fetch all volumes
  const volumes = await get24HourVolumes(hyperliquid, perpSymbols, {
    concurrency,
    delayBetweenBatches,
    verbose,
    config
  });

  // Filter by minimum volume
  return filterByVolume(volumes, minVolume, market);
}

/**
 * Calculate total volumes across all pairs
 * @param {Array} volumeResults - Results from get24HourVolumes()
 * @returns {Object} Total volumes: { totalPerpVolume, totalSpotVolume, perpCount, spotCount }
 */
export function calculateTotalVolumes(volumeResults) {
  let totalPerpVolume = 0;
  let totalSpotVolume = 0;
  let perpCount = 0;
  let spotCount = 0;

  for (const result of volumeResults) {
    if (typeof result.perpVolume === 'number') {
      totalPerpVolume += result.perpVolume;
      perpCount++;
    }
    if (typeof result.spotVolume === 'number') {
      totalSpotVolume += result.spotVolume;
      spotCount++;
    }
  }

  return {
    totalPerpVolume,
    totalSpotVolume,
    perpCount,
    spotCount
  };
}

/**
 * Format volume results as a table string
 * @param {Array} volumeResults - Results from get24HourVolumes()
 * @returns {string} Formatted table
 */
export function formatVolumeTable(volumeResults) {
  const lines = [];

  lines.push('┌──────────────┬──────────────┬────────────────────────┬────────────────────────┐');
  lines.push('│ Perp Symbol  │ Spot Symbol  │ Perp 24h Volume        │ Spot 24h Volume        │');
  lines.push('├──────────────┼──────────────┼────────────────────────┼────────────────────────┤');

  for (const result of volumeResults) {
    const perpVolStr = typeof result.perpVolume === 'number'
      ? result.perpVolume.toFixed(4).padStart(22)
      : result.perpVolume.toString().padStart(22);

    const spotVolStr = typeof result.spotVolume === 'number'
      ? result.spotVolume.toFixed(4).padStart(22)
      : result.spotVolume.toString().padStart(22);

    lines.push(
      `│ ${result.perpSymbol.padEnd(12)} │ ` +
      `${result.spotSymbol.padEnd(12)} │ ` +
      `${perpVolStr} │ ` +
      `${spotVolStr} │`
    );
  }

  lines.push('└──────────────┴──────────────┴────────────────────────┴────────────────────────┘');

  return lines.join('\n');
}

/**
 * Convert volume results to USDC using current prices
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Array} volumeResults - Results from get24HourVolumes()
 * @returns {Promise<Array>} Volume results with USDC values added
 */
export async function convertVolumesToUSDC(hyperliquid, volumeResults) {
  // Fetch all mid prices at once
  const allMids = await hyperliquid.getAllMids();

  // Convert string prices to numbers
  const priceMap = {};
  for (const [symbol, priceStr] of Object.entries(allMids)) {
    const price = parseFloat(priceStr);
    if (Number.isFinite(price) && price > 0) {
      priceMap[symbol] = price;
    }
  }

  // Add USDC conversions to each result
  const enrichedResults = volumeResults.map(result => {
    const perpVol = Number.isFinite(result.perpVolume) ? result.perpVolume : null;
    const spotVol = Number.isFinite(result.spotVolume) ? result.spotVolume : null;
    const price = priceMap[result.perpSymbol] || null;

    if (price === null || perpVol === null || spotVol === null) {
      return {
        ...result,
        price: null,
        perpVolUSDC: null,
        spotVolUSDC: null,
        totalVolUSDC: null
      };
    }

    const perpVolUSDC = perpVol * price;
    const spotVolUSDC = spotVol * price;
    const totalVolUSDC = perpVolUSDC + spotVolUSDC;

    return {
      ...result,
      price: price,
      perpVolUSDC: perpVolUSDC,
      spotVolUSDC: spotVolUSDC,
      totalVolUSDC: totalVolUSDC
    };
  });

  return enrichedResults;
}

/**
 * Filter volume results by USDC value
 * @param {Array} volumeResultsWithUSDC - Results from convertVolumesToUSDC()
 * @param {number} minVolumeUSDC - Minimum volume in USDC
 * @param {string} market - Which market to check: 'perp', 'spot', 'both', 'either', 'total' (default: 'total')
 * @returns {Array} Filtered results
 */
export function filterByVolumeUSDC(volumeResultsWithUSDC, minVolumeUSDC, market = 'total') {
  return volumeResultsWithUSDC.filter(result => {
    if (result.price === null) return false;

    const perpVolUSDC = result.perpVolUSDC || 0;
    const spotVolUSDC = result.spotVolUSDC || 0;
    const totalVolUSDC = result.totalVolUSDC || 0;

    switch (market) {
      case 'perp':
        return perpVolUSDC >= minVolumeUSDC;
      case 'spot':
        return spotVolUSDC >= minVolumeUSDC;
      case 'both':
        return perpVolUSDC >= minVolumeUSDC && spotVolUSDC >= minVolumeUSDC;
      case 'either':
        return perpVolUSDC >= minVolumeUSDC || spotVolUSDC >= minVolumeUSDC;
      case 'total':
      default:
        return totalVolUSDC >= minVolumeUSDC;
    }
  });
}

/**
 * Save volume results to CSV file
 * @param {Array} volumeResults - Results from get24HourVolumes()
 * @param {string} filepath - Path to save CSV file
 * @returns {string} CSV content
 */
export function toCSV(volumeResults) {
  const lines = ['perpSymbol,spotSymbol,perp24hVolume,spot24hVolume'];

  for (const result of volumeResults) {
    lines.push(
      `${result.perpSymbol},${result.spotSymbol},` +
      `${result.perpVolume},${result.spotVolume}`
    );
  }

  return lines.join('\n') + '\n';
}
