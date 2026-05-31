import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-perp-short.js');
import HyperliquidConnector from '../hyperliquid.js';
import fs from 'fs';

/**
 * Test script to open and close a PERP short position
 * Tests: HYPE, SOL, BTC
 */

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function testPerpShort(hyperliquid, symbol, sizeUSD = 15) {
  console.log('='.repeat(80));
  console.log(`Testing PERP SHORT for ${symbol} ($${sizeUSD})`);
  console.log('='.repeat(80));

  try {
    // Get current mid price
    const allMids = await hyperliquid.getAllMids();
    const midPrice = parseFloat(allMids[symbol]);

    if (!midPrice) {
      console.error(`❌ No price data for ${symbol}`);
      return false;
    }

    console.log(`Current ${symbol} price: $${midPrice.toFixed(2)}`);

    // Calculate size
    const size = sizeUSD / midPrice;

    // Get asset info for rounding
    const assetId = await hyperliquid.getAssetId(symbol, false);
    const assetInfo = hyperliquid.getAssetInfo(symbol, assetId);
    const sizeRounded = parseFloat(hyperliquid.roundSize(size, assetInfo.szDecimals));
    const notional = sizeRounded * midPrice;

    console.log(`Size: ${sizeRounded} ${symbol} (notional: $${notional.toFixed(2)})`);
    console.log();

    // Step 1: Open SHORT position (sell)
    console.log('[1/2] Opening SHORT position (selling)...');
    const sellResult = await hyperliquid.createMarketOrder(symbol, 'sell', sizeRounded, {
      isSpot: false,
      slippage: config.trading.maxSlippagePercent,
      overrideMidPrice: midPrice
    });

    const sellFilled = sellResult.response?.data?.statuses?.[0]?.filled;
    if (!sellFilled) {
      const error = sellResult.response?.data?.statuses?.[0]?.error;
      console.error(`❌ Failed to open SHORT: ${error || 'Unknown error'}`);
      console.error('Response:', JSON.stringify(sellResult.response?.data, null, 2));
      return false;
    }

    const fillPx = parseFloat(sellFilled.avgPx);
    const fillSz = parseFloat(sellFilled.totalSz);
    console.log(`✅ SHORT opened: ${fillSz} @ $${fillPx.toFixed(2)}`);
    console.log();

    // Wait a moment
    console.log('Waiting 2 seconds before closing...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 2: Close SHORT position (buy with reduceOnly)
    console.log('[2/2] Closing SHORT position (buying with reduceOnly)...');
    const buyResult = await hyperliquid.createMarketOrder(symbol, 'buy', sizeRounded, {
      isSpot: false,
      reduceOnly: true,
      slippage: config.trading.maxSlippagePercent
    });

    const buyFilled = buyResult.response?.data?.statuses?.[0]?.filled;
    if (!buyFilled) {
      const error = buyResult.response?.data?.statuses?.[0]?.error;
      console.error(`❌ Failed to close SHORT: ${error || 'Unknown error'}`);
      console.error('⚠️  MANUAL ACTION REQUIRED: Close SHORT position for', symbol);
      return false;
    }

    const closePx = parseFloat(buyFilled.avgPx);
    const closeSz = parseFloat(buyFilled.totalSz);
    const pnl = (fillPx - closePx) * closeSz;

    console.log(`✅ SHORT closed: ${closeSz} @ $${closePx.toFixed(2)}`);
    console.log(`PnL: $${pnl.toFixed(4)} ${pnl >= 0 ? '📈' : '📉'}`);
    console.log();

    return true;

  } catch (error) {
    console.error(`❌ Error testing ${symbol}:`, error.message);
    return false;
  }
}

async function main() {
  console.log('Delta-Neutral Bot - PERP SHORT Test');
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  console.log('✅ Connected to Hyperliquid');
  console.log(`   Wallet: ${hyperliquid.wallet}`);
  console.log();

  // Test symbols (start with small positions)
  const tests = [
    { symbol: 'HYPE', sizeUSD: 12 },
    { symbol: 'SOL', sizeUSD: 12 },
    { symbol: 'BTC', sizeUSD: 15 }
  ];

  const results = [];

  for (const test of tests) {
    const success = await testPerpShort(hyperliquid, test.symbol, test.sizeUSD);
    results.push({ symbol: test.symbol, success });

    // Wait between tests
    if (test !== tests[tests.length - 1]) {
      console.log('Waiting 3 seconds before next test...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // Summary
  console.log('='.repeat(80));
  console.log('Test Summary:');
  console.log('='.repeat(80));
  for (const result of results) {
    console.log(`  ${result.symbol}: ${result.success ? '✅ PASS' : '❌ FAIL'}`);
  }
  console.log();

  hyperliquid.disconnect();
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
