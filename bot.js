import HyperliquidConnector from './hyperliquid.js';
import { loadState, saveState, hasPosition, getCurrentPosition, recordPosition, closePosition as closePositionState, updateCheckTime, canClosePosition, getPositionAge, formatPosition, getHistoryStats } from './utils/state.js';
import { checkAndReportBalances } from './utils/balance.js';
import { findBestOpportunities, isSignificantlyBetter } from './utils/opportunity.js';
import { getPerpPositions, getSpotBalances, analyzeDeltaNeutral } from './utils/positions.js';
import { openDeltaNeutralPosition, closeDeltaNeutralPosition } from './utils/trade.js';
import { logStatistics } from './utils/statistics.js';
import { autoHedgeAll } from './utils/hedge.js';
import { getFundingRates, getFundingRatesWithHistory } from './utils/funding.js';
import { get24HourVolumes, convertVolumesToUSDC } from './utils/volume.js';
import { getBidAskSpreads } from './utils/spread.js';
import { getPerpSpotSpreads } from './utils/arbitrage.js';
import { getManagedSpotSymbols, getMaxHedgeMismatchPercent } from './utils/risk.js';
import fs from 'fs';
import { pathToFileURL } from 'url';

/**
 * Delta-Neutral Trading Bot
 *
 * Automatically opens and manages delta-neutral positions to earn funding rate arbitrage.
 *
 * Strategy:
 * - SHORT PERP + LONG SPOT to earn positive funding
 * - Minimum hold time: 2 weeks
 * - Check cycle: Every 1 hour
 * - Switch positions if funding becomes negative or significantly better opportunity exists (2x+)
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

// Bot parameters
const CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const MIN_HOLD_TIME_MS = process.env.MIN_HOLD_TIME_MS
  ? parseInt(process.env.MIN_HOLD_TIME_MS)
  : (config.bot?.minHoldTimeDays ? config.bot.minHoldTimeDays * 24 * 60 * 60 * 1000 : 14 * 24 * 60 * 60 * 1000);  // Default: 2 weeks
const IMPROVEMENT_FACTOR = config.bot?.improvementFactor || 2;  // Require 2x better funding to switch
const STATS_LOG_INTERVAL = 6;  // Log statistics every N cycles (6 cycles = 6 hours)
const STATUS_DISPLAY_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes

// Global state
let state = null;
let hyperliquid = null;
let isRunning = false;
let cycleCount = 0;

function timestamp() {
  return `[${new Date().toLocaleTimeString()}]`;
}

/**
 * Initialize bot
 */
async function initialize() {
  console.log('='.repeat(80));
  console.log('Delta-Neutral Trading Bot');
  console.log('='.repeat(80));
  console.log();

  // Log configuration
  console.log('[Bot] Configuration:');
  console.log(`[Bot]   Min Hold Time: ${MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24)} days`);
  console.log(`[Bot]   Improvement Factor: ${IMPROVEMENT_FACTOR}x`);
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
  hyperliquid = new HyperliquidConnector({ testnet: false });

  if (!hyperliquid.wallet) {
    console.error('❌ Error: Wallet address not configured');
    console.error('   Please set HL_WALLET in .env file');
    process.exit(1);
  }

  console.log(`[Bot] Wallet: ${hyperliquid.wallet}`);
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
  const currentPosition = hasPosition(state) ? getCurrentPosition(state) : null;
  const managedSpotSymbols = getManagedSpotSymbols(config, currentPosition);

  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false }),
    getSpotBalances(hyperliquid, null, { verbose: false, managedSpotSymbols })
  ]);

  if (perpPositions.length === 0 && spotBalances.length === 0) {
    console.log('[Bot] ✅ No positions on-chain');
    return { status: 'none', pair: null, analysis: null };
  }

  // Analyze for delta-neutral
  const analysis = analyzeDeltaNeutral(perpPositions, spotBalances, {
    maxHedgeMismatchPercent: getMaxHedgeMismatchPercent(config)
  });

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

/**
 * Clean up imbalanced positions at startup
 * Uses the hedge utility to automatically hedge or close unhedged positions
 */
async function cleanupImbalancedPositions() {
  console.log('[Bot] Checking for imbalanced positions to hedge...');
  console.log();

  try {
    const results = await autoHedgeAll(hyperliquid, config, {
      verbose: true,
      minValueUSD: 1,
      fallbackToClose: true,
      managedSpotSymbols: Array.from(getManagedSpotSymbols(config, hasPosition(state) ? getCurrentPosition(state) : null)),
      maxHedgeMismatchPercent: getMaxHedgeMismatchPercent(config)
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
        console.log(`${timestamp()} [Bot] ⚠️  Position in state but not on-chain! Clearing state.`);
        state = closePositionState(state, {
          reason: 'Position not found on-chain',
          perpClosePrice: 0,
          spotClosePrice: 0,
          totalPnl: 0
        });
        saveState(state);
      } else if (onChainPosition.status === 'imbalanced') {
        console.log(`${timestamp()} [Bot] Managed on-chain exposure is imbalanced. Halting new decisions this cycle.`);
        await autoHedgeAll(hyperliquid, config, {
          verbose: true,
          minValueUSD: 1,
          fallbackToClose: false,
          managedSpotSymbols: Array.from(getManagedSpotSymbols(config, position)),
          maxHedgeMismatchPercent: getMaxHedgeMismatchPercent(config)
        });
        return;
      } else {
        // Check if we should close position
        const age = getPositionAge(position);
        const canClose = canClosePosition(position, MIN_HOLD_TIME_MS);

        console.log(`${timestamp()} [2/6] Position Age: ${(age / (1000 * 60 * 60 * 24)).toFixed(2)} days`);
        console.log(`${timestamp()} [2/6] Can Close: ${canClose ? 'YES' : 'NO'} (min hold: ${MIN_HOLD_TIME_MS / (1000 * 60 * 60 * 24)} days)`);
        console.log();

        if (canClose) {
          // Check current funding rate
          console.log(`${timestamp()} [3/6] Checking current opportunities...`);
          const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
          console.log();
          console.log(analysis.report);
          console.log();

          // Find current position's funding
          const currentSymbolOpp = analysis.rankedOpportunities.find(o => o.symbol === position.symbol);

          // If not in ranked opportunities, check raw market data (might be filtered out due to low/negative funding)
          if (!currentSymbolOpp) {
            console.log(`${timestamp()} [4/6] ⚠️  ${position.symbol} not in ranked opportunities (may be filtered out)`);

            // Check raw funding data from marketData
            const rawFundingData = analysis.marketData.fundingRates.find(f => f.symbol === position.symbol);
            const rawPredictedData = analysis.marketData.predictedFundingRates?.get(position.symbol);

            if (rawFundingData && !rawFundingData.error) {
              // CRITICAL: Use PREDICTED funding rate (what will be paid NEXT), not historical
              const predictedFunding = rawPredictedData?.predictedAnnualizedRate;
              const avgFunding = rawFundingData.history?.avg?.annualized || rawFundingData.annualizedRate;
              const useFunding = predictedFunding !== null && predictedFunding !== undefined ? predictedFunding : avgFunding;
              const useFundingPercent = useFunding * 100;

              console.log(`${timestamp()} [4/6] Funding data: ${useFundingPercent.toFixed(2)}% APY ${predictedFunding !== null && predictedFunding !== undefined ? '(predicted)' : '(avg)'}`);

              // Check if funding is negative
              if (useFundingPercent < 0) {
                console.log(`${timestamp()} [4/6] ❌ Funding is negative! Closing position...`);

                // Only reopen if there's a valid positive opportunity (check primaryFundingPercent)
                const newOpportunity = (analysis.best && analysis.best.primaryFundingPercent > 0) ? analysis.best : null;

                if (newOpportunity) {
                  console.log(`${timestamp()} [4/6] ✅ Found positive opportunity: ${newOpportunity.symbol} (${newOpportunity.primaryFundingPercent.toFixed(2)}% APY)`);
                } else {
                  console.log(`${timestamp()} [4/6] ⚠️  No positive funding opportunities available. Will close without reopening.`);
                }

                await closeAndReopen(position, 'Funding turned negative', newOpportunity);
                return;
              } else if (useFundingPercent < config.thresholds.minFundingRatePercent) {
                console.log(`${timestamp()} [4/6] ⚠️  Funding below minimum threshold (${useFundingPercent.toFixed(2)}% < ${config.thresholds.minFundingRatePercent}%)`);
                console.log(`${timestamp()} [4/6] Checking for better opportunities...`);

                // Close and switch to better opportunity if one exists
                if (analysis.best && analysis.best.symbol !== position.symbol) {
                  console.log(`${timestamp()} [4/6] ✅ Found better opportunity: ${analysis.best.symbol} (${analysis.best.primaryFundingPercent.toFixed(2)}% APY)`);
                  await closeAndReopen(position, 'Funding below minimum threshold', analysis.best);
                  return;
                } else {
                  console.log(`${timestamp()} [4/6] No better opportunities available. Holding current position.`);
                }
              }
            } else {
              console.log(`${timestamp()} [4/6] ❌ Cannot retrieve funding data for ${position.symbol}`);
            }
          } else {
            // CRITICAL: Use primaryFundingPercent (predicted if available, else avg)
            const currentFunding = currentSymbolOpp.primaryFundingPercent;
            const fundingType = currentSymbolOpp.predictedFundingPercent !== null && currentSymbolOpp.predictedFundingPercent !== undefined ? '(predicted)' : '(avg)';
            console.log(`${timestamp()} [4/6] Current position ${position.symbol} funding: ${currentFunding.toFixed(2)}% APY ${fundingType}`);

            // Check if funding is negative
            if (currentFunding < 0) {
              console.log(`${timestamp()} [4/6] ❌ Funding turned negative! Closing position...`);

              // Only reopen if there's a valid positive opportunity (check primaryFundingPercent)
              const newOpportunity = (analysis.best && analysis.best.primaryFundingPercent > 0) ? analysis.best : null;

              if (newOpportunity) {
                console.log(`${timestamp()} [4/6] ✅ Found positive opportunity: ${newOpportunity.symbol} (${newOpportunity.primaryFundingPercent.toFixed(2)}% APY)`);
              } else {
                console.log(`${timestamp()} [4/6] ⚠️  No positive funding opportunities available. Will close without reopening.`);
              }

              await closeAndReopen(position, 'Funding turned negative', newOpportunity);
              return;
            }

            // Check if significantly better opportunity exists
            if (analysis.best && analysis.best.symbol !== position.symbol) {
              const incumbentFundingRate = currentSymbolOpp.primaryFundingRate ?? position.annualizedFunding;
              const isBetter = isSignificantlyBetter(
                { avgFundingRate: incumbentFundingRate },
                { avgFundingRate: analysis.best.primaryFundingRate },  // Use primaryFundingRate for comparison
                IMPROVEMENT_FACTOR
              );

              if (isBetter) {
                console.log(`${timestamp()} [4/6] ✅ Found significantly better opportunity: ${analysis.best.symbol}`);
                console.log(`${timestamp()} [4/6]   Current: ${(incumbentFundingRate * 100).toFixed(2)}% APY`);
                console.log(`${timestamp()} [4/6]   New: ${analysis.best.primaryFundingPercent.toFixed(2)}% APY`);
                console.log(`${timestamp()} [4/6]   Improvement: ${(analysis.best.primaryFundingRate / incumbentFundingRate).toFixed(2)}x`);
                await closeAndReopen(position, 'Switching to better opportunity', analysis.best);
                return;
              } else {
                console.log(`${timestamp()} [4/6] Current position is still competitive`);
              }
            }
          }

          console.log(`${timestamp()} [5/6] Holding current position`);
        } else {
          console.log(`${timestamp()} [3/6] Position within minimum hold time, skipping opportunity check`);
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
        console.log(`${timestamp()} [Bot] ⚠️  Found position on-chain but not in state!`);
        console.log(`${timestamp()} [Bot]    Status: ${onChainPosition.status}. Please close manually or wait for next cycle.`);
        // Don't open new position if there's one on-chain
        return;
      }
    }

    // Step 2: Check balance distribution
    console.log(`${timestamp()} [2/6] Checking Balance Distribution...`);
    const balanceReport = await checkAndReportBalances(hyperliquid, 10);
    console.log(balanceReport.report);
    console.log();

    // Step 3: Find best opportunity
    console.log(`${timestamp()} [3/6] Finding Best Opportunities...`);
    const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
    console.log();
    console.log(analysis.report);
    console.log();

    // No valid opportunities (includes case where all symbols have negative funding)
    // Opportunities are filtered by minFundingRatePercent threshold (default 5% APY)
    if (!analysis.best) {
      console.log(`${timestamp()} [4/6] ❌ No valid opportunities found. Waiting for next cycle...`);
      console.log(`${timestamp()} [4/6]   (All symbols filtered out - may be negative funding, low volume, or high spreads)`);
      console.log(`${timestamp()} [5/6] Skipped`);
      console.log(`${timestamp()} [6/6] Next check in 1 hour`);
      console.log();
      return;
    }

    // Step 4: Open position
    console.log(`${timestamp()} [4/6] Opening Delta-Neutral Position for ${analysis.best.symbol}...`);
    console.log();

    try {
      const positionResult = await openDeltaNeutralPosition(
        hyperliquid,
        analysis.best,
        balanceReport.balances,
        config,
        { verbose: true }
      );

      if (positionResult.success) {
        console.log();
        console.log(`${timestamp()} [5/6] ✅ Position Opened Successfully!`);
        console.log(`${timestamp()} [5/6]   Symbol: ${positionResult.symbol}`);
        console.log(`${timestamp()} [5/6]   PERP: SHORT ${positionResult.perpSize} @ $${positionResult.perpEntryPrice.toFixed(2)}`);
        console.log(`${timestamp()} [5/6]   SPOT: LONG ${positionResult.spotSize} @ $${positionResult.spotEntryPrice.toFixed(2)}`);
        console.log(`${timestamp()} [5/6]   Position Value: $${positionResult.positionValue.toFixed(2)}`);
        console.log(`${timestamp()} [5/6]   Funding: ${(positionResult.annualizedFunding * 100).toFixed(2)}% APY`);
        console.log();

        // Record position in state
        state = recordPosition(state, positionResult);
        saveState(state);
        console.log(`${timestamp()} [5/6] Position recorded in state`);
      } else {
        console.log(`${timestamp()} [5/6] ❌ Failed to open position`);
      }
    } catch (error) {
      console.error(`${timestamp()} [5/6] ❌ Error opening position:`, error.message);
    }

    console.log(`${timestamp()} [6/6] Next check in 1 hour`);
    console.log();

  } catch (error) {
    console.error(`${timestamp()} [Bot] ❌ Error in cycle:`, error.message);
    console.error(error.stack);
  }
}

/**
 * Close current position and open new one
 */
async function closeAndReopen(currentPosition, reason, newOpportunity) {
  console.log(`${timestamp()} [Bot] Closing position: ${reason}`);
  console.log();

  try {
    // Close current position
    const closeResult = await closeDeltaNeutralPosition(
      hyperliquid,
      currentPosition,
      config,
      { verbose: true, reason }
    );

    if (closeResult.success) {
      console.log();
      console.log(`${timestamp()} ✅ Position Closed Successfully!`);
      console.log(`${timestamp()}    PnL: $${closeResult.totalPnl.toFixed(2)}`);
      console.log();

      // Update state
      state = closePositionState(state, closeResult);
      saveState(state);

      // Open new position if opportunity provided
      if (newOpportunity) {
        console.log(`Opening new position for ${newOpportunity.symbol}...`);
        console.log();

        // Get fresh balance data
        const balanceReport = await checkAndReportBalances(hyperliquid, 10);

        const positionResult = await openDeltaNeutralPosition(
          hyperliquid,
          newOpportunity,
          balanceReport.balances,
          config,
          { verbose: true }
        );

        if (positionResult.success) {
          console.log();
          console.log('✅ New Position Opened Successfully!');
          console.log(`   Symbol: ${positionResult.symbol}`);
          console.log(`   Funding: ${(positionResult.annualizedFunding * 100).toFixed(2)}% APY`);
          console.log();

          state = recordPosition(state, positionResult);
          saveState(state);
        }
      }
    } else {
      console.error('❌ Failed to close position');
      throw new Error('Failed to close position');
    }
  } catch (error) {
    console.error('❌ Error closing position:', error.message);
    throw error;
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
  console.log(`${colors.bright}${colors.cyan}📊 Bot Status${colors.reset} - ${colors.dim}${now.toLocaleString()}${colors.reset}`);
  console.log(colors.dim + '─'.repeat(80) + colors.reset);

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
      console.log(`${colors.green}✅ Can Rebalance: YES${colors.reset} ${colors.dim}(held > ${minHoldDays} days)${colors.reset}`);
      console.log(`   ${colors.dim}Will close if:${colors.reset}`);
      console.log(`   • Funding turns negative, OR`);
      console.log(`   • ${IMPROVEMENT_FACTOR}x better opportunity exists`);
    } else {
      if (daysUntilCanClose >= 1) {
        console.log(`${colors.yellow}⏳ Can Rebalance: NO${colors.reset} ${colors.dim}(need ${daysUntilCanClose.toFixed(2)} more days)${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⏳ Can Rebalance: NO${colors.reset} ${colors.dim}(need ${hoursUntilCanClose.toFixed(1)} more hours)${colors.reset}`);
      }
      console.log(`   ${colors.dim}Min hold: ${minHoldDays} days${colors.reset}`);
      console.log(`   ${colors.dim}Can close at: ${new Date(position.openTime + MIN_HOLD_TIME_MS).toLocaleString()}${colors.reset}`);
    }

  } else {
    console.log(`${colors.bright}Position:${colors.reset} None`);
    console.log(`${colors.bright}Status:${colors.reset} 🔍 Looking for opportunities...`);
    console.log(`${colors.dim}Next check: ${new Date(state.lastOpportunityCheck + CHECK_INTERVAL_MS).toLocaleTimeString()}${colors.reset}`);
  }

  console.log(colors.dim + '─'.repeat(80) + colors.reset);
  console.log();

  // Fetch and display market summary
  try {
    const colors = {
      reset: '\x1b[0m',
      bright: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m'
    };

    console.log(`${colors.bright}📈 Market Summary:${colors.reset}`);
    console.log();

    // Fetch current funding rates only (faster, no history to avoid rate limits)
    // Fetch market data (funding, volumes, perp-spot spreads) with exponential backoff for 429 errors
    const [fundingData, rawVolumes, perpSpotSpreads] = await retryWithExponentialBackoff(
      async () => Promise.all([
        getFundingRates(hyperliquid, config.trading.pairs, { verbose: false }),
        get24HourVolumes(hyperliquid, config.trading.pairs, { verbose: false }),
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

    // Fetch bid-ask spreads via WebSocket subscription (avoids REST API rate limits)
    const bidAskSpreads = [];
    try {
      // Subscribe to orderbooks for all pairs (both PERP and SPOT)
      const subscribePromises = [];
      const spotOrderbookCoins = new Map();
      for (const symbol of config.trading.pairs) {
        subscribePromises.push(hyperliquid.subscribeOrderbook(symbol)); // PERP
        const spotSymbol = HyperliquidConnector.perpToSpot(symbol);
        const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
        const spotCoin = hyperliquid.getCoinForOrderbook(spotSymbol, spotAssetId);
        spotOrderbookCoins.set(symbol, spotCoin);
        subscribePromises.push(hyperliquid.subscribeOrderbook(spotCoin)); // SPOT
      }
      await Promise.all(subscribePromises);

      // Wait for orderbook data to arrive and validate we have valid data
      const maxRetries = 5;
      const retryDelay = 500; // ms
      let validDataCount = 0;

      for (let retry = 0; retry < maxRetries; retry++) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));

        // Check how many symbols have valid orderbook data
        validDataCount = 0;
        for (const symbol of config.trading.pairs) {
          const perpBidAsk = hyperliquid.getBidAsk(symbol);
          const spotBidAsk = hyperliquid.getBidAsk(spotOrderbookCoins.get(symbol));

          // Check if we have valid bid/ask/mid data
          if (perpBidAsk?.bid && perpBidAsk?.ask && perpBidAsk?.mid && perpBidAsk.mid > 0 &&
              spotBidAsk?.bid && spotBidAsk?.ask && spotBidAsk?.mid && spotBidAsk.mid > 0) {
            validDataCount++;
          }
        }

        // If we have valid data for most symbols (at least 75%), we're good
        if (validDataCount >= config.trading.pairs.length * 0.75) {
          break;
        }
      }

      if (validDataCount === 0) {
        throw new Error('No valid orderbook data received after retries');
      }

      // Get spreads from cached orderbook data
      for (const symbol of config.trading.pairs) {
        const perpBidAsk = hyperliquid.getBidAsk(symbol);
        const spotSymbol = HyperliquidConnector.perpToSpot(symbol);
        const spotBidAsk = hyperliquid.getBidAsk(spotOrderbookCoins.get(symbol));

        if (perpBidAsk && spotBidAsk) {
          let perpSpread = null;
          let spotSpread = null;

          // Calculate PERP spread with validation
          if (perpBidAsk.ask && perpBidAsk.bid && perpBidAsk.mid && perpBidAsk.mid > 0) {
            perpSpread = ((perpBidAsk.ask - perpBidAsk.bid) / perpBidAsk.mid) * 100;
            // Validate result is a valid number
            if (!isFinite(perpSpread)) perpSpread = null;
          }

          // Calculate SPOT spread with validation
          if (spotBidAsk.ask && spotBidAsk.bid && spotBidAsk.mid && spotBidAsk.mid > 0) {
            spotSpread = ((spotBidAsk.ask - spotBidAsk.bid) / spotBidAsk.mid) * 100;
            // Validate result is a valid number
            if (!isFinite(spotSpread)) spotSpread = null;
          }

          bidAskSpreads.push({
            perpSymbol: symbol,
            spotSymbol: spotSymbol,
            perpSpreadPercent: perpSpread,
            spotSpreadPercent: spotSpread
          });
        }
      }

      // Unsubscribe to clean up
      for (const symbol of config.trading.pairs) {
        hyperliquid.unsubscribe(symbol); // PERP
        const spotSymbol = HyperliquidConnector.perpToSpot(symbol);
        const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
        const spotCoin = hyperliquid.getCoinForOrderbook(spotSymbol, spotAssetId);
        hyperliquid.unsubscribe(spotCoin); // SPOT
      }
    } catch (error) {
      // If WebSocket fails, just show --- (no spreads)
      console.error(colors.dim + `[Status] Could not fetch bid-ask spreads: ${error.message}` + colors.reset);
    }

    // Convert volumes to USDC
    const volumes = await convertVolumesToUSDC(hyperliquid, rawVolumes);

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
async function run() {
  await initialize();

  // Clean up any imbalanced positions from failed trades
  await cleanupImbalancedPositions();

  // Run first cycle immediately
  await runCycle();

  // Display initial status
  await displayStatus();

  // Schedule regular cycles
  setInterval(async () => {
    if (isRunning) {
      console.log('[Bot] Previous cycle still running, skipping...');
      return;
    }

    isRunning = true;
    try {
      await runCycle();
    } catch (error) {
      console.error('[Bot] Cycle error:', error.message);
    } finally {
      isRunning = false;
    }
  }, CHECK_INTERVAL_MS);

  // Schedule status display every 2 minutes
  setInterval(async () => {
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
  console.log();
  console.log('[Bot] Shutting down...');

  if (hyperliquid) {
    hyperliquid.disconnect();
  }

  if (state) {
    saveState(state);
    console.log('[Bot] State saved');
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
    process.exit(1);
  });
}

export { timestamp, verifyPositionOnChain, runCycle, closeAndReopen, displayStatus };
