import fs from 'fs';
import path from 'path';

/**
 * State Management Utilities
 *
 * Manages persistent state for the delta-neutral bot.
 * Tracks open positions, entry times, and position metadata.
 */

const DEFAULT_STATE_FILE = './bot-state.json';

export function getStateFilePath() {
  return process.env.BOT_STATE_FILE || DEFAULT_STATE_FILE;
}

/**
 * Default state structure
 */
const DEFAULT_STATE = {
  version: '1.0',
  position: null,  // Current position, or null if no position
  pendingIntent: null,
  lastCheckTime: null,
  lastOpportunityCheck: null,
  history: []  // Historical positions
};

const DEFAULT_MAX_HISTORY = 500;

function compactOrderResult(result) {
  const status = result?.response?.data?.statuses?.[0] || {};
  const filled = status.filled || null;

  return {
    status: result?.status,
    error: status.error || null,
    oid: filled?.oid || null,
    avgPx: filled?.avgPx !== undefined ? parseFloat(filled.avgPx) : null,
    totalSz: filled?.totalSz !== undefined ? parseFloat(filled.totalSz) : null
  };
}

function compactPositionData(positionData) {
  return {
    success: positionData.success,
    symbol: positionData.symbol,
    perpSymbol: positionData.perpSymbol,
    spotSymbol: positionData.spotSymbol,
    perpSize: positionData.perpSize,
    spotSize: positionData.spotSize,
    perpEntryPrice: positionData.perpEntryPrice,
    spotEntryPrice: positionData.spotEntryPrice,
    positionValue: positionData.positionValue,
    fundingRate: positionData.fundingRate,
    annualizedFunding: positionData.annualizedFunding,
    accountingComplete: positionData.accountingComplete !== false,
    openFeesActual: positionData.openFeesActual || 0,
    openFeesEstimated: positionData.openFeesEstimated || 0,
    orderSummary: {
      perp: compactOrderResult(positionData.perpResult),
      spot: compactOrderResult(positionData.spotResult)
    }
  };
}

/**
 * Load bot state from disk
 * @returns {Object} State object
 */
export function loadState() {
  const stateFile = getStateFilePath();
  try {
    if (fs.existsSync(stateFile)) {
      const data = fs.readFileSync(stateFile, 'utf8');
      const state = JSON.parse(data);

      // Ensure all required fields exist (handle old versions)
      return {
        ...DEFAULT_STATE,
        ...state
      };
    }
  } catch (error) {
    console.error('[State] Error loading state:', error.message);
    if (fs.existsSync(stateFile)) {
      const corruptPath = `${stateFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(stateFile, corruptPath);
        console.error(`[State] Corrupt state moved to ${corruptPath}`);
      } catch (renameError) {
        console.error('[State] Failed to quarantine corrupt state:', renameError.message);
      }
    }
  }

  // Return default state if file doesn't exist or error occurred
  return { ...DEFAULT_STATE };
}

/**
 * Crash-safe JSON write: temp file + fsync + rename, so a reader (or a restart) never sees a half-written file.
 * Shared by the bot state, the rebalance status file and the paper-trading ledger.
 */
export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);

  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpFile, file);

  if (dir && dir !== '.') {
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best-effort on Windows.
    }
  }
}

/**
 * Save bot state to disk
 * @param {Object} state - State object to save
 */
export function saveState(state) {
  try {
    writeJsonAtomic(getStateFilePath(), state);
  } catch (error) {
    console.error('[State] Error saving state:', error.message);
    throw error;
  }
}

/**
 * Get current position from state
 * @param {Object} state - State object
 * @returns {Object|null} Current position or null
 */
export function getCurrentPosition(state) {
  return state.position;
}

/**
 * Check if bot has an open position
 * @param {Object} state - State object
 * @returns {boolean} True if position exists
 */
export function hasPosition(state) {
  return state.position !== null;
}

/**
 * Record new position in state
 * @param {Object} state - State object
 * @param {Object} positionData - Position data
 * @returns {Object} Updated state
 */
export function recordPosition(state, positionData) {
  const position = {
    ...compactPositionData(positionData),
    openTime: Object.hasOwn(positionData, 'openTime') ? positionData.openTime : Date.now(),
    lastCheckTime: Date.now()
  };

  return {
    ...state,
    position: position,
    pendingIntent: null,
    lastOpportunityCheck: Date.now()
  };
}

export function setPendingIntent(state, intent) {
  return {
    ...state,
    pendingIntent: {
      ...intent,
      createdAt: intent.createdAt || Date.now()
    }
  };
}

export function clearPendingIntent(state) {
  return {
    ...state,
    pendingIntent: null
  };
}

/**
 * Close current position and move to history
 * @param {Object} state - State object
 * @param {Object} closeData - Data about position close
 * @returns {Object} Updated state
 */
export function closePosition(state, closeData) {
  if (!state.position) {
    return state;
  }

  const pricePnl = Object.hasOwn(closeData, 'pricePnl') ? closeData.pricePnl :
    [closeData.perpPnl, closeData.spotPnl].every(Number.isFinite) ? closeData.perpPnl + closeData.spotPnl : null;

  // Move position to history
  const historicalPosition = {
    ...state.position,
    closeTime: Date.now(),
    closeReason: closeData.reason,
    perpClosePrice: closeData.perpClosePrice,
    spotClosePrice: closeData.spotClosePrice,
    perpPnl: closeData.perpPnl,
    spotPnl: closeData.spotPnl,
    pricePnl,
    fundingPnl: closeData.fundingPnl ?? null,
    accountingComplete: closeData.accountingComplete !== false && Number.isFinite(closeData.totalPnl),
    residualInventory: closeData.residualInventory ?? null,
    closeFills: closeData.closeFills ?? null,
    feesActual: closeData.feesActual || 0,
    feesEstimated: closeData.feesEstimated || 0,
    pnl: {
      price: pricePnl,
      funding: closeData.fundingPnl ?? null,
      feesActual: closeData.feesActual || 0,
      feesEstimated: closeData.feesEstimated || 0,
      total: closeData.totalPnl
    },
    totalPnl: closeData.totalPnl,
    duration: Number.isFinite(state.position.openTime) ? Date.now() - state.position.openTime : null
  };

  return {
    ...state,
    position: null,
    pendingIntent: null,
    history: [...state.history, historicalPosition].slice(-(state.maxHistory || DEFAULT_MAX_HISTORY)),
    lastCheckTime: Date.now()
  };
}

/**
 * Update position check time
 * @param {Object} state - State object
 * @returns {Object} Updated state
 */
export function updateCheckTime(state) {
  return {
    ...state,
    lastCheckTime: Date.now(),
    ...(state.position ? {
      position: {
        ...state.position,
        lastCheckTime: Date.now()
      }
    } : {})
  };
}

/**
 * Get position age in milliseconds
 * @param {Object} position - Position object
 * @returns {number} Age in milliseconds
 */
export function getPositionAge(position) {
  if (!position || !Number.isFinite(position.openTime)) {
    return 0;
  }

  return Date.now() - position.openTime;
}

/**
 * Check if position meets minimum hold time
 * @param {Object} position - Position object
 * @param {number} minHoldTimeMs - Minimum hold time in milliseconds
 * @returns {boolean} True if can close
 */
export function canClosePosition(position, minHoldTimeMs) {
  // Unknown opening time (adopted position): hold from adoption, so it can still be switched later
  const since = Number.isFinite(position?.openTime) ? position.openTime : position?.adoptedAt;
  if (!Number.isFinite(since)) {
    return false;
  }

  return Date.now() - since >= minHoldTimeMs;
}

/**
 * Format position for display
 * @param {Object} position - Position object
 * @returns {string} Formatted string
 */
export function formatPosition(position) {
  if (!position) {
    return 'No position';
  }

  const age = getPositionAge(position);
  const ageHours = (age / (1000 * 60 * 60)).toFixed(1);
  const ageDays = (age / (1000 * 60 * 60 * 24)).toFixed(2);

  return `
Position: ${position.symbol} Delta-Neutral
  PERP: SHORT ${position.perpSize} @ $${position.perpEntryPrice}
  SPOT: LONG ${position.spotSize} @ $${position.spotEntryPrice}
  Funding Rate at entry: ${position.fundingRate == null ? 'unknown' : (position.fundingRate * 100).toFixed(4) + '%'} (${position.annualizedFunding == null ? 'unknown' : (position.annualizedFunding * 100).toFixed(2) + '% annualized'})
  Open Time: ${Number.isFinite(position.openTime) ? new Date(position.openTime).toLocaleString() : 'unknown'}
  Age: ${ageHours}h (${ageDays} days)
  Position Value: $${position.positionValue?.toFixed(2) || 'N/A'}
`.trim();
}

/**
 * Get statistics from history
 * @param {Object} state - State object
 * @returns {Object} Statistics
 */
export function getHistoryStats(state) {
  if (!state.history || state.history.length === 0) {
    return {
      totalPositions: 0,
      totalPnl: 0,
      unavailablePnlCount: 0,
      avgDuration: 0,
      avgFundingRate: 0
    };
  }

  const totalPositions = state.history.length;
  const known = state.history.filter(p => p.accountingComplete !== false && Number.isFinite(p.pnl?.total ?? p.totalPnl));
  const totalPnl = known.reduce((sum, p) => sum + (p.pnl?.total ?? p.totalPnl), 0);
  const durations = state.history.map(p => p.duration).filter(Number.isFinite);
  const fundingRates = state.history.map(p => p.annualizedFunding).filter(Number.isFinite);
  const avgDuration = durations.length ? durations.reduce((sum, n) => sum + n, 0) / durations.length : null;
  const avgFundingRate = fundingRates.length ? fundingRates.reduce((sum, n) => sum + n, 0) / fundingRates.length : null;

  return {
    totalPositions,
    totalPnl,
    unavailablePnlCount: totalPositions - known.length,
    avgDuration,
    avgDurationDays: avgDuration === null ? null : avgDuration / (1000 * 60 * 60 * 24),
    avgFundingRate: avgFundingRate === null ? null : avgFundingRate * 100
  };
}
