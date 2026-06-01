import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import HyperliquidConnector from '../../hyperliquid.js';
import { getLeverageSettings } from '../../utils/leverage.js';
import { clearPendingIntent, getHistoryStats, loadState, recordPosition, closePosition, saveState, setPendingIntent } from '../../utils/state.js';
import { timestamp } from '../../bot.js';

test('bot timestamp is available at module scope', () => {
  assert.match(timestamp(), /^\[\d{1,2}:\d{2}:\d{2}/);
});

test('getBidAsk includes mid price', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0' });
  connector.updateOrderbook({
    coin: 'BTC',
    levels: [
      [{ px: '99', sz: '1', n: 1 }],
      [{ px: '101', sz: '1', n: 1 }]
    ],
    time: 123
  });

  assert.deepEqual(connector.getBidAsk('BTC'), {
    coin: 'BTC',
    bid: 99,
    ask: 101,
    mid: 100,
    bidSize: 1,
    askSize: 1,
    timestamp: 123
  });
});

test('getLeverageSettings handles string asset.coin values', async () => {
  const settings = await getLeverageSettings({
    wallet: '0x0000000000000000000000000000000000000001',
    restUrl: 'https://example.invalid/info',
    async infoRequest() {
      return {
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              leverage: { value: '1', type: 'isolated' }
            }
          }
        ]
      };
    },
    async getMeta() {
      return { universe: [] };
    }
  });

  assert.deepEqual(settings, [{ symbol: 'BTC', leverage: 1, type: 'isolated' }]);
});

test('state compacts order responses and history stats use component total PnL', () => {
  const initial = { version: '1.0', position: null, history: [] };
  const opened = recordPosition(initial, {
    success: true,
    symbol: 'BTC',
    perpSymbol: 'BTC',
    spotSymbol: 'UBTC',
    perpSize: 1,
    spotSize: 1,
    perpEntryPrice: 100,
    spotEntryPrice: 100,
    positionValue: 100,
    fundingRate: 0.001,
    annualizedFunding: 0.1,
    openFeesActual: 0.1,
    perpResult: {
      response: { data: { statuses: [{ filled: { oid: 1, avgPx: '100', totalSz: '1' } }] } }
    },
    spotResult: {
      response: { data: { statuses: [{ filled: { oid: 2, avgPx: '100', totalSz: '1' } }] } }
    }
  });

  assert.equal(opened.position.perpResult, undefined);
  assert.equal(opened.position.orderSummary.perp.oid, 1);

  const closed = closePosition(opened, {
    reason: 'test',
    perpClosePrice: 99,
    spotClosePrice: 101,
    perpPnl: 1,
    spotPnl: 1,
    pricePnl: 2,
    fundingPnl: 3,
    feesActual: 0.5,
    totalPnl: 4.5
  });

  assert.equal(getHistoryStats(closed).totalPnl, 4.5);
});

test('state file path can point at a missing directory', () => {
  const previous = process.env.BOT_STATE_FILE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-state-'));
  const stateFile = path.join(tempDir, 'nested', 'bot-state.json');
  process.env.BOT_STATE_FILE = stateFile;

  try {
    saveState({ version: '1.0', position: null, history: [{ totalPnl: 1 }] });
    assert.equal(fs.existsSync(stateFile), true);
    assert.equal(loadState().history.length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.BOT_STATE_FILE;
    } else {
      process.env.BOT_STATE_FILE = previous;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pending intents are persisted and cleared through state helpers', () => {
  const initial = { version: '1.0', position: null, history: [] };
  const pending = setPendingIntent(initial, { type: 'opening', symbol: 'BTC', createdAt: 123 });

  assert.equal(pending.pendingIntent.type, 'opening');
  assert.equal(pending.pendingIntent.createdAt, 123);
  assert.equal(clearPendingIntent(pending).pendingIntent, null);
});

test('corrupt state file is quarantined instead of silently reused', () => {
  const previous = process.env.BOT_STATE_FILE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-state-corrupt-'));
  const stateFile = path.join(tempDir, 'bot-state.json');
  process.env.BOT_STATE_FILE = stateFile;

  try {
    fs.writeFileSync(stateFile, '{not-json', 'utf8');
    const loaded = loadState();
    const quarantined = fs.readdirSync(tempDir).filter(name => name.includes('.corrupt-'));

    assert.equal(loaded.position, null);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(quarantined.length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.BOT_STATE_FILE;
    } else {
      process.env.BOT_STATE_FILE = previous;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
