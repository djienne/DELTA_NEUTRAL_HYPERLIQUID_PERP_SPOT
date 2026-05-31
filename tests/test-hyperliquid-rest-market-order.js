import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-rest-market-order.js');
import dotenv from 'dotenv';
import { loadConfig } from '../utils/config.js';
import HyperliquidConnector from '../connectors/hyperliquid.js';

dotenv.config();

async function testRestMarketOrder() {
  console.log('='.repeat(80));
  console.log('Testing Hyperliquid REST API Market Orders');
  console.log('='.repeat(80));

  const config = loadConfig();
  const hyperliquid = new HyperliquidConnector({
    testnet: config.exchanges.hyperliquid.testnet
  });

  // DON'T connect WebSocket - test pure REST functionality
  console.log('\n[TEST] Skipping WebSocket connection to test REST-only functionality\n');

  const symbol = 'SOL';
  const side = 'buy';
  const size = 0.1; // Small test order

  try {
    console.log(`[TEST] Placing ${side.toUpperCase()} order for ${size} ${symbol} via REST API...`);
    console.log(`[TEST] This will:`);
    console.log(`  1. Fetch orderbook via REST API (no WebSocket)`);
    console.log(`  2. Calculate limit price with 5% slippage`);
    console.log(`  3. Submit order via REST API\n`);

    const startTime = Date.now();

    const result = await hyperliquid.createMarketOrder(symbol, side, size, {
      reduceOnly: false
    });

    const endTime = Date.now();
    const latency = endTime - startTime;

    console.log('\n' + '='.repeat(80));
    console.log('ORDER RESULT');
    console.log('='.repeat(80));
    console.log(JSON.stringify(result, null, 2));
    console.log('='.repeat(80));
    console.log(`Total latency: ${latency}ms`);
    console.log('='.repeat(80) + '\n');

    // Wait a moment for order to settle
    console.log('[TEST] Waiting 2s for order settlement...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check position
    console.log('[TEST] Checking positions...\n');
    const balance = await hyperliquid.getBalance();

    console.log('Balance Info:');
    console.log(`  Total notional: $${balance.totalNtlPos}`);

    if (balance.assetPositions && balance.assetPositions.length > 0) {
      console.log('\nPositions:');
      for (const asset of balance.assetPositions) {
        const szi = parseFloat(asset.position.szi);
        if (Math.abs(szi) > 0.001) {
          console.log(`  ${asset.position.coin}: ${szi > 0 ? '+' : ''}${szi.toFixed(4)}`);
        }
      }
    }

    console.log('\n✅ REST API market order test PASSED\n');

  } catch (error) {
    console.error('\n❌ REST API market order test FAILED');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }

  process.exit(0);
}

testRestMarketOrder();
