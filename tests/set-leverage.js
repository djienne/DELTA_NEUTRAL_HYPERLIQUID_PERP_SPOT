import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/set-leverage.js');
import HyperliquidConnector from '../hyperliquid.js';
import { setLeverageTo1xForAll, getLeverageSettings, formatLeverageSettings } from '../utils/leverage.js';
import fs from 'fs';

/**
 * Test script to set leverage to 1x for all configured pairs
 */

async function setLeverage() {
  console.log('='.repeat(80));
  console.log('Hyperliquid Leverage Setup - Set to 1x');
  console.log('='.repeat(80));
  console.log();

  // Load config
  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

  console.log(`[1/3] Loaded ${config.trading.pairs.length} pairs from config.json`);
  console.log(`       Pairs: ${config.trading.pairs.join(', ')}`);
  console.log();

  // Initialize connector
  const hyperliquid = new HyperliquidConnector({ testnet: false });

  if (!hyperliquid.wallet) {
    console.error('❌ Error: Wallet address not configured');
    console.error('   Please set HL_WALLET and HL_PRIVATE_KEY in .env file');
    process.exit(1);
  }

  console.log(`[2/3] Wallet: ${hyperliquid.wallet}`);
  console.log();

  console.log('[3/3] Setting leverage to 1x (isolated) for all pairs...');
  console.log('       Note: This will only take effect when you open a position');
  console.log();

  // Set leverage to 1x for all pairs
  const results = await setLeverageTo1xForAll(hyperliquid, config.trading.pairs, false, {
    verbose: true
  });

  console.log();
  console.log('='.repeat(80));
  console.log('Results:');
  console.log('='.repeat(80));
  console.log();

  // Display results
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    console.log(`✅ Successfully set leverage to 1x for ${successful.length} pair(s):`);
    for (const result of successful) {
      console.log(`   ${result.coin}: 1x ${result.isCross ? 'cross' : 'isolated'}`);
    }
    console.log();
  }

  if (failed.length > 0) {
    console.log(`❌ Failed to set leverage for ${failed.length} pair(s):`);
    for (const result of failed) {
      console.log(`   ${result.coin}: ${result.error}`);
    }
    console.log();
  }

  // Try to get current leverage settings (only works if you have positions)
  console.log('Current Leverage Settings:');
  try {
    const settings = await getLeverageSettings(hyperliquid);
    console.log(formatLeverageSettings(settings));
  } catch (error) {
    console.log('  (No positions yet - leverage will be applied when opening positions)');
  }

  console.log();
  console.log('='.repeat(80));
  console.log();

  if (failed.length === 0) {
    console.log('✅ All leverages set successfully!');
  } else {
    console.log('⚠️  Some leverages failed to set. Please check errors above.');
  }

  console.log();

  process.exit(failed.length > 0 ? 1 : 0);
}

setLeverage().catch(error => {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
