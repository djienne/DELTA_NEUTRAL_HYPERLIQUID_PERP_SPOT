import HyperliquidConnector from '../hyperliquid.js';

/**
 * Position Utilities
 *
 * Functions to fetch and analyze PERP and SPOT positions,
 * and identify delta-neutral hedges.
 *
 * Key concepts:
 * - PERP positions: Perpetual futures contracts (from clearinghouseState)
 * - SPOT positions: Spot token balances (from spotClearinghouseState)
 * - Delta neutral: Offsetting PERP and SPOT positions that hedge each other
 *   (e.g., SHORT 1 BTC perp + LONG 1 BTC spot)
 */

/**
 * Get PERP positions from clearinghouse state
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} user - User wallet address (optional, uses configured wallet)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object[]>} Array of PERP position objects
 */
export async function getPerpPositions(hyperliquid, user = null, options = {}) {
  const { verbose = false } = options;

  try {
    user = user || hyperliquid.wallet;

    if (!user) {
      throw new Error('User address required to fetch positions');
    }

    if (verbose) {
      console.log(`Fetching PERP positions for ${user}...`);
    }

    const data = await hyperliquid.infoRequest({
      type: 'clearinghouseState',
      user: user
    }, 2);

    // Get asset metadata to map positions to symbols
    const meta = await hyperliquid.getMeta();

    const positions = [];

    // Process asset positions
    if (data.assetPositions && data.assetPositions.length > 0) {
      for (const position of data.assetPositions) {
        const asset = position.position;
        const assetIndex = asset.coin;

        // Get symbol name from meta
        // asset.coin can be either a numeric index or a string name
        let assetInfo, symbol;
        if (typeof assetIndex === 'string') {
          // It's already the symbol name
          symbol = assetIndex;
          // Find the asset info by name
          assetInfo = meta.universe.find(a => a && a.name === assetIndex);
        } else {
          // It's a numeric index
          assetInfo = meta.universe[assetIndex];
          symbol = assetInfo ? assetInfo.name : `Asset${assetIndex}`;
        }

        // Parse position data
        const size = parseFloat(asset.szi);
        const entryPx = parseFloat(asset.entryPx || '0');
        const positionValue = parseFloat(asset.positionValue || '0');
        const unrealizedPnl = parseFloat(asset.unrealizedPnl || '0');
        const returnOnEquity = parseFloat(asset.returnOnEquity || '0');

        // Determine side (positive size = long, negative = short)
        const side = size > 0 ? 'LONG' : size < 0 ? 'SHORT' : 'NONE';

        positions.push({
          symbol: symbol,
          side: side,
          size: Math.abs(size),
          sizeRaw: size,
          entryPrice: entryPx,
          positionValue: Math.abs(positionValue),
          unrealizedPnl: unrealizedPnl,
          returnOnEquity: returnOnEquity * 100, // Convert to percentage
          leverage: parseFloat(asset.leverage?.value || '0'),
          liquidationPx: parseFloat(asset.liquidationPx || '0'),
          marginUsed: parseFloat(asset.marginUsed || '0')
        });
      }
    }

    if (verbose) {
      console.log(`✅ Found ${positions.length} PERP position(s)`);
    }

    return positions;

  } catch (error) {
    console.error('Error fetching PERP positions:', error.message);
    throw error;
  }
}

/**
 * Get SPOT balances from spot clearinghouse state
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} user - User wallet address (optional, uses configured wallet)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object[]>} Array of SPOT balance objects
 */
export async function getSpotBalances(hyperliquid, user = null, options = {}) {
  const { verbose = false, managedSpotSymbols = null } = options;
  const managedSet = managedSpotSymbols ? new Set(managedSpotSymbols) : null;

  try {
    user = user || hyperliquid.wallet;

    if (!user) {
      throw new Error('User address required to fetch balances');
    }

    if (verbose) {
      console.log(`Fetching SPOT balances for ${user}...`);
    }

    const data = await hyperliquid.infoRequest({
      type: 'spotClearinghouseState',
      user: user
    }, 2);

    const balances = [];

    // Process spot balances
    if (data.balances && data.balances.length > 0) {
      for (const balance of data.balances) {
        const coin = balance.coin;
        const total = parseFloat(balance.total || '0');
        const hold = parseFloat(balance.hold || '0');
        const available = total - hold;

        // Only include non-USDC balances with non-zero amounts
        if (coin !== 'USDC' && total > 0 && (!managedSet || managedSet.has(coin))) {
          balances.push({
            symbol: coin,
            total: total,
            hold: hold,
            available: available,
            token: balance.token
          });
        }
      }
    }

    if (verbose) {
      console.log(`✅ Found ${balances.length} SPOT balance(s) (excluding USDC)`);
    }

    return balances;

  } catch (error) {
    console.error('Error fetching SPOT balances:', error.message);
    throw error;
  }
}

/**
 * Get both PERP positions and SPOT balances
 *
 * @param {HyperliquidConnector} hyperliquid - Initialized Hyperliquid connector
 * @param {string} user - User wallet address (optional, uses configured wallet)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.verbose - Log progress to console
 * @returns {Promise<Object>} Object with perp and spot arrays
 */
export async function getAllPositions(hyperliquid, user = null, options = {}) {
  const { verbose = false } = options;

  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, user, { verbose }),
    getSpotBalances(hyperliquid, user, { verbose })
  ]);

  return {
    perp: perpPositions,
    spot: spotBalances
  };
}

/**
 * Identify delta-neutral positions
 * Matches PERP positions with corresponding SPOT balances
 *
 * @param {Object[]} perpPositions - Array of PERP positions from getPerpPositions
 * @param {Object[]} spotBalances - Array of SPOT balances from getSpotBalances
 * @returns {Object} Delta-neutral analysis
 */
export function analyzeDeltaNeutral(perpPositions, spotBalances, options = {}) {
  const { maxHedgeMismatchPercent = 30 } = options;
  const deltaNeutralPairs = [];
  const imbalancedPairs = [];
  const unmatchedPerp = [];
  const unmatchedSpot = [];

  // Create a map of PERP positions by symbol
  const perpMap = new Map();
  for (const position of perpPositions) {
    perpMap.set(position.symbol, position);
  }

  // Create a map of SPOT balances by symbol (convert to PERP symbol format)
  const spotMap = new Map();
  for (const balance of spotBalances) {
    // Convert spot symbol to perp symbol (UBTC -> BTC, UETH -> ETH, etc.)
    const perpSymbol = HyperliquidConnector.spotToPerp(balance.symbol);
    spotMap.set(perpSymbol, balance);
  }

  // Check each PERP position for matching SPOT balance
  for (const [symbol, perpPosition] of perpMap) {
    const spotBalance = spotMap.get(symbol);

    if (spotBalance) {
      // Calculate hedge ratio
      const perpSize = Math.abs(perpPosition.sizeRaw);
      const spotSize = spotBalance.total;
      const hedgeRatio = spotSize / perpSize;

      // Determine if this is a proper delta-neutral hedge
      // Delta neutral requires: SHORT perp + LONG spot OR LONG perp + SHORT spot
      const isDeltaNeutral = (perpPosition.side === 'SHORT' && spotSize > 0) ||
                              (perpPosition.side === 'LONG' && spotSize < 0);

      // Calculate mismatch percentage
      const sizeMismatch = Math.abs(perpSize - spotSize);
      const sizeMismatchPct = (sizeMismatch / perpSize) * 100;

      // Determine hedge quality
      let hedgeQuality = 'NONE';
      if (isDeltaNeutral) {
        if (sizeMismatchPct < 5) {
          hedgeQuality = 'PERFECT';
        } else if (sizeMismatchPct < 15) {
          hedgeQuality = 'GOOD';
        } else if (sizeMismatchPct < 30) {
          hedgeQuality = 'PARTIAL';
        } else {
          hedgeQuality = 'WEAK';
        }
      }

      const pair = {
        symbol: symbol,
        perpSide: perpPosition.side,
        perpSize: perpSize,
        spotSize: spotSize,
        hedgeRatio: hedgeRatio,
        sizeMismatch: sizeMismatch,
        sizeMismatchPct: sizeMismatchPct,
        isDeltaNeutral: isDeltaNeutral,
        hedgeQuality: hedgeQuality,
        perpPosition: perpPosition,
        spotBalance: spotBalance
      };

      if (isDeltaNeutral && sizeMismatchPct <= maxHedgeMismatchPercent) {
        deltaNeutralPairs.push(pair);
      } else {
        imbalancedPairs.push(pair);
      }

      // Remove from spotMap so we can track unmatched
      spotMap.delete(symbol);
    } else {
      // No matching spot balance
      unmatchedPerp.push(perpPosition);
    }
  }

  // Remaining spot balances are unmatched
  for (const [symbol, balance] of spotMap) {
    unmatchedSpot.push({
      symbol: HyperliquidConnector.perpToSpot(symbol), // Convert back to spot symbol
      balance: balance
    });
  }

  return {
    deltaNeutralPairs: deltaNeutralPairs,
    imbalancedPairs: imbalancedPairs,
    unmatchedPerp: unmatchedPerp,
    unmatchedSpot: unmatchedSpot,
    hasDeltaNeutral: deltaNeutralPairs.length > 0,
    perfectHedges: deltaNeutralPairs.filter(p => p.hedgeQuality === 'PERFECT').length,
    goodHedges: deltaNeutralPairs.filter(p => p.hedgeQuality === 'GOOD').length
  };
}

/**
 * Format positions for CSV export
 *
 * @param {Object[]} perpPositions - Array of PERP positions
 * @param {Object[]} spotBalances - Array of SPOT balances
 * @returns {string} CSV formatted string
 */
export function positionsToCSV(perpPositions, spotBalances) {
  const rows = [];

  // PERP positions header
  rows.push('PERP POSITIONS');
  rows.push('symbol,side,size,entryPrice,positionValue,unrealizedPnl,returnOnEquity,leverage,marginUsed');

  for (const pos of perpPositions) {
    rows.push(
      `${pos.symbol},${pos.side},${pos.size},${pos.entryPrice},${pos.positionValue},` +
      `${pos.unrealizedPnl},${pos.returnOnEquity.toFixed(2)},${pos.leverage},${pos.marginUsed}`
    );
  }

  rows.push('');
  rows.push('SPOT BALANCES');
  rows.push('symbol,total,hold,available');

  for (const bal of spotBalances) {
    rows.push(`${bal.symbol},${bal.total},${bal.hold},${bal.available}`);
  }

  return rows.join('\n');
}

/**
 * Format delta-neutral analysis for CSV export
 *
 * @param {Object} analysis - Delta-neutral analysis from analyzeDeltaNeutral
 * @returns {string} CSV formatted string
 */
export function deltaNeutralToCSV(analysis) {
  const headers = 'symbol,perpSide,perpSize,spotSize,hedgeRatio,sizeMismatch,sizeMismatchPct,isDeltaNeutral,hedgeQuality';

  const rows = analysis.deltaNeutralPairs.map(pair => {
    return `${pair.symbol},${pair.perpSide},${pair.perpSize},${pair.spotSize},` +
           `${pair.hedgeRatio.toFixed(4)},${pair.sizeMismatch.toFixed(6)},` +
           `${pair.sizeMismatchPct.toFixed(2)},${pair.isDeltaNeutral},${pair.hedgeQuality}`;
  });

  return [headers, ...rows].join('\n');
}
