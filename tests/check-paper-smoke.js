// Public-data integration check. Paper account and all state live in a disposable directory; no credentials loaded.
// Run in the review image: node tests/check-paper-smoke.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaperConnector } from '../utils/paper-exchange.js';
import { findBestOpportunities } from '../utils/opportunity.js';
import { openDeltaNeutralPosition, closeDeltaNeutralPosition } from '../utils/trade.js';
import { recordPosition } from '../utils/state.js';
import { verifyPositionOnChain } from '../bot.js';

const config = JSON.parse(fs.readFileSync('config.json','utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-paper-smoke-'));
let requests = 0;
const publicFetch = async (url, init) => {
  assert.equal(url, 'https://api.hyperliquid.xyz/info', 'Only public info requests are allowed');
  assert.equal(JSON.parse(init.body).user, undefined, 'No real account queries');
  requests++;
  return fetch(url, init);
};
const paper = new PaperConnector(config, { dir, fetch: publicFetch });
try {
  await paper.loadMeta();
  const analysis = await findBestOpportunities(paper, config.trading.pairs, config, { verbose:false });
  assert.ok(analysis.best, 'No eligible entry on current market data; inspect filters before retrying');
  const startEquity = config.paper.startPerpUSDC + config.paper.startSpotUSDC;
  const open = await openDeltaNeutralPosition(paper, analysis.best,
    { perpBalance:config.paper.startPerpUSDC, spotBalance:config.paper.startSpotUSDC }, config);
  assert.equal(open.success, true);
  const state = recordPosition({position:null,pendingIntent:null,history:[]},open);
  assert.equal((await verifyPositionOnChain(paper,state)).status,'delta_neutral');
  // Reload the persisted exchange account before closing through the production trade path.
  const reloaded = new PaperConnector(config,{dir,fetch:publicFetch});
  const closed = await closeDeltaNeutralPosition(reloaded,state.position,config);
  assert.equal(closed.success,true);
  assert.equal((await verifyPositionOnChain(reloaded,{...state,position:null})).status,'none');
  const equity = reloaded.equity(await reloaded.getAllMids());
  const events = fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const fills=events.filter(e=>e.type==='fill');
  const funding=events.filter(e=>e.type==='funding').reduce((s,e)=>s+e.usdc,0);
  const cashPnl=fills.reduce((s,e)=>s+(e.realizedPnl??0)+(e.cashFlow??0)-(e.market==='perp'?e.feeUSD:0),0)+
    Object.values(equity.tokens).reduce((s,t)=>s+t.amount*t.mid,0)+funding;
  const residual=equity.equity-startEquity-cashPnl;
  assert.ok(Math.abs(residual)<1e-7,`Cash conservation residual ${residual}`);
  assert.equal(closed.accountingComplete,true);
  const dustMarkPnl = Object.values(equity.tokens).reduce((s,t)=>s+t.amount*(t.mid-state.position.spotEntryPrice),0);
  assert.ok(Math.abs(cashPnl-closed.totalPnl-dustMarkPnl)<0.005,'Bot realized PnL must reconcile with paper cash flows and residual inventory');
  assert.equal(fills.length,4);
  console.log(JSON.stringify({symbol:open.symbol,publicRequests:requests,fills:fills.length,fundingRows:events.filter(e=>e.type==='funding').length,
    startEquity,endEquity:equity.equity,cashPnl,reportedRealizedPnl:closed.totalPnl,accountingResidual:residual,
    residualInventory:closed.residualInventory,remainingPerps:Object.keys(reloaded.ledger.positions),accountingComplete:closed.accountingComplete},null,2));
} finally {
  paper.disconnect();
  fs.rmSync(dir,{recursive:true,force:true});
}
