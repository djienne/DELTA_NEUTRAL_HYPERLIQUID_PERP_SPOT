import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-spot-market-orders.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Test spot market orders on Hyperliquid
 * This script will:
 * 1. Check which symbols are available on spot
 * 2. Buy a small amount of each available symbol
 * 3. Sell all positions to close (back to 0)
 */

const SYMBOLS = ['BTC', 'ETH', 'PUMP', 'XPL', 'ENA', 'CRV'];
const ORDER_SIZE_USD = 10; // $10 per order

async function testSpotMarketOrders() {
  console.log('='.repeat(80));
  console.log('Hyperliquid Spot Market Order Test');
  console.log('='.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({
    testnet: false
  });

  try {
    // Step 1: Check which symbols are available on spot
    console.log('[STEP 1] Checking available spot symbols...');
    console.log('-'.repeat(80));

    await hyperliquid.getMeta(); // Load perp meta
    await hyperliquid.getSpotMeta(); // Load spot meta

    const availableSymbols = [];
    const unavailableSymbols = [];

    for (const symbol of SYMBOLS) {
      try {
        const assetId = await hyperliquid.getAssetId(symbol, true);
        const assetInfo = hyperliquid.getAssetInfo(symbol, assetId);
        availableSymbols.push({
          symbol,
          assetId,
          szDecimals: assetInfo.szDecimals
        });
        console.log(`✅ ${symbol}: Available (assetId: ${assetId}, szDecimals: ${assetInfo.szDecimals})`);
      } catch (error) {
        unavailableSymbols.push(symbol);
        console.log(`❌ ${symbol}: Not available on spot`);
      }
    }

    console.log();
    console.log(`Available: ${availableSymbols.length}/${SYMBOLS.length} symbols`);
    console.log();

    if (availableSymbols.length === 0) {
      console.log('❌ No symbols available for trading on spot. Exiting.');
      process.exit(0);
    }

    // Step 2: Connect to WebSocket
    console.log('[STEP 2] Connecting to Hyperliquid...');
    console.log('-'.repeat(80));
    await hyperliquid.connect();
    console.log('✅ Connected');
    console.log();

    // Subscribe to orderbooks for all available symbols
    console.log('[STEP 3] Subscribing to orderbooks...');
    console.log('-'.repeat(80));
    for (const { symbol } of availableSymbols) {
      await hyperliquid.subscribeOrderbook(symbol);
      console.log(`📊 Subscribed to ${symbol} orderbook`);
    }

    // Wait for orderbook data
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('✅ Orderbooks ready');
    console.log();

    // Step 3: Buy each available symbol
    console.log('[STEP 4] Buying spot positions...');
    console.log('-'.repeat(80));

    const positions = [];

    for (const { symbol } of availableSymbols) {
      try {
        console.log(`\n[BUY] ${symbol}`);

        // Get current mid price
        const bidAsk = hyperliquid.getBidAsk(symbol);
        if (!bidAsk || !bidAsk.bid || !bidAsk.ask) {
          console.log(`⚠️  No orderbook data for ${symbol}, skipping...`);
          continue;
        }

        const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
        const quantity = ORDER_SIZE_USD / midPrice;

        console.log(`  Mid price: $${midPrice.toFixed(4)}`);
        console.log(`  Quantity: ${quantity.toFixed(6)}`);

        // Place buy order
        const result = await hyperliquid.createMarketOrder(symbol, 'buy', quantity, {
          isSpot: true,
          slippage: 0.02 // 2% slippage
        });

        console.log(`  Result: ${JSON.stringify(result)}`);

        if (result.status === 'ok') {
          positions.push({
            symbol,
            quantity,
            midPrice
          });
          console.log(`✅ Bought ${quantity.toFixed(6)} ${symbol} at ~$${midPrice.toFixed(4)}`);
        } else {
          console.log(`❌ Failed to buy ${symbol}: ${JSON.stringify(result)}`);
        }

        // Wait a bit between orders
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ Error buying ${symbol}:`, error.message);
      }
    }

    console.log();
    console.log(`Positions opened: ${positions.length}/${availableSymbols.length}`);
    console.log();

    // Step 4: Wait and get actual positions
    console.log('[STEP 5] Checking actual positions...');
    console.log('-'.repeat(80));
    await new Promise(resolve => setTimeout(resolve, 3000));

    const spotState = await hyperliquid.getSpotBalance();
    console.log('Spot balances:');
    console.log(JSON.stringify(spotState, null, 2));
    console.log();

    // Step 5: Sell all positions
    console.log('[STEP 6] Closing all spot positions...');
    console.log('-'.repeat(80));

    for (const { symbol, quantity } of positions) {
      try {
        console.log(`\n[SELL] ${symbol}`);

        // Get current mid price
        const bidAsk = hyperliquid.getBidAsk(symbol);
        if (!bidAsk || !bidAsk.bid || !bidAsk.ask) {
          console.log(`⚠️  No orderbook data for ${symbol}, skipping...`);
          continue;
        }

        const midPrice = (bidAsk.bid + bidAsk.ask) / 2;

        console.log(`  Mid price: $${midPrice.toFixed(4)}`);
        console.log(`  Quantity to sell: ${quantity.toFixed(6)}`);

        // Place sell order
        const result = await hyperliquid.createMarketOrder(symbol, 'sell', quantity, {
          isSpot: true,
          slippage: 0.02 // 2% slippage
        });

        console.log(`  Result: ${JSON.stringify(result)}`);

        if (result.status === 'ok') {
          console.log(`✅ Sold ${quantity.toFixed(6)} ${symbol} at ~$${midPrice.toFixed(4)}`);
        } else {
          console.log(`❌ Failed to sell ${symbol}: ${JSON.stringify(result)}`);
        }

        // Wait a bit between orders
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ Error selling ${symbol}:`, error.message);
      }
    }

    console.log();

    // Step 6: Final check
    console.log('[STEP 7] Final position check...');
    console.log('-'.repeat(80));
    await new Promise(resolve => setTimeout(resolve, 3000));

    const finalSpotState = await hyperliquid.getSpotBalance();
    console.log('Final spot balances:');
    console.log(JSON.stringify(finalSpotState, null, 2));
    console.log();

    // Check for remaining positions (excluding dust)
    const remainingPositions = finalSpotState.balances?.filter(b => {
      const balance = parseFloat(b.total || b.hold || 0);
      return balance > 0.0001 && b.coin !== 'USDC'; // Ignore tiny dust and USDC
    }) || [];

    if (remainingPositions.length === 0) {
      console.log('✅ All positions closed successfully (no significant balances remaining)');
    } else {
      console.log('⚠️  Some positions remain (may be dust):');
      remainingPositions.forEach(pos => {
        console.log(`  ${pos.coin}: ${pos.total || pos.hold}`);
      });
    }

    console.log();
    console.log('='.repeat(80));
    console.log('Test completed successfully');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    console.error(error.stack);
  } finally {
    // Cleanup
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }

  process.exit(0);
}

// Add helper method to get spot balance
HyperliquidConnector.prototype.getSpotBalance = async function(user = null) {
  const userAddress = user || this.wallet;

  try {
    const response = await fetch(this.restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'spotClearinghouseState',
        user: userAddress
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Hyperliquid] Error fetching spot balance:', error.message);
    throw error;
  }
};

// Run the test
testSpotMarketOrders().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
