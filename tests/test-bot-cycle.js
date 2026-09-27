import HyperliquidConnector from '../hyperliquid.js';
import { findBestOpportunities } from '../utils/opportunity.js';
import { checkAndReportBalances } from '../utils/balance.js';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function test() {
  console.log('Testing bot cycle logic...\n');

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  console.log('Connected\n');

  // Test balance check
  console.log('[1/2] Checking Balance Distribution...');
  const balanceReport = await checkAndReportBalances(hyperliquid, (config.bot?.maxBalanceImbalancePercent ?? 10) / 2);  // same hold rule as bot.js
  console.log(balanceReport.report);
  console.log();

  // Test opportunity finding
  console.log('[2/2] Finding Best Opportunities...');
  const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config, { verbose: true });
  console.log();
  console.log(analysis.report);
  console.log();

  if (analysis.best) {
    console.log('✅ Best opportunity:', analysis.best.symbol);
    console.log('   Avg Funding:', (analysis.best.avgFundingPercent).toFixed(2), '% APY');
    console.log('   Volume:', '$' + (analysis.best.totalVolumeUSDC / 1e6).toFixed(1) + 'M');
    console.log('   Max Bid-Ask:', (analysis.best.maxBidAskSpread).toFixed(3), '%');
  } else {
    console.log('❌ No valid opportunities found');
  }

  hyperliquid.disconnect();
  process.exit(0);
}

test().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
