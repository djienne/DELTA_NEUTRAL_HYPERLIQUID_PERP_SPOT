import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-market-orders.js');
import HyperliquidConnector from '../connectors/hyperliquid.js';

/**
 * Test Hyperliquid market orders
 * Tests: Open Long -> Close Long -> Open Short -> Close Short on SOL
 */

async function testMarketOrders() {
  console.log('Hyperliquid Market Orders Test');
  console.log('===============================\n');

  const connector = new HyperliquidConnector();

  try {
    // Step 1: Connect
    console.log('Step 1: Connecting to Hyperliquid...');
    await connector.connect();
    console.log('✓ Connected\n');

    // Step 2: Subscribe to SOL orderbook
    console.log('Step 2: Subscribing to SOL orderbook...');
    await connector.subscribeOrderbook('SOL');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const solBidAsk = connector.getBidAsk('SOL');
    if (!solBidAsk) {
      throw new Error('No market data received for SOL');
    }

    console.log('✓ Market data received');
    console.log(`  Current bid: $${solBidAsk.bid}`);
    console.log(`  Current ask: $${solBidAsk.ask}\n`);

    // Step 3: Open Long Position (Buy Market Order)
    console.log('Step 3: Opening LONG position (buy market order)...');
    console.log('  Size: 0.06 SOL (~$11)');

    const longOrder = await connector.createMarketOrder('SOL', 'buy', 0.06);
    console.log('✓ Long position opened');
    console.log(`  Order result:`, JSON.stringify(longOrder, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('');

    // Step 4: Close Long Position (Sell Market Order with reduce-only)
    console.log('Step 4: Closing LONG position (sell market order, reduce-only)...');
    console.log('  Size: 0.06 SOL');

    const closeLong = await connector.closePosition('SOL', 'sell', 0.06);
    console.log('✓ Long position closed');
    console.log(`  Order result:`, JSON.stringify(closeLong, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('');

    // Step 5: Open Short Position (Sell Market Order)
    console.log('Step 5: Opening SHORT position (sell market order)...');
    console.log('  Size: 0.06 SOL');

    const shortOrder = await connector.createMarketOrder('SOL', 'sell', 0.06);
    console.log('✓ Short position opened');
    console.log(`  Order result:`, JSON.stringify(shortOrder, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('');

    // Step 6: Close Short Position (Buy Market Order with reduce-only)
    console.log('Step 6: Closing SHORT position (buy market order, reduce-only)...');
    console.log('  Size: 0.06 SOL');

    const closeShort = await connector.closePosition('SOL', 'buy', 0.06);
    console.log('✓ Short position closed');
    console.log(`  Order result:`, JSON.stringify(closeShort, null, 2));
    console.log('');

    // Cleanup
    connector.intentionalDisconnect = true;
    connector.disconnect();

    console.log('✅ Test completed successfully!\n');
    console.log('Summary:');
    console.log('  - Opened long position (buy)');
    console.log('  - Closed long position (sell, reduce-only)');
    console.log('  - Opened short position (sell)');
    console.log('  - Closed short position (buy, reduce-only)');
    console.log('  - All operations executed via market orders');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error('Error details:', error);

    connector.intentionalDisconnect = true;
    connector.disconnect();
    process.exit(1);
  }
}

testMarketOrders();
