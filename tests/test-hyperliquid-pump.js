import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-pump.js');
import HyperliquidConnector from '../connectors/hyperliquid.js';

/**
 * Test Hyperliquid market orders with PUMP
 * Full cycle: Open Long -> Close Long -> Open Short -> Close Short
 * Target: $14 notional value
 */

async function testPumpOrders() {
  console.log('Hyperliquid PUMP Full Cycle Test');
  console.log('=================================\n');

  const connector = new HyperliquidConnector();

  try {
    // Step 1: Connect
    console.log('Step 1: Connecting to Hyperliquid...');
    await connector.connect();
    console.log('✓ Connected\n');

    // Step 2: Subscribe to PUMP orderbook
    console.log('Step 2: Subscribing to PUMP orderbook...');
    await connector.subscribeOrderbook('PUMP');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pumpBidAsk = connector.getBidAsk('PUMP');
    if (!pumpBidAsk) {
      throw new Error('No market data received for PUMP');
    }

    console.log('✓ Market data received');
    console.log(`  Current bid: $${pumpBidAsk.bid}`);
    console.log(`  Current ask: $${pumpBidAsk.ask}`);

    // Calculate size for $14 notional (use mid price)
    const midPrice = (pumpBidAsk.bid + pumpBidAsk.ask) / 2;
    const targetNotional = 14;
    const size = Math.ceil(targetNotional / midPrice); // Round up to whole number (szDecimals = 0)

    console.log(`  Mid price: $${midPrice.toFixed(6)}`);
    console.log(`  Size for $${targetNotional}: ${size} PUMP (~$${(size * midPrice).toFixed(2)})\n`);

    // Step 3: Open Long Position (Buy Market Order)
    console.log('Step 3: Opening LONG position (buy market order)...');
    console.log(`  Size: ${size} PUMP`);

    const longOrder = await connector.createMarketOrder('PUMP', 'buy', size);
    console.log('✓ Long position opened');
    console.log(`  Order result:`, JSON.stringify(longOrder, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 4: Close Long Position (Sell Market Order with reduce-only)
    console.log('Step 4: Closing LONG position (sell market order, reduce-only)...');
    console.log(`  Size: ${size} PUMP`);

    const closeLong = await connector.closePosition('PUMP', 'sell', size);
    console.log('✓ Long position closed');
    console.log(`  Order result:`, JSON.stringify(closeLong, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 5: Open Short Position (Sell Market Order)
    console.log('Step 5: Opening SHORT position (sell market order)...');
    console.log(`  Size: ${size} PUMP`);

    const shortOrder = await connector.createMarketOrder('PUMP', 'sell', size);
    console.log('✓ Short position opened');
    console.log(`  Order result:`, JSON.stringify(shortOrder, null, 2));
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 6: Close Short Position (Buy Market Order with reduce-only)
    console.log('Step 6: Closing SHORT position (buy market order, reduce-only)...');
    console.log(`  Size: ${size} PUMP`);

    const closeShort = await connector.closePosition('PUMP', 'buy', size);
    console.log('✓ Short position closed');
    console.log(`  Order result:`, JSON.stringify(closeShort, null, 2));
    console.log('');

    // Cleanup
    connector.intentionalDisconnect = true;
    connector.disconnect();

    console.log('✅ Test completed successfully!\n');
    console.log('Summary:');
    console.log(`  - Opened long position (buy ${size} PUMP)`);
    console.log(`  - Closed long position (sell ${size} PUMP, reduce-only)`);
    console.log(`  - Opened short position (sell ${size} PUMP)`);
    console.log(`  - Closed short position (buy ${size} PUMP, reduce-only)`);
    console.log('  - All positions should be closed now (net 0)');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error('Error details:', error);

    connector.intentionalDisconnect = true;
    connector.disconnect();
    process.exit(1);
  }
}

testPumpOrders();
