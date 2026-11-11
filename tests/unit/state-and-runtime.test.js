import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import HyperliquidConnector from '../../hyperliquid.js';
import { canClosePosition, getHistoryStats, loadState, recordPosition, closePosition, saveState } from '../../utils/state.js';

test('getBidAsk includes mid price', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0' });
  connector.updateOrderbook({ coin: 'BTC', levels: [[{ px: '99', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]], time: 123 });
  assert.equal(connector.getBidAsk('BTC').mid, 100);
});

test('state compacts order responses and history stats use component total PnL', () => {
  const filled = oid => ({ response: { data: { statuses: [{ filled: { oid, avgPx: '100', totalSz: '1' } }] } } });
  const opened = recordPosition({ position: null, history: [] },
    { symbol: 'BTC', perpSymbol: 'BTC', spotSymbol: 'UBTC', perpSize: 1, spotSize: 1, perpResult: filled(1), spotResult: filled(2) });
  assert.equal(opened.position.perpResult, undefined);
  assert.equal(opened.position.orderSummary.perp.oid, 1);
  const closed = closePosition(opened, { reason: 'test', perpPnl: 1, spotPnl: 1, pricePnl: 2, fundingPnl: 3, feesActual: 0.5, totalPnl: 4.5 });
  assert.equal(getHistoryStats(closed).totalPnl, 4.5);
});

// Runs fn(stateFile, dir) with BOT_STATE_FILE at `file` in a fresh temp dir, then restores the env and removes the dir.
function withStateFile(file, fn) {
  const previous = process.env.BOT_STATE_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-state-'));
  process.env.BOT_STATE_FILE = path.join(dir, file);
  try {
    fn(process.env.BOT_STATE_FILE, dir);
  } finally {
    if (previous === undefined) delete process.env.BOT_STATE_FILE; else process.env.BOT_STATE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('state file path can point at a missing directory', () => withStateFile(path.join('nested', 'bot-state.json'), stateFile => {
  saveState({ version: '1.0', position: null, history: [{ totalPnl: 1 }] });
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(loadState().history.length, 1);
}));

test('corrupt state file is quarantined instead of silently reused', () => withStateFile('bot-state.json', (stateFile, dir) => {
  fs.writeFileSync(stateFile, '{not-json', 'utf8');
  assert.equal(loadState().position, null);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.corrupt-')).length, 1);
}));

test('adopted position with unknown opening time: the minimum hold counts from adoption, then it can switch', () => {
  const day = 24 * 3600000;
  // Through recordPosition, as adoptOnChainPair stores it: adoptedAt must survive the state compaction
  const adopted = ago => recordPosition({}, { symbol: 'HYPE', openTime: null, adoptedAt: Date.now() - ago }).position;
  assert.equal(canClosePosition(adopted(8 * day), 7 * day), true);
  assert.equal(canClosePosition(adopted(day), 7 * day), false);
  assert.equal(canClosePosition({ openTime: Date.now() - 8 * day, adoptedAt: Date.now() }, 7 * day), true);  // known time wins
  assert.equal(canClosePosition({ openTime: null }, 7 * day), false);
});
