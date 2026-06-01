import HyperliquidConnector from '../hyperliquid.js';

/**
 * Convert PERP symbol to SPOT symbol
 * @param {string} perpSymbol - PERP symbol (e.g., 'BTC', 'ETH', 'SOL')
 * @returns {string} SPOT symbol (e.g., 'UBTC', 'UETH', 'USOL')
 */
export function perpToSpot(perpSymbol) {
  return HyperliquidConnector.perpToSpot(perpSymbol);
}

/**
 * Convert SPOT symbol to PERP symbol
 * @param {string} spotSymbol - SPOT symbol (e.g., 'UBTC', 'UETH', 'USOL')
 * @returns {string} PERP symbol (e.g., 'BTC', 'ETH', 'SOL')
 */
export function spotToPerp(spotSymbol) {
  return HyperliquidConnector.spotToPerp(spotSymbol);
}

/**
 * Get symbol for specific market type
 * @param {string} symbol - Input symbol (can be PERP or SPOT format)
 * @param {boolean} isSpot - Whether to get SPOT symbol (true) or PERP symbol (false)
 * @returns {string} Symbol in the requested format
 */
export function getSymbolForMarket(symbol, isSpot) {
  if (isSpot) {
    // If input is perp symbol, convert to spot
    return perpToSpot(symbol);
  } else {
    // If input is spot symbol, convert to perp
    return spotToPerp(symbol);
  }
}

/**
 * Check if a symbol has different PERP and SPOT names
 * @param {string} symbol - Symbol to check (either PERP or SPOT format)
 * @returns {boolean} True if PERP and SPOT symbols are different
 */
export function hasDifferentSymbols(symbol) {
  const perpSym = spotToPerp(symbol);
  const spotSym = perpToSpot(perpSym);
  return perpSym !== spotSym;
}

/**
 * Get all supported PERP symbols
 * @returns {Array<string>} Array of PERP symbols
 */
export function getAllPerpSymbols() {
  return Object.keys(HyperliquidConnector.PERP_TO_SPOT_MAP);
}

/**
 * Get all supported SPOT symbols
 * @returns {Array<string>} Array of SPOT symbols
 */
export function getAllSpotSymbols() {
  return Object.values(HyperliquidConnector.PERP_TO_SPOT_MAP);
}

/**
 * Get complete mapping
 * @returns {Object} Object with perpToSpot and spotToPerp mappings
 */
export function getMappings() {
  return {
    perpToSpot: { ...HyperliquidConnector.PERP_TO_SPOT_MAP },
    spotToPerp: { ...HyperliquidConnector.SPOT_TO_PERP_MAP }
  };
}

/**
 * Add custom symbol mapping
 * @param {string} perpSymbol - PERP symbol
 * @param {string} spotSymbol - SPOT symbol
 */
export function addMapping(perpSymbol, spotSymbol) {
  HyperliquidConnector.configureSymbolMapping({ perpToSpot: { [perpSymbol]: spotSymbol } });
}

/**
 * Format symbol pair for display
 * @param {string} perpSymbol - PERP symbol
 * @returns {string} Formatted pair (e.g., "BTC (PERP) / UBTC (SPOT)")
 */
export function formatSymbolPair(perpSymbol) {
  const spotSymbol = perpToSpot(perpSymbol);
  if (perpSymbol === spotSymbol) {
    return `${perpSymbol} (same on both markets)`;
  }
  return `${perpSymbol} (PERP) / ${spotSymbol} (SPOT)`;
}

// Default export with all functions
export default {
  perpToSpot,
  spotToPerp,
  getSymbolForMarket,
  hasDifferentSymbols,
  getAllPerpSymbols,
  getAllSpotSymbols,
  getMappings,
  addMapping,
  formatSymbolPair
};
