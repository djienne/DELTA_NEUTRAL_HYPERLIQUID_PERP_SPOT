import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-config-mapping.js');
import HyperliquidConnector from '../hyperliquid.js';
import fs from 'fs';

/**
 * Test script to demonstrate config.json usage with symbol mapping
 * Shows how to use perp symbols from config and convert to spot symbols
 */

async function testConfigMapping() {
  console.log('='.repeat(80));
  console.log('Config.json Symbol Mapping Test');
  console.log('='.repeat(80));
  console.log();

  // Load config
  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

  console.log('[STEP 1] Loaded config.json');
  console.log(`  Pairs: ${config.trading.pairs.join(', ')}`);
  console.log();

  // Test symbol mapping
  console.log('[STEP 2] Testing symbol mapping (Perp -> Spot)');
  console.log('─'.repeat(80));
  console.log('Perp Symbol │ Spot Symbol │ Method Used');
  console.log('─'.repeat(80));

  config.trading.pairs.forEach(perpSymbol => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);
    const method = config.symbolMapping.perpToSpot[perpSymbol] ? 'Config map' : 'Static map';
    console.log(`${perpSymbol.padEnd(11)} │ ${spotSymbol.padEnd(11)} │ ${method}`);
  });
  console.log();

  // Test reverse mapping
  console.log('[STEP 3] Testing reverse mapping (Spot -> Perp)');
  console.log('─'.repeat(80));
  console.log('Spot Symbol │ Perp Symbol │ Notes');
  console.log('─'.repeat(80));

  const spotSymbols = config.trading.pairs.map(p => HyperliquidConnector.perpToSpot(p));
  spotSymbols.forEach(spotSymbol => {
    const perpSymbol = HyperliquidConnector.spotToPerp(spotSymbol);
    const same = spotSymbol === perpSymbol ? '(Same on both markets)' : '';
    console.log(`${spotSymbol.padEnd(11)} │ ${perpSymbol.padEnd(11)} │ ${same}`);
  });
  console.log();

  // Test getSymbolForMarket
  console.log('[STEP 4] Testing getSymbolForMarket helper');
  console.log('─'.repeat(80));

  const testSymbol = 'ETH';
  const spotVersion = HyperliquidConnector.getSymbolForMarket(testSymbol, true);
  const perpVersion = HyperliquidConnector.getSymbolForMarket(testSymbol, false);

  console.log(`  Input: '${testSymbol}'`);
  console.log(`  For Spot Market: '${spotVersion}'`);
  console.log(`  For Perp Market: '${perpVersion}'`);
  console.log();

  // Practical example with real metadata
  console.log('[STEP 5] Practical example: Get asset IDs for both markets');
  console.log('─'.repeat(80));

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.getMeta();
  await hyperliquid.getSpotMeta();

  const perpSymbol = 'ETH';
  const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

  console.log(`  Perp Symbol: ${perpSymbol}`);
  const perpAssetId = await hyperliquid.getAssetId(perpSymbol, false);
  console.log(`  Perp Asset ID: ${perpAssetId}`);

  console.log(`  Spot Symbol: ${spotSymbol}`);
  const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
  console.log(`  Spot Asset ID: ${spotAssetId}`);
  console.log();

  // Show order size configuration
  console.log('[STEP 6] Order size configuration from config.json');
  console.log('─'.repeat(80));
  console.log('Perp Symbol │ Spot Symbol │ Order Size USD │ Notes');
  console.log('─'.repeat(80));

  config.trading.pairs.forEach(perpSymbol => {
    const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);
    const orderSize = config.trading.defaultOrderSizeUSD[perpSymbol] || 15;
    const notes = perpSymbol === 'BTC' ? 'BTC can use up to $150' : 'Max $20 for spot';
    console.log(`${perpSymbol.padEnd(11)} │ ${spotSymbol.padEnd(11)} │ $${orderSize.toString().padEnd(13)} │ ${notes}`);
  });
  console.log();

  // Example: How to use in trading code
  console.log('[STEP 7] Example: Trading both markets');
  console.log('─'.repeat(80));
  console.log(`
// Example trading code:
import config from './config.json' assert { type: 'json' };

async function tradePair(perpSymbol) {
  // Get symbols for both markets
  const spotSymbol = HyperliquidConnector.perpToSpot(perpSymbol);

  // Get order size from config
  const orderSizeUSD = config.trading.defaultOrderSizeUSD[perpSymbol];

  // Trade perp market
  const perpAssetId = await hyperliquid.getAssetId(perpSymbol, false);
  await hyperliquid.createMarketOrder(perpSymbol, 'buy', quantity, {
    isSpot: false,
    slippage: config.trading.maxSlippagePercent / 100  // Convert 5.0% to 0.05 decimal
  });

  // Trade spot market
  const spotAssetId = await hyperliquid.getAssetId(spotSymbol, true);
  await hyperliquid.createMarketOrder(spotSymbol, 'buy', quantity, {
    isSpot: true,
    slippage: config.trading.maxSlippagePercent / 100  // Convert 5.0% to 0.05 decimal
  });
}

// Trade all pairs from config
for (const perpSymbol of config.trading.pairs) {
  await tradePair(perpSymbol);
}
  `);

  console.log('='.repeat(80));
  console.log('✅ Symbol mapping test completed');
  console.log('='.repeat(80));

  process.exit(0);
}

testConfigMapping().catch(error => {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
