import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/emergency-close-hyperliquid.js');
import dotenv from 'dotenv';
import { loadConfig } from '../utils/config.js';
import HyperliquidConnector from '../connectors/hyperliquid.js';

dotenv.config();

async function emergencyCloseHyperliquid() {
  console.log('='.repeat(80));
  console.log('Emergency Close All Hyperliquid Positions');
  console.log('='.repeat(80));

  const config = loadConfig();
  const hyperliquid = new HyperliquidConnector({
    testnet: config.exchanges.hyperliquid.testnet
  });

  await hyperliquid.connect();
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    console.log('\n[HYPERLIQUID] Getting balance and positions...\n');
    const balance = await hyperliquid.getBalance(hyperliquid.wallet.address);

    console.log(`Total notional: $${balance.totalNtlPos}`);

    if (!balance || !balance.assetPositions || balance.assetPositions.length === 0) {
      console.log('No Hyperliquid positions found');
      hyperliquid.intentionalDisconnect = true;
      hyperliquid.disconnect();
      process.exit(0);
    }

    console.log('\nFound positions:');
    for (const asset of balance.assetPositions) {
      const szi = parseFloat(asset.position.szi);
      const coin = asset.position.coin;

      if (Math.abs(szi) > 0.001) {
        console.log(`  ${coin}: ${szi > 0 ? 'LONG' : 'SHORT'} ${Math.abs(szi)}`);
      }
    }

    console.log('\n[CLOSING] Positions...\n');

    for (const asset of balance.assetPositions) {
      const szi = parseFloat(asset.position.szi);
      const coin = asset.position.coin;

      if (Math.abs(szi) > 0.001) {
        const side = szi > 0 ? 'sell' : 'buy';
        const size = Math.abs(szi);

        console.log(`[HYPERLIQUID] Closing ${coin}: ${side.toUpperCase()} ${size}`);

        try {
          const result = await hyperliquid.createMarketOrder(coin, side, size, {
            reduceOnly: true
          });

          console.log('✅ Closed:', JSON.stringify(result, null, 2));
        } catch (error) {
          console.error(`❌ Failed to close ${coin}:`, error.message);
        }
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ All Hyperliquid positions closed');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }

  hyperliquid.intentionalDisconnect = true;
  hyperliquid.disconnect();
  process.exit(0);
}

emergencyCloseHyperliquid();
