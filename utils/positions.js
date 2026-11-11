import HyperliquidConnector from '../hyperliquid.js';
import { getSizeMismatchPercent } from './order-fill.js';

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

// The connector's minimum order size. Dust remains inventory, even when it cannot be traded alone.
export const MIN_NOTIONAL_USD = 10;

/** Price for logs: 6 significant figures, so $0.004968 (PUMP) and $84776.5 (BTC) both stay readable. */
export const formatPrice = p => Number.isFinite(p) ? String(Number(p.toPrecision(6))) : 'unknown';

export async function executableSize(hyperliquid, symbol, isSpot, size, price) {
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid exposure or price for ${symbol}`);
  }
  if (size * price < MIN_NOTIONAL_USD) return 0;
  const assetId = await hyperliquid.getAssetId(symbol, isSpot);
  const { szDecimals } = hyperliquid.getAssetInfo(symbol, assetId);
  if (size < 10 ** -szDecimals) return 0;
  const rounded = Number(hyperliquid.roundSize(size, szDecimals, 'down'));
  return rounded * price >= MIN_NOTIONAL_USD ? rounded : 0;
}

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
  const { verbose = false, managedPerpSymbols = null, includeDust = false } = options;
  const managedSet = managedPerpSymbols ? new Set(managedPerpSymbols) : null;

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
    if (!Array.isArray(data?.assetPositions)) throw new Error('Invalid perpetual account response');

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

        if ((!managedSet || managedSet.has(symbol)) && (!Number.isFinite(size) || !Number.isFinite(positionValue))) {
          throw new Error(`Invalid perpetual exposure for ${symbol}`);
        }
        if ((!managedSet || managedSet.has(symbol)) && size !== 0 && (includeDust || Math.abs(positionValue) >= MIN_NOTIONAL_USD)) {
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
  const { verbose = false, managedSpotSymbols = null, includeDust = false } = options;
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
    if (!Array.isArray(data?.balances)) throw new Error('Invalid spot account response');

    const balances = [];
    // Spot tokens are priced with their perp mid (same underlying; basis is filtered to <= 0.5%).
    const mids = await hyperliquid.getAllMids();

    // Process spot balances
    if (data.balances && data.balances.length > 0) {
      for (const balance of data.balances) {
        const coin = balance.coin;
        const total = parseFloat(balance.total || '0');
        const hold = parseFloat(balance.hold || '0');
        const available = total - hold;
        if ((!managedSet || managedSet.has(coin)) && (!Number.isFinite(total) || !Number.isFinite(hold) || total < 0 || hold < 0 || hold > total)) {
          throw new Error(`Invalid spot exposure for ${coin}`);
        }
        const price = parseFloat(mids[HyperliquidConnector.spotToPerp(coin)]);
        const valueUSD = total * price;

        // Only non-USDC balances worth at least MIN_NOTIONAL_USD (unknown price is kept, not dropped)
        if (coin !== 'USDC' && total > 0 && (!managedSet || managedSet.has(coin)) &&
            (includeDust || !(valueUSD < MIN_NOTIONAL_USD))) {
          balances.push({
            symbol: coin,
            total: total,
            hold: hold,
            available: available,
            price: Number.isFinite(price) ? price : null,
            valueUSD: Number.isFinite(valueUSD) ? valueUSD : null,
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
 * Identify delta-neutral positions
 * Matches PERP positions with corresponding SPOT balances
 *
 * @param {Object[]} perpPositions - Array of PERP positions from getPerpPositions
 * @param {Object[]} spotBalances - Array of SPOT balances from getSpotBalances
 * @returns {Object} Delta-neutral analysis
 */
export function analyzeDeltaNeutral(perpPositions, spotBalances, options = {}) {
  const { maxHedgeMismatchPercent = 2 } = options;
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
      const perpSize = Math.abs(perpPosition.sizeRaw);
      const spotSize = spotBalance.total;

      // Spot balances are long-only in this bot. LONG perp + LONG spot is directional.
      const isDeltaNeutral = perpPosition.side === 'SHORT' && spotSize > 0;
      const imbalanceType = isDeltaNeutral
        ? (perpSize > spotSize ? 'EXCESS_PERP_SHORT' : (spotSize > perpSize ? 'EXCESS_SPOT_LONG' : 'BALANCED'))
        : (perpPosition.side === 'LONG' && spotSize > 0 ? 'DOUBLE_LONG' : 'UNSUPPORTED');

      // Calculate mismatch percentage
      const sizeMismatch = Math.abs(perpSize - spotSize);
      const sizeMismatchPct = getSizeMismatchPercent(perpSize, spotSize);

      const pair = {
        symbol: symbol,
        perpSide: perpPosition.side,
        perpSize: perpSize,
        spotSize: spotSize,
        sizeMismatch: sizeMismatch,
        sizeMismatchPct: sizeMismatchPct,
        isDeltaNeutral: isDeltaNeutral,
        imbalanceType: imbalanceType,
        perpPosition: perpPosition,
        spotBalance: spotBalance
      };

      if (isDeltaNeutral && sizeMismatchPct <= maxHedgeMismatchPercent + 1e-9) {
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
    unmatchedSpot: unmatchedSpot
  };
}
