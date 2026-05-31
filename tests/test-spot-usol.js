import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-spot-usol.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';
dotenv.config();

const SYMBOL = 'USOL';
const ORDER_SIZE_USD = 15; // $15 per user request

async function testUSOLSpot() {
  console.log('='.repeat(80));
  console.log(`Hyperliquid Spot Market Order Test - ${SYMBOL}`);
  console.log('='.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });

  try {
    console.log(`[STEP 1] Checking ${SYMBOL} availability...`);
    await hyperliquid.getMeta();
    await hyperliquid.getSpotMeta();
    const assetId = await hyperliquid.getAssetId(SYMBOL, true);
    const assetInfo = hyperliquid.getAssetInfo(SYMBOL, assetId);
    console.log(`✅ ${SYMBOL} available (assetId: ${assetId}, szDecimals: ${assetInfo.szDecimals})\n`);

    console.log('[STEP 2] Connecting...');
    await hyperliquid.connect();
    console.log('✅ Connected\n');

    console.log('[STEP 3] Subscribing to orderbook...');
    const orderbookCoin = hyperliquid.getCoinForOrderbook(SYMBOL, assetId);
    console.log(`   Using orderbook coin: ${orderbookCoin}`);
    await hyperliquid.subscribeOrderbook(orderbookCoin);
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('✅ Orderbook ready\n');

    console.log(`[STEP 4] Buying ${SYMBOL}...`);
    const bidAsk = hyperliquid.getBidAsk(orderbookCoin);
    if (!bidAsk || !bidAsk.bid || !bidAsk.ask) throw new Error(`No orderbook data for ${SYMBOL}`);
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
    const quantity = ORDER_SIZE_USD / midPrice;
    console.log(`  Mid price: $${midPrice.toFixed(2)}, Quantity: ${quantity.toFixed(assetInfo.szDecimals)} (~$${ORDER_SIZE_USD})`);

    const buyResult = await hyperliquid.createMarketOrder(SYMBOL, 'buy', quantity, { isSpot: true, slippage: 0.02 });
    console.log(`  Result: ${buyResult.status}`);

    // Check if order actually filled
    if (buyResult.response?.data?.statuses?.[0]?.filled) {
      const filled = buyResult.response.data.statuses[0].filled;
      console.log(`✅ Bought ${filled.totalSz} ${SYMBOL} at avg price $${filled.avgPx} (oid: ${filled.oid})\n`);
    } else if (buyResult.response?.data?.statuses?.[0]?.error) {
      throw new Error(`Buy ERROR: ${buyResult.response.data.statuses[0].error}`);
    } else {
      throw new Error(`Buy failed: ${JSON.stringify(buyResult)}`);
    }

    console.log('Waiting 10 seconds before selling...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log(`[STEP 5] Selling ${SYMBOL}...`);
    const bidAskSell = hyperliquid.getBidAsk(orderbookCoin);
    const midPriceSell = (bidAskSell.bid + bidAskSell.ask) / 2;
    console.log(`  Mid price: $${midPriceSell.toFixed(2)}, Quantity: ${quantity.toFixed(assetInfo.szDecimals)}`);

    const sellResult = await hyperliquid.createMarketOrder(SYMBOL, 'sell', quantity, { isSpot: true, slippage: 0.02 });
    console.log(`  Result: ${sellResult.status}`);

    // Check if order actually filled
    if (sellResult.response?.data?.statuses?.[0]?.filled) {
      const filled = sellResult.response.data.statuses[0].filled;
      console.log(`✅ Sold ${filled.totalSz} ${SYMBOL} at avg price $${filled.avgPx} (oid: ${filled.oid})\n`);
    } else if (sellResult.response?.data?.statuses?.[0]?.error) {
      throw new Error(`Sell ERROR: ${sellResult.response.data.statuses[0].error}`);
    } else {
      throw new Error(`Sell failed: ${JSON.stringify(sellResult)}`);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
    const finalState = await hyperliquid.getSpotBalance();
    const finalBalance = finalState.balances?.find(b => b.coin === SYMBOL);
    const balance = finalBalance ? parseFloat(finalBalance.total || finalBalance.hold || 0) : 0;
    console.log(`[STEP 6] Final ${SYMBOL} balance: ${balance.toFixed(assetInfo.szDecimals)}`);
    console.log(balance < 0.0001 ? '✅ Position closed\n' : `⚠️  Dust remaining: ${balance}\n`);

    console.log('='.repeat(80));
    console.log('✅ Test completed successfully');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }
  process.exit(0);
}

HyperliquidConnector.prototype.getSpotBalance = async function(user = null) {
  const response = await fetch(this.restUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotClearinghouseState', user: user || this.wallet })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
};

testUSOLSpot();
