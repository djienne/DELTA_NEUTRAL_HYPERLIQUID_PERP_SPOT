import HyperliquidConnector from '../hyperliquid.js';

/**
 * Test script to fetch and display user funding payment history
 *
 * Usage:
 *   node tests/check-funding-payments.js              # All time
 *   node tests/check-funding-payments.js --7d         # Last 7 days
 *   node tests/check-funding-payments.js --30d        # Last 30 days
 *   node tests/check-funding-payments.js --since 1234567890000  # Since timestamp
 */

async function main() {
  console.log('='.repeat(80));
  console.log('User Funding Payment History');
  console.log('='.repeat(80));
  console.log();

  // Parse arguments
  const args = process.argv.slice(2);
  let startTime = null;

  if (args.includes('--7d')) {
    startTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
    console.log(`Fetching payments from last 7 days (since ${new Date(startTime).toLocaleString()})...`);
  } else if (args.includes('--30d')) {
    startTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
    console.log(`Fetching payments from last 30 days (since ${new Date(startTime).toLocaleString()})...`);
  } else if (args.includes('--since')) {
    const sinceIndex = args.indexOf('--since');
    startTime = parseInt(args[sinceIndex + 1]);
    console.log(`Fetching payments since ${new Date(startTime).toLocaleString()}...`);
  } else {
    console.log('Fetching all funding payments...');
  }
  console.log();

  // Initialize connector
  const hyperliquid = new HyperliquidConnector({ testnet: false });

  if (!hyperliquid.wallet) {
    console.error('❌ Error: Wallet address not configured');
    console.error('   Please set wallet_address in hyperliquid.env');
    process.exit(1);
  }

  console.log(`Wallet: ${hyperliquid.wallet}`);
  console.log();

  try {
    // Fetch funding history
    const history = await hyperliquid.getUserFundingHistory(null, startTime);

    console.log('='.repeat(80));
    console.log('Summary');
    console.log('='.repeat(80));
    console.log();
    console.log(`Total Payments: ${history.count}`);
    console.log(`Total Accumulated: $${history.totalAccumulated.toFixed(4)}`);
    console.log();

    if (Object.keys(history.accumulated).length > 0) {
      console.log('Per-Coin Accumulated:');
      const sorted = Object.entries(history.accumulated).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      for (const [coin, amount] of sorted) {
        const sign = amount >= 0 ? '+' : '';
        const color = amount >= 0 ? '\x1b[32m' : '\x1b[31m'; // Green for positive, red for negative
        const reset = '\x1b[0m';
        console.log(`  ${coin.padEnd(10)} ${color}${sign}$${amount.toFixed(4)}${reset}`);
      }
      console.log();
    }

    if (history.count > 0) {
      console.log('='.repeat(80));
      console.log(`Recent Payments (showing last ${Math.min(20, history.count)} of ${history.count})`);
      console.log('='.repeat(80));
      console.log();

      // Show last 20 payments
      const recentPayments = history.payments.slice(-20).reverse();

      console.log('┌────────────────────┬──────────┬─────────────┬──────────────┬──────────────┐');
      console.log('│ Time               │ Coin     │ Funding %   │ Position     │ Payment      │');
      console.log('├────────────────────┼──────────┼─────────────┼──────────────┼──────────────┤');

      for (const payment of recentPayments) {
        // Skip non-funding deltas
        if (!payment.delta || payment.delta.type !== 'funding') continue;

        const time = new Date(payment.time).toLocaleString();
        const coin = payment.delta.coin.padEnd(8);
        const fundingRate = (parseFloat(payment.delta.fundingRate) * 100).toFixed(4);
        const fundingStr = fundingRate.padStart(11);
        const szi = parseFloat(payment.delta.szi).toFixed(4).padStart(12);
        const usdc = parseFloat(payment.delta.usdc);
        const usdcStr = usdc.toFixed(4).padStart(12);
        const sign = usdc >= 0 ? '+' : '';
        const color = usdc >= 0 ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';

        console.log(`│ ${time.padEnd(18)} │ ${coin} │ ${fundingStr}% │ ${szi} │ ${color}${sign}${usdcStr}${reset} │`);
      }

      console.log('└────────────────────┴──────────┴─────────────┴──────────────┴──────────────┘');
      console.log();

      if (history.count > 20) {
        console.log(`(${history.count - 20} earlier payments not shown)`);
        console.log();
      }
    } else {
      console.log('No funding payments found for the specified period.');
      console.log();
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
