import HyperliquidConnector from '../hyperliquid.js';

export function getMaxBidAskSpreadPercent(thresholds = {}) {
  return thresholds.maxSpreadPercent ??
    thresholds.maxBidAskSpreadPercent ??
    0.15;
}

export function getMinFillRatio(config = {}) {
  return config.risk?.minFillRatio ?? 0.999;
}

export function getMaxHedgeMismatchPercent(config = {}) {
  return config.risk?.maxHedgeMismatchPercent ?? 2;
}

export function getMaxOpenHedgeMismatchPercent(config = {}) {
  return Math.min(config.risk?.maxOpenHedgeMismatchPercent ?? 2, getMaxHedgeMismatchPercent(config));
}

// Taker fee per leg (fraction of notional). Defaults are Hyperliquid base tier: perp 0.045%, spot 0.07%.
export function getTakerFees(config = {}) {
  return {
    perp: config.trading?.takerFeeRate ?? 0.00045,
    spot: config.trading?.spotTakerFeeRate ?? 0.0007
  };
}

export function getStartupCleanupMode(config = {}) {
  const mode = config.risk?.startupCleanupMode ?? 'hedge-only';
  const allowedModes = new Set(['report-only', 'hedge-only', 'hedge-or-close']);

  return allowedModes.has(mode) ? mode : 'hedge-only';
}

export function getManagedSpotSymbols(config = {}, currentPosition = null) {
  const managed = new Set(config.risk?.managedSpotSymbols || []);

  for (const pair of config.trading?.pairs || []) {
    managed.add(HyperliquidConnector.perpToSpot(pair));
  }

  if (currentPosition?.spotSymbol) {
    managed.add(currentPosition.spotSymbol);
  }

  return managed;
}

export function getManagedPerpSymbols(config = {}, currentPosition = null) {
  const managed = new Set(config.risk?.managedPerpSymbols || []);

  for (const pair of config.trading?.pairs || []) {
    managed.add(pair);
  }

  if (currentPosition?.perpSymbol || currentPosition?.symbol) {
    managed.add(currentPosition.perpSymbol || currentPosition.symbol);
  }

  return managed;
}
