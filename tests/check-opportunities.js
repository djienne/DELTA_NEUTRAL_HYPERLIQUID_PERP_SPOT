// Read-only: the bot's own entry filters and 7d-funding ranking (findBestOpportunities) on live public data.
// No wallet is passed, so hyperliquid.env is never read.   node tests/check-opportunities.js
import fs from 'fs';
import HyperliquidConnector from '../hyperliquid.js';
import { findBestOpportunities } from '../utils/opportunity.js';

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const hyperliquid = new HyperliquidConnector({ wallet: null });
const analysis = await findBestOpportunities(hyperliquid, config.trading.pairs, config);
console.log(analysis.report);
console.log('Rejected:', JSON.stringify(analysis.filterResult.rejected, null, 2));
