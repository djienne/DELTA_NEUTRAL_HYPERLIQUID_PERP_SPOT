import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { ethers } from 'ethers';
import HyperliquidConnector from '../../hyperliquid.js';
import { UnknownOrderOutcomeError } from '../../utils/order-fill.js';
import { updateLeverage } from '../../utils/leverage.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

test('central market data preserves full-precision requests and never falls back upstream', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null, marketDataHub: 'http://hub:8766' });
  const calls = [];
  connector.fetchJsonWithTimeout = async (url, options) => {
    calls.push({ url, options });
    return { coin: 'BTC', time: 123, levels: [[], []] };
  };
  await connector.requestL2BookRest('BTC', { nSigFigs: null });
  assert.equal(calls[0].url, 'http://hub:8766/book?coin=BTC');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(connector.wsUrl, 'ws://hub:8766/ws?consumer=delta-neutral');
  assert.equal(connector.exchangeUrl, 'https://api.hyperliquid.xyz/exchange');
  connector.fetchJsonWithTimeout = async () => { throw new Error('hub down'); };
  await assert.rejects(connector.requestL2BookRest('BTC'), /hub down/);
});

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.pingCalls = 0;
    this.terminated = false;
    this.closed = false;
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  ping() {
    this.pingCalls++;
  }

  terminate() {
    this.terminated = true;
  }

  close() {
    this.closed = true;
  }
}

function uint64Bytes(value) {
  return Array.from(ethers.getBytes(`0x${BigInt(value).toString(16).padStart(16, '0')}`));
}

function expectedConnectionId(action, nonce, vaultAddress = null) {
  const bytes = [
    ...msgpackEncode(action),
    ...uint64Bytes(nonce)
  ];

  if (vaultAddress) {
    bytes.push(1);
    bytes.push(...ethers.getBytes(ethers.getAddress(vaultAddress)));
  } else {
    bytes.push(0);
  }

  return ethers.keccak256(new Uint8Array(bytes));
}

test('l2Book payload defaults to 5 significant figures', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });

  assert.deepEqual(connector.buildL2BookPayload('BTC'), {
    type: 'l2Book',
    coin: 'BTC',
    nSigFigs: 5
  });
});

test('health monitoring uses app-level ping and handles app-level pong', async () => {
  const connector = new HyperliquidConnector({
    wallet: '0x0',
    privateKey: null,
    pingInterval: 5,
    pongTimeout: 100
  });
  const ws = new FakeWebSocket();

  connector.connected = true;
  connector.ws = ws;
  connector.lastPongReceived = Date.now();

  try {
    connector.startHealthMonitoring();
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    connector.stopHealthMonitoring();
  }

  assert.equal(ws.pingCalls, 0);
  assert.ok(ws.sent.some(message => message.method === 'ping'));

  connector.pongTimer = setTimeout(() => {}, 1000);
  connector.lastPongReceived = 0;
  connector.handleMessage(JSON.stringify({ channel: 'pong' }));

  assert.equal(connector.pongTimer, null);
  assert.ok(connector.lastPongReceived > 0);
});

test('infoRequest uses injected fetch and weighted REST limiter', async () => {
  const weights = [];
  const requests = [];
  const connector = new HyperliquidConnector({
    wallet: '0x0',
    privateKey: null,
    fetch: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ ok: true })
      };
    }
  });

  connector.restRateLimiter.waitForSlot = async (weight) => {
    weights.push(weight);
  };

  const result = await connector.infoRequest({ type: 'meta' }, 20);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(weights, [20]);
  assert.deepEqual(requests, [{
    url: 'https://api.hyperliquid.xyz/info',
    payload: { type: 'meta' }
  }]);
});

test('connection id includes vault address bytes', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  const action = {
    type: 'order',
    orders: [{ a: 0, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na'
  };
  const vaultAddress = '0x00000000000000000000000000000000000000ab';

  assert.equal(
    await connector.constructConnectionId(action, 123, null),
    expectedConnectionId(action, 123)
  );
  assert.equal(
    await connector.constructConnectionId(action, 123, vaultAddress),
    expectedConnectionId(action, 123, vaultAddress)
  );
});

test('is_vault=true in hyperliquid.env signs orders and leverage for the sub-account', async () => {
  const subAccount = '0x00000000000000000000000000000000000000ab';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-env-'));
  fs.writeFileSync(path.join(dir, 'hyperliquid.env'), `wallet_address=${subAccount}
private_key=0x${'1'.repeat(64)}
is_vault=True
`);
  const cwd = process.cwd();
  process.chdir(dir);
  let connector;
  try {
    connector = new HyperliquidConnector();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(connector.wallet, subAccount);

  const sentVaults = [];
  connector.getAssetId = async () => 0;
  connector.getAssetInfo = () => ({ szDecimals: 3 });
  connector.fetchJsonWithTimeout = async (url, init) => {
    sentVaults.push(JSON.parse(init.body).vaultAddress);
    return { status: 'ok' };
  };

  connector.getFreshBidAsk = async () => ({ bid: 99999, ask: 100001, mid: 100000, timestamp: Date.now() });
  await connector.createMarketOrder('BTC', 'sell', 0.001);
  await updateLeverage(connector, 'BTC', 1, false);

  assert.deepEqual(sentVaults, [ethers.getAddress(subAccount), ethers.getAddress(subAccount)]);
});

test('nextNonce is strictly monotonic within the same millisecond', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  const originalNow = Date.now;
  Date.now = () => 1234567890;

  try {
    assert.deepEqual(
      [connector.nextNonce(), connector.nextNonce(), connector.nextNonce()],
      [1234567890, 1234567891, 1234567892]
    );
  } finally {
    Date.now = originalNow;
  }
});

test('REST info requests time out instead of hanging forever', async () => {
  const connector = new HyperliquidConnector({
    wallet: '0x0',
    privateKey: null,
    infoTimeoutMs: 5,
    fetch: async () => new Promise(() => {})
  });
  connector.restRateLimiter.waitForSlot = async () => {};

  await assert.rejects(
    () => connector.infoRequest({ type: 'meta' }, 1),
    /timed out/
  );
});

test('REST order parse failure is treated as unknown outcome', async () => {
  const connector = new HyperliquidConnector({
    wallet: '0x0000000000000000000000000000000000000001',
    privateKey: `0x${'1'.repeat(64)}`,
    fetch: async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      }
    })
  });

  const action = { type: 'order', orders: [], grouping: 'na' };

  await assert.rejects(
    () => connector.createOrderRest(action, 123, { coin: 'BTC' }),
    UnknownOrderOutcomeError
  );
});

test('disconnect rejects pending order requests as unknown outcomes', async () => {
  const connector = new HyperliquidConnector({
    wallet: '0x0000000000000000000000000000000000000001',
    privateKey: `0x${'1'.repeat(64)}`
  });
  connector.connected = true;
  connector.ws = new FakeWebSocket();

  const action = {
    type: 'order',
    orders: [{ a: 0, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na'
  };
  const pending = connector.createOrderWebSocket(action, 123, { coin: 'BTC' });
  await new Promise(resolve => setImmediate(resolve));
  connector.disconnect();

  await assert.rejects(pending, UnknownOrderOutcomeError);
});

test('createMarketOrder refreshes stale orderbook before pricing', async () => {
  const connector = new HyperliquidConnector({
    wallet: '0x0000000000000000000000000000000000000001',
    privateKey: `0x${'1'.repeat(64)}`,
    maxOrderbookAgeMs: 1
  });
  let refreshed = false;

  connector.getAssetId = async () => 0;
  connector.getAssetInfo = () => ({ szDecimals: 4 });
  connector.getCoinForOrderbook = () => 'BTC';
  connector.createOrderRest = async (action) => action;
  connector.updateOrderbook({
    coin: 'BTC',
    levels: [
      [{ px: '90', sz: '1', n: 1 }],
      [{ px: '110', sz: '1', n: 1 }]
    ],
    time: Date.now() - 10000
  });
  connector.orderbooks.get('BTC').receivedAt -= 10000;  // nothing received for 10 s
  connector.requestL2BookRest = async () => {
    refreshed = true;
    return {
      levels: [
        [{ px: '99', sz: '1', n: 1 }],
        [{ px: '101', sz: '1', n: 1 }]
      ],
      time: Date.now()
    };
  };

  const action = await connector.createMarketOrder('BTC', 'buy', 1);

  assert.equal(refreshed, true);
  assert.equal(action.orders[0].p, '105');
});

test('roundPrice avoids exponential notation', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });

  assert.equal(connector.roundPrice(0.000012345, 2, true).includes('e'), false);
});

test('getUserFundingHistory pages past the 500-row API cap without losing rows that share an hour', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  // 499 HYPE hours, then two coins funded in the same hour: the 500-row page boundary falls between them
  const rows = [...Array.from({ length: 499 }, (_, i) => ({ time: 1000 + i, coin: 'HYPE' })),
    { time: 1499, coin: 'HYPE' }, { time: 1499, coin: 'PURR' }, { time: 1500, coin: 'HYPE' }]
    .map(r => ({ time: r.time, delta: { type: 'funding', coin: r.coin, usdc: '0.01' } }));
  connector.infoRequest = async ({ startTime }) => rows.filter(r => r.time >= startTime).slice(0, 500);  // API paging

  const history = await connector.getUserFundingHistory(null, 1000);

  assert.equal(history.count, 502);
  assert.ok(Math.abs(history.totalAccumulated - 5.02) < 1e-9);
});

test('network outage: a failed WebSocket connect rejects promptly and does not crash the process', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));  // nothing listens there any more: connection refused

  // Child process: exit 0 when connect() rejects. An unlistened 'error' crashes it (exit 1); a promise that never
  // settles (reconnect stuck at attempt 1, startup hanging instead of exiting for Docker to restart) times out (exit 3).
  const script = `const { default: C } = await import(${JSON.stringify(new URL('../../hyperliquid.js', import.meta.url).href)});
    const c = new C({ wallet: null, privateKey: null });
    c.wsUrl = 'ws://127.0.0.1:${port}';
    c.connect().then(() => process.exit(4), () => process.exit(0));
    setTimeout(() => process.exit(3), 15000);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.match(run.stderr, /WebSocket error/);
  assert.equal(run.status, 0, run.stderr);
});

test('after an outage the reconnected socket is not killed by the pong clock of the old one', async () => {
  const c = new HyperliquidConnector({ wallet: null, privateKey: null, pingInterval: 20, pongTimeout: 1000 });
  let terminated = false;
  c.connected = true;
  c.ws = { send: () => {}, terminate: () => { terminated = true; } };
  c.lastPongReceived = Date.now() - 5 * 60000;  // last pong before a 5-minute outage
  c.startHealthMonitoring();                    // what the 'open' handler of the new socket does
  await new Promise(resolve => setTimeout(resolve, 60));
  c.stopHealthMonitoring();
  assert.equal(terminated, false);
});

test('book freshness: a host clock lagging the exchange (Docker/WSL2 after sleep) does not block orders; old data does', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  const levels = [[{ px: '99', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]];
  let exchangeSkew = 60000;  // exchange clock a minute ahead of the host
  let refreshes = 0;
  connector.requestL2BookRest = async () => { refreshes++; return { levels, time: Date.now() + exchangeSkew }; };

  connector.updateOrderbook({ coin: 'BTC', levels, time: Date.now() + exchangeSkew });
  assert.equal((await connector.getFreshBidAsk('BTC')).mid, 100);
  assert.equal(refreshes, 0);
  connector.orderbooks.get('BTC').receivedAt -= 60000;  // nothing received for a minute: stale, refreshed
  assert.equal((await connector.getFreshBidAsk('BTC')).mid, 100);
  assert.equal(refreshes, 1);

  exchangeSkew = -60000;  // exchange data a minute old (halted chain, or host clock ahead): no order
  connector.orderbooks.clear();
  await assert.rejects(connector.getFreshBidAsk('BTC'), /fresh valid/);
});
