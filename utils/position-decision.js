export function getCurrentPositionFundingSignal(position, analysis) {
  if (!position || !analysis) {
    return {
      available: false,
      reason: 'missing position or analysis'
    };
  }

  const currentSymbolOpp = analysis.rankedOpportunities?.find(o => o.symbol === position.symbol);

  if (currentSymbolOpp) {
    const fundingType =
      Number.isFinite(currentSymbolOpp.predictedFundingPercent)
        ? 'predicted'
        : 'avg';

    return {
      available: true,
      symbol: position.symbol,
      source: 'ranked',
      fundingRate: currentSymbolOpp.primaryFundingRate,
      fundingPercent: currentSymbolOpp.primaryFundingPercent,
      fundingType,
      currentSymbolOpp
    };
  }

  const rawFundingData = analysis.marketData?.fundingRates?.find(f => f.symbol === position.symbol);
  const rawPredictedData = analysis.marketData?.predictedFundingRates?.get(position.symbol);

  if (!rawFundingData || rawFundingData.error) {
    return {
      available: false,
      symbol: position.symbol,
      reason: rawFundingData?.error || `Cannot retrieve funding data for ${position.symbol}`
    };
  }

  const predictedFunding = rawPredictedData?.predictedAnnualizedRate;
  const avgFunding = rawFundingData.history?.avg?.annualized ?? rawFundingData.annualizedRate;
  const fundingRate =
    Number.isFinite(predictedFunding)
      ? predictedFunding
      : avgFunding;

  if (fundingRate === null || fundingRate === undefined || !Number.isFinite(fundingRate)) {
    return {
      available: false,
      symbol: position.symbol,
      reason: `Funding data for ${position.symbol} is not finite`
    };
  }

  return {
    available: true,
    symbol: position.symbol,
    source: 'raw',
    fundingRate,
    fundingPercent: fundingRate * 100,
    fundingType:
      Number.isFinite(predictedFunding)
        ? 'predicted'
        : 'avg',
    rawFundingData,
    rawPredictedData
  };
}

export function isNegativeFundingSignal(signal) {
  return signal?.available === true && signal.fundingPercent < 0;
}

export function getPositiveReopenOpportunity(analysis) {
  return analysis?.best && analysis.best.primaryFundingPercent > 0 ? analysis.best : null;
}
