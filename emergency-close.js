import HyperliquidConnector from './hyperliquid.js';
import { getPerpPositions, getSpotBalances, MIN_NOTIONAL_USD } from './utils/positions.js';
import { assertCompleteFill } from './utils/order-fill.js';
import fs from 'fs';

/**
 * EMERGENCY CLOSE - Closes ALL PERP and SPOT positions immediately
 *
 * This script:
 * - Fetches all open positions
 * - Ignores dust below the $10 minimum order notional (see utils/positions.js)
 * - Closes remaining positions in parallel for maximum speed
 * - Uses reduceOnly flag for PERP to prevent opening new positions
 * - Continues even if some closes fail
 *
 * Usage: node emergency-close.js
 */

if (process.env.PAPER_TRADING === '1') {
  // This script always trades the LIVE account from hyperliquid.env; paper positions live in the simulated ledger.
  console.error('emergency-close.js closes the LIVE account and is not available in paper mode.');
  console.error('To reset the paper run instead: stop the paper bot and delete ./data-paper/');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
HyperliquidConnector.configureSymbolMapping(config.symbolMapping || {});

async function closePosition(hyperliquid, position, type, priceMap) {
  const symbol = position.symbol;
  const size = Math.abs(type === 'PERP' ? position.sizeRaw : position.total);

  // Determine close side
  let closeSide;
  if (type === 'PERP') {
    closeSide = position.side === 'SHORT' ? 'buy' : 'sell';
  } else {
    closeSide = 'sell'; // SPOT is always LONG, so sell to close
  }

  const isSpot = type === 'SPOT';

  try {
    console.log(`[${type}] Closing ${symbol}: ${closeSide.toUpperCase()} ${size.toFixed(6)}...`);

    // Get price for this symbol
    let price;
    if (isSpot) {
      const assetId = await hyperliquid.getAssetId(symbol, true);
      const spotCoin = hyperliquid.getCoinForOrderbook(symbol, assetId);
      price = priceMap[spotCoin];
    } else {
      price = priceMap[symbol];
    }

    if (!price) {
      throw new Error(`No price data available for ${symbol}`);
    }

    // Get asset info for proper rounding
    const assetId = await hyperliquid.getAssetId(symbol, isSpot);
    const assetInfo = hyperliquid.getAssetInfo(symbol, assetId);
    const sizeRounded = parseFloat(hyperliquid.roundSize(size, assetInfo.szDecimals, 'down'));
    const roundedNotional = sizeRounded * price;
    if (roundedNotional < MIN_NOTIONAL_USD) {
      throw new Error(`Rounded order notional ($${roundedNotional.toFixed(2)}) is below minimum ($${MIN_NOTIONAL_USD})`);
    }

    const result = await hyperliquid.createMarketOrder(symbol, closeSide, sizeRounded, {
      isSpot: isSpot,
      reduceOnly: isSpot ? false : true, // reduceOnly only works for PERP
      slippage: config.trading.maxSlippagePercent,
      overrideMidPrice: price,
      sizeRoundingMode: 'down'
    });

    const outcome = assertCompleteFill(result, sizeRounded, {
      minFillRatio: config.risk?.minFillRatio || 0.999,
      fallbackPrice: price,
      context: { emergencyClose: true, symbol, type }
    });
    const error = result.response?.data?.statuses?.[0]?.error;

    if (outcome.isCompleteFill) {
      const fillPx = outcome.fillPrice;
      const fillSz = outcome.fillSize;
      console.log(`[${type}] ✅ ${symbol} closed: ${fillSz} @ $${fillPx.toFixed(2)}`);
      return { success: true, symbol, type, size: fillSz, price: fillPx };
    } else {
      console.error(`[${type}] ❌ ${symbol} failed: ${error || 'Unknown error'}`);
      return { success: false, symbol, type, error: error || 'Unknown error' };
    }
  } catch (err) {
    console.error(`[${type}] ❌ ${symbol} error: ${err.message}`);
    return { success: false, symbol, type, error: err.message };
  }
}

async function main() {
  console.log('═'.repeat(80));
  console.log('⚠️  EMERGENCY CLOSE - Closing ALL Positions');
  console.log('═'.repeat(80));
  console.log();

  const hyperliquid = new HyperliquidConnector({ testnet: false });
  await hyperliquid.connect();
  console.log(`Connected - Wallet: ${hyperliquid.wallet}`);
  console.log();

  // Fetch all positions in parallel
  console.log('Fetching positions...');
  const [perpPositions, spotBalances] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false }),
    getSpotBalances(hyperliquid, null, { verbose: false })
  ]);

  const totalPositions = perpPositions.length + spotBalances.length;

  if (totalPositions === 0) {
    console.log('✅ No open positions to close.');
    hyperliquid.disconnect();
    process.exit(0);
  }

  console.log(`Found ${perpPositions.length} PERP position(s) and ${spotBalances.length} SPOT balance(s)`);
  console.log();

  // Fetch current prices
  console.log('Fetching current prices...');
  const allMids = await hyperliquid.getAllMids();
  const priceMap = {};
  for (const [symbol, priceStr] of Object.entries(allMids)) {
    priceMap[symbol] = parseFloat(priceStr);
  }
  console.log(`✅ Fetched prices for ${Object.keys(priceMap).length} symbols`);
  console.log();

  // positions.js already drops exposure below MIN_NOTIONAL_USD (untradeable dust)
  const perpToClose = perpPositions;
  const spotToClose = spotBalances;

  console.log('PERP Positions to close:');
  for (const pos of perpToClose) {
    console.log(`  ${pos.symbol}: ${pos.side} ${pos.size} (~$${pos.positionValue.toFixed(2)})`);
  }
  console.log('SPOT Balances to close:');
  for (const bal of spotToClose) {
    console.log(`  ${bal.symbol}: ${bal.total} (~$${bal.valueUSD?.toFixed(2) ?? '?'})`);
  }
  console.log();

  const totalToClose = totalPositions;
  console.log(`Closing ${totalToClose} position(s) in parallel...`);
  console.log();

  // Close all positions in parallel for maximum speed
  const closePromises = [];

  // Add PERP closes
  for (const position of perpToClose) {
    closePromises.push(closePosition(hyperliquid, position, 'PERP', priceMap));
  }

  // Add SPOT closes
  for (const balance of spotToClose) {
    closePromises.push(closePosition(hyperliquid, balance, 'SPOT', priceMap));
  }

  // Execute all closes in parallel
  const results = await Promise.all(closePromises);

  // Summary
  console.log();
  console.log('═'.repeat(80));
  console.log('Summary:');
  console.log('═'.repeat(80));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Total positions found: ${totalPositions}`);
  console.log(`✅ Successfully closed: ${successful.length}`);
  console.log(`❌ Failed to close: ${failed.length}`);

  if (successful.length > 0) {
    console.log();
    console.log('Closed positions:');
    for (const result of successful) {
      console.log(`  ✅ ${result.type} ${result.symbol}: ${result.size} @ $${result.price.toFixed(2)}`);
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log('Failed to close:');
    for (const result of failed) {
      console.log(`  ❌ ${result.type} ${result.symbol}: ${result.error}`);
    }
    console.log();
    console.log('⚠️  Some positions could not be closed. Please check manually.');
  }

  console.log();
  console.log('═'.repeat(80));

  console.log();
  console.log('Verifying remaining on-chain exposure...');
  const [remainingPerps, remainingSpots] = await Promise.all([
    getPerpPositions(hyperliquid, null, { verbose: false }),
    getSpotBalances(hyperliquid, null, { verbose: false })
  ]);

  const residuals = [
    ...remainingPerps.map(pos => ({ type: 'PERP', symbol: pos.symbol, size: pos.size, notional: pos.positionValue })),
    ...remainingSpots.map(bal => ({ type: 'SPOT', symbol: bal.symbol, size: bal.total, notional: bal.valueUSD }))
  ];

  if (residuals.length > 0) {
    console.log(`❌ Residual exposure remains: ${residuals.length} position(s)`);
    for (const residual of residuals) {
      const notionalText = residual.notional == null ? 'unknown notional' : `$${residual.notional.toFixed(2)}`;
      console.log(`  ${residual.type} ${residual.symbol}: ${residual.size} (${notionalText})`);
    }
  } else {
    console.log('✅ No remaining exposure above minimum notional.');
  }

  hyperliquid.disconnect();
  process.exit(failed.length > 0 || residuals.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
