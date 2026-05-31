import HyperliquidConnector from '../hyperliquid.js';
import { getPerpPositions, getSpotBalances, analyzeDeltaNeutral } from './positions.js';

/**
 * Hedge Utility Functions
 *
 * Detect and correct unhedged positions by creating matching opposite positions
 */

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
    maxHedgeMismatchPercent = 30
  } = options;

  if (verbose) {
    console.log('[Hedge] Analyzing positions for hedge needs...');
  }

  // Fetch current positions
  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false }),
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
          hedgeNeeds.push({
            type: 'STRENGTHEN_PERP_SHORT',
            spotSymbol: HyperliquidConnector.perpToSpot(pair.symbol),
            perpSymbol: pair.symbol,
            existingPerpSize: pair.perpSize,
            existingSpotSize: pair.spotSize,
            spotSize: pair.spotSize,
            perpSizeNeeded: perpSizeNeeded,
            currentPrice: price,
            valueUSD: value,
            action: 'SELL',
            market: 'PERP',
            reason: `Strengthen WEAK hedge (${pair.sizeMismatchPct.toFixed(1)}% mismatch)`
          });
        }
      } else if (pair.spotSize < pair.perpSize) {
        // Need more SPOT LONG to match PERP SHORT (but ignoring this for now)
        // This would require buying more SPOT
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
      hedgeNeeds.push({
        type: 'SPOT_NEEDS_PERP_SHORT',
        spotSymbol: spotPos.symbol,
        perpSymbol: perpSymbol,
        spotSize: spotSize,
        perpSizeNeeded: spotSize,
        currentPrice: price,
        valueUSD: value,
        action: 'SELL',
        market: 'PERP',
        reason: 'Unhedged SPOT position'
      });
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

      hedgeNeeds.push({
        type: 'PERP_NEEDS_SPOT',
        perpSymbol: perpPos.symbol,
        spotSymbol: spotSymbol,
        perpSide: perpPos.side,
        perpSize: Math.abs(perpPos.size),
        spotSizeNeeded: Math.abs(perpPos.size),
        currentPrice: price,
        valueUSD: value,
        action: needSpotBuy ? 'BUY' : 'SELL',
        market: 'SPOT',
        reason: `Unhedged PERP ${perpPos.side.toUpperCase()}`
      });
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

  const symbol = hedgeNeed.market === 'PERP' ? hedgeNeed.perpSymbol : hedgeNeed.spotSymbol;
  const size = hedgeNeed.market === 'PERP' ? hedgeNeed.perpSizeNeeded : hedgeNeed.spotSizeNeeded;
  const isSpot = hedgeNeed.market === 'SPOT';

  // Get the original position size for comparison
  const originalSize = hedgeNeed.spotSize !== undefined ? hedgeNeed.spotSize : hedgeNeed.perpSize;

  if (verbose) {
    console.log(`[Hedge] Creating hedge for ${symbol}:`);
    console.log(`[Hedge]   Type: ${hedgeNeed.type}`);
    console.log(`[Hedge]   Original position: ${originalSize.toFixed(6)}`);
    console.log(`[Hedge]   Action: ${hedgeNeed.action} ${size.toFixed(6)} ${symbol} (${hedgeNeed.market})`);
    console.log(`[Hedge]   Value: $${hedgeNeed.valueUSD.toFixed(2)}`);
    console.log(`[Hedge]   Reason: ${hedgeNeed.reason}`);
  }

  try {
    // Get asset info for proper rounding to match the target market's lot size
    const assetId = await hyperliquid.getAssetId(symbol, isSpot);
    const assetInfo = hyperliquid.getAssetInfo(symbol, assetId);
    const sizeRounded = parseFloat(hyperliquid.roundSize(size, assetInfo.szDecimals));

    // Calculate mismatch between original and hedge
    const mismatchAbs = Math.abs(originalSize - sizeRounded);
    const mismatchPct = (mismatchAbs / originalSize) * 100;

    if (verbose) {
      console.log(`[Hedge]   Rounded size: ${sizeRounded} (szDecimals: ${assetInfo.szDecimals})`);
      if (mismatchPct > 0.1) {
        console.log(`[Hedge]   ⚠️  Size mismatch: ${mismatchPct.toFixed(3)}% (${mismatchAbs.toFixed(6)} difference due to lot size rounding)`);
      }
    }

    // Create market order (note: no reduceOnly, we're creating new position)
    const side = hedgeNeed.action.toLowerCase();
    const result = await hyperliquid.createMarketOrder(symbol, side, sizeRounded, {
      isSpot: isSpot,
      slippage: config.trading?.maxSlippagePercent || 5.0,
      overrideMidPrice: hedgeNeed.currentPrice
    });

    const filled = result.response?.data?.statuses?.[0]?.filled;

    if (!filled) {
      const error = result.response?.data?.statuses?.[0]?.error;
      if (verbose) {
        console.error(`[Hedge]   ❌ Failed: ${error || 'Unknown error'}`);
      }
      return {
        success: false,
        error: error || 'Order not filled',
        hedgeNeed: hedgeNeed,
        response: result.response
      };
    }

    const fillPx = parseFloat(filled.avgPx || hedgeNeed.currentPrice);
    const fillSz = parseFloat(filled.totalSz || sizeRounded);

    if (verbose) {
      console.log(`[Hedge]   ✅ Success: ${hedgeNeed.action} ${fillSz} @ $${fillPx.toFixed(2)}`);
    }

    return {
      success: true,
      hedgeNeed: hedgeNeed,
      fillPrice: fillPx,
      fillSize: fillSz,
      fillValue: fillSz * fillPx,
      response: result.response
    };

  } catch (error) {
    if (verbose) {
      console.error(`[Hedge]   ❌ Error: ${error.message}`);
    }
    return {
      success: false,
      error: error.message,
      hedgeNeed: hedgeNeed
    };
  }
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
        const closeSymbol = hedgeNeed.type === 'SPOT_NEEDS_PERP_SHORT' ? hedgeNeed.spotSymbol : hedgeNeed.perpSymbol;
        const closeIsSpot = hedgeNeed.type === 'SPOT_NEEDS_PERP_SHORT';
        const closeSize = hedgeNeed.type === 'SPOT_NEEDS_PERP_SHORT' ? hedgeNeed.spotSize : hedgeNeed.perpSize;
        const closeSide = hedgeNeed.type === 'SPOT_NEEDS_PERP_SHORT' ? 'sell' : (hedgeNeed.perpSide === 'LONG' ? 'sell' : 'buy');

        // Get asset info
        const assetId = await hyperliquid.getAssetId(closeSymbol, closeIsSpot);
        const assetInfo = hyperliquid.getAssetInfo(closeSymbol, assetId);
        const sizeRounded = parseFloat(hyperliquid.roundSize(closeSize, assetInfo.szDecimals));

        const closeResult = await hyperliquid.createMarketOrder(closeSymbol, closeSide, sizeRounded, {
          isSpot: closeIsSpot,
          reduceOnly: closeIsSpot ? false : true,
          slippage: config.trading?.maxSlippagePercent || 5.0,
          overrideMidPrice: hedgeNeed.currentPrice
        });

        const filled = closeResult.response?.data?.statuses?.[0]?.filled;

        if (filled) {
          if (verbose) {
            console.log(`[Hedge]   ✅ Closed ${closeSymbol} instead`);
          }
          results.closed.push({
            hedgeNeed: hedgeNeed,
            hedgeResult: hedgeResult,
            closeResult: closeResult
          });
        } else {
          if (verbose) {
            const error = closeResult.response?.data?.statuses?.[0]?.error;
            console.log(`[Hedge]   ❌ Failed to close: ${error || 'Unknown'}`);
          }
          results.failed.push({
            hedgeNeed: hedgeNeed,
            hedgeResult: hedgeResult,
            closeError: closeResult.response?.data?.statuses?.[0]?.error
          });
        }
      } catch (error) {
        if (verbose) {
          console.error(`[Hedge]   ❌ Error closing: ${error.message}`);
        }
        results.failed.push({
          hedgeNeed: hedgeNeed,
          hedgeResult: hedgeResult,
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

  return {
    success: results.failed.length === 0,
    totalProcessed: analysis.hedgeNeeds.length,
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
      lines.push(`   Current: ${need.spotSize !== undefined ? `SPOT ${need.spotSize.toFixed(6)}` : `PERP ${need.perpSide.toUpperCase()} ${need.perpSize.toFixed(6)}`}`);
      lines.push(`   Action Needed: ${need.action} ${(need.perpSizeNeeded || need.spotSizeNeeded).toFixed(6)} ${need.market}`);
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
