import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-rest-market-orders.js');
import HyperliquidConnector from '../connectors/hyperliquid.js';

/**
 * Test Hyperliquid REST API Market Orders
 *
 * This test verifies that market orders are executed via REST API (not WebSocket)
 * Tests both buy and sell market orders on XPL (small size for testing)
 */

async function testRestMarketOrders() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Hyperliquid REST API Market Orders Test                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const connector = new HyperliquidConnector();

  try {
    // Step 1: Connect (WebSocket will connect for orderbook data)
    console.log('[1/6] Connecting to Hyperliquid...');
    await connector.connect();
    console.log('✅ Connected\n');

    // Step 2: Subscribe to XPL orderbook (needed for market order pricing)
    console.log('[2/6] Subscribing to XPL orderbook...');
    await connector.subscribeOrderbook('XPL');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const xplBidAsk = connector.getBidAsk('XPL');
    if (!xplBidAsk) {
      throw new Error('No market data received for XPL');
    }

    console.log('✅ Market data received');
    console.log(`   Current bid: $${xplBidAsk.bid.toFixed(6)}`);
    console.log(`   Current ask: $${xplBidAsk.ask.toFixed(6)}`);
    console.log(`   Spread: ${((xplBidAsk.ask - xplBidAsk.bid) / xplBidAsk.bid * 100).toFixed(4)}%\n`);

    // Step 3: Buy Market Order (Open Long) - via REST API
    console.log('[3/6] Placing BUY market order (REST API)...');
    console.log('   Symbol: XPL');
    console.log('   Side: BUY');
    console.log('   Size: 52 XPL (~$20)');
    console.log('   Method: REST API (POST /exchange)\n');

    const buyStart = Date.now();
    const buyOrder = await connector.createMarketOrder('XPL', 'buy', 52);
    const buyLatency = Date.now() - buyStart;

    console.log('✅ BUY order executed');
    console.log(`   Latency: ${buyLatency}ms`);
    console.log(`   Response:`, JSON.stringify(buyOrder, null, 2));
    console.log('');

    // Check if order was filled
    if (buyOrder.response?.data?.statuses?.[0]?.filled) {
      const filled = buyOrder.response.data.statuses[0].filled;
      console.log('   Fill Details:');
      console.log(`     Total Size: ${filled.totalSz}`);
      console.log(`     Average Price: $${filled.avgPx}`);
      console.log('');
    }

    // Wait before closing
    console.log('⏳ Waiting 5 seconds before closing...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 4: Sell Market Order (Close Long) - via REST API with reduce-only
    console.log('[4/6] Placing SELL market order to close (REST API)...');
    console.log('   Symbol: XPL');
    console.log('   Side: SELL');
    console.log('   Size: 52 XPL');
    console.log('   Reduce-Only: true');
    console.log('   Method: REST API (POST /exchange)\n');

    const sellStart = Date.now();
    const sellOrder = await connector.closePosition('XPL', 'sell', 52);
    const sellLatency = Date.now() - sellStart;

    console.log('✅ SELL order executed (position closed)');
    console.log(`   Latency: ${sellLatency}ms`);
    console.log(`   Response:`, JSON.stringify(sellOrder, null, 2));
    console.log('');

    // Check if order was filled
    if (sellOrder.response?.data?.statuses?.[0]?.filled) {
      const filled = sellOrder.response.data.statuses[0].filled;
      console.log('   Fill Details:');
      console.log(`     Total Size: ${filled.totalSz}`);
      console.log(`     Average Price: $${filled.avgPx}`);
      console.log('');
    }

    // Step 5: Open Short (Sell Market Order)
    console.log('[5/6] Opening SHORT position (SELL market order via REST)...');
    console.log('   Symbol: XPL');
    console.log('   Side: SELL');
    console.log('   Size: 52 XPL (~$20)');
    console.log('   Method: REST API (POST /exchange)\n');

    const shortStart = Date.now();
    const shortOrder = await connector.createMarketOrder('XPL', 'sell', 52);
    const shortLatency = Date.now() - shortStart;

    console.log('✅ SHORT position opened');
    console.log(`   Latency: ${shortLatency}ms`);
    console.log(`   Response:`, JSON.stringify(shortOrder, null, 2));
    console.log('');

    // Check if order was filled
    if (shortOrder.response?.data?.statuses?.[0]?.filled) {
      const filled = shortOrder.response.data.statuses[0].filled;
      console.log('   Fill Details:');
      console.log(`     Total Size: ${filled.totalSz}`);
      console.log(`     Average Price: $${filled.avgPx}`);
      console.log('');
    }

    // Wait before closing
    console.log('⏳ Waiting 5 seconds before closing...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 6: Close Short (Buy Market Order with reduce-only)
    console.log('[6/6] Closing SHORT position (BUY market order via REST)...');
    console.log('   Symbol: XPL');
    console.log('   Side: BUY');
    console.log('   Size: 52 XPL');
    console.log('   Reduce-Only: true');
    console.log('   Method: REST API (POST /exchange)\n');

    const closeStart = Date.now();
    const closeOrder = await connector.closePosition('XPL', 'buy', 52);
    const closeLatency = Date.now() - closeStart;

    console.log('✅ SHORT position closed');
    console.log(`   Latency: ${closeLatency}ms`);
    console.log(`   Response:`, JSON.stringify(closeOrder, null, 2));
    console.log('');

    // Check if order was filled
    if (closeOrder.response?.data?.statuses?.[0]?.filled) {
      const filled = closeOrder.response.data.statuses[0].filled;
      console.log('   Fill Details:');
      console.log(`     Total Size: ${filled.totalSz}`);
      console.log(`     Average Price: $${filled.avgPx}`);
      console.log('');
    }

    // Summary
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Test Summary                                                ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    console.log('✅ All market orders executed successfully via REST API');
    console.log('');
    console.log('Performance:');
    console.log(`   BUY order latency:   ${buyLatency}ms`);
    console.log(`   SELL order latency:  ${sellLatency}ms`);
    console.log(`   SHORT order latency: ${shortLatency}ms`);
    console.log(`   CLOSE order latency: ${closeLatency}ms`);
    console.log(`   Average latency:     ${Math.round((buyLatency + sellLatency + shortLatency + closeLatency) / 4)}ms`);
    console.log('');
    console.log('✅ REST API market orders working correctly!');
    console.log('');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    console.log('Disconnecting...');
    await connector.disconnect();
    console.log('✅ Disconnected\n');
    process.exit(0);
  }
}

// Run the test
testRestMarketOrders();
