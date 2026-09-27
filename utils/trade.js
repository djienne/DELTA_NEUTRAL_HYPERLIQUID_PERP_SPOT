import HyperliquidConnector from '../hyperliquid.js';
import { setLeverageTo1x } from './leverage.js';
import { getKnownFee, getSizeMismatchPercent, getOrderFees, normalizeOrderOutcome } from './order-fill.js';
import { getMaxOpenHedgeMismatchPercent, getMinFillRatio, getTakerFees, getMaxBidAskSpreadPercent } from './risk.js';
import { getPerpPositions, getSpotBalances, executableSize, formatPrice } from './positions.js';

/**
 * Trading Utilities
 *
 * Open and close delta-neutral positions with parallel execution.
 * Position sizing is based on minimum order size requirements (minOrderSizeUSD).
 */

function normalizeSettledOrder(settled, options = {}) {
  return normalizeOrderOutcome(settled, options);
}

async function getOpenExposure(hyperliquid, perpSymbol, spotSymbol) {
  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false, includeDust: true }),
    getSpotBalances(hyperliquid, null, { verbose: false, includeDust: true, managedSpotSymbols: [spotSymbol] })
  ]);

  const perpPosition = perpPositions.find(pos => pos.symbol === perpSymbol);
  const spotBalance = spotBalances.find(balance => balance.symbol === spotSymbol);

  return {
    perp: perpPosition ? {
      symbol: perpSymbol,
      side: perpPosition.side,
      size: Math.abs(perpPosition.sizeRaw ?? perpPosition.size ?? 0)
    } : null,
    spot: spotBalance ? {
      symbol: spotSymbol,
      size: spotBalance.total
    } : null
  };
}

function closeSideForPerpPosition(perpPosition) {
  return perpPosition?.side === 'LONG' ? 'sell' : 'buy';
}

async function cleanupOpenExposure(hyperliquid, perpSymbol, spotSymbol, config) {
  try {
    await closeDeltaNeutralPosition(hyperliquid, { perpSymbol, spotSymbol }, config, { accountingComplete: false });
    return [];
  } catch (error) {
    return [error.message];
  }
}
function orderFailureSummary(label, outcome) {
  if (outcome.rejected) {
    return `${label}: request rejected (${outcome.error || 'Unknown error'})`;
  }
  if (!outcome.filled) {
    return `${label}: ${outcome.error || 'not filled'}`;
  }
  if (outcome.status === 'partial') {
    return `${label}: partial fill ${outcome.fillSize}`;
  }
  return `${label}: filled ${outcome.fillSize}`;
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

  await setLeverageTo1x(hyperliquid, symbol, false);
  const spotId = await hyperliquid.getAssetId(spotSymbol, true);
  const [perpBook, spotBook] = await Promise.all([
    hyperliquid.getFreshBidAsk(perpSymbol, { force: true }),
    hyperliquid.getFreshBidAsk(hyperliquid.getCoinForOrderbook(spotSymbol, spotId), { force: true })
  ]);
  const perpMid = perpBook.mid;
  const spotMid = spotBook.mid;
  const spread = book => (book.ask - book.bid) / book.mid * 100;
  const maxSpread = getMaxBidAskSpreadPercent(config.thresholds);
  if (spread(perpBook) > maxSpread || spread(spotBook) > maxSpread ||
      Math.abs(spotMid / perpMid - 1) * 100 > (config.thresholds?.maxPerpSpotSpreadPercent ?? 0.5)) {
    throw new Error('Fresh entry books fail spread or basis filters');
  }
  if (verbose) {
    console.log(`[Trade] Prices - PERP: $${formatPrice(perpMid)}, SPOT: $${formatPrice(spotMid)}`);
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
  const maxOrderSizeUSD = config.trading?.maxOrderSizeUSD?.[symbol] ?? config.trading?.maxOrderSizeUSD ?? Infinity;
  const availableNotional = Math.min(availablePerpNotional, availableSpotNotional, maxOrderSizeUSD);

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
  const size = Math.min(availableNotional / perpMid, availableNotional / spotMid);
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
  const perpSizeRounded = parseFloat(hyperliquid.roundSize(size, perpAssetInfo.szDecimals, 'down'));
  const spotSizeRounded = parseFloat(hyperliquid.roundSize(size, spotAssetInfo.szDecimals, 'down'));

  if (verbose) {
    console.log(`[Trade] Rounded sizes:`);
    console.log(`[Trade]   PERP: ${perpSizeRounded} (szDecimals: ${perpAssetInfo.szDecimals})`);
    console.log(`[Trade]   SPOT: ${spotSizeRounded} (szDecimals: ${spotAssetInfo.szDecimals})`);
  }

  // Spot buys pay the fee in the token: on-chain spot (what the live hedge check sees) is net of it
  const spotNet = size => size * (1 - getTakerFees(config).spot);
  if (getSizeMismatchPercent(perpSizeRounded, spotNet(spotSizeRounded)) > getMaxOpenHedgeMismatchPercent(config) + 1e-9) {
    throw new Error('Rounded entry sizes exceed hedge mismatch limit');
  }
  if (perpSizeRounded * perpMid < minNotional || spotSizeRounded * spotMid < minNotional) {
    return { success: false, error: 'Rounded entry size is below the configured minimum', symbol };
  }
  // Execute orders in parallel for speed
  if (verbose) {
    console.log('[Trade] Executing orders in parallel...');
  }

  try {
    const [perpSettled, spotSettled] = await Promise.allSettled([
      // SHORT PERP (sell)
      hyperliquid.createMarketOrder(perpSymbol, 'sell', perpSizeRounded, {
        isSpot: false,
        slippage: config.trading.maxSlippagePercent,
        sizeRoundingMode: 'down'
      }),

      // LONG SPOT (buy)
      hyperliquid.createMarketOrder(spotSymbol, 'buy', spotSizeRounded, {
        isSpot: true,
        slippage: config.trading.maxSlippagePercent,
        sizeRoundingMode: 'down'
      })
    ]);

    // Verify both orders filled enough to be a managed hedge.
    const minFillRatio = getMinFillRatio(config);
    const perpOutcome = normalizeSettledOrder(perpSettled, {
      requestedSize: perpSizeRounded,
      minFillRatio,
      fallbackPrice: perpMid,
      context: { symbol: perpSymbol, side: 'sell', isSpot: false, phase: 'open' }
    });
    const spotOutcome = normalizeSettledOrder(spotSettled, {
      requestedSize: spotSizeRounded,
      minFillRatio,
      fallbackPrice: spotMid,
      context: { symbol: spotSymbol, side: 'buy', isSpot: true, phase: 'open' }
    });
    const perpResult = perpOutcome.result;
    const spotResult = spotOutcome.result;
    const perpFilled = perpOutcome.isCompleteFill ? perpOutcome.filled : null;
    const spotFilled = spotOutcome.isCompleteFill ? spotOutcome.filled : null;
    const perpError = perpOutcome.error;
    const spotError = spotOutcome.error;
    let perpFillSzActual = perpOutcome.fillSize || 0;
    let spotFillSzActual = spotOutcome.fillSize || 0;

    if (perpOutcome.rejected || spotOutcome.rejected) {
      try {
        const exposure = await getOpenExposure(hyperliquid, perpSymbol, spotSymbol);
        if (perpOutcome.rejected && exposure.perp?.size > 0) {
          perpFillSzActual = exposure.perp.size;
        }
        if (spotOutcome.rejected && exposure.spot?.size > 0) {
          spotFillSzActual = exposure.spot.size;
        }
      } catch (reconcileError) {
        console.error('[Trade] ⚠️  Could not reconcile rejected order on-chain:', reconcileError.message);
      }
    }

    // Handle partial fills - need to cleanup if only one succeeded
    if (!perpFilled && !spotFilled) {
      if (perpFillSzActual > 0 || spotFillSzActual > 0) {
        const cleanupErrors = await cleanupOpenExposure(hyperliquid, perpSymbol, spotSymbol, config);

        if (cleanupErrors.length > 0) {
          throw new Error(`Both open orders failed or were unknown, and cleanup failed. MANUAL ACTION REQUIRED. ${cleanupErrors.join('; ')}`);
        }
      }

      throw new Error(`Open orders did not reach minimum fill ratio - ${orderFailureSummary('PERP', perpOutcome)}, ${orderFailureSummary('SPOT', spotOutcome)}`);
    }

    if (!perpFilled && spotFilled) {
      // PERP failed or under-filled but SPOT succeeded - close all open exposure.
      console.error('[Trade] PERP order failed or under-filled, closing open exposure...');
      const cleanupErrors = await cleanupOpenExposure(hyperliquid, perpSymbol, spotSymbol, config);
      if (cleanupErrors.length > 0) {
        throw new Error(`PERP order failed or under-filled and cleanup failed. MANUAL ACTION REQUIRED. ${cleanupErrors.join('; ')}`);
      }
      console.log('[Trade] Open exposure closed and verified');
      throw new Error(`PERP order failed or under-filled: ${perpError || orderFailureSummary('PERP', perpOutcome)}`);
    }

    if (perpFilled && !spotFilled) {
      // SPOT failed or under-filled but PERP succeeded - close all open exposure.
      console.error('[Trade] SPOT order failed or under-filled, closing open exposure...');
      const cleanupErrors = await cleanupOpenExposure(hyperliquid, perpSymbol, spotSymbol, config);
      if (cleanupErrors.length > 0) {
        throw new Error(`SPOT order failed or under-filled and cleanup failed. MANUAL ACTION REQUIRED. ${cleanupErrors.join('; ')}`);
      }
      console.log('[Trade] Open exposure closed and verified');
      throw new Error(`SPOT order failed or under-filled: ${spotError || orderFailureSummary('SPOT', spotOutcome)}`);
    }

    // Both filled successfully!
    const perpFillPx = parseFloat(perpFilled.avgPx);
    const spotFillPx = parseFloat(spotFilled.avgPx);
    const perpFillSz = parseFloat(perpFilled.totalSz || perpSizeRounded);
    const spotFillSz = parseFloat(spotFilled.totalSz || spotSizeRounded);
    const maxOpenHedgeMismatchPercent = getMaxOpenHedgeMismatchPercent(config);
    const hedgeMismatchPct = getSizeMismatchPercent(perpFillSz, spotNet(spotFillSz));

    if (hedgeMismatchPct > maxOpenHedgeMismatchPercent + 1e-9) {
      console.error('[Trade] ❌ Partial fill imbalance detected, closing filled legs...');
      console.error(`[Trade]   PERP filled: ${perpFillSz}/${perpSizeRounded}, SPOT filled: ${spotFillSz}/${spotSizeRounded}, mismatch: ${hedgeMismatchPct.toFixed(2)}%`);

      const cleanupErrors = await cleanupOpenExposure(hyperliquid, perpSymbol, spotSymbol, config);

      if (cleanupErrors.length > 0) {
        throw new Error(`Partial open cleanup failed. MANUAL ACTION REQUIRED. ${cleanupErrors.join('; ')}`);
      }

      throw new Error(`Partial open fills were imbalanced and have been closed (${hedgeMismatchPct.toFixed(2)}% mismatch)`);
    }

    if (verbose) {
      console.log('[Trade] ✅ Both orders filled:');
      console.log(`[Trade]   PERP: ${perpFillSz} @ $${formatPrice(perpFillPx)}`);
      console.log(`[Trade]   SPOT: ${spotFillSz} @ $${formatPrice(spotFillPx)}`);
    }

    return {
      success: true,
      symbol: symbol,
      perpSymbol: perpSymbol,
      spotSymbol: spotSymbol,
      perpSize: perpFillSz,
      spotSize: spotFillSz,
      perpEntryPrice: Number.isFinite(perpFillPx) && perpFillPx > 0 ? perpFillPx : null,
      spotEntryPrice: Number.isFinite(spotFillPx) && spotFillPx > 0 ? spotFillPx : null,
      positionValue: perpFillSz * perpFillPx,
      fundingRate: opportunity.funding.fundingRate,  // current hourly rate at open
      annualizedFunding: opportunity.avgFundingRate,  // 7d average APY (decision basis)
      openFeesActual: getOrderFees(perpResult, spotResult),
      openFeesEstimated: (getKnownFee(perpResult) === null ? perpFillSz * perpFillPx * getTakerFees(config).perp : 0) +
        (getKnownFee(spotResult) === null ? spotFillSz * spotFillPx * getTakerFees(config).spot : 0),
      accountingComplete: Number.isFinite(perpFillPx) && perpFillPx > 0 && Number.isFinite(spotFillPx) && spotFillPx > 0,
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
  const { perpSymbol, spotSymbol } = position;
  const fees = getTakerFees(config);
  const fills = {
    perp: { size: 0, notional: 0, feesActual: 0, feesEstimated: 0 },
    spot: { size: 0, notional: 0, feesActual: 0, feesEstimated: 0 }
  };
  let accountingComplete = options.accountingComplete !== false && position.accountingComplete !== false;
  // Older states stored an estimate for all opening fees even when some actual fees were supplied.
  const legacyMixedFees = position.accountingComplete === undefined && position.openFeesActual > 0 && position.openFeesEstimated > 0;
  if (legacyMixedFees) accountingComplete = false;
  let exposure = await getOpenExposure(hyperliquid, perpSymbol, spotSymbol);
  if ((!exposure.perp && position.perpSize > 0) || (!exposure.spot && position.spotSize > 0) ||
      (exposure.perp && exposure.perp.side !== 'SHORT')) accountingComplete = false;

  async function ordersFor(current) {
    const orders = [];
    for (const leg of ['perp', 'spot']) {
      const p = current[leg];
      if (!p?.size) continue;
      const isSpot = leg === 'spot';
      const id = await hyperliquid.getAssetId(p.symbol, isSpot);
      const book = await hyperliquid.getFreshBidAsk(hyperliquid.getCoinForOrderbook(p.symbol, id));
      const size = await executableSize(hyperliquid, p.symbol, isSpot, p.size, book.mid);
      if (size) orders.push({ leg, symbol: p.symbol, size, isSpot, side: isSpot ? 'sell' : closeSideForPerpPosition(p) });
    }
    return orders;
  }

  // Two bounded attempts, always sized from a new account read. Each acknowledged fill counts once.
  for (let pass = 0; pass < 2; pass++) {
    const orders = await ordersFor(exposure);
    if (!orders.length) break;
    const settled = await Promise.allSettled(orders.map(o => hyperliquid.createMarketOrder(o.symbol, o.side, o.size, {
      isSpot: o.isSpot, reduceOnly: !o.isSpot, slippage: config.trading.maxSlippagePercent, sizeRoundingMode: 'down'
    })));
    settled.forEach((result, i) => {
      const total = fills[orders[i].leg];
      if (result.status === 'rejected') { accountingComplete = false; return; }
      const outcome = normalizeOrderOutcome(result.value, { requestedSize: orders[i].size });
      if (outcome.unknown) accountingComplete = false;
      if (!outcome.filled) return;
      const price = Number(outcome.filled.avgPx);
      if (!(price > 0) || !Number.isFinite(price) || !(outcome.fillSize > 0)) { accountingComplete = false; return; }
      const notional = outcome.fillSize * price;
      total.size += outcome.fillSize;
      total.notional += notional;
      const fee = getKnownFee(result.value);
      if (fee !== null) total.feesActual += fee;
      else total.feesEstimated += notional * fees[orders[i].leg];
    });
    exposure = await getOpenExposure(hyperliquid, perpSymbol, spotSymbol);
  }
  if ((await ordersFor(exposure)).length) throw new Error('Close incomplete: executable exposure remains; keep closing intent');
  const residualInventory = { perp: exposure.perp?.size ?? 0, spot: exposure.spot?.size ?? 0 };
  for (const leg of ['perp', 'spot']) {
    const recorded = position[`${leg}Size`];
    // Spot buy fees reduce token inventory; larger differences imply unrecorded position changes.
    const expected = leg === 'spot' ? recorded * (1 - fees.spot) : recorded;
    if (!Number.isFinite(recorded) || Math.abs(fills[leg].size + residualInventory[leg] - expected) >
        Math.max(1e-9, recorded * (leg === 'spot' ? fees.spot + 1e-9 : 1e-9))) accountingComplete = false;
  }
  const perpClosePrice = fills.perp.size ? fills.perp.notional / fills.perp.size : null;
  const spotClosePrice = fills.spot.size ? fills.spot.notional / fills.spot.size : null;
  const perpPnl = Number.isFinite(position.perpEntryPrice) ? position.perpEntryPrice * fills.perp.size - fills.perp.notional : null;
  const spotPnl = Number.isFinite(position.spotEntryPrice) ? fills.spot.notional - position.spotEntryPrice * fills.spot.size : null;
  if (perpPnl === null || spotPnl === null) accountingComplete = false;
  let fundingPnl = null;
  try {
    if (position.openTime && typeof hyperliquid.getUserFundingHistory === 'function') {
      fundingPnl = (await hyperliquid.getUserFundingHistory(null, position.openTime)).accumulated?.[perpSymbol] ?? 0;
    }
  } catch (error) {
    if (verbose) console.warn(`[Trade] Funding unavailable: ${error.message}`);
  }
  if (!Number.isFinite(fundingPnl)) accountingComplete = false;
  const feesActual = (position.openFeesActual ?? 0) + fills.perp.feesActual + fills.spot.feesActual;
  const feesEstimated = (legacyMixedFees ? 0 : position.openFeesEstimated ?? 0) + fills.perp.feesEstimated + fills.spot.feesEstimated;
  const pricePnl = perpPnl !== null && spotPnl !== null ? perpPnl + spotPnl : null;
  const totalPnl = accountingComplete ? pricePnl + fundingPnl - feesActual - feesEstimated : null;
  if (verbose) console.log(`[Trade] Closed; PnL ${totalPnl === null ? 'unavailable' : totalPnl.toFixed(4)}; residual inventory ${JSON.stringify(residualInventory)}`);
  return { success: true, reason, perpClosePrice, spotClosePrice, perpPnl, spotPnl, pricePnl, fundingPnl,
    fundingUnavailable: fundingPnl === null, feesActual, feesEstimated, accountingComplete, totalPnl, closeFills: fills, residualInventory };
}
