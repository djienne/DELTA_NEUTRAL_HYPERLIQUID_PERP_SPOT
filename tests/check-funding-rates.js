import fs from 'fs';
import HyperliquidConnector from '../hyperliquid.js';
import { getFundingRates, sortByAnnualizedRate } from '../utils/funding.js';

// Read-only: the funding rate accruing this hour (= Hyperliquid's predicted next payment) per configured pair.
// Trading decisions use the 7-day average instead: see tests/check-funding-history.js.
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const rates = await getFundingRates(new HyperliquidConnector({ testnet: false }), config.trading.pairs);

console.log(`${'Symbol'.padEnd(10)}${'Hourly %'.padStart(12)}${'APY %'.padStart(10)}`);
for (const r of sortByAnnualizedRate(rates)) {
  console.log(`${r.symbol.padEnd(10)}${(r.fundingRate * 100).toFixed(6).padStart(12)}${(r.annualizedRate * 100).toFixed(2).padStart(10)}`);
}
for (const r of rates.filter(r => r.error)) console.log(`${r.symbol}: ${r.error}`);
process.exit(0);
