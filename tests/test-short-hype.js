import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-short-hype.js');
import HyperliquidConnector from '../hyperliquid.js';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function testShort() {
  console.log('Testing SHORT HYPE position...\n');

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  console.log(`Connected - Wallet: ${hyperliquid.wallet}\n`);

  // Get current price
  const allMids = await hyperliquid.getAllMids();
  const price = parseFloat(allMids['HYPE']);
  console.log(`Current HYPE price: $${price}\n`);

  // Calculate size for ~$15 order
  const targetUSD = 15;
  const size = targetUSD / price;

  // Get asset info for rounding
  const assetId = await hyperliquid.getAssetId('HYPE', false);
  const assetInfo = hyperliquid.getAssetInfo('HYPE', assetId);
  const sizeRounded = parseFloat(hyperliquid.roundSize(size, assetInfo.szDecimals));

  console.log(`Attempting to SHORT ${sizeRounded} HYPE (~$${(sizeRounded * price).toFixed(2)})\n`);

  try {
    const result = await hyperliquid.createMarketOrder('HYPE', 'sell', sizeRounded, {
      isSpot: false,
      slippage: config.trading.maxSlippagePercent,
      overrideMidPrice: price
    });

    console.log('Order response:', JSON.stringify(result.response, null, 2));

    const filled = result.response?.data?.statuses?.[0]?.filled;
    const error = result.response?.data?.statuses?.[0]?.error;

    if (filled) {
      console.log('\n✅ SHORT position opened successfully!');
      console.log(`   Filled: ${filled.totalSz} @ $${filled.avgPx}`);

      // Wait a moment
      console.log('\nWaiting 2 seconds before closing...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Close it
      console.log('Closing SHORT position...');
      const closeResult = await hyperliquid.createMarketOrder('HYPE', 'buy', sizeRounded, {
        isSpot: false,
        reduceOnly: true,
        slippage: config.trading.maxSlippagePercent
      });

      const closeFilled = closeResult.response?.data?.statuses?.[0]?.filled;
      if (closeFilled) {
        console.log('✅ SHORT position closed');
      }
    } else {
      console.log('\n❌ SHORT position failed:', error);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  }

  hyperliquid.disconnect();
}

testShort().catch(console.error);
