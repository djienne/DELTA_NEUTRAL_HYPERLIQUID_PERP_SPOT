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
  return config.risk?.maxHedgeMismatchPercent ?? 30;
}

export function getMaxOpenHedgeMismatchPercent(config = {}) {
  return config.risk?.maxOpenHedgeMismatchPercent ?? 2;
}

export function getTakerFeeRate(config = {}) {
  return config.trading?.takerFeeRate ?? config.fees?.takerFeeRate ?? 0;
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

export function filterManagedSpotBalances(spotBalances, managedSpotSymbols) {
  if (!managedSpotSymbols || managedSpotSymbols.size === 0) {
    return spotBalances;
  }

  return spotBalances.filter(balance => managedSpotSymbols.has(balance.symbol));
}
