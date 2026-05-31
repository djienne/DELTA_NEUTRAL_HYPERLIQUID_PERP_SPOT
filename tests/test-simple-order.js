import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-simple-order.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';
dotenv.config();

const SYMBOL = 'UBTC';
const ORDER_SIZE_USD = 500; // Try much larger order

async function testSimpleOrder() {
  const hyperliquid = new HyperliquidConnector({ testnet: false });

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
    console.log(`Bid: ${bidAsk.bid}, Ask: ${bidAsk.ask}`);

    // For testing, try a fixed quantity first
    const roundedQty = 0.01; // Try 0.01 UBTC
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;
    const usdValue = roundedQty * midPrice;

    console.log(`\nBuying ${roundedQty} ${SYMBOL} (~$${usdValue.toFixed(2)})`);

    const result = await hyperliquid.createMarketOrder(SYMBOL, 'buy', roundedQty, {
      isSpot: true,
      slippage: 0.02  // 2% slippage
    });

    console.log('\nResult:', JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }

  process.exit(0);
}

testSimpleOrder();
