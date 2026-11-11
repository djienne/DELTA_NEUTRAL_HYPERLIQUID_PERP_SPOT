import HyperliquidConnector from './hyperliquid.js';
import { loadState, saveState, hasPosition, getCurrentPosition, recordPosition, closePosition as closePositionState, canClosePosition, getPositionAge, formatPosition, getHistoryStats, setPendingIntent, clearPendingIntent, getStateFilePath, writeJsonAtomic } from './utils/state.js';
import { getBalances, rebalanceNeeded } from './utils/balance.js';
import { findBestOpportunities } from './utils/opportunity.js';
import { openDeltaNeutralPosition, closeDeltaNeutralPosition } from './utils/trade.js';
import { logStatistics, formatMarketTable } from './utils/statistics.js';
import { autoHedgeAll, analyzeHedgeNeeds, formatHedgeReport } from './utils/hedge.js';
import { getStartupCleanupMode } from './utils/risk.js';
import { getCurrentPositionFundingSignal, decide } from './utils/position-decision.js';
import { PaperConnector } from './utils/paper-exchange.js';
import { formatPrice } from './utils/positions.js';
import { perpToSpot } from './utils/symbols.js';
import { verifyPositionOnChain, confirmNoManagedExposure, adoptOnChainPair, managedScope, reconcilePendingIntent } from './utils/recovery.js';
import { colors, formatKnown, printPositionStatus } from './utils/report.js';
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

// Configuration
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

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
let lastAnalysis = null;   // the last hourly market scan (findBestOpportunities + time), shown by displayStatus

function timestamp() {
  return `[${new Date().toLocaleTimeString()}]`;
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
    console.log(`[Bot] Historical stats: ${stats.totalPositions} positions, Total PnL: $${stats.totalPnl.toFixed(2)}, unavailable PnL: ${stats.unavailablePnlCount}`);
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

  // Everything is REST; the paper connector starts its simulator here
  await hyperliquid.connect();
  console.log('[Bot] Connected to Hyperliquid');
  console.log();
}

/**
 * Clean up imbalanced positions at startup
 * Uses the hedge utility to automatically hedge or close unhedged positions
 */
async function cleanupImbalancedPositions() {
  console.log('[Bot] Checking for imbalanced positions to hedge...');
  console.log();

  try {
    if ((await verifyPositionOnChain(hyperliquid, state)).status === 'ambiguous') return;
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
    if (results.totalProcessed > 0 && state.position) {
      state = { ...state, position: { ...state.position, accountingComplete: false } };
      saveState(state);
    }

    if (results.totalProcessed === 0) {
      console.log(results.success ? '[Bot] No executable hedge repairs needed' : '[Bot] Recovery blocked: manual resolution required');
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
  state = await reconcilePendingIntent(hyperliquid, state);
  if (state.pendingIntent) {
    console.error('[Bot] Pending recovery unresolved; discretionary trading blocked');
    return;
  }
  cycleCount++;

  console.log('='.repeat(80));
  console.log(`${timestamp()} Check Cycle #${cycleCount} - ${new Date().toLocaleDateString()}`);
  console.log('='.repeat(80));
  console.log();

  try {
    // Step 1: Check existing position
    if (hasPosition(state)) {
      const position = getCurrentPosition(state);
      console.log(`${timestamp()} [1/6] Current Position:`);
      console.log(formatPosition(position));
      console.log();

      // Verify position still exists on-chain
      const onChainPosition = await verifyPositionOnChain(hyperliquid, state);

      if (onChainPosition.status === 'none') {
        const confirmedFlat = await confirmNoManagedExposure(3, 750, hyperliquid, state);
        if (!confirmedFlat) {
          console.log(`${timestamp()} [Bot] Managed exposure reappeared during flat confirmation. Keeping state and halting this cycle.`);
          return;
        }
        console.log(`${timestamp()} [Bot] Position in state confirmed absent on-chain. Clearing state.`);
        state = closePositionState(state, {
          reason: 'Position not found on-chain',
          perpClosePrice: null,
          spotClosePrice: null,
          totalPnl: null, accountingComplete: false
        });
        saveState(state);
      } else if (onChainPosition.status === 'ambiguous') {
        return;
      } else if (onChainPosition.status === 'imbalanced') {
        console.log(`${timestamp()} [Bot] Managed on-chain exposure is imbalanced. Halting new decisions this cycle.`);
        // A rejected re-short (e.g. no perp margin left after a liquidation) sells the measured spot excess instead of
        // leaving a naked long; an unknown order outcome never falls back. Startup keeps risk.startupCleanupMode.
        const repair = await autoHedgeAll(hyperliquid, config, { verbose: true, fallbackToClose: true, ...managedScope(position) });
        if (repair.totalProcessed > 0) {
          state = { ...state, position: { ...state.position, accountingComplete: false } };
          saveState(state);
        }
        return;
      } else {
        // Check if we should close position
        const age = getPositionAge(position);
        const canClose = canClosePosition(position, MIN_HOLD_TIME_MS);

        console.log(`${timestamp()} [2/6] Position Age: ${(age / (1000 * 60 * 60 * 24)).toFixed(2)} days`);
        console.log(`${timestamp()} [2/6] Can Close: ${canClose ? 'YES' : 'NO'} (min hold: ${MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24)} days)`);
        console.log();

        const analysis = await scanMarkets();

        // Cost-aware decision on 7d-average funding (see switchEdge). Only a position with negative
        // funding may be acted on inside the minimum hold.
        const signal = getCurrentPositionFundingSignal(position, analysis);
        if (!signal.available) {
          console.log(`${timestamp()} [4/6] ${signal.reason}. Holding current position.`);
        } else {
          const best = analysis.best && analysis.best.symbol !== position.symbol ? analysis.best : null;
          const { action, switchGain, blockedByHold } = decide(signal.fundingRate, best, canClose, config);
          console.log(`${timestamp()} [4/6] ${position.symbol} 7d avg funding: ${signal.fundingPercent.toFixed(2)}% APY`);
          if (best) {
            console.log(`${timestamp()} [4/6] Best alternative ${best.symbol}: ${best.avgFundingPercent.toFixed(2)}% APY, expected switch gain ${(switchGain * 100).toFixed(3)}% of notional`);
          }

          if (action) {
            const reason = signal.fundingRate < 0 ? 'Funding negative' : 'Better opportunity';
            await closeAndReopen(position, reason, action === 'switch' ? best : null);
            return;
          }
          console.log(`${timestamp()} [5/6] Holding current position${blockedByHold ? ' (within minimum hold)' : ''}`);
        }

        console.log(`${timestamp()} [6/6] Next check in 1 hour`);
        console.log();
        return;
      }
    } else {
      console.log(`${timestamp()} [1/6] No Current Position`);
      console.log();

      // Verify no position on-chain
      const onChainPosition = await verifyPositionOnChain(hyperliquid, state);

      if (onChainPosition.status !== 'none') {
        console.log(`${timestamp()} [Bot] Found position on-chain but not in state!`);
        if (onChainPosition.status === 'delta_neutral') {
          state = adoptOnChainPair(onChainPosition.pair, state, 'existing managed exposure');
        } else {
          console.log(`${timestamp()} [Bot] Status: ${onChainPosition.status}. Attempting hedge-only startup reconciliation.`);
          await autoHedgeAll(hyperliquid, config, { verbose: true, fallbackToClose: false, ...managedScope(null) });
        }
        return;
      }
    }

    // Find best opportunity
    const analysis = await scanMarkets();

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
 * The cycle's one market scan. The decision, the statistics (every STATS_LOG_INTERVAL cycles) and the 2-minute
 * status table all use it.
 */
async function scanMarkets() {
  console.log(`${timestamp()} [3/6] Checking opportunities...`);
  const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
  lastAnalysis = { ...analysis, time: Date.now() };
  if (cycleCount % STATS_LOG_INTERVAL === 1) {
    try {
      await logStatistics(hyperliquid, analysis.marketData, config.trading.pairs, getCurrentPosition(state)?.symbol);
    } catch (error) {
      console.error(`${timestamp()} [Bot] Failed to log statistics:`, error.message);
    }
  }
  console.log();
  console.log(analysis.report);
  console.log();
  return analysis;
}

/**
 * Check the free PERP/SPOT USDC split. If it is off by more than MAX_BALANCE_IMBALANCE_PERCENT, the bot is ON HOLD
 * (no trade, no exposure) until the user moves USDC by hand. The verdict is written to rebalance-status.json next to
 * the state file, so "is a rebalance needed?" can be answered without reading logs.
 * @returns {Promise<Object>} { balances, onHold }
 */
async function checkRebalance() {
  const balances = await getBalances(hyperliquid);
  const { perpBalance, spotBalance } = balances;
  const { imbalancePercent, onHold, amount, fromPerpToSpot } = rebalanceNeeded(balances, MAX_BALANCE_IMBALANCE_PERCENT);
  rebalanceHold = onHold ? (rebalanceHold || { since: new Date().toISOString() }) : null;

  const action = onHold
    ? `Transfer ${amount.toFixed(2)} USDC from ${fromPerpToSpot ? 'PERP to SPOT' : 'SPOT to PERP'} ` +
      `(Hyperliquid UI, account ${hyperliquid.wallet})`
    : 'none';
  const statusFile = path.join(path.dirname(getStateFilePath()), 'rebalance-status.json');
  try {
    writeJsonAtomic(statusFile, {
      rebalanceNeeded: onHold,
      status: onHold ? 'ACTION_REQUIRED' : 'OK',
      action,
      bot: onHold ? 'ON HOLD: no trades, no exposure until the transfer arrives' : 'balanced, trading normally',
      direction: onHold ? (fromPerpToSpot ? 'PERP_TO_SPOT' : 'SPOT_TO_PERP') : null,
      amountUSDC: onHold ? Number(amount.toFixed(2)) : 0,
      perpUSDC: Number(perpBalance.toFixed(2)),
      spotUSDC: Number(spotBalance.toFixed(2)),
      imbalancePercent: Number(imbalancePercent.toFixed(1)),
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
  return { balances, onHold };
}

/**
 * Open a delta-neutral position behind a crash-safe pending intent. The intent is cleared on failure
 * unless exposure may exist on-chain, which the next start (reconcilePendingIntent) then resolves.
 */
async function openPosition(opportunity, reason) {
  if ((await verifyPositionOnChain(hyperliquid, state)).status !== 'none') throw new Error('Managed exposure blocks a new opening');
  const balanceReport = await checkRebalance();
  if (balanceReport.onHold) {
    return;
  }

  console.log(`${timestamp()} [4/6] Opening Delta-Neutral Position for ${opportunity.symbol} (${reason})...`);
  state = setPendingIntent(state, {
    type: 'opening',
    symbol: opportunity.symbol,
    perpSymbol: opportunity.symbol,
    spotSymbol: perpToSpot(opportunity.symbol),
    reason
  });
  saveState(state);

  try {
    const result = await openDeltaNeutralPosition(hyperliquid, opportunity, balanceReport.balances, config, { verbose: true });
    if (result.success) {
      console.log(`${timestamp()} [5/6] ✅ Opened ${result.symbol}: SHORT ${result.perpSize} PERP @ $${formatPrice(result.perpEntryPrice)}, ` +
        `LONG ${result.spotSize} SPOT @ $${formatPrice(result.spotEntryPrice)}, value $${formatKnown(result.positionValue)}, ` +
        `7d funding ${(result.annualizedFunding * 100).toFixed(2)}% APY`);
      state = recordPosition(state, result);
      saveState(state);
      return;
    }
    console.log(`${timestamp()} [5/6] Failed to open position: ${result.error}`);
  } catch (error) {
    console.error(`${timestamp()} [5/6] Error opening position:`, error.message);
    if ((await verifyPositionOnChain(hyperliquid, state)).status !== 'none') {
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
  console.log(`${timestamp()} ✅ Position closed. PnL: $${Number.isFinite(closeResult.totalPnl) ? closeResult.totalPnl.toFixed(2) : 'unavailable'}`);
  state = closePositionState(state, closeResult);
  saveState(state);

  if (newOpportunity) {
    const refreshed = await findBestOpportunities(hyperliquid, [newOpportunity.symbol], config, { verbose: false });
    if (refreshed.best) await openPosition(refreshed.best, `after close: ${reason}`);
    else console.log('[Bot] Replacement no longer passes entry filters; remaining flat');
  }
}

/**
 * Display current bot status
 */
async function displayStatus() {
  const now = new Date();

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

  // Unresolved recovery (e.g. a close that failed on a transient error): retry every status tick, not only hourly
  if (state?.pendingIntent && !isRunning) {
    await runGuardedCycle();
  }

  await printPositionStatus(state, hyperliquid, MIN_HOLD_TIME_MS, CHECK_INTERVAL_MS);

  console.log(colors.dim + '─'.repeat(80) + colors.reset);
  console.log();

  // Market table of the last hourly scan: refetching it every 2 minutes cost ~125 weight/min for nothing new
  if (lastAnalysis) {
    const asOf = new Date(lastAnalysis.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log(`${colors.bright}📈 Markets (7-day funding, as of ${asOf}):${colors.reset}`);
    console.log(formatMarketTable(lastAnalysis.marketData, config.trading.pairs, getCurrentPosition(state)?.symbol));
    console.log();
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

  // A failed recovery (e.g. a close hitting a 429) must not exit into a Docker restart loop that resends orders on every
  // start: keep running; runCycle retries it first, and displayStatus every 2 minutes while it is pending.
  try {
    state = await reconcilePendingIntent(hyperliquid, state);
  } catch (error) {
    console.error(`${timestamp()} [Bot] Startup recovery failed, will retry: ${error.message}`);
  }

  // Clean up any imbalanced positions from failed trades
  if (!state.pendingIntent) await cleanupImbalancedPositions();

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

export { timestamp };
