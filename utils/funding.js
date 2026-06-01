import HyperliquidConnector from '../hyperliquid.js';

/**
 * Funding Rate Utilities
 *
 * Functions to fetch and analyze perpetual funding rates from Hyperliquid.
 *
 * Key concepts:
 * - Funding rates are ONLY available for PERP symbols (not SPOT)
 * - Hyperliquid pays funding every hour (24 times per day)
 * - Annualized rate = hourly_rate × 24 hours × 365 days
 * - Funding can be positive (longs pay shorts) or negative (shorts pay longs)
 */

/**
 * Fetch current funding rates for all perpetual symbols
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Map<string, Object>>} Map of symbol -> funding info
 */
export async function getAllFundingRates(hyperliquid, options = {}) {
  const { verbose = false } = options;

  try {
    if (verbose) {
      console.log('Fetching funding rates from Hyperliquid API...');
    }

    // Fetch meta and asset context which includes funding rates
    const data = await hyperliquid.infoRequest({
      type: 'metaAndAssetCtxs'
    }, 20);

    // Extract funding rates from the response
    // The structure is: data = [meta, assetCtxs]
    // meta contains the universe of assets
    // assetCtxs contains current context including funding rates

    const fundingMap = new Map();

    if (data && data.length >= 2) {
      const meta = data[0];
      const assetCtxs = data[1];

      // Match assets with their funding rates
      for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i];
        const assetCtx = assetCtxs[i];

        if (asset && assetCtx && assetCtx.funding) {
          fundingMap.set(asset.name, {
            symbol: asset.name,
            fundingRate: parseFloat(assetCtx.funding),
            // Annualize: hourly rate × 24 hours × 365 days
            annualizedRate: parseFloat(assetCtx.funding) * 24 * 365,
            // Keep the raw context for additional info
            ctx: assetCtx
          });
        }
      }
    }

    if (verbose) {
      console.log(`✅ Fetched funding rates for ${fundingMap.size} perpetual symbols`);
    }

    return fundingMap;

  } catch (error) {
    console.error('Error fetching funding rates:', error.message);
    throw error;
  }
}

/**
 * Get funding rates for specific perpetual symbols
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string[]} symbols - Array of PERP symbols (e.g., ['BTC', 'ETH', 'SOL'])
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object[]>} Array of funding rate objects
 */
export async function getFundingRates(hyperliquid, symbols, options = {}) {
  const { verbose = false } = options;

  const allRates = await getAllFundingRates(hyperliquid, { verbose });

  const results = [];

  for (const symbol of symbols) {
    if (allRates.has(symbol)) {
      results.push(allRates.get(symbol));
    } else {
      results.push({
        symbol: symbol,
        fundingRate: null,
        annualizedRate: null,
        error: `No funding rate data for ${symbol}`
      });
    }
  }

  return results;
}

/**
 * Sort funding rates by annualized rate (highest first)
 * Filters out symbols with errors
 *
 * @param {Object[]} fundingRates - Array of funding rate objects
 * @param {boolean} descending - Sort descending (highest first) if true
 * @returns {Object[]} Sorted array of funding rate objects
 */
export function sortByAnnualizedRate(fundingRates, descending = true) {
  // Filter out entries with errors
  const validRates = fundingRates.filter(r => r.annualizedRate !== null && r.error === undefined);

  // Sort by annualized rate
  validRates.sort((a, b) => {
    if (descending) {
      return b.annualizedRate - a.annualizedRate; // Highest first
    } else {
      return a.annualizedRate - b.annualizedRate; // Lowest first
    }
  });

  return validRates;
}

/**
 * Format funding rates for CSV export
 *
 * @param {Object[]} fundingRates - Array of funding rate objects
 * @returns {string} CSV formatted string
 */
export function fundingRatesToCSV(fundingRates) {
  const headers = 'symbol,hourlyFundingRate,annualizedRatePercent,error';

  const rows = fundingRates.map(r => {
    const hourlyRate = r.fundingRate !== null ? r.fundingRate : '';
    const annualizedPct = r.annualizedRate !== null ? (r.annualizedRate * 100).toFixed(4) : '';
    const error = r.error || '';

    return `${r.symbol},${hourlyRate},${annualizedPct},${error}`;
  });

  return [headers, ...rows].join('\n');
}

/**
 * Filter funding rates by annualized rate threshold
 *
 * @param {Object[]} fundingRates - Array of funding rate objects
 * @param {number} thresholdPercent - Threshold in percent (e.g., 10 for 10%)
 * @returns {Object} Object with high and low funding rate arrays
 */
export function filterByAnnualizedRate(fundingRates, thresholdPercent) {
  const thresholdDecimal = thresholdPercent / 100; // Convert 10% to 0.10

  const high = fundingRates.filter(r =>
    r.annualizedRate !== null &&
    Math.abs(r.annualizedRate) >= thresholdDecimal
  );

  const low = fundingRates.filter(r =>
    r.annualizedRate !== null &&
    Math.abs(r.annualizedRate) < thresholdDecimal
  );

  return { high, low };
}

/**
 * Fetch historical funding rates for a specific coin
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} coin - Coin symbol (e.g., 'BTC')
 * @param {number} days - Number of days of history (default 7)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object>} Object with funding history data
 */
export async function getFundingHistory(hyperliquid, coin, days = 7, options = {}) {
  const { verbose = false } = options;

  try {
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

    if (verbose) {
      console.log(`Fetching ${days}-day funding history for ${coin}...`);
    }

    const data = await hyperliquid.infoRequest({
      type: 'fundingHistory',
      coin: coin,
      startTime: startTime
    }, 20);

    if (verbose) {
      console.log(`✅ Fetched ${data.length} funding rate entries for ${coin}`);
    }

    return {
      coin: coin,
      history: data,
      startTime: startTime,
      endTime: Date.now(),
      days: days
    };

  } catch (error) {
    console.error(`Error fetching funding history for ${coin}:`, error.message);
    throw error;
  }
}

/**
 * Calculate average funding rate from history
 *
 * @param {Object[]} history - Array of funding history entries
 * @returns {Object} Statistics object with avg, min, max
 */
export function calculateFundingStats(history) {
  if (!history || history.length === 0) {
    return {
      count: 0,
      avgHourly: null,
      avgAnnualized: null,
      minHourly: null,
      maxHourly: null,
      minAnnualized: null,
      maxAnnualized: null
    };
  }

  const rates = history.map(h => parseFloat(h.fundingRate));

  const sum = rates.reduce((acc, r) => acc + r, 0);
  const avgHourly = sum / rates.length;
  const avgAnnualized = avgHourly * 24 * 365;

  const minHourly = Math.min(...rates);
  const maxHourly = Math.max(...rates);
  const minAnnualized = minHourly * 24 * 365;
  const maxAnnualized = maxHourly * 24 * 365;

  return {
    count: rates.length,
    avgHourly: avgHourly,
    avgAnnualized: avgAnnualized,
    minHourly: minHourly,
    maxHourly: maxHourly,
    minAnnualized: minAnnualized,
    maxAnnualized: maxAnnualized
  };
}

/**
 * Fetch PREDICTED funding rates for all perpetual symbols
 * This returns the NEXT funding rate that will be applied, not the current/historical rate
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Map<string, Object>>} Map of symbol -> predicted funding info
 */
export async function getPredictedFundingRates(hyperliquid, options = {}) {
  const { verbose = false } = options;

  try {
    if (verbose) {
      console.log('Fetching PREDICTED funding rates from Hyperliquid API...');
    }

    // Fetch predicted fundings
    const data = await hyperliquid.infoRequest({
      type: 'predictedFundings'
    }, 20);

    // Extract predicted funding rates from the response
    // The structure is: data = [[coin, [[exchange, {fundingRate, nextFundingTime}], ...]], ...]
    // We want the "HlPerp" exchange data for each coin

    const fundingMap = new Map();

    for (const [coin, exchanges] of data) {
      // Find HlPerp exchange data
      const hlPerpData = exchanges.find(([exchange]) => exchange === 'HlPerp');

      if (hlPerpData && hlPerpData[1]) {
        const { fundingRate, nextFundingTime } = hlPerpData[1];
        const parsedFundingRate = parseFloat(fundingRate);

        if (!Number.isFinite(parsedFundingRate)) {
          if (verbose) {
            console.warn(`Skipping ${coin}: invalid predicted funding rate ${fundingRate}`);
          }
          continue;
        }

        fundingMap.set(coin, {
          symbol: coin,
          predictedFundingRate: parsedFundingRate,
          // Annualize: hourly rate x 24 hours x 365 days
          predictedAnnualizedRate: parsedFundingRate * 24 * 365,
          nextFundingTime: nextFundingTime,
          nextFundingDate: new Date(nextFundingTime)
        });
      }
    }

    if (verbose) {
      console.log(`✅ Fetched predicted funding rates for ${fundingMap.size} perpetual symbols`);
    }

    return fundingMap;

  } catch (error) {
    console.error('Error fetching predicted funding rates:', error.message);
    throw error;
  }
}

/**
 * Combine current (historical) and predicted funding rates for symbols
 * This provides a complete view of both what was just paid and what will be paid next
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string[]} symbols - Array of PERP symbols
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object[]>} Array of funding rate objects with both current and predicted rates
 */
export async function getCombinedFundingRates(hyperliquid, symbols, options = {}) {
  const { verbose = false } = options;

  // Fetch both current and predicted rates in parallel
  const [currentRates, predictedRates] = await Promise.all([
    getAllFundingRates(hyperliquid, { verbose }),
    getPredictedFundingRates(hyperliquid, { verbose })
  ]);

  const results = [];

  for (const symbol of symbols) {
    const current = currentRates.get(symbol);
    const predicted = predictedRates.get(symbol);

    if (!current && !predicted) {
      results.push({
        symbol: symbol,
        error: `No funding rate data for ${symbol}`
      });
      continue;
    }

    results.push({
      symbol: symbol,
      // Current (historical) rate - what was just paid
      currentFundingRate: current?.fundingRate || null,
      currentAnnualizedRate: current?.annualizedRate || null,
      // Predicted rate - what will be paid next
      predictedFundingRate: predicted?.predictedFundingRate || null,
      predictedAnnualizedRate: predicted?.predictedAnnualizedRate || null,
      nextFundingTime: predicted?.nextFundingTime || null,
      nextFundingDate: predicted?.nextFundingDate || null,
      // Calculate the change from current to predicted
      fundingRateChange: (predicted?.predictedFundingRate && current?.fundingRate)
        ? predicted.predictedFundingRate - current.fundingRate
        : null,
      annualizedRateChange: (predicted?.predictedAnnualizedRate && current?.annualizedRate)
        ? predicted.predictedAnnualizedRate - current.annualizedRate
        : null
    });
  }

  return results;
}

/**
 * Get current funding rate with 7-day historical statistics
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string[]} symbols - Array of PERP symbols
 * @param {Object} options - Optional parameters
 * @param {number} options.days - Number of days of history (default 7)
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object[]>} Array of funding rate objects with history
 */
export async function getFundingRatesWithHistory(hyperliquid, symbols, options = {}) {
  const { days = 7, verbose = false } = options;

  // Get current rates
  const currentRates = await getFundingRates(hyperliquid, symbols, { verbose });

  // Fetch history for each symbol
  const results = [];

  for (const current of currentRates) {
    if (current.error) {
      results.push(current);
      continue;
    }

    try {
      const historyData = await getFundingHistory(hyperliquid, current.symbol, days, { verbose: false });
      const stats = calculateFundingStats(historyData.history);

      results.push({
        ...current,
        history: {
          days: days,
          count: stats.count,
          avg: {
            hourly: stats.avgHourly,
            annualized: stats.avgAnnualized
          },
          min: {
            hourly: stats.minHourly,
            annualized: stats.minAnnualized
          },
          max: {
            hourly: stats.maxHourly,
            annualized: stats.maxAnnualized
          },
          // Compare current to average
          vsCurrent: {
            hourlyDiff: current.fundingRate - stats.avgHourly,
            annualizedDiff: current.annualizedRate - stats.avgAnnualized,
            percentChange: stats.avgHourly !== 0
              ? ((current.fundingRate - stats.avgHourly) / stats.avgHourly) * 100
              : 0
          }
        }
      });

      if (verbose) {
        console.log(`  ${current.symbol}: Current ${(current.annualizedRate * 100).toFixed(2)}% vs 7d avg ${(stats.avgAnnualized * 100).toFixed(2)}%`);
      }

    } catch (error) {
      results.push({
        ...current,
        historyError: error.message
      });
    }
  }

  return results;
}

/**
 * Format funding rates with history for CSV export
 *
 * @param {Object[]} fundingRates - Array of funding rate objects with history
 * @returns {string} CSV formatted string
 */
export function fundingRatesWithHistoryToCSV(fundingRates) {
  const headers = 'symbol,currentHourly,currentAnnualizedPct,avg7dHourly,avg7dAnnualizedPct,min7dAnnualizedPct,max7dAnnualizedPct,vsAvgPctChange,error';

  const rows = fundingRates.map(r => {
    const currentHourly = r.fundingRate !== null ? r.fundingRate : '';
    const currentAnnPct = r.annualizedRate !== null ? (r.annualizedRate * 100).toFixed(4) : '';

    let avg7dHourly = '';
    let avg7dAnnPct = '';
    let min7dAnnPct = '';
    let max7dAnnPct = '';
    let vsAvgPct = '';

    if (r.history) {
      avg7dHourly = r.history.avg.hourly || '';
      avg7dAnnPct = r.history.avg.annualized !== null ? (r.history.avg.annualized * 100).toFixed(4) : '';
      min7dAnnPct = r.history.min.annualized !== null ? (r.history.min.annualized * 100).toFixed(4) : '';
      max7dAnnPct = r.history.max.annualized !== null ? (r.history.max.annualized * 100).toFixed(4) : '';
      vsAvgPct = r.history.vsCurrent.percentChange !== null ? r.history.vsCurrent.percentChange.toFixed(2) : '';
    }

    const error = r.error || r.historyError || '';

    return `${r.symbol},${currentHourly},${currentAnnPct},${avg7dHourly},${avg7dAnnPct},${min7dAnnPct},${max7dAnnPct},${vsAvgPct},${error}`;
  });

  return [headers, ...rows].join('\n');
}
