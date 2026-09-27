import HyperliquidConnector from '../hyperliquid.js';

const toNumber = v => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

/**
 * 24h notional volume in USD per pair, from the exchange's own `dayNtlVlm` (two info calls in total).
 * Missing data is null, so callers can reject the pair instead of treating it as zero volume.
 * @returns {Promise<Array<{perpSymbol, spotSymbol, perpVolUSDC, spotVolUSDC, totalVolUSDC}>>}
 */
export async function get24HourVolumes(hyperliquid, perpSymbols) {
  const [[meta, perpCtxs], [, spotCtxs]] = await Promise.all([
    hyperliquid.infoRequest({ type: 'metaAndAssetCtxs' }, 20),
    hyperliquid.infoRequest({ type: 'spotMetaAndAssetCtxs' }, 20)
  ]);
  const perpVolume = new Map(meta.universe.map((asset, i) => [asset.name, toNumber(perpCtxs[i]?.dayNtlVlm)]));
  const spotVolume = new Map(spotCtxs.map(ctx => [ctx.coin, toNumber(ctx.dayNtlVlm)]));

  return Promise.all(perpSymbols.map(async perpSymbol => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);
    const spotCoin = await hyperliquid.getAssetId(spotSymbol, true)
      .then(id => hyperliquid.getCoinForOrderbook(spotSymbol, id), () => null);
    const perpVolUSDC = perpVolume.get(perpSymbol) ?? null;
    const spotVolUSDC = spotVolume.get(spotCoin) ?? null;
    const totalVolUSDC = perpVolUSDC !== null && spotVolUSDC !== null ? perpVolUSDC + spotVolUSDC : null;
    return { perpSymbol, spotSymbol, perpVolUSDC, spotVolUSDC, totalVolUSDC };
  }));
}
