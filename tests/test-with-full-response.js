import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-with-full-response.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';
dotenv.config();

const SYMBOL = 'UXPL';
const ORDER_SIZE_USD = 50;

async function testWithFullResponse() {
  console.log('='.repeat(80));
  console.log('FULL RESPONSE VALIDATION TEST');
  console.log('='.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  console.log('Wallet:', hyperliquid.wallet);
  console.log();

  try {
    await hyperliquid.getMeta();
    await hyperliquid.getSpotMeta();
    const assetId = await hyperliquid.getAssetId(SYMBOL, true);
    const assetInfo = hyperliquid.getAssetInfo(SYMBOL, assetId);

    await hyperliquid.connect();
    const orderbookCoin = hyperliquid.getCoinForOrderbook(SYMBOL, assetId);
    await hyperliquid.subscribeOrderbook(orderbookCoin);
    await new Promise(resolve => setTimeout(resolve, 3000));

    const bidAsk = hyperliquid.getBidAsk(orderbookCoin);
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
    const quantity = ORDER_SIZE_USD / midPrice;

    console.log(`Placing BUY order for ${quantity.toFixed(assetInfo.szDecimals)} ${SYMBOL}`);
    console.log('-'.repeat(80));

    const buyResult = await hyperliquid.createMarketOrder(SYMBOL, 'buy', quantity, {
      isSpot: true,
      slippage: 0.02
    });

    console.log('\n=== FULL BUY RESPONSE ===');
    console.log(JSON.stringify(buyResult, null, 2));

    // Parse and validate response
    let buyFilled = false;
    let buyOid = null;
    let buyFilledQty = 0;
    let buyAvgPx = 0;

    if (buyResult.response && buyResult.response.data && buyResult.response.data.statuses) {
      const status = buyResult.response.data.statuses[0];

      if (status.filled) {
        buyFilled = true;
        buyOid = status.filled.oid;
        buyFilledQty = parseFloat(status.filled.totalSz);
        buyAvgPx = parseFloat(status.filled.avgPx);
        console.log(`\n✅ BUY FILLED:`);
        console.log(`   Order ID: ${buyOid}`);
        console.log(`   Filled: ${buyFilledQty} ${SYMBOL}`);
        console.log(`   Avg Price: $${buyAvgPx}`);
        console.log(`   Total Value: $${(buyFilledQty * buyAvgPx).toFixed(2)}`);
      } else if (status.error) {
        console.log(`\n❌ BUY ERROR: ${status.error}`);
      } else if (status.resting) {
        console.log(`\n⏳ BUY RESTING (not filled):`, JSON.stringify(status.resting));
      } else {
        console.log(`\n⚠️ UNKNOWN STATUS:`, JSON.stringify(status));
      }
    }

    if (!buyFilled) {
      console.log('\n❌ BUY ORDER WAS NOT FILLED - STOPPING TEST');
      process.exit(1);
    }

    console.log('\nWaiting 10 seconds before selling...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Check balance before selling
    const balanceBefore = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: hyperliquid.wallet })
    });
    const balanceData = await balanceBefore.json();
    const balanceItem = balanceData.balances?.find(b => b.coin === SYMBOL);
    console.log(`\n${SYMBOL} balance before sell:`, balanceItem ? (balanceItem.total || balanceItem.hold) : 'None');

    console.log(`\nPlacing SELL order for ${quantity.toFixed(assetInfo.szDecimals)} ${SYMBOL}`);
    console.log('-'.repeat(80));

    const sellResult = await hyperliquid.createMarketOrder(SYMBOL, 'sell', quantity, {
      isSpot: true,
      slippage: 0.02
    });

    console.log('\n=== FULL SELL RESPONSE ===');
    console.log(JSON.stringify(sellResult, null, 2));

    // Parse and validate sell response
    let sellFilled = false;
    let sellOid = null;
    let sellFilledQty = 0;
    let sellAvgPx = 0;

    if (sellResult.response && sellResult.response.data && sellResult.response.data.statuses) {
      const status = sellResult.response.data.statuses[0];

      if (status.filled) {
        sellFilled = true;
        sellOid = status.filled.oid;
        sellFilledQty = parseFloat(status.filled.totalSz);
        sellAvgPx = parseFloat(status.filled.avgPx);
        console.log(`\n✅ SELL FILLED:`);
        console.log(`   Order ID: ${sellOid}`);
        console.log(`   Filled: ${sellFilledQty} ${SYMBOL}`);
        console.log(`   Avg Price: $${sellAvgPx}`);
        console.log(`   Total Value: $${(sellFilledQty * sellAvgPx).toFixed(2)}`);
      } else if (status.error) {
        console.log(`\n❌ SELL ERROR: ${status.error}`);
      } else if (status.resting) {
        console.log(`\n⏳ SELL RESTING (not filled):`, JSON.stringify(status.resting));
      } else {
        console.log(`\n⚠️ UNKNOWN STATUS:`, JSON.stringify(status));
      }
    }

    if (!sellFilled) {
      console.log('\n❌ SELL ORDER WAS NOT FILLED');
    }

    // Final balance check
    await new Promise(resolve => setTimeout(resolve, 5000));
    const balanceAfter = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: hyperliquid.wallet })
    });
    const balanceAfterData = await balanceAfter.json();
    const balanceItemAfter = balanceAfterData.balances?.find(b => b.coin === SYMBOL);
    console.log(`\n${SYMBOL} balance after sell:`, balanceItemAfter ? (balanceItemAfter.total || balanceItemAfter.hold) : 'None');

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY:');
    console.log(`  Buy Order ID: ${buyOid} - ${buyFilled ? '✅ Filled' : '❌ Not filled'}`);
    console.log(`  Sell Order ID: ${sellOid} - ${sellFilled ? '✅ Filled' : '❌ Not filled'}`);
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
  } finally {
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }

  process.exit(0);
}

testWithFullResponse();
