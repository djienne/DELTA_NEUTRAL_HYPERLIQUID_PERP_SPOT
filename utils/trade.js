import HyperliquidConnector from '../hyperliquid.js';
import { setLeverageTo1x } from './leverage.js';
import {
  getFilledStatus,
  getFilledSize,
  getFilledPrice,
  getOrderError,
  getSizeMismatchPercent,
  getOrderFees
} from './order-fill.js';
import { getMaxOpenHedgeMismatchPercent, getMinFillRatio, getTakerFeeRate } from './risk.js';

/**
 * Trading Utilities
 *
 * Open and close delta-neutral positions with parallel execution.
 * Position sizing is based on minimum order size requirements (minOrderSizeUSD).
 */

function estimateFees(notional, config) {
  return notional * getTakerFeeRate(config);
}

async function cleanupFilledLeg(hyperliquid, symbol, side, size, options) {
  if (!size || size <= 0) {
    return null;
  }

  return await hyperliquid.createMarketOrder(symbol, side, size, {
    isSpot: options.isSpot,
    reduceOnly: options.isSpot ? false : true,
    slippage: options.slippage,
    overrideMidPrice: options.overrideMidPrice
  });
}

/**
 * Open delta-neutral position (SHORT PERP + LONG SPOT)
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {Object} opportunity - Opportunity object
 * @param {Object} balances - Balance information
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<Object>} Position result
 */
export async function openDeltaNeutralPosition(hyperliquid, opportunity, balances, config, options = {}) {
  const { verbose = false } = options;

  const symbol = opportunity.symbol;
  const perpSymbol = symbol;
  const spotSymbol = HyperliquidConnector.perpToSpot(symbol);

  if (verbose) {
    console.log(`[Trade] Opening delta-neutral position for ${symbol}...`);
    console.log(`[Trade] PERP: ${perpSymbol}, SPOT: ${spotSymbol}`);
  }

  // Get current mid prices
  const perpMid = opportunity.bidAsk.perpMid;
  const spotMid = opportunity.bidAsk.spotMid;

  if (verbose) {
    console.log(`[Trade] Prices - PERP: $${perpMid.toFixed(2)}, SPOT: $${spotMid.toFixed(2)}`);
  }

  // Get minimum notional from config (with fallback to 20 if not specified)
  const minNotional = config.trading?.minOrderSizeUSD?.[symbol] || 20;

  // Get utilization from config (default to 95%)
  const utilization = config.trading?.balanceUtilizationPercent || 95;

  // Calculate available capital for position
  const perpBalance = balances.perpBalance;
  const spotBalance = balances.spotBalance;

  // Apply utilization percentage to each balance
  const availablePerpNotional = perpBalance * (utilization / 100);
  const availableSpotNotional = spotBalance * (utilization / 100);
  // Use the smaller of the two to ensure both sides can be filled
  const availableNotional = Math.min(availablePerpNotional, availableSpotNotional);

  if (verbose) {
    console.log(`[Trade] Available capital:`);
    console.log(`[Trade]   PERP: $${availablePerpNotional.toFixed(2)}, SPOT: $${availableSpotNotional.toFixed(2)}`);
    console.log(`[Trade]   Available: $${availableNotional.toFixed(2)}, Minimum required: $${minNotional.toFixed(2)}`);
  }

  // Check if we have enough capital to meet minimum order size
  if (availableNotional < minNotional) {
    const errorMsg = `Insufficient capital for ${symbol}: $${availableNotional.toFixed(2)} available < $${minNotional.toFixed(2)} minimum required`;
    console.error(`[Trade] ❌ ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
      symbol: symbol,
      availableCapital: availableNotional,
      minimumRequired: minNotional
    };
  }

  // Calculate position sizes based on available capital
  const size = availableNotional / perpMid;
  const notionalValue = size * perpMid;

  if (verbose) {
    console.log(`[Trade] Calculated size: ${size.toFixed(6)} (notional: $${notionalValue.toFixed(2)})`);
  }

  // Get asset info for rounding
  const perpAssetId = await hyperliquid.getAssetId(perpSymbol, false);
  const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);

  const perpAssetInfo = hyperliquid.getAssetInfo(perpSymbol, perpAssetId);
  const spotAssetInfo = hyperliquid.getAssetInfo(spotSymbol, spotAssetId);

  // Round sizes to proper lot sizes
  const perpSizeRounded = parseFloat(hyperliquid.roundSize(size, perpAssetInfo.szDecimals));
  const spotSizeRounded = parseFloat(hyperliquid.roundSize(size, spotAssetInfo.szDecimals));

  if (verbose) {
    console.log(`[Trade] Rounded sizes:`);
    console.log(`[Trade]   PERP: ${perpSizeRounded} (szDecimals: ${perpAssetInfo.szDecimals})`);
    console.log(`[Trade]   SPOT: ${spotSizeRounded} (szDecimals: ${spotAssetInfo.szDecimals})`);
  }

  // Verify sizes are close enough (within 2%)
  const sizeDiff = Math.abs(perpSizeRounded - spotSizeRounded);
  const sizeDiffPct = (sizeDiff / perpSizeRounded) * 100;

  if (sizeDiffPct > 2) {
    console.warn(`[Trade] ⚠️  Size mismatch after rounding: ${sizeDiffPct.toFixed(2)}%`);
    console.warn(`[Trade]    PERP: ${perpSizeRounded}, SPOT: ${spotSizeRounded}`);
    // Continue anyway, this is normal for different lot sizes
  }

  // Set leverage to 1x for this specific pair before opening position
  if (verbose) {
    console.log(`[Trade] Setting leverage to 1x for ${symbol}...`);
  }

  try {
    await setLeverageTo1x(hyperliquid, symbol, false, { verbose: false });
    if (verbose) {
      console.log(`[Trade] ✅ Leverage set to 1x (isolated) for ${symbol}`);
    }
  } catch (error) {
    console.warn(`[Trade] ⚠️  Failed to set leverage for ${symbol}: ${error.message}`);
    throw new Error(`Failed to set leverage for ${symbol}; refusing to open position: ${error.message}`);
  }

  // Execute orders in parallel for speed
  if (verbose) {
    console.log('[Trade] Executing orders in parallel...');
  }

  try {
    const [perpResult, spotResult] = await Promise.all([
      // SHORT PERP (sell)
      hyperliquid.createMarketOrder(perpSymbol, 'sell', perpSizeRounded, {
        isSpot: false,
        slippage: config.trading.maxSlippagePercent,
        overrideMidPrice: perpMid
      }),

      // LONG SPOT (buy)
      hyperliquid.createMarketOrder(spotSymbol, 'buy', spotSizeRounded, {
        isSpot: true,
        slippage: config.trading.maxSlippagePercent,
        overrideMidPrice: spotMid
      })
    ]);

    // Verify both orders filled
    const perpFilled = getFilledStatus(perpResult);
    const spotFilled = getFilledStatus(spotResult);
    const perpError = perpResult.response?.data?.statuses?.[0]?.error;
    const spotError = spotResult.response?.data?.statuses?.[0]?.error;
    const perpFillSzActual = getFilledSize(perpResult) || (perpFilled ? perpSizeRounded : 0);
    const spotFillSzActual = getFilledSize(spotResult) || (spotFilled ? spotSizeRounded : 0);

    // Handle partial fills - need to cleanup if only one succeeded
    if (!perpFilled && !spotFilled) {
      // Both failed - safe to throw
      throw new Error(`Both orders failed - PERP: ${perpError || 'Unknown'}, SPOT: ${spotError || 'Unknown'}`);
    }

    if (!perpFilled && spotFilled) {
      // PERP failed but SPOT succeeded - close SPOT position
      console.error('[Trade] ❌ PERP order failed, closing SPOT position...');
      try {
        await hyperliquid.createMarketOrder(spotSymbol, 'sell', spotFillSzActual, {
          isSpot: true,
          reduceOnly: false,
          slippage: config.trading.maxSlippagePercent,
          overrideMidPrice: spotMid
        });
        console.log('[Trade] ✅ SPOT position closed');
      } catch (closeError) {
        console.error('[Trade] ❌ Failed to close SPOT position:', closeError.message);
        console.error('[Trade] ⚠️  MANUAL ACTION REQUIRED: Close SPOT position for', spotSymbol);
      }
      throw new Error(`PERP order failed: ${perpError || 'Unknown error'}`);
    }

    if (perpFilled && !spotFilled) {
      // SPOT failed but PERP succeeded - close PERP position
      console.error('[Trade] ❌ SPOT order failed, closing PERP position...');
      try {
        await hyperliquid.createMarketOrder(perpSymbol, 'buy', perpFillSzActual, {
          isSpot: false,
          reduceOnly: true,
          slippage: config.trading.maxSlippagePercent,
          overrideMidPrice: perpMid
        });
        console.log('[Trade] ✅ PERP position closed');
      } catch (closeError) {
        console.error('[Trade] ❌ Failed to close PERP position:', closeError.message);
        console.error('[Trade] ⚠️  MANUAL ACTION REQUIRED: Close PERP position for', perpSymbol);
      }
      throw new Error(`SPOT order failed: ${spotError || 'Unknown error'}`);
    }

    // Both filled successfully!
    const perpFillPx = parseFloat(perpFilled.avgPx || perpMid);
    const spotFillPx = parseFloat(spotFilled.avgPx || spotMid);
    const perpFillSz = parseFloat(perpFilled.totalSz || perpSizeRounded);
    const spotFillSz = parseFloat(spotFilled.totalSz || spotSizeRounded);
    const maxOpenHedgeMismatchPercent = getMaxOpenHedgeMismatchPercent(config);
    const hedgeMismatchPct = getSizeMismatchPercent(perpFillSz, spotFillSz);

    if (hedgeMismatchPct > maxOpenHedgeMismatchPercent) {
      console.error('[Trade] âŒ Partial fill imbalance detected, closing filled legs...');
      console.error(`[Trade]   PERP filled: ${perpFillSz}/${perpSizeRounded}, SPOT filled: ${spotFillSz}/${spotSizeRounded}, mismatch: ${hedgeMismatchPct.toFixed(2)}%`);

      const cleanupErrors = [];

      try {
        await cleanupFilledLeg(hyperliquid, spotSymbol, 'sell', spotFillSz, {
          isSpot: true,
          slippage: config.trading.maxSlippagePercent,
          overrideMidPrice: spotMid
        });
      } catch (closeError) {
        cleanupErrors.push(`SPOT ${spotSymbol}: ${closeError.message}`);
      }

      try {
        await cleanupFilledLeg(hyperliquid, perpSymbol, 'buy', perpFillSz, {
          isSpot: false,
          slippage: config.trading.maxSlippagePercent,
          overrideMidPrice: perpMid
        });
      } catch (closeError) {
        cleanupErrors.push(`PERP ${perpSymbol}: ${closeError.message}`);
      }

      if (cleanupErrors.length > 0) {
        throw new Error(`Partial open cleanup failed. MANUAL ACTION REQUIRED. ${cleanupErrors.join('; ')}`);
      }

      throw new Error(`Partial open fills were imbalanced and have been closed (${hedgeMismatchPct.toFixed(2)}% mismatch)`);
    }

    if (verbose) {
      console.log('[Trade] ✅ Both orders filled:');
      console.log(`[Trade]   PERP: ${perpFillSz} @ $${perpFillPx.toFixed(2)}`);
      console.log(`[Trade]   SPOT: ${spotFillSz} @ $${spotFillPx.toFixed(2)}`);
    }

    // CRITICAL: Use PREDICTED funding rate (what will be paid NEXT), not historical
    // Use predicted if available, otherwise fall back to current/historical
    const predictedFundingRate = opportunity.predictedFunding?.predictedFundingRate;
    const currentFundingRate = opportunity.funding.fundingRate;
    const useFundingRate = predictedFundingRate !== null && predictedFundingRate !== undefined
      ? predictedFundingRate
      : currentFundingRate;

    const predictedAnnualizedFunding = opportunity.predictedFundingRate;
    const avgAnnualizedFunding = opportunity.avgFundingRate;
    const useAnnualizedFunding = predictedAnnualizedFunding !== null && predictedAnnualizedFunding !== undefined
      ? predictedAnnualizedFunding
      : avgAnnualizedFunding;

    return {
      success: true,
      symbol: symbol,
      perpSymbol: perpSymbol,
      spotSymbol: spotSymbol,
      perpSize: perpFillSz,
      spotSize: spotFillSz,
      perpEntryPrice: perpFillPx,
      spotEntryPrice: spotFillPx,
      positionValue: perpFillSz * perpFillPx,
      fundingRate: useFundingRate,  // Use predicted rate (hourly)
      annualizedFunding: useAnnualizedFunding,  // Use predicted annualized rate
      openFeesActual: getOrderFees(perpResult, spotResult),
      openFeesEstimated: estimateFees((perpFillSz * perpFillPx) + (spotFillSz * spotFillPx), config),
      perpResult: perpResult,
      spotResult: spotResult
    };

  } catch (error) {
    console.error('[Trade] ❌ Error opening position:', error.message);
    throw error;
  }
}

/**
 * Close delta-neutral position
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {Object} position - Position object from state
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<Object>} Close result
 */
export async function closeDeltaNeutralPosition(hyperliquid, position, config, options = {}) {
  const { verbose = false, reason = 'Manual close' } = options;

  const symbol = position.symbol;
  const perpSymbol = position.perpSymbol;
  const spotSymbol = position.spotSymbol;

  if (verbose) {
    console.log(`[Trade] Closing delta-neutral position for ${symbol}...`);
    console.log(`[Trade] Reason: ${reason}`);
  }

  // Get current prices (fetch orderbooks for both)
  await hyperliquid.subscribeOrderbook(perpSymbol);
  const perpAssetId = await hyperliquid.getAssetId(spotSymbol, true);
  const spotOrderbookCoin = hyperliquid.getCoinForOrderbook(spotSymbol, perpAssetId);
  await hyperliquid.subscribeOrderbook(spotOrderbookCoin);

  // Wait briefly for orderbook data
  await new Promise(resolve => setTimeout(resolve, 1000));

  const perpBidAsk = hyperliquid.getBidAsk(perpSymbol);
  const spotBidAsk = hyperliquid.getBidAsk(spotOrderbookCoin);

  if (!perpBidAsk || !spotBidAsk) {
    throw new Error('Failed to get current prices for closing position');
  }

  const perpMid = (perpBidAsk.bid + perpBidAsk.ask) / 2;
  const spotMid = (spotBidAsk.bid + spotBidAsk.ask) / 2;

  if (verbose) {
    console.log(`[Trade] Current prices - PERP: $${perpMid.toFixed(2)}, SPOT: $${spotMid.toFixed(2)}`);
    console.log(`[Trade] Entry prices - PERP: $${position.perpEntryPrice.toFixed(2)}, SPOT: $${position.spotEntryPrice.toFixed(2)}`);
  }

  // Calculate PnL
  // PERP: SHORT, so profit if price goes down
  const perpPnl = (position.perpEntryPrice - perpMid) * position.perpSize;
  // SPOT: LONG, so profit if price goes up
  const spotPnl = (spotMid - position.spotEntryPrice) * position.spotSize;
  const totalPnl = perpPnl + spotPnl;

  if (verbose) {
    console.log(`[Trade] PnL - PERP: $${perpPnl.toFixed(2)}, SPOT: $${spotPnl.toFixed(2)}, Total: $${totalPnl.toFixed(2)}`);
  }

  // Execute close orders in parallel
  if (verbose) {
    console.log('[Trade] Executing close orders in parallel...');
  }

  try {
    const [perpResult, spotResult] = await Promise.all([
      // Close SHORT PERP (buy back)
      hyperliquid.createMarketOrder(perpSymbol, 'buy', position.perpSize, {
        isSpot: false,
        reduceOnly: true,
        slippage: config.trading.maxSlippagePercent,
        overrideMidPrice: perpMid
      }),

      // Sell SPOT
      hyperliquid.createMarketOrder(spotSymbol, 'sell', position.spotSize, {
        isSpot: true,
        slippage: config.trading.maxSlippagePercent,
        overrideMidPrice: spotMid
      })
    ]);

    // Verify both orders filled
    const perpFilled = perpResult.response?.data?.statuses?.[0]?.filled;
    const spotFilled = spotResult.response?.data?.statuses?.[0]?.filled;

    if (!perpFilled) {
      const perpError = getOrderError(perpResult);
      console.error('[Trade] ❌ PERP close failed:', perpError);
    }

    if (!spotFilled) {
      const spotError = getOrderError(spotResult);
      console.error('[Trade] ❌ SPOT close failed:', spotError);
    }

    if (!perpFilled || !spotFilled) {
      throw new Error('Failed to close position completely. Manual intervention may be required.');
    }

    const minFillRatio = getMinFillRatio(config);
    const perpCloseSz = getFilledSize(perpResult) || position.perpSize;
    const spotCloseSz = getFilledSize(spotResult) || position.spotSize;

    if (perpCloseSz < position.perpSize * minFillRatio || spotCloseSz < position.spotSize * minFillRatio) {
      throw new Error(
        `Close orders partially filled. Manual intervention may be required. ` +
        `PERP ${perpCloseSz}/${position.perpSize}, SPOT ${spotCloseSz}/${position.spotSize}`
      );
    }

    // Both closed successfully!
    const perpClosePx = getFilledPrice(perpResult, perpMid);
    const spotClosePx = getFilledPrice(spotResult, spotMid);

    const actualPerpPnl = (position.perpEntryPrice - perpClosePx) * position.perpSize;
    const actualSpotPnl = (spotClosePx - position.spotEntryPrice) * position.spotSize;
    const pricePnl = actualPerpPnl + actualSpotPnl;
    let fundingPnl = 0;
    let fundingUnavailable = false;

    try {
      if (typeof hyperliquid.getUserFundingHistory === 'function' && position.openTime) {
        const fundingHistory = await hyperliquid.getUserFundingHistory(null, position.openTime);
        fundingPnl = fundingHistory.accumulated?.[position.perpSymbol] || 0;
      }
    } catch (error) {
      fundingUnavailable = true;
      if (verbose) {
        console.warn(`[Trade] Funding PnL unavailable: ${error.message}`);
      }
    }

    const closeFeesActual = getOrderFees(perpResult, spotResult);
    const closeFeesEstimated = estimateFees((perpCloseSz * perpClosePx) + (spotCloseSz * spotClosePx), config);
    const feesActual = (position.openFeesActual || 0) + closeFeesActual;
    const feesEstimated = feesActual > 0 ? 0 : (position.openFeesEstimated || 0) + closeFeesEstimated;
    const totalFees = feesActual || feesEstimated;
    const actualTotalPnl = pricePnl + fundingPnl - totalFees;

    if (verbose) {
      console.log('[Trade] ✅ Position closed:');
      console.log(`[Trade]   PERP: $${perpClosePx.toFixed(2)} (PnL: $${actualPerpPnl.toFixed(2)})`);
      console.log(`[Trade]   SPOT: $${spotClosePx.toFixed(2)} (PnL: $${actualSpotPnl.toFixed(2)})`);
      console.log(`[Trade]   Price PnL: $${pricePnl.toFixed(2)}, Funding: $${fundingPnl.toFixed(2)}, Fees: $${totalFees.toFixed(2)}`);
      console.log(`[Trade]   Total PnL: $${actualTotalPnl.toFixed(2)}`);
    }

    return {
      success: true,
      reason: reason,
      perpClosePrice: perpClosePx,
      spotClosePrice: spotClosePx,
      perpPnl: actualPerpPnl,
      spotPnl: actualSpotPnl,
      pricePnl: pricePnl,
      fundingPnl: fundingPnl,
      fundingUnavailable: fundingUnavailable,
      feesActual: feesActual,
      feesEstimated: feesEstimated,
      totalPnl: actualTotalPnl,
      perpResult: perpResult,
      spotResult: spotResult
    };

  } catch (error) {
    console.error('[Trade] ❌ Error closing position:', error.message);
    throw error;
  }
}
