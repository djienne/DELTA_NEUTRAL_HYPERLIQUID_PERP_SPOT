import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { ethers } from 'ethers';
import HyperliquidConnector from '../../hyperliquid.js';

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

function expectedConnectionId(action, nonce, vaultAddress = null, expiresAfter = null) {
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

  if (expiresAfter !== null && expiresAfter !== undefined) {
    bytes.push(0);
    bytes.push(...uint64Bytes(expiresAfter));
  }

  return ethers.keccak256(new Uint8Array(bytes));
}

test('l2Book payload omits out-of-spec mantissa null', () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });

  assert.deepEqual(connector.buildL2BookPayload('BTC'), {
    type: 'l2Book',
    coin: 'BTC',
    nSigFigs: 5
  });

  assert.deepEqual(connector.buildL2BookPayload('BTC', { mantissa: 2 }), {
    type: 'l2Book',
    coin: 'BTC',
    nSigFigs: 5,
    mantissa: 2
  });

  assert.throws(
    () => connector.buildL2BookPayload('BTC', { nSigFigs: 4, mantissa: 2 }),
    /mantissa is only valid/
  );
  assert.throws(
    () => connector.buildL2BookPayload('BTC', { mantissa: 3 }),
    /must be one of/
  );
});

test('subscription lifecycle sends documented l2Book frames', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  const ws = new FakeWebSocket();
  const snapshots = [];

  connector.connected = true;
  connector.ws = ws;
  connector.requestL2Book = async (coin) => {
    snapshots.push(coin);
    return {};
  };

  await connector.subscribeOrderbook('BTC');
  connector.unsubscribe('BTC');
  connector.stopPeriodicRestRefresh();
  connector.stopStalenessMonitoring();

  assert.deepEqual(ws.sent[0], {
    method: 'subscribe',
    subscription: { type: 'l2Book', coin: 'BTC' }
  });
  assert.deepEqual(snapshots, ['BTC']);
  assert.deepEqual(ws.sent[1], {
    method: 'unsubscribe',
    subscription: { type: 'l2Book', coin: 'BTC' }
  });
  assert.equal(connector.subscriptions.has('BTC'), false);
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

test('connection id includes vault address bytes and expiresAfter separator', async () => {
  const connector = new HyperliquidConnector({ wallet: '0x0', privateKey: null });
  const action = {
    type: 'order',
    orders: [{ a: 0, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na'
  };
  const vaultAddress = '0x00000000000000000000000000000000000000ab';

  assert.equal(
    await connector.constructConnectionId(action, 123, null, null),
    expectedConnectionId(action, 123)
  );
  assert.equal(
    await connector.constructConnectionId(action, 123, vaultAddress, 456),
    expectedConnectionId(action, 123, vaultAddress, 456)
  );
});

test('order helpers validate cloid and forward expiresAfter', async () => {
  assert.throws(
    () => new HyperliquidConnector({ wallet: '0x0', privateKey: null }).validateCloid('abc'),
    /cloid must be/
  );

  const payloads = [];
  const connector = new HyperliquidConnector({
    wallet: '0x0000000000000000000000000000000000000001',
    privateKey: `0x${'1'.repeat(64)}`,
    fetch: async (url, options) => {
      payloads.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ status: 'ok' })
      };
    }
  });
  const action = { type: 'order', orders: [], grouping: 'na' };
  const vaultAddress = '0x00000000000000000000000000000000000000ab';

  assert.equal(
    connector.validateCloid('0x0123456789abcdef0123456789abcdef'),
    '0x0123456789abcdef0123456789abcdef'
  );

  await connector.createOrderRest(action, 123, vaultAddress, 456);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].expiresAfter, 456);
  assert.equal(payloads[0].vaultAddress, ethers.getAddress(vaultAddress));
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
