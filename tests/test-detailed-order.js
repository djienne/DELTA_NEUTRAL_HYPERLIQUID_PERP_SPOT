import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-detailed-order.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';
dotenv.config();

const SYMBOL = 'UBTC';
const ORDER_SIZE_USD = 11;

async function testDetailedOrder() {
  console.log('='.repeat(80));
  console.log('DETAILED ORDER TEST - Checking API Responses');
  console.log('='.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  console.log('Wallet:', hyperliquid.wallet);
  console.log();

  try {
    // Get metadata
    await hyperliquid.getMeta();
    await hyperliquid.getSpotMeta();
    const assetId = await hyperliquid.getAssetId(SYMBOL, true);
    const assetInfo = hyperliquid.getAssetInfo(SYMBOL, assetId);
    console.log(`Asset: ${SYMBOL}, ID: ${assetId}, szDecimals: ${assetInfo.szDecimals}`);
    console.log();

    // Connect and subscribe
    await hyperliquid.connect();
    const orderbookCoin = hyperliquid.getCoinForOrderbook(SYMBOL, assetId);
    console.log(`Orderbook coin: ${orderbookCoin}`);
    await hyperliquid.subscribeOrderbook(orderbookCoin);
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get price
    const bidAsk = hyperliquid.getBidAsk(orderbookCoin);
    console.log(`Bid/Ask: ${bidAsk.bid} / ${bidAsk.ask}`);
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
    const quantity = ORDER_SIZE_USD / midPrice;
    console.log(`Mid: ${midPrice}, Quantity: ${quantity.toFixed(assetInfo.szDecimals)}`);
    console.log();

    // Place buy order with detailed logging
    console.log('Placing BUY order...');
    console.log('-'.repeat(80));

    const buyResult = await hyperliquid.createMarketOrder(SYMBOL, 'buy', quantity, {
      isSpot: true,
      slippage: 0.02
    });

    console.log('BUY RESULT:');
    console.log(JSON.stringify(buyResult, null, 2));
    console.log();

    // Check the response details
    if (buyResult.response && buyResult.response.data) {
      console.log('Order data:');
      console.log(JSON.stringify(buyResult.response.data, null, 2));

      if (buyResult.response.data.statuses) {
        buyResult.response.data.statuses.forEach((status, idx) => {
          console.log(`\nStatus ${idx}:`);
          if (status.filled) {
            console.log(`  ✅ FILLED: ${status.filled.totalSz} at avg price ${status.filled.avgPx}`);
            console.log(`  Order ID: ${status.filled.oid}`);
          }
          if (status.error) {
            console.log(`  ❌ ERROR: ${status.error}`);
          }
          if (status.resting) {
            console.log(`  ⏳ RESTING: ${JSON.stringify(status.resting)}`);
          }
        });
      }
    }

    console.log();
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check balance
    const spotResponse = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: hyperliquid.wallet })
    });
    const spotData = await spotResponse.json();
    const balance = spotData.balances?.find(b => b.coin === SYMBOL);
    console.log(`\n${SYMBOL} balance:`, balance ? balance.total || balance.hold : 'None');

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
  } finally {
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }

  process.exit(0);
}

testDetailedOrder();
