import HyperliquidConnector from '../hyperliquid.js';
import { getPerpPositions, getSpotBalances } from './positions.js';
import { getFundingRatesWithHistory, getPredictedFundingRates } from './funding.js';
import { get24HourVolumes, convertVolumesToUSDC } from './volume.js';
import { getBidAskSpreads } from './spread.js';
import { getPerpSpotSpreads } from './arbitrage.js';
import { getBalances } from './balance.js';

/**
 * Format a statistics report with market data
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string[]} symbols - Symbols to analyze
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 * @returns {Promise<string>} Formatted statistics report
 */
export async function generateStatisticsReport(hyperliquid, symbols, config, options = {}) {
  const { verbose = false } = options;

  if (verbose) {
    console.log('[Stats] Gathering market statistics...');
  }

  // Balances and positions
  const wallet = hyperliquid.wallet;
  const balances = await getBalances(hyperliquid, wallet);
  const perpBalance = balances.perpBalance;
  const spotBalance = balances.spotBalance;
  const totalBalance = balances.totalBalance;

  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, wallet, { verbose: false }),
    getSpotBalances(hyperliquid, wallet, { verbose: false })
  ]);

  // Market data - CRITICAL: Fetch PREDICTED funding rates
  const [fundingRates, predictedFundingRates, volumes, bidAskSpreads, perpSpotSpreads] = await Promise.all([
    getFundingRatesWithHistory(hyperliquid, symbols, { days: 7, verbose: false }),
    getPredictedFundingRates(hyperliquid, { verbose: false }),
    get24HourVolumes(hyperliquid, symbols, { verbose: false }),
    getBidAskSpreads(hyperliquid, symbols, { config, verbose: false }),
    getPerpSpotSpreads(hyperliquid, symbols, { config, verbose: false })
  ]);

  const volumesUSDC = await convertVolumesToUSDC(hyperliquid, volumes);

  // Helpers
  const fmtSigned = (n, digits = 1) => (n >= 0 ? ` ${n.toFixed(digits)}` : n.toFixed(digits)); // width ~5
  const lines = [];

  // Header
  lines.push('');
  lines.push('='.repeat(80));
  lines.push('Market Statistics Report');
  lines.push('='.repeat(80));
  lines.push('');

  // Account Summary
  const perpBalancePct = totalBalance > 0 ? (perpBalance / totalBalance * 100) : 0;
  const spotBalancePct = totalBalance > 0 ? (spotBalance / totalBalance * 100) : 0;
  lines.push('Account Summary:');
  lines.push(`   Wallet: ${wallet}`);
  lines.push(`   PERP Balance: $${perpBalance.toFixed(2)} (${perpBalancePct.toFixed(1)}%)`);
  lines.push(`   SPOT Balance: $${spotBalance.toFixed(2)} (${spotBalancePct.toFixed(1)}%)`);
  lines.push(`   Total Balance: $${totalBalance.toFixed(2)}`);
  lines.push('');

  // Positions Summary
  lines.push('Current Positions:');
  if (perpPositions.length === 0 && spotBalances.length === 0) {
    lines.push('   No open positions');
  } else {
    if (perpPositions.length > 0) {
      lines.push(`   PERP Positions (${perpPositions.length}):`);
      for (const pos of perpPositions) {
        lines.push(`     ${pos.symbol}: ${pos.side.toUpperCase()} ${pos.size} @ $${pos.entryPrice.toFixed(2)} (PnL: $${pos.unrealizedPnl.toFixed(2)})`);
      }
    }
    if (spotBalances.length > 0) {
      lines.push(`   SPOT Balances (${spotBalances.length}, excluding USDC):`);
      for (const bal of spotBalances.slice(0, 5)) {
        const value = bal.total * (bal.price || 0);
        lines.push(`     ${bal.symbol}: ${bal.total.toFixed(6)} ($${value.toFixed(2)})`);
      }
      if (spotBalances.length > 5) {
        lines.push(`     ... and ${spotBalances.length - 5} more`);
      }
    }
  }
  lines.push('');

  // Market Data Table
  lines.push('Market Data for Tracked Symbols:');
  lines.push('');

  const COLS = { symbol: 10, funding: 15, vol: 13, bidask: 15, psspr: 10, quality: 10 };
  const top = '┌' + '─'.repeat(COLS.symbol) + '┬' + '─'.repeat(COLS.funding) + '┬' + '─'.repeat(COLS.vol) + '┬' + '─'.repeat(COLS.bidask) + '┬' + '─'.repeat(COLS.psspr) + '┬' + '─'.repeat(COLS.quality) + '┐';
  const mid = '├' + '─'.repeat(COLS.symbol) + '┼' + '─'.repeat(COLS.funding) + '┼' + '─'.repeat(COLS.vol) + '┼' + '─'.repeat(COLS.bidask) + '┼' + '─'.repeat(COLS.psspr) + '┼' + '─'.repeat(COLS.quality) + '┤';
  const bot = '└' + '─'.repeat(COLS.symbol) + '┴' + '─'.repeat(COLS.funding) + '┴' + '─'.repeat(COLS.vol) + '┴' + '─'.repeat(COLS.bidask) + '┴' + '─'.repeat(COLS.psspr) + '┴' + '─'.repeat(COLS.quality) + '┘';
  const cell = (t, w, a = 'left') => {
    const inner = w - 2;
    let s = String(t ?? '');
    if (s.length > inner) s = s.slice(0, inner);
    s = (a === 'right') ? s.padStart(inner) : s.padEnd(inner);
    return `│ ${s} `;
  };

  lines.push(top);
  lines.push(
    cell('Symbol', COLS.symbol) +
    cell('Funding APY', COLS.funding) +
    cell('24h Vol', COLS.vol) +
    cell('Bid-Ask %', COLS.bidask) +
    cell('P-S Spr%', COLS.psspr) +
    cell('Quality', COLS.quality) + '│'
  );
  lines.push(
    cell('', COLS.symbol) +
    cell('Avg  | Pred', COLS.funding) +  // CRITICAL: Changed from Curr to Pred
    cell('(USDC)', COLS.vol) +
    cell('Perp  | Spot', COLS.bidask) +
    cell('', COLS.psspr) +
    cell('', COLS.quality) + '│'
  );
  lines.push(mid);

  for (const symbol of symbols) {
    const funding = fundingRates.find(f => f.symbol === symbol);
    const predicted = predictedFundingRates.get(symbol);  // CRITICAL: Get predicted funding
    const volume = volumesUSDC.find(v => v.perpSymbol === symbol);
    const bidAskPerp = bidAskSpreads.find(s => s.symbol === symbol && !s.isSpot);
    const spotSymbol = HyperliquidConnector.perpToSpot(symbol);
    const bidAskSpot = bidAskSpreads.find(s => s.symbol === spotSymbol && s.isSpot);
    const perpSpot = perpSpotSpreads.find(s => s.perpSymbol === symbol);

    const avgFundingNum = funding?.history?.avg?.annualized ? (funding.history.avg.annualized * 100) : null;
    const predFundingNum = predicted?.predictedAnnualizedRate ? (predicted.predictedAnnualizedRate * 100) : null;  // CRITICAL: Use predicted instead of current

    const avgFunding = avgFundingNum !== null ? fmtSigned(avgFundingNum) : 'N/A';
    const predFunding = predFundingNum !== null ? fmtSigned(predFundingNum) : 'N/A';  // CRITICAL: Show predicted
    const volStr = volume?.totalVolUSDC ? `$${(volume.totalVolUSDC / 1e6).toFixed(0)}M` : 'N/A';
    const perpSpread = bidAskPerp?.spreadPercent !== undefined ? bidAskPerp.spreadPercent.toFixed(3) : 'N/A';
    const spotSpread = bidAskSpot?.spreadPercent !== undefined ? bidAskSpot.spreadPercent.toFixed(3) : 'N/A';
    const psSpr = perpSpot?.spreadPercent !== undefined ? Math.abs(perpSpot.spreadPercent).toFixed(3) : 'N/A';

    let quality = '';
    // Use predicted for quality assessment if available, otherwise fall back to average
    const qualityBasis = (predFundingNum !== null ? predFundingNum : (avgFundingNum !== null ? avgFundingNum : null));
    if (qualityBasis !== null) {
      if (qualityBasis >= 10) quality = 'GOOD';
      else if (qualityBasis >= 5) quality = 'MOD';
      else if (qualityBasis >= 0) quality = 'NEU';
      else quality = 'NEG';
    }

    // Keep inner content within column width (no extra spaces around '|')
    const fundingCell = `${avgFunding.padStart(5)}|${predFunding.padStart(5)}`;  // CRITICAL: Show predicted instead of current
    const bidAskCell = `${String(perpSpread).padStart(5)}|${String(spotSpread).padStart(5)}`;

    lines.push(
      cell(symbol, COLS.symbol, 'left') +
      cell(fundingCell, COLS.funding, 'right') +
      cell(volStr, COLS.vol, 'right') +
      cell(bidAskCell, COLS.bidask, 'right') +
      cell(psSpr, COLS.psspr, 'right') +
      cell(quality, COLS.quality, 'left') + '│'
    );
  }

  lines.push(bot);
  lines.push('');
  lines.push('Legend: GOOD (≥10% APY) | MOD (5–10% APY) | NEG (<0% APY) | Avg = 7-day avg');
  lines.push('');
  lines.push('='.repeat(80));
  lines.push('');

  return lines.join('\n');
}

/**
 * Log statistics report to console
 * @param {HyperliquidConnector} hyperliquid - Hyperliquid connector
 * @param {string[]} symbols - Symbols to analyze
 * @param {Object} config - Configuration
 * @param {Object} options - Options
 */
export async function logStatistics(hyperliquid, symbols, config, options = {}) {
  const report = await generateStatisticsReport(hyperliquid, symbols, config, options);
  console.log(report);
}
