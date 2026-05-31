import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/emergency-close-fartcoin-imbalance.js');
#!/usr/bin/env node
import dotenv from 'dotenv';
import HyperliquidConnector from '../connectors/hyperliquid.js';

dotenv.config();

async function main() {
  console.log('\n🚨 EMERGENCY: Closing FARTCOIN imbalance');
  console.log('Target: BUY 52.1 FARTCOIN on Hyperliquid to balance NET position\n');

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  await hyperliquid.subscribeOrderbook('FARTCOIN');

  // Wait for orderbook
  await new Promise(r => setTimeout(r, 2000));

  const bidAsk = hyperliquid.getBidAsk('FARTCOIN');
  if (!bidAsk) {
    console.error('❌ No market data available');
    process.exit(1);
  }

  console.log(`Market: bid=${bidAsk.bid.toFixed(4)}, ask=${bidAsk.ask.toFixed(4)}`);

  // Buy 52.1 on Hyperliquid (market order) to close the short imbalance
  console.log('\nExecuting BUY 52.1 FARTCOIN...');
  try {
    const result = await hyperliquid.createMarketOrder('FARTCOIN', 'buy', 52.1);
    console.log('\n✅ ORDER RESULT:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Failed:', error.message);
    console.error(error);
  }

  await hyperliquid.disconnect();
  console.log('\n✅ Emergency close complete');
}

main().catch(console.error);
