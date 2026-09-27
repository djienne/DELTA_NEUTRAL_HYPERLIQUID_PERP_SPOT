import HyperliquidConnector from './hyperliquid.js';
import { loadState, saveState, hasPosition, getCurrentPosition, recordPosition, closePosition as closePositionState, updateCheckTime, canClosePosition, getPositionAge, formatPosition, getHistoryStats, setPendingIntent, clearPendingIntent, getStateFilePath, writeJsonAtomic } from './utils/state.js';
import { checkAndReportBalances } from './utils/balance.js';
import { findBestOpportunities } from './utils/opportunity.js';
import { getPerpPositions, getSpotBalances, analyzeDeltaNeutral } from './utils/positions.js';
import { openDeltaNeutralPosition, closeDeltaNeutralPosition } from './utils/trade.js';
import { logStatistics } from './utils/statistics.js';
import { autoHedgeAll, analyzeHedgeNeeds, formatHedgeReport } from './utils/hedge.js';
import { getFundingRates } from './utils/funding.js';
import { get24HourVolumes } from './utils/volume.js';
import { getPerpSpotSpreads } from './utils/arbitrage.js';
import { getManagedPerpSymbols, getManagedSpotSymbols, getMaxHedgeMismatchPercent, getStartupCleanupMode } from './utils/risk.js';
import { getCurrentPositionFundingSignal, switchEdge } from './utils/position-decision.js';
import { PaperConnector } from './utils/paper-exchange.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Delta-Neutral Trading Bot
 *
 * Automatically opens and manages delta-neutral positions to earn funding rate arbitrage.
 *
 * Strategy:
 * - SHORT PERP + LONG SPOT to earn positive funding
 * - Check cycle: Every 1 hour
 * - Decisions on 7-day average funding; switch only when the expected gain beats fees + spread
 *   (utils/position-decision.js switchEdge), after a minimum hold unless funding is negative
 */

/**
 * Exponential backoff retry for rate limit errors (429)
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Options
 * @returns {Promise} Result of the function
 */
async function retryWithExponentialBackoff(fn, options = {}) {
  const {
    maxRetries = 5,
    initialDelay = 1000,
    maxDelay = 30000,
    onRetry = null
  } = options;

  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Check if it's a rate limit error (429)
      const is429 = error.message?.includes('429') ||
                    error.message?.includes('Too Many Requests') ||
                    error.message?.includes('rate limit');

      if (!is429 || attempt === maxRetries) {
        throw error; // Not a rate limit error or out of retries
      }

      // Calculate next delay with exponential backoff
      const nextDelay = Math.min(delay * 2, maxDelay);

      if (onRetry) {
        onRetry(attempt + 1, maxRetries, delay, error);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = nextDelay;
    }
  }
}

// Configuration
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
HyperliquidConnector.configureSymbolMapping(config.symbolMapping || {});

// PAPER_TRADING=1: same bot, simulated account (utils/paper-exchange.js). Paper state always lives in ./data-paper/,
// whatever BOT_STATE_FILE says (e.g. the live service's), so paper can never write into the live state.
const PAPER = process.env.PAPER_TRADING === '1';
if (PAPER) {
  process.env.BOT_STATE_FILE = './data-paper/bot-state.json';
}

// Bot parameters
const CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const MIN_HOLD_TIME_MS = process.env.MIN_HOLD_TIME_MS
  ? parseInt(process.env.MIN_HOLD_TIME_MS)
  : (config.bot?.minHoldTimeDays ?? 7) * 24 * 60 * 60 * 1000;  // Default: 7 days (= 7d funding window)
const STATS_LOG_INTERVAL = 6;  // Log statistics every N cycles (6 cycles = 6 hours)
const STATUS_DISPLAY_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes
// Before opening, the free USDC split must satisfy |PERP - SPOT| / (PERP + SPOT) <= this (10 = 50/50 +-5 points).
// Otherwise the bot is ON HOLD and asks for a manual transfer (an API key cannot move funds). Derivation: config notes.rebalance.
const MAX_BALANCE_IMBALANCE_PERCENT = config.bot?.maxBalanceImbalancePercent ?? 10;

// Global state
let state = null;
let hyperliquid = null;
let isRunning = false;
let cycleCount = 0;
let cycleInterval = null;
let statusInterval = null;
let activeCyclePromise = null;
let shutdownRequested = false;
let rebalanceHold = null;  // { since } while ON HOLD waiting for a manual PERP<->SPOT transfer

function timestamp() {
  return `[${new Date().toLocaleTimeString()}]`;
}

function bidAskFromL2Book(coin, l2Book) {
  const [bids, asks] = l2Book?.levels || [];
  const bestBid = bids?.[0];
  const bestAsk = asks?.[0];

  if (!bestBid || !bestAsk) {
    return null;
  }

  const bid = parseFloat(bestBid.px);
  const ask = parseFloat(bestAsk.px);

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return null;
  }

  return {
    coin,
    bid,
    ask,
    mid: (bid + ask) / 2,
    bidSize: parseFloat(bestBid.sz || '0'),
    askSize: parseFloat(bestAsk.sz || '0'),
    timestamp: l2Book.time || Date.now()
  };
}

/**
 * Initialize bot
 */
async function initialize() {
  console.log('='.repeat(80));
  console.log(PAPER ? 'Delta-Neutral Trading Bot - PAPER TRADING (simulated account, live market data)' : 'Delta-Neutral Trading Bot');
  console.log('='.repeat(80));
  console.log();

  // Log configuration
  console.log('[Bot] Configuration:');
  console.log(`[Bot]   Min Hold Time: ${MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24)} days`);
  console.log(`[Bot]   Switch Horizon: ${config.bot?.switchHorizonDays ?? 8} days`);
  console.log(`[Bot]   Check Interval: ${CHECK_INTERVAL_MS / (1000 * 60 * 60)} hour(s)`);
  console.log();

  // Load state
  state = loadState();
  console.log('[Bot] State loaded');

  if (state.history && state.history.length > 0) {
    const stats = getHistoryStats(state);
    console.log(`[Bot] Historical stats: ${stats.totalPositions} positions, Total PnL: $${stats.totalPnl.toFixed(2)}`);
  }

  // Initialize Hyperliquid connector
  hyperliquid = PAPER ? new PaperConnector(config) : new HyperliquidConnector({ testnet: false });

  if (!hyperliquid.wallet) {
    console.error('❌ Error: Wallet address not configured');
    console.error('   Please set wallet_address in hyperliquid.env');
    process.exit(1);
  }

  console.log(`[Bot] Wallet: ${hyperliquid.wallet}${hyperliquid.vaultAddress ? ' (sub-account/vault: orders signed with vaultAddress)' : ''}`);
  console.log();

  // Connect to WebSocket for orderbook streaming
  await hyperliquid.connect();
  console.log('[Bot] Connected to Hyperliquid');
  console.log();
}

/**
 * Check for existing delta-neutral position on-chain
 * (In case bot was restarted and state is out of sync)
 */
async function verifyPositionOnChain() {
  console.log('[Bot] Verifying position on-chain...');
  const scope = managedScope(hasPosition(state) ? getCurrentPosition(state) : null);

  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, scope),
    getSpotBalances(hyperliquid, null, scope)
  ]);

  if (perpPositions.length === 0 && spotBalances.length === 0) {
    console.log('[Bot] ✅ No positions on-chain');
    return { status: 'none', pair: null, analysis: null };
  }

  // Analyze for delta-neutral
  const analysis = analyzeDeltaNeutral(perpPositions, spotBalances, scope);

  if (analysis.deltaNeutralPairs.length > 0) {
    const pair = analysis.deltaNeutralPairs[0];

    console.log(`[Bot] ⚠️  Found existing delta-neutral position on-chain:`);
    console.log(`[Bot]   ${pair.symbol}: ${pair.perpSide} ${pair.perpSize} PERP + ${pair.spotSize} SPOT`);
    console.log(`[Bot]   Hedge Quality: ${pair.hedgeQuality}`);

    return { status: 'delta_neutral', pair, analysis };
  }

  if (perpPositions.length > 0 || spotBalances.length > 0) {
    console.log(`[Bot] ⚠️  Found positions on-chain but not delta-neutral:`);
    if (perpPositions.length > 0) {
      for (const pos of perpPositions) {
        console.log(`[Bot]   PERP: ${pos.symbol} ${pos.side} ${pos.size}`);
      }
    }
    if (spotBalances.length > 0) {
      for (const bal of spotBalances) {
        console.log(`[Bot]   SPOT: ${bal.symbol} ${bal.total}`);
      }
    }
  }

  return { status: 'imbalanced', pair: null, analysis };
}

async function confirmNoManagedExposure(confirmations = 3, delayMs = 750) {
  for (let i = 0; i < confirmations; i++) {
    const onChainPosition = await verifyPositionOnChain();
    if (onChainPosition.status !== 'none') {
      return false;
    }
    if (i < confirmations - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return true;
}

async function adoptOnChainPair(pair, reason = 'adopted on-chain position') {
  const allMids = await hyperliquid.getAllMids();
  const perpPrice = parseFloat(allMids[pair.symbol] || pair.perpPosition.entryPrice || '0');
  const spotSymbol = HyperliquidConnector.perpToSpot(pair.symbol);
  let spotPrice = perpPrice;

  try {
    const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
    const spotCoin = hyperliquid.getCoinForOrderbook(spotSymbol, spotAssetId);
    const parsedSpot = parseFloat(allMids[spotCoin]);
    if (Number.isFinite(parsedSpot) && parsedSpot > 0) {
      spotPrice = parsedSpot;
    }
  } catch {
    // Fall back to perp mid if the spot mid is unavailable during adoption.
  }

  state = recordPosition(state, {
    success: true,
    symbol: pair.symbol,
    perpSymbol: pair.symbol,
    spotSymbol,
    perpSize: pair.perpSize,
    spotSize: pair.spotSize,
    perpEntryPrice: Number.isFinite(pair.perpPosition.entryPrice) && pair.perpPosition.entryPrice > 0
      ? pair.perpPosition.entryPrice
      : perpPrice,
    spotEntryPrice: spotPrice,
    positionValue: pair.perpSize * (Number.isFinite(perpPrice) && perpPrice > 0 ? perpPrice : pair.perpPosition.entryPrice),
    fundingRate: 0,
    annualizedFunding: 0,
    openFeesActual: 0,
    openFeesEstimated: 0,
    openTime: state.pendingIntent?.createdAt || Date.now(),
    adoptionReason: reason
  });
  saveState(state);
  console.log(`${timestamp()} [Bot] Adopted managed on-chain position into state (${reason})`);
}

// Symbols and hedge tolerance the bot treats as its own exposure (dedicated account assumed)
function managedScope(position) {
  return {
    managedSpotSymbols: Array.from(getManagedSpotSymbols(config, position)),
    managedPerpSymbols: Array.from(getManagedPerpSymbols(config, position)),
    maxHedgeMismatchPercent: getMaxHedgeMismatchPercent(config)
  };
}

async function reconcilePendingIntent() {
  if (!state?.pendingIntent) {
    return;
  }

  console.log(`${timestamp()} [Bot] Reconciling pending intent: ${state.pendingIntent.type}`);
  const onChainPosition = await verifyPositionOnChain();

  if (onChainPosition.status === 'delta_neutral') {
    await adoptOnChainPair(onChainPosition.pair, `pending ${state.pendingIntent.type}`);
    return;
  }

  if (onChainPosition.status === 'none') {
    state = clearPendingIntent(state);
    saveState(state);
    console.log(`${timestamp()} [Bot] Pending intent cleared; no managed exposure on-chain`);
    return;
  }

  await autoHedgeAll(hyperliquid, config, { verbose: true, fallbackToClose: false, ...managedScope(getCurrentPosition(state)) });
}

/**
 * Clean up imbalanced positions at startup
 * Uses the hedge utility to automatically hedge or close unhedged positions
 */
async function cleanupImbalancedPositions() {
  console.log('[Bot] Checking for imbalanced positions to hedge...');
  console.log();

  try {
    const startupCleanupMode = getStartupCleanupMode(config);
    const scope = managedScope(hasPosition(state) ? getCurrentPosition(state) : null);

    if (startupCleanupMode === 'report-only') {
      const analysis = await analyzeHedgeNeeds(hyperliquid, { verbose: false, ...scope });

      console.log('[Bot] Startup cleanup mode: report-only');
      console.log(formatHedgeReport(analysis));
      return;
    }

    if (startupCleanupMode === 'hedge-only') {
      console.log('[Bot] Startup cleanup mode: hedge-only (will not close positions if hedging fails)');
    } else {
      console.log('[Bot] Startup cleanup mode: hedge-or-close (may close positions if hedging fails)');
    }

    const results = await autoHedgeAll(hyperliquid, config, {
      verbose: true,
      fallbackToClose: startupCleanupMode === 'hedge-or-close',
      ...scope
    });

    if (results.totalProcessed === 0) {
      console.log('[Bot] ✅ No positions need hedging');
      console.log();
      return;
    }

    // Log summary
    if (results.hedged.length > 0) {
      console.log(`[Bot] ✅ Successfully hedged ${results.hedged.length} position(s)`);
    }
    if (results.closed.length > 0) {
      console.log(`[Bot] 🔒 Closed ${results.closed.length} position(s) (hedge failed)`);
    }
    if (results.failed.length > 0) {
      console.log(`[Bot] ⚠️  ${results.failed.length} position(s) could not be hedged or closed`);
    }
    console.log();

  } catch (error) {
    console.error('[Bot] ❌ Error during cleanup:', error.message);
    console.log();
  }
}

/**
 * Main bot cycle
 */
async function runCycle() {
  cycleCount++;

  console.log('='.repeat(80));
  console.log(`${timestamp()} Check Cycle #${cycleCount} - ${new Date().toLocaleDateString()}`);
  console.log('='.repeat(80));
  console.log();

  // Log detailed statistics periodically
  if (cycleCount % STATS_LOG_INTERVAL === 1 || cycleCount === 1) {
    console.log(`${timestamp()} [Bot] Logging market statistics...`);
    try {
      await retryWithExponentialBackoff(
        async () => logStatistics(hyperliquid, config.trading.pairs, config, { verbose: false }),
        {
          maxRetries: 5,
          initialDelay: 2000,
          maxDelay: 30000,
          onRetry: (attempt, maxRetries, delay) => {
            console.log(`${timestamp()} [Bot] Rate limit hit while fetching statistics, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
          }
        }
      );
    } catch (error) {
      console.error(`${timestamp()} [Bot] Failed to log statistics:`, error.message);
    }
  }

  try {
    // Step 1: Check existing position
    if (hasPosition(state)) {
      const position = getCurrentPosition(state);
      console.log(`${timestamp()} [1/6] Current Position:`);
      console.log(formatPosition(position));
      console.log();

      // Verify position still exists on-chain
      const onChainPosition = await verifyPositionOnChain();

      if (onChainPosition.status === 'none') {
        const confirmedFlat = await confirmNoManagedExposure();
        if (!confirmedFlat) {
          console.log(`${timestamp()} [Bot] Managed exposure reappeared during flat confirmation. Keeping state and halting this cycle.`);
          return;
        }
        console.log(`${timestamp()} [Bot] Position in state confirmed absent on-chain. Clearing state.`);
        state = closePositionState(state, {
          reason: 'Position not found on-chain',
          perpClosePrice: 0,
          spotClosePrice: 0,
          totalPnl: 0
        });
        saveState(state);
      } else if (onChainPosition.status === 'imbalanced') {
        console.log(`${timestamp()} [Bot] Managed on-chain exposure is imbalanced. Halting new decisions this cycle.`);
        await autoHedgeAll(hyperliquid, config, { verbose: true, fallbackToClose: false, ...managedScope(position) });
        return;
      } else {
        // Check if we should close position
        const age = getPositionAge(position);
        const canClose = canClosePosition(position, MIN_HOLD_TIME_MS);

        console.log(`${timestamp()} [2/6] Position Age: ${(age / (1000 * 60 * 60 * 24)).toFixed(2)} days`);
        console.log(`${timestamp()} [2/6] Can Close: ${canClose ? 'YES' : 'NO'} (min hold: ${MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24)} days)`);
        console.log();

        console.log(`${timestamp()} [3/6] Checking current opportunities...`);
        const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
        console.log();
        console.log(analysis.report);
        console.log();

        // Cost-aware decision on 7d-average funding (see switchEdge). Only a position with negative
        // funding may be acted on inside the minimum hold.
        const signal = getCurrentPositionFundingSignal(position, analysis);
        if (!signal.available) {
          console.log(`${timestamp()} [4/6] ${signal.reason}. Holding current position.`);
        } else {
          const best = analysis.best && analysis.best.symbol !== position.symbol ? analysis.best : null;
          const switchGain = best ? switchEdge(signal.fundingRate, best, config) : -Infinity;
          const closeGain = switchEdge(signal.fundingRate, null, config);
          console.log(`${timestamp()} [4/6] ${position.symbol} 7d avg funding: ${signal.fundingPercent.toFixed(2)}% APY`);
          if (best) {
            console.log(`${timestamp()} [4/6] Best alternative ${best.symbol}: ${best.avgFundingPercent.toFixed(2)}% APY, expected switch gain ${(switchGain * 100).toFixed(3)}% of notional`);
          }

          const action = switchGain > 0 ? 'switch' : closeGain > 0 ? 'close' : null;
          if (action && (canClose || signal.fundingRate < 0)) {
            const reason = signal.fundingRate < 0 ? 'Funding negative' : 'Better opportunity';
            await closeAndReopen(position, reason, action === 'switch' ? best : null);
            return;
          }
          console.log(`${timestamp()} [5/6] Holding current position${action ? ' (within minimum hold)' : ''}`);
        }

        // Update check time
        state = updateCheckTime(state);
        saveState(state);

        console.log(`${timestamp()} [6/6] Next check in 1 hour`);
        console.log();
        return;
      }
    } else {
      console.log(`${timestamp()} [1/6] No Current Position`);
      console.log();

      // Verify no position on-chain
      const onChainPosition = await verifyPositionOnChain();

      if (onChainPosition.status !== 'none') {
        console.log(`${timestamp()} [Bot] Found position on-chain but not in state!`);
        if (onChainPosition.status === 'delta_neutral') {
          await adoptOnChainPair(onChainPosition.pair, 'existing managed exposure');
        } else {
          console.log(`${timestamp()} [Bot] Status: ${onChainPosition.status}. Attempting hedge-only startup reconciliation.`);
          await autoHedgeAll(hyperliquid, config, { verbose: true, fallbackToClose: false, ...managedScope(null) });
        }
        return;
      }
    }

    // Find best opportunity
    console.log(`${timestamp()} [3/6] Finding Best Opportunities...`);
    const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
    console.log();
    console.log(analysis.report);
    console.log();

    // No valid opportunities (e.g. all symbols below minFundingRatePercent on 7d average)
    if (!analysis.best) {
      console.log(`${timestamp()} [4/6] ❌ No valid opportunities found (funding, volume or spread filters). Waiting for next cycle...`);
      console.log(`${timestamp()} [6/6] Next check in 1 hour`);
      console.log();
      return;
    }

    await openPosition(analysis.best, 'best opportunity');

    console.log(`${timestamp()} [6/6] Next check in 1 hour`);
    console.log();

  } catch (error) {
    console.error(`${timestamp()} [Bot] ❌ Error in cycle:`, error.message);
    console.error(error.stack);
  }
}

/**
 * Check the free PERP/SPOT USDC split. If it is off by more than MAX_BALANCE_IMBALANCE_PERCENT, the bot is ON HOLD
 * (no trade, no exposure) until the user moves USDC by hand. The verdict is written to rebalance-status.json next to
 * the state file, so "is a rebalance needed?" can be answered without reading logs.
 * @returns {Promise<Object>} balance report (utils/balance.js) plus `onHold`
 */
async function checkRebalance() {
  const report = await checkAndReportBalances(hyperliquid, MAX_BALANCE_IMBALANCE_PERCENT / 2);
  const { perpBalance, spotBalance, totalBalance } = report.balances;
  const transfer = report.transferSuggestion;
  const onHold = !report.balanceCheck.isBalanced && totalBalance > 0;
  rebalanceHold = onHold ? (rebalanceHold || { since: new Date().toISOString() }) : null;

  const action = onHold
    ? `Transfer ${transfer.amount.toFixed(2)} USDC from ${transfer.fromPerpToSpot ? 'PERP to SPOT' : 'SPOT to PERP'} ` +
      `(Hyperliquid UI, account ${hyperliquid.wallet})`
    : 'none';
  const statusFile = path.join(path.dirname(getStateFilePath()), 'rebalance-status.json');
  try {
    writeJsonAtomic(statusFile, {
      rebalanceNeeded: onHold,
      status: onHold ? 'ACTION_REQUIRED' : 'OK',
      action,
      bot: onHold ? 'ON HOLD: no trades, no exposure until the transfer arrives' : 'balanced, trading normally',
      direction: onHold ? (transfer.fromPerpToSpot ? 'PERP_TO_SPOT' : 'SPOT_TO_PERP') : null,
      amountUSDC: onHold ? Number(transfer.amount.toFixed(2)) : 0,
      perpUSDC: Number(perpBalance.toFixed(2)),
      spotUSDC: Number(spotBalance.toFixed(2)),
      imbalancePercent: totalBalance > 0 ? Number((Math.abs(perpBalance - spotBalance) / totalBalance * 100).toFixed(1)) : 0,
      maxImbalancePercent: MAX_BALANCE_IMBALANCE_PERCENT,
      since: rebalanceHold?.since ?? null,
      updated: new Date().toISOString()
    });
  } catch (error) {
    console.error(`${timestamp()} [Bot] Could not write ${statusFile}: ${error.message}`);
  }

  if (onHold) {
    console.log('!'.repeat(80));
    console.log(`${timestamp()} ⚠️  ACTION REQUIRED, bot ON HOLD: ${action}`);
    console.log(`   PERP $${perpBalance.toFixed(2)} | SPOT $${spotBalance.toFixed(2)}: split is off by more than ` +
      `${MAX_BALANCE_IMBALANCE_PERCENT}%. No trades and no exposure until the funds arrive; resumes automatically.`);
    console.log('!'.repeat(80));
  }
  return { ...report, onHold };
}

/**
 * Open a delta-neutral position behind a crash-safe pending intent. The intent is cleared on failure
 * unless exposure may exist on-chain, which the next start (reconcilePendingIntent) then resolves.
 */
async function openPosition(opportunity, reason) {
  const balanceReport = await checkRebalance();
  if (balanceReport.onHold) {
    return;
  }

  console.log(`${timestamp()} [4/6] Opening Delta-Neutral Position for ${opportunity.symbol} (${reason})...`);
  state = setPendingIntent(state, {
    type: 'opening',
    symbol: opportunity.symbol,
    perpSymbol: opportunity.symbol,
    spotSymbol: HyperliquidConnector.perpToSpot(opportunity.symbol),
    reason
  });
  saveState(state);

  try {
    console.log(balanceReport.report);
    const result = await openDeltaNeutralPosition(hyperliquid, opportunity, balanceReport.balances, config, { verbose: true });
    if (result.success) {
      console.log(`${timestamp()} [5/6] ✅ Opened ${result.symbol}: SHORT ${result.perpSize} PERP @ $${result.perpEntryPrice.toFixed(2)}, ` +
        `LONG ${result.spotSize} SPOT @ $${result.spotEntryPrice.toFixed(2)}, value $${result.positionValue.toFixed(2)}, ` +
        `7d funding ${(result.annualizedFunding * 100).toFixed(2)}% APY`);
      state = recordPosition(state, result);
      saveState(state);
      return;
    }
    console.log(`${timestamp()} [5/6] Failed to open position: ${result.error}`);
  } catch (error) {
    console.error(`${timestamp()} [5/6] Error opening position:`, error.message);
    if ((await verifyPositionOnChain()).status !== 'none') {
      return;  // keep the intent: on-chain exposure must be reconciled
    }
  }
  state = clearPendingIntent(state);
  saveState(state);
}

/**
 * Close the current position (throws on any failure) and optionally open a new one.
 */
async function closeAndReopen(currentPosition, reason, newOpportunity) {
  console.log(`${timestamp()} [Bot] Closing position: ${reason}`);
  state = setPendingIntent(state, {
    type: 'closing',
    symbol: currentPosition.symbol,
    perpSymbol: currentPosition.perpSymbol,
    spotSymbol: currentPosition.spotSymbol,
    reason
  });
  saveState(state);

  const closeResult = await closeDeltaNeutralPosition(hyperliquid, currentPosition, config, { verbose: true, reason });
  console.log(`${timestamp()} ✅ Position closed. PnL: $${closeResult.totalPnl.toFixed(2)}`);
  state = closePositionState(state, closeResult);
  saveState(state);

  if (newOpportunity) {
    await openPosition(newOpportunity, `after close: ${reason}`);
  }
}

/**
 * Display current bot status
 */
async function displayStatus() {
  const now = new Date();

  // ANSI color codes
  const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m'
  };

  console.log(colors.dim + '─'.repeat(80) + colors.reset);
  console.log(`${colors.bright}${colors.cyan}📊 Bot Status${PAPER ? ' [PAPER TRADING]' : ''}${colors.reset} - ${colors.dim}${now.toLocaleString()}${colors.reset}`);
  console.log(colors.dim + '─'.repeat(80) + colors.reset);

  // ON HOLD: re-check every status tick so the bot resumes within ~2 minutes of the manual transfer landing
  if (rebalanceHold && !isRunning) {
    if (!(await checkRebalance()).onHold) {
      console.log(`${timestamp()} ✅ Transfer received, PERP/SPOT balanced: resuming now`);
      await runGuardedCycle();
    }
  }

  if (hasPosition(state)) {
    const position = getCurrentPosition(state);

    // Calculate time info
    const age = getPositionAge(position);
    const ageHours = age / (1000 * 60 * 60);
    const ageDays = age / (1000 * 60 * 60 * 24);
    const canClose = canClosePosition(position, MIN_HOLD_TIME_MS);
    const minHoldDays = MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24);

    // Calculate time until can rebalance
    const timeUntilCanClose = MIN_HOLD_TIME_MS - age;
    const daysUntilCanClose = timeUntilCanClose / (1000 * 60 * 60 * 24);
    const hoursUntilCanClose = timeUntilCanClose / (1000 * 60 * 60);

    console.log(`${colors.bright}Position:${colors.reset} ${colors.cyan}${position.symbol}${colors.reset} Delta-Neutral`);

    const perpValue = position.perpSize * position.perpEntryPrice;
    const spotValue = position.spotSize * position.spotEntryPrice;
    const totalValue = perpValue + spotValue;

    console.log(`  PERP:  SHORT ${position.perpSize} @ $${position.perpEntryPrice.toFixed(4)} ${colors.dim}($${perpValue.toFixed(2)})${colors.reset}`);
    console.log(`  SPOT:  LONG ${position.spotSize} @ $${position.spotEntryPrice.toFixed(4)} ${colors.dim}($${spotValue.toFixed(2)})${colors.reset}`);
    console.log(`  ${colors.bright}Total Value: $${totalValue.toFixed(2)}${colors.reset}`);
    console.log();

    const fundingColor = position.annualizedFunding >= 0 ? colors.green : colors.red;
    console.log(`${colors.bright}Funding:${colors.reset} ${fundingColor}${(position.annualizedFunding * 100).toFixed(2)}% APY${colors.reset}`);
    console.log(`  Hourly Rate: ${fundingColor}${(position.fundingRate * 100).toFixed(4)}%${colors.reset}`);
    console.log(`  Expected/hour: ${colors.green}$${(position.positionValue * position.fundingRate).toFixed(4)}${colors.reset}`);
    console.log(`  Expected/day: ${colors.green}$${(position.positionValue * position.fundingRate * 24).toFixed(4)}${colors.reset}`);

    // Fetch accumulated funding for current position
    try {
      const fundingHistory = await hyperliquid.getUserFundingHistory(null, position.openTime);

      // Filter for current position symbol
      const perpSymbol = position.perpSymbol;
      const positionFunding = fundingHistory.accumulated[perpSymbol] || 0;

      if (positionFunding !== 0) {
        const earnedColor = positionFunding >= 0 ? colors.green : colors.red;
        const sign = positionFunding >= 0 ? '+' : '';
        console.log(`  ${colors.bright}Accumulated Earned:${colors.reset} ${earnedColor}${sign}$${positionFunding.toFixed(4)}${colors.reset} ${colors.dim}(since open)${colors.reset}`);
      }
    } catch (error) {
      // Silently fail if funding history unavailable
      console.log(`  ${colors.dim}(Accumulated funding unavailable)${colors.reset}`);
    }

    console.log();

    if (ageDays >= 1) {
      console.log(`${colors.bright}Age:${colors.reset} ${colors.yellow}${ageDays.toFixed(2)} days${colors.reset} ${colors.dim}(${ageHours.toFixed(1)} hours)${colors.reset}`);
    } else {
      console.log(`${colors.bright}Age:${colors.reset} ${colors.yellow}${ageHours.toFixed(1)} hours${colors.reset}`);
    }

    console.log(`${colors.dim}Opened: ${new Date(position.openTime).toLocaleString()}${colors.reset}`);
    console.log();

    if (canClose) {
      console.log(`${colors.green}✅ Can Switch/Close: YES${colors.reset} ${colors.dim}(held > ${minHoldDays} days)${colors.reset}`);
      console.log(`   ${colors.dim}Switches only if the expected funding gain beats fees + spread${colors.reset}`);
    } else {
      if (daysUntilCanClose >= 1) {
        console.log(`${colors.yellow}⏳ Can Switch/Close: NO${colors.reset} ${colors.dim}(need ${daysUntilCanClose.toFixed(2)} more days)${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⏳ Can Switch/Close: NO${colors.reset} ${colors.dim}(need ${hoursUntilCanClose.toFixed(1)} more hours)${colors.reset}`);
      }
      console.log(`   ${colors.dim}Min hold: ${minHoldDays} days${colors.reset}`);
      console.log(`   ${colors.dim}Can close at: ${new Date(position.openTime + MIN_HOLD_TIME_MS).toLocaleString()}${colors.reset}`);
    }

  } else {
    console.log(`${colors.bright}Position:${colors.reset} None`);
    console.log(`${colors.bright}Status:${colors.reset} 🔍 Looking for opportunities...`);
    const nextCheck = state.lastOpportunityCheck
      ? new Date(state.lastOpportunityCheck + CHECK_INTERVAL_MS).toLocaleTimeString()
      : 'on next cycle';
    console.log(`${colors.dim}Next check: ${nextCheck}${colors.reset}`);
  }

  console.log(colors.dim + '─'.repeat(80) + colors.reset);
  console.log();

  // Fetch and display market summary
  try {
    console.log(`${colors.bright}📈 Market Summary:${colors.reset}`);
    console.log();

    // Fetch current funding rates only (faster, no history to avoid rate limits)
    // Fetch market data (funding, volumes, perp-spot spreads) with exponential backoff for 429 errors
    const [fundingData, volumes, perpSpotSpreads] = await retryWithExponentialBackoff(
      async () => Promise.all([
        getFundingRates(hyperliquid, config.trading.pairs, { verbose: false }),
        get24HourVolumes(hyperliquid, config.trading.pairs),
        getPerpSpotSpreads(hyperliquid, config.trading.pairs, { verbose: false })
      ]),
      {
        maxRetries: 5,
        initialDelay: 2000,
        maxDelay: 30000,
        onRetry: (attempt, maxRetries, delay) => {
          console.log(colors.yellow + `[Status] Rate limit hit, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...` + colors.reset);
        }
      }
    );

    // Fetch bid-ask spreads with REST snapshots so status display does not mutate
    // the trading connector's shared WebSocket subscriptions/orderbook cache.
    const bidAskSpreads = [];
    try {
      for (const symbol of config.trading.pairs) {
        const spotSymbol = HyperliquidConnector.perpToSpot(symbol);
        const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
        const spotCoin = hyperliquid.getCoinForOrderbook(spotSymbol, spotAssetId);

        const [perpBook, spotBook] = await Promise.all([
          hyperliquid.requestL2BookRest(symbol),
          hyperliquid.requestL2BookRest(spotCoin)
        ]);

        const perpBidAsk = bidAskFromL2Book(symbol, perpBook);
        const spotBidAsk = bidAskFromL2Book(spotCoin, spotBook);

        if (!perpBidAsk || !spotBidAsk) {
          continue;
        }

        let perpSpread = ((perpBidAsk.ask - perpBidAsk.bid) / perpBidAsk.mid) * 100;
        let spotSpread = ((spotBidAsk.ask - spotBidAsk.bid) / spotBidAsk.mid) * 100;

        if (!Number.isFinite(perpSpread)) perpSpread = null;
        if (!Number.isFinite(spotSpread)) spotSpread = null;

        bidAskSpreads.push({
          perpSymbol: symbol,
          spotSymbol,
          perpSpreadPercent: perpSpread,
          spotSpreadPercent: spotSpread
        });
      }
    } catch (error) {
      // If snapshot fetching fails, just show --- (no spreads)
      console.error(colors.dim + `[Status] Could not fetch bid-ask spreads: ${error.message}` + colors.reset);
    }


    // Check if we got valid data
    if (!fundingData || fundingData.length === 0) {
      console.log(colors.yellow + '⚠️  No funding data available' + colors.reset);
      console.log();
      return;
    }

    // Build maps for quick lookup
    const volumeMap = new Map(volumes.map(v => [v.perpSymbol, v]));
    const bidAskMap = new Map(bidAskSpreads.map(s => [s.perpSymbol, s]));
    const perpSpotMap = new Map(perpSpotSpreads.map(s => [s.perpSymbol, s]));

    // Table header
    console.log(colors.dim + '┌──────────┬──────────────┬─────────────┬─────────────┬──────────┬──────────┐' + colors.reset);
    console.log(colors.dim + '│' + colors.reset + ' Symbol   ' + colors.dim + '│' + colors.reset + ' Funding APY  ' + colors.dim + '│' + colors.reset + ' 24h Vol     ' + colors.dim + '│' + colors.reset + ' Bid-Ask %   ' + colors.dim + '│' + colors.reset + ' P-S Spr% ' + colors.dim + '│' + colors.reset + ' Quality  ' + colors.dim + '│' + colors.reset);
    console.log(colors.dim + '│          │' + colors.reset + ' Current      ' + colors.dim + '│' + colors.reset + ' (USDC)      ' + colors.dim + '│' + colors.reset + ' Perp | Spot ' + colors.dim + '│' + colors.reset + '          ' + colors.dim + '│' + colors.reset + '          ' + colors.dim + '│' + colors.reset);
    console.log(colors.dim + '├──────────┼──────────────┼─────────────┼─────────────┼──────────┼──────────┤' + colors.reset);

    // Table rows
    for (const data of fundingData) {
      if (data.error) continue; // Skip errors

      const symbol = data.symbol || '?';

      // Funding rate - convert from decimal to percentage
      let currentAPY = 0;
      if (data.annualizedRate !== undefined && data.annualizedRate !== null) {
        currentAPY = data.annualizedRate * 100;  // Convert 0.1095 to 10.95%
      } else if (data.annualizedFundingPercent !== undefined) {
        currentAPY = data.annualizedFundingPercent;
      }

      const volume = volumeMap.get(symbol);
      const perpVolUSDC = volume?.perpVolUSDC || 0;
      const spotVolUSDC = volume?.spotVolUSDC || 0;
      const totalVolUSDC = perpVolUSDC + spotVolUSDC;

      const volStr = totalVolUSDC >= 1e9 ? `$${(totalVolUSDC / 1e9).toFixed(0)}B` :
                     totalVolUSDC >= 1e6 ? `$${(totalVolUSDC / 1e6).toFixed(0)}M` :
                     totalVolUSDC >= 1e3 ? `$${(totalVolUSDC / 1e3).toFixed(0)}K` :
                     totalVolUSDC > 0 ? `$${totalVolUSDC.toFixed(0)}` : '---';

      const bidAsk = bidAskMap.get(symbol);
      const perpSpreadPct = bidAsk?.perpSpreadPercent ?? null;
      const spotSpreadPct = bidAsk?.spotSpreadPercent ?? null;

      // Format spread with fallback for missing data
      const perpSpreadStr = perpSpreadPct !== null ? perpSpreadPct.toFixed(3).padStart(5) : ' ---';
      const spotSpreadStr = spotSpreadPct !== null ? spotSpreadPct.toFixed(3).padStart(5) : ' ---';

      const perpSpot = perpSpotMap.get(symbol);
      const perpSpotSpreadPct = perpSpot?.spreadPercent !== undefined ? Math.abs(perpSpot.spreadPercent) : null;
      const perpSpotStr = perpSpotSpreadPct !== null ? perpSpotSpreadPct.toFixed(3).padStart(8) : '     ---';

      // Color funding rate based on value
      let fundingColorCode = '';
      if (currentAPY >= 10) fundingColorCode = colors.green;
      else if (currentAPY >= 5) fundingColorCode = colors.yellow;
      else if (currentAPY < 0) fundingColorCode = colors.red;

      // Format APY with space for sign (even when positive)
      const currentAPYStr = currentAPY >= 0 ? ` ${currentAPY.toFixed(1)}` : `${currentAPY.toFixed(1)}`;

      // Quality indicator based on funding
      const quality = currentAPY >= 10 ? '🟢' : currentAPY >= 5 ? '🟡' : currentAPY < 0 ? '🔴' : '⚪';

      // Highlight current position
      const isCurrentPosition = hasPosition(state) && getCurrentPosition(state).symbol === symbol;
      const prefix = isCurrentPosition ? colors.cyan + '►' + colors.reset : ' ';
      const symbolDisplay = isCurrentPosition ? colors.bright + colors.cyan + symbol.padEnd(9) + colors.reset : symbol.padEnd(9);

      console.log(
        colors.dim + '│' + colors.reset + prefix + symbolDisplay + colors.dim + '│' + colors.reset +
        ` ${fundingColorCode}${currentAPYStr.padStart(6)}%${colors.reset}      ${colors.dim}│${colors.reset}` +
        ` ${volStr.padStart(11)} ${colors.dim}│${colors.reset}` +
        ` ${perpSpreadStr}${colors.dim} | ${colors.reset}${spotSpreadStr}${colors.dim} │${colors.reset}` +
        ` ${perpSpotStr} ${colors.dim}│${colors.reset}` +
        ` ${quality}        ${colors.dim}│${colors.reset}`
      );
    }

    console.log(colors.dim + '└──────────┴──────────────┴─────────────┴─────────────┴──────────┴──────────┘' + colors.reset);
    console.log();
    console.log(colors.dim + 'Legend: 🟢 Good (≥10% APY) | 🟡 Moderate (5-10% APY) | 🔴 Negative | ► Current' + colors.reset);
    console.log();

  } catch (error) {
    console.error(`${colors.red}Failed to fetch market summary: ${error.message}${colors.reset}`);
  }

  console.log(colors.dim + '─'.repeat(80) + colors.reset);
  console.log();
}

/**
 * Main bot loop
 */
async function runGuardedCycle() {
  if (isRunning) {
    console.log('[Bot] Previous cycle still running, skipping...');
    return;
  }

  isRunning = true;
  activeCyclePromise = runCycle();
  try {
    await activeCyclePromise;
  } catch (error) {
    console.error('[Bot] Cycle error:', error.message);
  } finally {
    activeCyclePromise = null;
    isRunning = false;
  }
}

async function run() {
  await initialize();

  await reconcilePendingIntent();

  // Clean up any imbalanced positions from failed trades
  await cleanupImbalancedPositions();

  // Run first cycle immediately
  await runGuardedCycle();

  // Display initial status
  await displayStatus();

  // Schedule regular cycles
  cycleInterval = setInterval(async () => {
    await runGuardedCycle();
  }, CHECK_INTERVAL_MS);

  // Schedule status display every 2 minutes
  statusInterval = setInterval(async () => {
    try {
      await displayStatus();
    } catch (error) {
      console.error('[Bot] Status display error:', error.message);
    }
  }, STATUS_DISPLAY_INTERVAL_MS);

  console.log('[Bot] Bot is running. Press Ctrl+C to stop.');
  console.log('[Bot] Status updates every 2 minutes.');
  console.log();
}

/**
 * Graceful shutdown
 */
async function shutdown(exitCode = 0) {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  console.log();
  console.log('[Bot] Shutting down...');

  if (cycleInterval) {
    clearInterval(cycleInterval);
    cycleInterval = null;
  }
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }

  if (activeCyclePromise) {
    console.log('[Bot] Waiting for active cycle to finish...');
    await Promise.race([
      activeCyclePromise,
      new Promise(resolve => setTimeout(resolve, 30000))
    ]);
  }

  if (hyperliquid) {
    hyperliquid.disconnect();
  }

  if (state && !(exitCode !== 0 && state.pendingIntent)) {
    saveState(state);
    console.log('[Bot] State saved');
  } else if (state?.pendingIntent) {
    console.log('[Bot] Pending trading intent preserved on disk; skipping blind error-exit save');
  }

  console.log('[Bot] Shutdown complete');
  process.exit(exitCode);
}

// Handle shutdown signals
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Bot] Uncaught exception:', error);
  void shutdown(1);
});

process.on('unhandledRejection', (error) => {
  console.error('[Bot] Unhandled rejection:', error);
  void shutdown(1);
});

// Start bot
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error('[Bot] Fatal error:', error);
    void shutdown(1);
  });
}

export { timestamp, verifyPositionOnChain, runCycle, closeAndReopen, displayStatus };
