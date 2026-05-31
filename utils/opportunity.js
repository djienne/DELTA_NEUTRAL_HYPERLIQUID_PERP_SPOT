import HyperliquidConnector from '../hyperliquid.js';
import { getBidAskSpreads, filterBySpread } from './spread.js';
import { getPerpSpotSpreads, filterByPerpSpotSpread } from './arbitrage.js';
import { get24HourVolumes, convertVolumesToUSDC, filterByVolumeUSDC } from './volume.js';
import { getFundingRatesWithHistory, sortByAnnualizedRate, getPredictedFundingRates } from './funding.js';
import { getMaxBidAskSpreadPercent } from './risk.js';

/**
 * Opportunity Selection Utilities
 *
 * Filter and rank trading opportunities based on multiple criteria:
 * - Bid-ask spreads
 * - PERP-SPOT spreads
 * - 24-hour volume
 * - PREDICTED funding rates (what will be paid NEXT)
 * - 7-day average funding rates (for context/stability assessment)
 */

/**
 * Get all market data for opportunity analysis
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string[]} symbols - Array of symbols to analyze
 * @param {Object} config - Configuration object
 * @param {Object} options - Options
 * @returns {Promise<Object>} Combined market data
 */
export async function getMarketData(hyperliquid, symbols, config, options = {}) {
  const { verbose = false } = options;

  if (verbose) {
    console.log('[Market Data] Fetching comprehensive market data...');
  }

  // Fetch all data in parallel for speed
  // CRITICAL: Now fetching PREDICTED funding rates for decision-making
  const [bidAskSpreads, perpSpotSpreads, volumes, fundingRatesHistory, predictedFundingRates] = await Promise.all([
    getBidAskSpreads(hyperliquid, symbols, { config, verbose: false }),
    getPerpSpotSpreads(hyperliquid, symbols, { config, verbose: false }),
    get24HourVolumes(hyperliquid, symbols, { config, verbose: false }),
    getFundingRatesWithHistory(hyperliquid, symbols, { days: 7, verbose: false }),
    getPredictedFundingRates(hyperliquid, { verbose: false })
  ]);

  // Convert volumes to USDC
  const volumesUSDC = await convertVolumesToUSDC(hyperliquid, volumes);

  if (verbose) {
    console.log(`[Market Data] ✅ Fetched data for ${symbols.length} symbols`);
    console.log(`[Market Data] ℹ️  Using PREDICTED funding rates for filtering/ranking`);
  }

  return {
    bidAskSpreads,
    perpSpotSpreads,
    volumes: volumesUSDC,
    fundingRates: fundingRatesHistory,
    predictedFundingRates
  };
}

/**
 * Filter opportunities based on quality criteria
 * @param {Object} marketData - Market data from getMarketData
 * @param {Object} thresholds - Threshold configuration
 * @returns {Object} Filtered opportunities
 */
export function filterOpportunities(marketData, thresholds) {
  const {
    maxPerpSpotSpreadPercent = 0.5,
    minVolumeUSDC = 75000000,
    minFundingRatePercent = 5
  } = thresholds;
  const maxBidAskSpreadPercent = getMaxBidAskSpreadPercent(thresholds);

  // Create maps for easy lookup
  // For bidAskSpreads, group perp and spot together by PERP symbol
  const bidAskMap = new Map();
  for (const spread of marketData.bidAskSpreads) {
    const perpSymbol = spread.isSpot ? HyperliquidConnector.spotToPerp(spread.symbol) : spread.symbol;

    if (!bidAskMap.has(perpSymbol)) {
      bidAskMap.set(perpSymbol, {
        symbol: perpSymbol,
        perpSpreadPercent: null,
        spotSpreadPercent: null,
        perpMid: null,
        spotMid: null
      });
    }

    const entry = bidAskMap.get(perpSymbol);
    if (spread.isSpot) {
      entry.spotSpreadPercent = spread.spreadPercent;
      entry.spotMid = spread.mid;
    } else {
      entry.perpSpreadPercent = spread.spreadPercent;
      entry.perpMid = spread.mid;
    }
  }

  const perpSpotMap = new Map(marketData.perpSpotSpreads.map(s => [s.perpSymbol, s]));
  const volumeMap = new Map(marketData.volumes.map(v => [v.perpSymbol, v]));
  const fundingMap = new Map(marketData.fundingRates.map(f => [f.symbol, f]));
  // CRITICAL: Use predicted funding rates for filtering/ranking decisions
  const predictedFundingMap = marketData.predictedFundingRates || new Map();

  const results = [];
  const rejected = {
    bidAskSpread: [],
    perpSpotSpread: [],
    volume: [],
    funding: [],
    missingData: []
  };

  // Iterate over funding symbols (PERP symbols are the canonical list)
  // Don't use allSymbols from all maps as that creates duplicates
  const symbols = Array.from(fundingMap.keys());

  for (const symbol of symbols) {
    const bidAsk = bidAskMap.get(symbol);
    const perpSpot = perpSpotMap.get(symbol);
    const volume = volumeMap.get(symbol);
    const funding = fundingMap.get(symbol);
    const predictedFunding = predictedFundingMap.get(symbol);

    // Check if all data is available
    if (!bidAsk || !perpSpot || !volume || !funding) {
      const missing = [
        !bidAsk && 'bidAsk',
        !perpSpot && 'perpSpot',
        !volume && 'volume',
        !funding && 'funding'
      ].filter(Boolean);

      rejected.missingData.push({
        symbol,
        missing: missing
      });

      console.log(`[Opportunity] Missing data for ${symbol}:`, missing.join(', '));
      continue;
    }

    // Check errors
    if (bidAsk.error || perpSpot.error || volume.error || funding.error || funding.historyError) {
      rejected.missingData.push({
        symbol,
        errors: [
          bidAsk.error,
          perpSpot.error,
          volume.error,
          funding.error,
          funding.historyError
        ].filter(Boolean)
      });
      continue;
    }

    // Filter by bid-ask spread (both PERP and SPOT must be acceptable)
    const perpBidAskPct = bidAsk.perpSpreadPercent;
    const spotBidAskPct = bidAsk.spotSpreadPercent;
    const maxBidAskPct = Math.max(perpBidAskPct, spotBidAskPct);

    if (maxBidAskPct > maxBidAskSpreadPercent) {
      rejected.bidAskSpread.push({
        symbol,
        perpSpread: perpBidAskPct,
        spotSpread: spotBidAskPct,
        max: maxBidAskPct,
        threshold: maxBidAskSpreadPercent
      });
      continue;
    }

    // Filter by PERP-SPOT spread
    const perpSpotSpreadPct = Math.abs(perpSpot.spreadPercent);

    if (perpSpotSpreadPct > maxPerpSpotSpreadPercent) {
      rejected.perpSpotSpread.push({
        symbol,
        spread: perpSpotSpreadPct,
        threshold: maxPerpSpotSpreadPercent
      });
      continue;
    }

    // Filter by volume (combined PERP + SPOT)
    const totalVolumeUSDC = volume.perpVolUSDC + volume.spotVolUSDC;

    if (totalVolumeUSDC < minVolumeUSDC) {
      rejected.volume.push({
        symbol,
        volume: totalVolumeUSDC,
        threshold: minVolumeUSDC
      });
      continue;
    }

    // CRITICAL: Filter by PREDICTED funding rate (what will be paid NEXT)
    // Use predicted rate if available, otherwise fall back to historical average
    const predictedRate = predictedFunding?.predictedAnnualizedRate;
    const avgFundingRate = funding.history?.avg?.annualized || funding.annualizedRate;

    // For filtering, use predicted rate (what we'll actually earn)
    const filterFundingRate = predictedRate !== null && predictedRate !== undefined ? predictedRate : avgFundingRate;
    const filterFundingPercent = filterFundingRate * 100;

    if (filterFundingPercent < minFundingRatePercent) {
      rejected.funding.push({
        symbol,
        predictedFunding: predictedRate ? (predictedRate * 100) : null,
        avgFunding: avgFundingRate * 100,
        usedForFilter: filterFundingPercent,
        threshold: minFundingRatePercent
      });
      continue;
    }

    // Passed all filters!
    results.push({
      symbol,
      bidAsk,
      perpSpot,
      volume,
      funding,
      predictedFunding,  // Include predicted funding data
      // Composite scores - use predicted rate for ranking (what we'll actually earn)
      predictedFundingRate: predictedRate,
      predictedFundingPercent: predictedRate ? (predictedRate * 100) : null,
      avgFundingRate: avgFundingRate,
      avgFundingPercent: avgFundingRate * 100,
      // Use predicted for primary metric, fall back to average if not available
      primaryFundingRate: filterFundingRate,
      primaryFundingPercent: filterFundingPercent,
      totalVolumeUSDC: totalVolumeUSDC,
      maxBidAskSpread: maxBidAskPct,
      perpSpotSpreadAbs: perpSpotSpreadPct,
      // Quality score (higher = better)
      // Weighted: funding 70%, liquidity 20%, spreads 10%
      // CRITICAL: Use predicted funding for quality score (what we'll actually earn)
      qualityScore: (
        filterFundingPercent * 0.7 +
        (Math.min(totalVolumeUSDC / minVolumeUSDC, 5) * 2) +  // Cap volume bonus at 5x threshold
        ((maxBidAskSpreadPercent - maxBidAskPct) / maxBidAskSpreadPercent * 10) * 0.1
      )
    });
  }

  return {
    opportunities: results,
    rejected: rejected,
    stats: {
      total: symbols.length,
      passed: results.length,
      rejected: symbols.length - results.length,
      rejectionReasons: {
        bidAskSpread: rejected.bidAskSpread.length,
        perpSpotSpread: rejected.perpSpotSpread.length,
        volume: rejected.volume.length,
        funding: rejected.funding.length,
        missingData: rejected.missingData.length
      }
    }
  };
}

/**
 * Rank opportunities by PREDICTED funding rate (highest first)
 * CRITICAL: Uses predicted funding rate (what will be paid NEXT), not historical average
 * @param {Object[]} opportunities - Array of opportunities
 * @returns {Object[]} Sorted opportunities
 */
export function rankOpportunities(opportunities) {
  return opportunities.sort((a, b) => {
    // Primary sort: by PRIMARY funding rate (predicted if available, else average)
    // This is what we'll actually earn on the next funding payment
    const fundingDiff = b.primaryFundingRate - a.primaryFundingRate;
    if (Math.abs(fundingDiff) > 0.0001) {
      return fundingDiff;
    }

    // Secondary sort: by quality score
    return b.qualityScore - a.qualityScore;
  });
}

/**
 * Select best opportunity
 * @param {Object[]} opportunities - Array of ranked opportunities
 * @returns {Object|null} Best opportunity or null if none available
 */
export function selectBestOpportunity(opportunities) {
  if (!opportunities || opportunities.length === 0) {
    return null;
  }

  return opportunities[0];
}

/**
 * Check if a new opportunity is significantly better than current
 * @param {Object} currentOpportunity - Current position data
 * @param {Object} newOpportunity - New opportunity data
 * @param {number} minImprovementFactor - Minimum improvement factor (default 2x)
 * @returns {boolean} True if new is significantly better
 */
export function isSignificantlyBetter(currentOpportunity, newOpportunity, minImprovementFactor = 2) {
  if (!currentOpportunity || !newOpportunity) {
    return false;
  }

  const currentFunding = currentOpportunity.avgFundingRate || currentOpportunity.annualizedFunding;
  const newFunding = newOpportunity.avgFundingRate;

  // Check if new funding is at least minImprovementFactor times better
  return newFunding >= currentFunding * minImprovementFactor;
}

/**
 * Format opportunity report
 * @param {Object} filterResult - Result from filterOpportunities
 * @param {Object[]} rankedOpportunities - Ranked opportunities
 * @returns {string} Formatted report
 */
export function formatOpportunityReport(filterResult, rankedOpportunities) {
  const lines = [];

  lines.push('Opportunity Analysis:');
  lines.push(`  Total Symbols Analyzed: ${filterResult.stats.total}`);
  lines.push(`  Passed Filters: ${filterResult.stats.passed}`);
  lines.push(`  Rejected: ${filterResult.stats.rejected}`);
  lines.push('');

  if (filterResult.stats.rejected > 0) {
    lines.push('Rejection Reasons:');
    if (filterResult.stats.rejectionReasons.bidAskSpread > 0) {
      lines.push(`  ❌ Bid-Ask Spread: ${filterResult.stats.rejectionReasons.bidAskSpread}`);
    }
    if (filterResult.stats.rejectionReasons.perpSpotSpread > 0) {
      lines.push(`  ❌ PERP-SPOT Spread: ${filterResult.stats.rejectionReasons.perpSpotSpread}`);
    }
    if (filterResult.stats.rejectionReasons.volume > 0) {
      lines.push(`  ❌ Volume: ${filterResult.stats.rejectionReasons.volume}`);
    }
    if (filterResult.stats.rejectionReasons.funding > 0) {
      lines.push(`  ❌ Funding Rate: ${filterResult.stats.rejectionReasons.funding}`);
    }
    if (filterResult.stats.rejectionReasons.missingData > 0) {
      lines.push(`  ❌ Missing Data: ${filterResult.stats.rejectionReasons.missingData}`);
    }
    lines.push('');
  }

  if (rankedOpportunities.length === 0) {
    lines.push('⚠️  No valid opportunities found!');
    return lines.join('\n');
  }

  lines.push(`Top ${Math.min(3, rankedOpportunities.length)} Opportunities (ranked by 7-day avg funding):`);
  lines.push('');

  for (let i = 0; i < Math.min(3, rankedOpportunities.length); i++) {
    const opp = rankedOpportunities[i];
    const rank = i + 1;

    lines.push(`${rank}. ${opp.symbol}:`);
    lines.push(`   Avg Funding: ${(opp.avgFundingPercent).toFixed(2)}% APY`);
    lines.push(`   Current Funding: ${(opp.funding.annualizedRate * 100).toFixed(2)}% APY`);
    lines.push(`   Volume: $${(opp.totalVolumeUSDC / 1e6).toFixed(1)}M`);
    lines.push(`   Max Bid-Ask: ${(opp.maxBidAskSpread).toFixed(3)}%`);
    lines.push(`   PERP-SPOT Spread: ${(opp.perpSpotSpreadAbs).toFixed(3)}%`);
    lines.push(`   Quality Score: ${opp.qualityScore.toFixed(2)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Find and rank best opportunities
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string[]} symbols - Symbols to analyze
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<Object>} Analysis result
 */
export async function findBestOpportunities(hyperliquid, symbols, config, options = {}) {
  const { verbose = false } = options;

  // Get market data
  const marketData = await getMarketData(hyperliquid, symbols, config, { verbose });

  // Filter opportunities
  const filterResult = filterOpportunities(marketData, config.thresholds);

  // Rank opportunities
  const rankedOpportunities = rankOpportunities(filterResult.opportunities);

  // Select best
  const best = selectBestOpportunity(rankedOpportunities);

  return {
    marketData,
    filterResult,
    rankedOpportunities,
    best,
    report: formatOpportunityReport(filterResult, rankedOpportunities)
  };
}
