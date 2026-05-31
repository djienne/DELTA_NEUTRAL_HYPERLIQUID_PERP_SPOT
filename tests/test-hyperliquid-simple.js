import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-hyperliquid-simple.js');
import HyperliquidConnector from '../connectors/hyperliquid.js';

/**
 * Simple test - just place one market order via WebSocket
 */

async function simpleTest() {
  console.log('Simple Hyperliquid Market Order Test\n');

  const connector = new HyperliquidConnector();

  try {
    // Connect
    console.log('Connecting...');
    await connector.connect();
    console.log('Connected\n');

    // Subscribe to orderbook
    console.log('Subscribing to SOL...');
    await connector.subscribeOrderbook('SOL');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const bidAsk = connector.getBidAsk('SOL');
    console.log(`Bid: ${bidAsk.bid}, Ask: ${bidAsk.ask}\n`);

    // Place one buy order (0.06 SOL ~= $11.40 > $10 minimum)
    console.log('Placing buy order (0.06 SOL)...');
    const result = await connector.createMarketOrder('SOL', 'buy', 0.06);

    console.log('\n=== ORDER RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n');

    connector.intentionalDisconnect = true;
    connector.disconnect();

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error);

    connector.intentionalDisconnect = true;
    connector.disconnect();
    process.exit(1);
  }
}

simpleTest();
