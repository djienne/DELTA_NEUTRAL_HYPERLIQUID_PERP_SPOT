import HyperliquidConnector from '../hyperliquid.js';
import { getPerpPositions, getSpotBalances, analyzeDeltaNeutral } from './positions.js';
import { assertCompleteFill } from './order-fill.js';
import { getMinFillRatio } from './risk.js';

/**
 * Hedge Utility Functions
 *
 * Detect and correct unhedged positions by creating matching opposite positions
 */

function buildHedgeNeed(fields) {
  return {
    targetSymbol: null,
    targetMarket: null,
    targetSide: null,
    targetSize: null,
    fallbackCloseSymbol: null,
    fallbackCloseMarket: null,
    fallbackCloseSide: null,
    fallbackCloseSize: null,
    fallbackCloseReduceOnly: true,
    ...fields
  };
}

function isSpotMarket(market) {
  return market === 'SPOT';
}

/**
 * Analyze current positions and identify what needs hedging
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {Object} options - Options
 * @returns {Promise<Object>} Analysis with hedge recommendations
 */
export async function analyzeHedgeNeeds(hyperliquid, options = {}) {
  const {
    minValueUSD = 1,
    verbose = false,
    managedSpotSymbols = null,
    managedPerpSymbols = null,
    maxHedgeMismatchPercent = 30
  } = options;

  if (verbose) {
    console.log('[Hedge] Analyzing positions for hedge needs...');
  }

  // Fetch current positions
  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false, managedPerpSymbols }),
    getSpotBalances(hyperliquid, null, { verbose: false, managedSpotSymbols })
  ]);

  // Analyze for delta-neutral pairs
  const analysis = analyzeDeltaNeutral(perpPositions, spotBalances, { maxHedgeMismatchPercent });

  // Get prices for all symbols
  const allMids = await hyperliquid.getAllMids();
  const priceMap = {};
  for (const [symbol, priceStr] of Object.entries(allMids)) {
    priceMap[symbol] = parseFloat(priceStr);
  }

  // Build hedge recommendations
  const hedgeNeeds = [];

  // Check existing delta-neutral pairs for WEAK hedges that need strengthening
  for (const pair of [...analysis.deltaNeutralPairs, ...analysis.imbalancedPairs]) {
    // Only strengthen if mismatch is significant (> 5%) and it's actually delta-neutral
    if (pair.isDeltaNeutral && pair.sizeMismatchPct > 5) {
      const price = priceMap[pair.symbol] || 0;
      const sizeDiff = Math.abs(pair.perpSize - pair.spotSize);

      if (pair.perpSize < pair.spotSize) {
        // Need more PERP SHORT to match SPOT LONG
        const perpSizeNeeded = sizeDiff;
        const value = perpSizeNeeded * price;

        if (value >= minValueUSD) {
          hedgeNeeds.push(buildHedgeNeed({
            type: 'STRENGTHEN_PERP_SHORT',
            spotSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
            perpSymbol: pair.symbol,
            existingPerpSize: pair.perpSize,
            existingSpotSize: pair.spotSize,
            spotSize: pair.spotSize,
            perpSizeNeeded: perpSizeNeeded,
            targetSymbol: pair.symbol,
            targetMarket: 'PERP',
            targetSide: 'sell',
            targetSize: perpSizeNeeded,
            fallbackCloseSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
            fallbackCloseMarket: 'SPOT',
            fallbackCloseSide: 'sell',
            fallbackCloseSize: perpSizeNeeded,
            fallbackCloseReduceOnly: false,
            currentPrice: price,
            valueUSD: value,
            action: 'SELL',
            market: 'PERP',
            reason: `Strengthen WEAK hedge (${pair.sizeMismatchPct.toFixed(1)}% mismatch)`
          }));
        }
      } else if (pair.spotSize < pair.perpSize) {
        const spotSizeNeeded = sizeDiff;
        const value = spotSizeNeeded * price;

        if (value >= minValueUSD) {
          hedgeNeeds.push(buildHedgeNeed({
            type: 'STRENGTHEN_SPOT_LONG',
            spotSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
            perpSymbol: pair.symbol,
            existingPerpSize: pair.perpSize,
            existingSpotSize: pair.spotSize,
            perpSize: pair.perpSize,
            spotSizeNeeded,
            targetSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
            targetMarket: 'SPOT',
            targetSide: 'buy',
            targetSize: spotSizeNeeded,
            fallbackCloseSymbol: pair.symbol,
            fallbackCloseMarket: 'PERP',
            fallbackCloseSide: 'buy',
            fallbackCloseSize: spotSizeNeeded,
            fallbackCloseReduceOnly: true,
            currentPrice: price,
            valueUSD: value,
            action: 'BUY',
            market: 'SPOT',
            reason: `Strengthen WEAK hedge (${pair.sizeMismatchPct.toFixed(1)}% mismatch)`
          }));
        }
      }
    } else if (!pair.isDeltaNeutral && pair.imbalanceType === 'DOUBLE_LONG') {
      const price = priceMap[pair.symbol] || 0;
      const value = pair.perpSize * price;
      if (value >= minValueUSD) {
        hedgeNeeds.push(buildHedgeNeed({
          type: 'DOUBLE_LONG_REQUIRES_CLOSE',
          spotSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
          perpSymbol: pair.symbol,
          perpSide: pair.perpSide,
          perpSize: pair.perpSize,
          spotSize: pair.spotSize,
          fallbackCloseSymbol: pair.symbol,
          fallbackCloseMarket: 'PERP',
          fallbackCloseSide: 'sell',
          fallbackCloseSize: pair.perpSize,
          fallbackCloseReduceOnly: true,
          currentPrice: price,
          valueUSD: value,
          action: 'CLOSE',
          market: 'PERP',
          reason: 'Directional LONG PERP + LONG SPOT exposure requires closing the PERP leg'
        }));
      }
    }
  }

  // Unhedged SPOT positions need PERP shorts
  for (const spotPos of analysis.unmatchedSpot) {
    const perpSymbol = HyperliquidConnector.spotToPerp(spotPos.symbol);
    const price = priceMap[perpSymbol] || 0;
    // analyzeDeltaNeutral returns balance objects with .balance.total property
    const spotSize = spotPos.balance?.total || spotPos.total || 0;
    const value = spotSize * price;

    if (value >= minValueUSD) {
      hedgeNeeds.push(buildHedgeNeed({
        type: 'SPOT_NEEDS_PERP_SHORT',
        spotSymbol: spotPos.symbol,
        perpSymbol: perpSymbol,
        spotSize: spotSize,
        perpSizeNeeded: spotSize,
        targetSymbol: perpSymbol,
        targetMarket: 'PERP',
        targetSide: 'sell',
        targetSize: spotSize,
        fallbackCloseSymbol: spotPos.symbol,
        fallbackCloseMarket: 'SPOT',
        fallbackCloseSide: 'sell',
        fallbackCloseSize: spotSize,
        fallbackCloseReduceOnly: false,
        currentPrice: price,
        valueUSD: value,
        action: 'SELL',
        market: 'PERP',
        reason: 'Unhedged SPOT position'
      }));
    }
  }

  // Unhedged PERP positions need opposite SPOT
  for (const perpPos of analysis.unmatchedPerp) {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpPos.symbol);
    const price = priceMap[perpPos.symbol] || 0;
    const value = Math.abs(perpPos.size) * price;

    if (value >= minValueUSD) {
      // If we have a SHORT perp, we need LONG spot (buy)
      // If we have a LONG perp, we need SHORT spot (sell)
      const needSpotBuy = perpPos.side === 'SHORT';

      hedgeNeeds.push(buildHedgeNeed({
        type: 'PERP_NEEDS_SPOT',
        perpSymbol: perpPos.symbol,
        spotSymbol: spotSymbol,
        perpSide: perpPos.side,
        perpSize: Math.abs(perpPos.size),
        spotSizeNeeded: Math.abs(perpPos.size),
        targetSymbol: needSpotBuy ? spotSymbol : null,
        targetMarket: needSpotBuy ? 'SPOT' : null,
        targetSide: needSpotBuy ? 'buy' : null,
        targetSize: needSpotBuy ? Math.abs(perpPos.size) : null,
        fallbackCloseSymbol: perpPos.symbol,
        fallbackCloseMarket: 'PERP',
        fallbackCloseSide: perpPos.side === 'LONG' ? 'sell' : 'buy',
        fallbackCloseSize: Math.abs(perpPos.size),
        fallbackCloseReduceOnly: true,
        currentPrice: price,
        valueUSD: value,
        action: needSpotBuy ? 'BUY' : 'SELL',
        market: 'SPOT',
        reason: `Unhedged PERP ${perpPos.side.toUpperCase()}`
      }));
    }
  }

  return {
    analysis: analysis,
    hedgeNeeds: hedgeNeeds,
    needsHedging: hedgeNeeds.length > 0,
    hasDeltaNeutralPairs: analysis.deltaNeutralPairs.length > 0
  };
}

/**
 * Create a hedge for a single unhedged position
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {Object} hedgeNeed - Hedge recommendation from analyzeHedgeNeeds
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<Object>} Hedge result
 */
export async function createHedge(hyperliquid, hedgeNeed, config, options = {}) {
  const { verbose = false } = options;

  if (!hedgeNeed.targetSymbol || !hedgeNeed.targetMarket || !hedgeNeed.targetSide || !hedgeNeed.targetSize) {
    return {
      success: false,
      requiresClose: Boolean(hedgeNeed.fallbackCloseSymbol),
      error: 'No safe hedge order is available for this exposure shape',
      hedgeNeed
    };
  }

  const symbol = hedgeNeed.targetSymbol;
  const isSpot = isSpotMarket(hedgeNeed.targetMarket);
  const size = hedgeNeed.targetSize;
  const minFillRatio = getMinFillRatio(config);

  if (verbose) {
    console.log(`[Hedge] Creating hedge for ${symbol}:`);
    console.log(`[Hedge]   Type: ${hedgeNeed.type}`);
    console.log(`[Hedge]   Action: ${hedgeNeed.targetSide.toUpperCase()} ${size.toFixed(6)} ${symbol} (${hedgeNeed.targetMarket})`);
    console.log(`[Hedge]   Value: ${hedgeNeed.valueUSD.toFixed(2)}`);
    console.log(`[Hedge]   Reason: ${hedgeNeed.reason}`);
  }

  try {
    const assetId = await hyperliquid.getAssetId(symbol, isSpot);
    const assetInfo = hyperliquid.getAssetInfo(symbol, assetId);
    const sizeRounded = parseFloat(hyperliquid.roundSize(size, assetInfo.szDecimals, 'down'));

    const result = await hyperliquid.createMarketOrder(symbol, hedgeNeed.targetSide, sizeRounded, {
      isSpot,
      reduceOnly: false,
      slippage: config.trading?.maxSlippagePercent || 5.0,
      overrideMidPrice: hedgeNeed.currentPrice,
      sizeRoundingMode: 'down'
    });

    const outcome = assertCompleteFill(result, sizeRounded, {
      minFillRatio,
      fallbackPrice: hedgeNeed.currentPrice,
      context: { hedgeType: hedgeNeed.type, symbol, isSpot }
    });

    if (verbose) {
      console.log(`[Hedge]   Success: ${hedgeNeed.targetSide.toUpperCase()} ${outcome.fillSize} @ ${outcome.fillPrice.toFixed(2)}`);
    }

    return {
      success: true,
      hedgeNeed,
      fillPrice: outcome.fillPrice,
      fillSize: outcome.fillSize,
      fillValue: outcome.fillSize * outcome.fillPrice,
      result
    };
  } catch (error) {
    if (verbose) {
      console.error(`[Hedge]   Error: ${error.message}`);
    }
    return {
      success: false,
      error: error.message,
      hedgeNeed
    };
  }
}

async function closeFallbackExposure(hyperliquid, hedgeNeed, config, options = {}) {
  const { verbose = false } = options;

  if (!hedgeNeed.fallbackCloseSymbol || !hedgeNeed.fallbackCloseSize || !hedgeNeed.fallbackCloseSide) {
    return {
      success: false,
      error: 'No fallback close order is defined for this hedge need',
      hedgeNeed
    };
  }

  const isSpot = isSpotMarket(hedgeNeed.fallbackCloseMarket);
  const minFillRatio = getMinFillRatio(config);
  const assetId = await hyperliquid.getAssetId(hedgeNeed.fallbackCloseSymbol, isSpot);
  const assetInfo = hyperliquid.getAssetInfo(hedgeNeed.fallbackCloseSymbol, assetId);
  const sizeRounded = parseFloat(hyperliquid.roundSize(hedgeNeed.fallbackCloseSize, assetInfo.szDecimals, 'down'));

  const result = await hyperliquid.createMarketOrder(
    hedgeNeed.fallbackCloseSymbol,
    hedgeNeed.fallbackCloseSide,
    sizeRounded,
    {
      isSpot,
      reduceOnly: isSpot ? false : hedgeNeed.fallbackCloseReduceOnly !== false,
      slippage: config.trading?.maxSlippagePercent || 5.0,
      overrideMidPrice: hedgeNeed.currentPrice,
      sizeRoundingMode: 'down'
    }
  );

  const outcome = assertCompleteFill(result, sizeRounded, {
    minFillRatio,
    fallbackPrice: hedgeNeed.currentPrice,
    context: {
      hedgeType: hedgeNeed.type,
      symbol: hedgeNeed.fallbackCloseSymbol,
      isSpot,
      fallbackClose: true
    }
  });

  if (verbose) {
    console.log(`[Hedge]   Closed ${hedgeNeed.fallbackCloseSymbol}: ${outcome.fillSize} @ ${outcome.fillPrice.toFixed(2)}`);
  }

  return {
    success: true,
    hedgeNeed,
    fillSize: outcome.fillSize,
    fillPrice: outcome.fillPrice,
    result
  };
}

/**
 * Automatically hedge all unhedged positions
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<Object>} Results summary
 */
export async function autoHedgeAll(hyperliquid, config, options = {}) {
  const {
    verbose = false,
    minValueUSD = 1,
    fallbackToClose = true,
    managedSpotSymbols = null,
    managedPerpSymbols = null,
    maxHedgeMismatchPercent = 30
  } = options;

  if (verbose) {
    console.log('[Hedge] Starting auto-hedge process...');
    console.log();
  }

  // Analyze what needs hedging
  const analysis = await analyzeHedgeNeeds(hyperliquid, {
    minValueUSD,
    verbose: false,
    managedSpotSymbols,
    managedPerpSymbols,
    maxHedgeMismatchPercent
  });

  if (!analysis.needsHedging) {
    if (verbose) {
      console.log('[Hedge] ✅ No positions need hedging');
    }
    return {
      success: true,
      totalProcessed: 0,
      hedged: [],
      closed: [],
      failed: [],
      skipped: []
    };
  }

  if (verbose) {
    console.log(`[Hedge] Found ${analysis.hedgeNeeds.length} position(s) needing hedges`);
    console.log();
  }

  const results = {
    hedged: [],
    closed: [],
    failed: [],
    skipped: []
  };

  // Process each hedge need
  for (const hedgeNeed of analysis.hedgeNeeds) {
    if (verbose) {
      console.log('─'.repeat(80));
    }

    // Try to create hedge
    const hedgeResult = await createHedge(hyperliquid, hedgeNeed, config, { verbose });

    if (hedgeResult.success) {
      results.hedged.push(hedgeResult);
    } else if (fallbackToClose) {
      // Hedge failed, try to close the original position
      if (verbose) {
        console.log(`[Hedge] Hedge failed, attempting to close original position instead...`);
      }

      try {
        const closeResult = await closeFallbackExposure(hyperliquid, hedgeNeed, config, { verbose });
        results.closed.push({
          hedgeNeed,
          hedgeResult,
          closeResult
        });
      } catch (error) {
        if (verbose) {
          console.error(`[Hedge]   Error closing: ${error.message}`);
        }
        results.failed.push({
          hedgeNeed,
          hedgeResult,
          closeError: error.message
        });
      }
    } else {
      results.failed.push({
        hedgeNeed: hedgeNeed,
        hedgeResult: hedgeResult
      });
    }

    if (verbose) {
      console.log();
    }

    // Small delay between operations
    if (hedgeNeed !== analysis.hedgeNeeds[analysis.hedgeNeeds.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (verbose) {
    console.log('═'.repeat(80));
    console.log('[Hedge] Summary:');
    console.log(`  ✅ Hedged: ${results.hedged.length}`);
    console.log(`  🔒 Closed: ${results.closed.length}`);
    console.log(`  ❌ Failed: ${results.failed.length}`);
    console.log(`  ⏭️  Skipped: ${results.skipped.length}`);
    console.log('═'.repeat(80));
    console.log();
  }

  const postAnalysis = await analyzeHedgeNeeds(hyperliquid, {
    minValueUSD,
    verbose: false,
    managedSpotSymbols,
    managedPerpSymbols,
    maxHedgeMismatchPercent
  });

  if (postAnalysis.needsHedging) {
    results.failed.push({
      hedgeNeed: null,
      error: `Residual managed exposure remains after hedge attempts (${postAnalysis.hedgeNeeds.length} need(s))`,
      postAnalysis
    });
    if (verbose) {
      console.error(`[Hedge] Residual managed exposure remains after hedge attempts: ${postAnalysis.hedgeNeeds.length} need(s)`);
    }
  }

  return {
    success: results.failed.length === 0 && !postAnalysis.needsHedging,
    totalProcessed: analysis.hedgeNeeds.length,
    postAnalysis,
    ...results
  };
}

/**
 * Format hedge analysis as a report string
 * @param {Object} analysis - Analysis from analyzeHedgeNeeds
 * @returns {string} Formatted report
 */
export function formatHedgeReport(analysis) {
  const lines = [];

  lines.push('');
  lines.push('═'.repeat(80));
  lines.push('🎯 Hedge Analysis Report');
  lines.push('═'.repeat(80));
  lines.push('');

  // Delta-neutral pairs
  if (analysis.analysis.deltaNeutralPairs.length > 0) {
    lines.push(`✅ Delta-Neutral Pairs: ${analysis.analysis.deltaNeutralPairs.length}`);
    for (const pair of analysis.analysis.deltaNeutralPairs) {
      lines.push(`   ${pair.symbol}: ${pair.perpSide} ${pair.perpSize} PERP + ${pair.spotSize} SPOT`);
      lines.push(`   Hedge Quality: ${pair.hedgeQuality}, Mismatch: ${pair.sizeMismatchPct.toFixed(2)}%`);
    }
    lines.push('');
  }

  // Positions needing hedges
  if (analysis.needsHedging) {
    lines.push(`⚠️  Positions Needing Hedges: ${analysis.hedgeNeeds.length}`);
    lines.push('');

    for (const need of analysis.hedgeNeeds) {
      lines.push(`📍 ${need.perpSymbol || need.spotSymbol}:`);
      lines.push(`   Type: ${need.type}`);
      if (need.spotSize !== undefined || need.perpSize !== undefined) {
        const currentParts = [
          need.perpSize !== undefined ? `PERP ${need.perpSide || ''} ${need.perpSize.toFixed(6)}` : null,
          need.spotSize !== undefined ? `SPOT ${need.spotSize.toFixed(6)}` : null
        ].filter(Boolean);
        lines.push(`   Current: ${currentParts.join(' + ')}`);
      }
      if (need.targetSymbol) {
        lines.push(`   Action Needed: ${need.targetSide.toUpperCase()} ${need.targetSize.toFixed(6)} ${need.targetMarket}`);
      } else if (need.fallbackCloseSymbol) {
        lines.push(`   Action Needed: CLOSE ${need.fallbackCloseSize.toFixed(6)} ${need.fallbackCloseMarket}`);
      }
      lines.push(`   Value: $${need.valueUSD.toFixed(2)}`);
      lines.push(`   Reason: ${need.reason}`);
      lines.push('');
    }
  } else {
    lines.push('✅ All positions are hedged or below minimum threshold');
    lines.push('');
  }

  lines.push('═'.repeat(80));
  lines.push('');

  return lines.join('\n');
}
