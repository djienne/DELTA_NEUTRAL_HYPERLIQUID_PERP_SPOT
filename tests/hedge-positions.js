import HyperliquidConnector from '../hyperliquid.js';
import { analyzeHedgeNeeds, autoHedgeAll, formatHedgeReport } from '../utils/hedge.js';
import { requireLiveTradingTest } from '../utils/live-guard.js';
import fs from 'fs';

/**
 * Manual script to analyze and hedge unbalanced positions
 *
 * Usage:
 *   node tests/hedge-positions.js --analyze   (just show what needs hedging)
 *   node tests/hedge-positions.js --execute   (actually create hedges)
 */

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--analyze';

  console.log('═'.repeat(80));
  console.log('Hedge Positions Tool');
  console.log('═'.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  console.log(`✅ Connected to Hyperliquid`);
  console.log(`   Wallet: ${hyperliquid.wallet}`);
  console.log();

  if (mode === '--analyze' || mode === '-a') {
    // Just analyze and show report
    console.log('[Mode] ANALYZE - Showing what needs hedging');
    console.log();

    const analysis = await analyzeHedgeNeeds(hyperliquid, {
      minValueUSD: 1,
      verbose: true
    });

    console.log(formatHedgeReport(analysis));

    if (analysis.needsHedging) {
      console.log('💡 To create hedges, run:');
      console.log('   node tests/hedge-positions.js --execute');
      console.log();
    }

  } else if (mode === '--execute' || mode === '-e') {
    // Execute - actually create hedges
    requireLiveTradingTest('tests/hedge-positions.js --execute');
    console.log('[Mode] EXECUTE - Creating hedges for real');
    console.log();

    // First show what will be done
    const analysis = await analyzeHedgeNeeds(hyperliquid, {
      minValueUSD: 1,
      verbose: false
    });

    if (!analysis.needsHedging) {
      console.log('✅ No positions need hedging. Exiting.');
      hyperliquid.disconnect();
      process.exit(0);
    }

    console.log(`Found ${analysis.hedgeNeeds.length} position(s) needing hedges:`);
    for (const need of analysis.hedgeNeeds) {
      const symbol = need.perpSymbol || need.spotSymbol;
      const size = (need.perpSizeNeeded || need.spotSizeNeeded).toFixed(6);
      console.log(`  • ${need.action} ${size} ${symbol} ${need.market} ($${need.valueUSD.toFixed(2)})`);
    }
    console.log();
    console.log('Executing hedges...');
    console.log();

    // Execute
    const results = await autoHedgeAll(hyperliquid, config, {
      verbose: true,
      minValueUSD: 1,
      fallbackToClose: true
    });

    // Final summary
    if (results.success) {
      console.log('');
      console.log('✅ All hedges created successfully!');
    } else {
      console.log('');
      console.log('⚠️  Some hedges failed. Check the output above.');
    }
    console.log();

  } else {
    console.log('❌ Invalid mode. Usage:');
    console.log('   node tests/hedge-positions.js --analyze   (default)');
    console.log('   node tests/hedge-positions.js --execute');
    console.log();
  }

  hyperliquid.disconnect();
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
