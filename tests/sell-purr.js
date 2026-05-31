import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/sell-purr.js');
import HyperliquidConnector from '../hyperliquid.js';
import dotenv from 'dotenv';
dotenv.config();

async function sellPurr() {
  const hyperliquid = new HyperliquidConnector({ testnet: false });

  try {
    // Get PURR balance
    const balanceResponse = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: hyperliquid.wallet })
    });
    const balanceData = await balanceResponse.json();
    const purrBalance = balanceData.balances?.find(b => b.coin === 'PURR');
    
    if (!purrBalance) {
      console.log('No PURR balance to sell');
      return;
    }

    const quantity = parseFloat(purrBalance.total || purrBalance.hold);
    console.log(`Selling ${quantity} PURR`);

    await hyperliquid.getMeta();
    await hyperliquid.getSpotMeta();
    await hyperliquid.connect();
    
    const assetId = await hyperliquid.getAssetId('PURR', true);
    const orderbookCoin = hyperliquid.getCoinForOrderbook('PURR', assetId);
    await hyperliquid.subscribeOrderbook(orderbookCoin);
    await new Promise(resolve => setTimeout(resolve, 3000));

    const result = await hyperliquid.createMarketOrder('PURR', 'sell', quantity, {
      isSpot: true,
      slippage: 0.02
    });

    console.log('Result:', JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    hyperliquid.intentionalDisconnect = true;
    hyperliquid.disconnect();
  }

  process.exit(0);
}

sellPurr();
