import fs from 'fs';
import HyperliquidConnector from '../hyperliquid.js';
import { get24HourVolumes } from '../utils/volume.js';

// Read-only: 24h notional volume (USD) per configured pair vs the opportunity filter threshold.
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const threshold = config.thresholds?.minVolumeUSDC ?? 75e6;
const hyperliquid = new HyperliquidConnector({ testnet: false });
const millions = v => (v === null ? 'N/A' : `$${(v / 1e6).toFixed(1)}M`).padStart(10);

console.log(`${'Pair'.padEnd(14)}${'Perp'.padStart(10)}${'Spot'.padStart(10)}${'Total'.padStart(10)}   (min ${millions(threshold).trim()})`);
for (const v of await get24HourVolumes(hyperliquid, config.trading.pairs)) {
  const pass = v.totalVolUSDC !== null && v.totalVolUSDC >= threshold ? '✅' : '❌';
  console.log(`${`${v.perpSymbol}/${v.spotSymbol}`.padEnd(14)}${millions(v.perpVolUSDC)}${millions(v.spotVolUSDC)}${millions(v.totalVolUSDC)}   ${pass}`);
}
process.exit(0);
