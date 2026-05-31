import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/close-hyperliquid-pump.js');
import dotenv from 'dotenv';
import { loadConfig } from '../utils/config.js';
import HyperliquidConnector from '../connectors/hyperliquid.js';

dotenv.config();

async function closeHyperliquidPump() {
  console.log('='.repeat(80));
  console.log('Closing PUMP Position on Hyperliquid');
  console.log('='.repeat(80));

  const config = loadConfig();
  const hyperliquid = new HyperliquidConnector({
    testnet: config.exchanges.hyperliquid.testnet
  });

  try {
    // Get positions via REST API
    console.log('\n[CHECK] Fetching positions via REST API...');
    const balance = await hyperliquid.getBalance(hyperliquid.wallet.address);
    console.log(`[CHECK] Total notional: $${balance.totalNtlPos}`);

    if (!balance.assetPositions || balance.assetPositions.length === 0) {
      console.log('[CHECK] ✅ No positions found\n');
      process.exit(0);
    }

    // Find PUMP position
    const pumpAsset = balance.assetPositions.find(a => a.position.coin === 'PUMP');
    if (!pumpAsset) {
      console.log('[CHECK] ✅ No PUMP position found\n');
      process.exit(0);
    }

    const szi = parseFloat(pumpAsset.position.szi);
    if (Math.abs(szi) < 0.001) {
      console.log('[CHECK] ✅ PUMP position is negligible\n');
      process.exit(0);
    }

    console.log(`\n[CHECK] Found PUMP position:`);
    console.log(`  Side:     ${szi > 0 ? 'LONG' : 'SHORT'}`);
    console.log(`  Amount:   ${Math.abs(szi)}`);
    console.log(`  Notional: $${parseFloat(pumpAsset.position.positionValue).toFixed(2)}\n`);

    // Determine close side (opposite of position)
    const closeSide = szi > 0 ? 'sell' : 'buy';
    const quantity = Math.abs(szi);

    console.log(`[CLOSE] Closing position: ${closeSide.toUpperCase()} ${quantity} PUMP (market order, reduce-only)`);

    // Place market order to close position
    const result = await hyperliquid.createMarketOrder(
      'PUMP',
      closeSide,
      quantity,
      { reduceOnly: true }  // Reduce-only to close position
    );

    console.log(`[CLOSE] ✅ Market order executed:`, result);

    // Wait for execution
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify position closed
    console.log('\n[VERIFY] Checking position after close...');
    const balanceAfter = await hyperliquid.getBalance(hyperliquid.wallet.address);
    console.log(`[VERIFY] Total notional: $${balanceAfter.totalNtlPos}`);

    const pumpAssetAfter = balanceAfter.assetPositions?.find(a => a.position.coin === 'PUMP');
    if (!pumpAssetAfter || Math.abs(parseFloat(pumpAssetAfter.position.szi)) < 0.001) {
      console.log('[VERIFY] ✅ PUMP position successfully closed\n');
    } else {
      console.log('[VERIFY] ⚠️  PUMP position still exists:');
      console.log(`  Amount: ${Math.abs(parseFloat(pumpAssetAfter.position.szi))}\n`);
    }

  } catch (error) {
    console.error('\n❌ Error closing position:', error.message);
    console.error('Stack:', error.stack);
  }

  process.exit(0);
}

closeHyperliquidPump();
