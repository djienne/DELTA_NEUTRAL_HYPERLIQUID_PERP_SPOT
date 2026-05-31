import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-generic.js');
import HyperliquidConnector from '../connectors/hyperliquid.js';

/**
 * Test Hyperliquid market orders with any symbol
 * Full cycle: Open Long -> Close Long -> Open Short -> Close Short
 *
 * Usage: node tests/test-hyperliquid-generic.js [SYMBOL] [NOTIONAL]
 * Example: node tests/test-hyperliquid-generic.js PUMP 14
 */

async function testGenericOrders() {
  // Get symbol and notional from command line args
  const symbol = process.argv[2] || 'SOL';
  const targetNotional = parseFloat(process.argv[3]) || 12;

  console.log(`Hyperliquid ${symbol} Full Cycle Test`);
  console.log('='.repeat(40));
  console.log(`Target notional: $${targetNotional}\n`);

  const connector = new HyperliquidConnector();

  try {
    // Step 1: Connect
    console.log('Step 1: Connecting to Hyperliquid...');
    await connector.connect();
    console.log('✓ Connected\n');

    // Step 2: Subscribe to orderbook
    console.log(`Step 2: Subscribing to ${symbol} orderbook...`);
    await connector.subscribeOrderbook(symbol);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const bidAsk = connector.getBidAsk(symbol);
    if (!bidAsk) {
      throw new Error(`No market data received for ${symbol}`);
    }

    console.log('✓ Market data received');
    console.log(`  Current bid: $${bidAsk.bid}`);
    console.log(`  Current ask: $${bidAsk.ask}`);

    // Get asset metadata for proper rounding
    const assetId = await connector.getAssetId(symbol);
    const assetInfo = connector.getAssetInfo(symbol);

    // Calculate size for target notional (use mid price)
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
    let size = targetNotional / midPrice;

    // Round size to proper lot size (szDecimals)
    const sizeDecimalMultiplier = Math.pow(10, assetInfo.szDecimals);
    size = Math.ceil(size * sizeDecimalMultiplier) / sizeDecimalMultiplier;

    console.log(`  Mid price: $${midPrice.toFixed(6)}`);
    console.log(`  szDecimals: ${assetInfo.szDecimals}`);
    console.log(`  Size for $${targetNotional}: ${size} ${symbol} (~$${(size * midPrice).toFixed(2)})\n`);

    // Step 3: Open Long Position (Buy Market Order)
    console.log('Step 3: Opening LONG position (buy market order)...');
    console.log(`  Size: ${size} ${symbol}`);

    const longOrder = await connector.createMarketOrder(symbol, 'buy', size);
    console.log('✓ Long position opened');
    console.log(`  Filled: ${longOrder.response.data.statuses[0].filled.totalSz} @ $${longOrder.response.data.statuses[0].filled.avgPx}`);
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 4: Close Long Position (Sell Market Order with reduce-only)
    console.log('Step 4: Closing LONG position (sell market order, reduce-only)...');
    console.log(`  Size: ${size} ${symbol}`);

    const closeLong = await connector.closePosition(symbol, 'sell', size);
    console.log('✓ Long position closed');
    console.log(`  Filled: ${closeLong.response.data.statuses[0].filled.totalSz} @ $${closeLong.response.data.statuses[0].filled.avgPx}`);
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 5: Open Short Position (Sell Market Order)
    console.log('Step 5: Opening SHORT position (sell market order)...');
    console.log(`  Size: ${size} ${symbol}`);

    const shortOrder = await connector.createMarketOrder(symbol, 'sell', size);
    console.log('✓ Short position opened');
    console.log(`  Filled: ${shortOrder.response.data.statuses[0].filled.totalSz} @ $${shortOrder.response.data.statuses[0].filled.avgPx}`);
    console.log('');

    // Wait a bit
    console.log('Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // Step 6: Close Short Position (Buy Market Order with reduce-only)
    console.log('Step 6: Closing SHORT position (buy market order, reduce-only)...');
    console.log(`  Size: ${size} ${symbol}`);

    const closeShort = await connector.closePosition(symbol, 'buy', size);
    console.log('✓ Short position closed');
    console.log(`  Filled: ${closeShort.response.data.statuses[0].filled.totalSz} @ $${closeShort.response.data.statuses[0].filled.avgPx}`);
    console.log('');

    // Cleanup
    connector.intentionalDisconnect = true;
    connector.disconnect();

    console.log('✅ Test completed successfully!\n');
    console.log('Summary:');
    console.log(`  - Opened long position (buy ${size} ${symbol})`);
    console.log(`  - Closed long position (sell ${size} ${symbol}, reduce-only)`);
    console.log(`  - Opened short position (sell ${size} ${symbol})`);
    console.log(`  - Closed short position (buy ${size} ${symbol}, reduce-only)`);
    console.log(`  - Final position: 0 ${symbol} ✅`);

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error('Error details:', error);

    connector.intentionalDisconnect = true;
    connector.disconnect();
    process.exit(1);
  }
}

testGenericOrders();
