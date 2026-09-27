import HyperliquidConnector from '../hyperliquid.js';
import { getPerpPositions, getSpotBalances, analyzeDeltaNeutral, executableSize } from './positions.js';
import { assertCompleteFill } from './order-fill.js';
import { getMinFillRatio, getMaxHedgeMismatchPercent } from './risk.js';
import { setLeverageTo1x } from './leverage.js';

// Inspect the whole managed account. Keep subminimum inventory visible, but never submit it alone.
export async function analyzeHedgeNeeds(hyperliquid, options = {}) {
  const maxHedgeMismatchPercent = options.maxHedgeMismatchPercent ?? 2;
  const [perp, spot, mids] = await Promise.all([
    getPerpPositions(hyperliquid, null, { ...options, includeDust: true }),
    getSpotBalances(hyperliquid, null, { ...options, includeDust: true }),
    hyperliquid.getAllMids()
  ]);
  const dust = [];
  const active = new Set();
  async function priceFor(symbol, isSpot) {
    const id = await hyperliquid.getAssetId(symbol, isSpot);
    const coin = hyperliquid.getCoinForOrderbook(symbol, id);
    const price = Number(mids[coin]);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Missing exposure price for ${symbol}`);
    return price;
  }
  for (const p of [...perp.map(p => ({ symbol: p.symbol, size: p.size, isSpot: false })),
    ...spot.map(p => ({ symbol: p.symbol, size: p.total, isSpot: true }))]) {
    const price = await priceFor(p.symbol, p.isSpot);
    if (await executableSize(hyperliquid, p.symbol, p.isSpot, p.size, price)) {
      active.add(p.isSpot ? HyperliquidConnector.spotToPerp(p.symbol) : p.symbol);
    } else {
      dust.push({ ...p, valueUSD: p.size * price });
    }
  }
  const analysis = analyzeDeltaNeutral(
    perp.filter(p => active.has(p.symbol)),
    spot.filter(p => active.has(HyperliquidConnector.spotToPerp(p.symbol))),
    { maxHedgeMismatchPercent }
  );
  const hedgeNeeds = [];
  async function add(perpSymbol, size, targetMarket, targetSide, fallbackMarket, fallbackSide, type) {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);
    const targetSymbol = targetMarket === 'SPOT' ? spotSymbol : perpSymbol;
    const fallbackCloseSymbol = fallbackMarket === 'SPOT' ? spotSymbol : perpSymbol;
    const isSpot = targetMarket === 'SPOT';
    const price = await priceFor(targetMarket ? targetSymbol : fallbackCloseSymbol, targetMarket ? isSpot : fallbackMarket === 'SPOT');
    const quantity = await executableSize(hyperliquid, targetMarket ? targetSymbol : fallbackCloseSymbol,
      targetMarket ? isSpot : fallbackMarket === 'SPOT', size, price);
    if (!quantity) {
      dust.push({ symbol: targetSymbol, size, isSpot, valueUSD: size * price, reason: 'hedge difference below executable minimum' });
      return;
    }
    hedgeNeeds.push({ type, perpSymbol, spotSymbol, targetSymbol: targetMarket ? targetSymbol : null,
      targetMarket, targetSide, targetSize: quantity, currentPrice: price, valueUSD: quantity * price,
      perpSizeNeeded: targetMarket === 'PERP' ? quantity : undefined,
      spotSizeNeeded: isSpot ? quantity : undefined,
      fallbackCloseSymbol, fallbackCloseMarket: fallbackMarket, fallbackCloseSide: fallbackSide,
      fallbackCloseSize: size, fallbackCloseReduceOnly: fallbackMarket === 'PERP',
      action: targetSide?.toUpperCase() ?? 'CLOSE', market: targetMarket ?? fallbackMarket, reason: type });
  }
  for (const pair of analysis.imbalancedPairs) {
    if (pair.isDeltaNeutral) {
      const missingSpot = pair.perpSize > pair.spotSize;
      await add(pair.symbol, pair.sizeMismatch, missingSpot ? 'SPOT' : 'PERP', missingSpot ? 'buy' : 'sell',
        missingSpot ? 'PERP' : 'SPOT', missingSpot ? 'buy' : 'sell', missingSpot ? 'STRENGTHEN_SPOT_LONG' : 'STRENGTHEN_PERP_SHORT');
    } else {
      await add(pair.symbol, pair.perpSize, null, null, 'PERP', 'sell', 'DOUBLE_LONG_REQUIRES_CLOSE');
    }
  }
  for (const p of analysis.unmatchedPerp) {
    await add(p.symbol, p.size, p.side === 'SHORT' ? 'SPOT' : null, p.side === 'SHORT' ? 'buy' : null,
      'PERP', p.side === 'SHORT' ? 'buy' : 'sell', 'PERP_NEEDS_SPOT');
  }
  for (const p of analysis.unmatchedSpot) {
    await add(HyperliquidConnector.spotToPerp(p.symbol), p.balance.total, 'PERP', 'sell', 'SPOT', 'sell', 'SPOT_NEEDS_PERP_SHORT');
  }
  return { analysis, hedgeNeeds, dust, symbols: [...active], needsHedging: hedgeNeeds.length > 0,
    hasDeltaNeutralPairs: analysis.deltaNeutralPairs.length > 0 };
}

export async function createHedge(hyperliquid, need, config, { verbose = false } = {}) {
  if (!need.targetSymbol || !need.targetMarket || !need.targetSide || !need.targetSize) {
    return { success: false, requiresClose: true, error: 'No safe hedge order is available', hedgeNeed: need };
  }
  try {
    const isSpot = need.targetMarket === 'SPOT';
    // A recovery short has exactly the same margin requirement as a normal opening short.
    if (!isSpot) await setLeverageTo1x(hyperliquid, need.targetSymbol, false);
    const id = await hyperliquid.getAssetId(need.targetSymbol, isSpot);
    const book = await hyperliquid.getFreshBidAsk(hyperliquid.getCoinForOrderbook(need.targetSymbol, id));
    const size = await executableSize(hyperliquid, need.targetSymbol, isSpot, need.targetSize, book.mid);
    if (!size) return { success: false, dust: true, error: 'Hedge difference below executable minimum', hedgeNeed: need };
    const result = await hyperliquid.createMarketOrder(need.targetSymbol, need.targetSide, size, {
      isSpot, reduceOnly: false, slippage: config.trading?.maxSlippagePercent ?? 5, sizeRoundingMode: 'down'
    });
    const fill = assertCompleteFill(result, size, { minFillRatio: getMinFillRatio(config) });
    if (verbose) console.log(`[Hedge] ${need.targetSymbol}: ${fill.fillSize} @ ${fill.fillPrice}`);
    return { success: true, hedgeNeed: need, fillPrice: fill.fillPrice, fillSize: fill.fillSize, result };
  } catch (error) {
    return { success: false, error: error.message, unknown: error.isUnknownOrderOutcome === true, hedgeNeed: need };
  }
}

export async function autoHedgeAll(hyperliquid, config, options = {}) {
  const scope = { ...options, maxHedgeMismatchPercent: options.maxHedgeMismatchPercent ?? getMaxHedgeMismatchPercent(config) };
  let snapshot = await analyzeHedgeNeeds(hyperliquid, scope);
  const results = { hedged: [], closed: [], failed: [], skipped: [], totalProcessed: 0 };
  // The bot holds one pair. Choosing ownership among multiple pairs requires the operator.
  if (snapshot.symbols.length > 1) {
    return { ...results, success: false, postAnalysis: snapshot, failed: [{ error: 'Multiple managed pairs require manual resolution' }] };
  }
  for (const need of snapshot.hedgeNeeds) {
    results.totalProcessed++;
    const result = await createHedge(hyperliquid, need, config, options);
    snapshot = await analyzeHedgeNeeds(hyperliquid, scope);
    if (result.success) results.hedged.push(result);
    else if (options.fallbackToClose && !result.unknown) {
      // Never close the original, stale size after a partial hedge: only the newly measured excess.
      const remaining = snapshot.hedgeNeeds.find(n => n.perpSymbol === need.perpSymbol);
      if (!remaining) continue;
      try {
        const isSpot = remaining.fallbackCloseMarket === 'SPOT';
        const id = await hyperliquid.getAssetId(remaining.fallbackCloseSymbol, isSpot);
        const book = await hyperliquid.getFreshBidAsk(hyperliquid.getCoinForOrderbook(remaining.fallbackCloseSymbol, id));
        const size = await executableSize(hyperliquid, remaining.fallbackCloseSymbol, isSpot, remaining.fallbackCloseSize, book.mid);
        if (!size) { results.skipped.push(remaining); continue; }
        const close = await hyperliquid.createMarketOrder(remaining.fallbackCloseSymbol, remaining.fallbackCloseSide, size,
          { isSpot, reduceOnly: !isSpot, slippage: config.trading?.maxSlippagePercent ?? 5, sizeRoundingMode: 'down' });
        assertCompleteFill(close, size, { minFillRatio: getMinFillRatio(config) });
        results.closed.push({ hedgeNeed: remaining, result: close });
      } catch (error) {
        results.failed.push({ hedgeNeed: remaining, error: error.message });
      }
    } else if (!result.dust) results.failed.push(result);
  }
  const postAnalysis = await analyzeHedgeNeeds(hyperliquid, scope);
  if (options.verbose) console.log(formatHedgeReport(postAnalysis));
  return { ...results, postAnalysis, success: results.failed.length === 0 && !postAnalysis.needsHedging && postAnalysis.symbols.length <= 1 };
}

export function formatHedgeReport(snapshot) {
  return [
    `Managed pairs: ${snapshot.symbols.join(', ') || 'none'}`,
    ...[...snapshot.analysis.deltaNeutralPairs, ...snapshot.analysis.imbalancedPairs].map(p =>
      `${p.symbol}: ${p.perpSide} ${p.perpSize} / SPOT ${p.spotSize}, mismatch ${p.sizeMismatchPct.toFixed(2)}%`),
    ...snapshot.hedgeNeeds.map(n => `${n.perpSymbol}: ${n.reason}, ${n.targetSide || 'close'} ${n.targetSize}`),
    ...snapshot.dust.map(d => `Dust: ${d.symbol} ${d.size} ($${d.valueUSD.toFixed(4)}), below executable minimum`)
  ].join('\n');
}
