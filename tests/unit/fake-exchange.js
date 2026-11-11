// Stateful fake exchange for unit tests: perp/spot inventories (symbol -> signed size) that orders change.
// e.execution(call) overrides a fill: {size, price, fee?}, {reject: true} or {error}; e.leverageResponse the leverage reply.
import HyperliquidConnector from '../../hyperliquid.js';

export function exchange(perps = { BTC: -1 }, spots = { UBTC: 1 }) {
  const e = {
    wallet: 'fake-account', signer: {}, exchangeUrl: 'https://example.invalid', perps: { ...perps }, spots: { ...spots }, calls: [], updates: [],
    async infoRequest({ type }) {
      if (type === 'clearinghouseState') return { assetPositions: Object.entries(e.perps).filter(([, q]) => q).map(([coin, q]) =>
        ({ position: { coin, szi: String(q), entryPx: '100', positionValue: String(Math.abs(q) * 100) } })) };
      if (type === 'spotClearinghouseState') return { balances: Object.entries(e.spots).filter(([, q]) => q).map(([coin, q]) => ({ coin, total: String(q), hold: '0' })) };
      throw Error(type);
    },
    async getAllMids() { return { BTC: '100', ETH: '100', '@1': '100', '@2': '100' }; },
    async getAssetId(symbol, isSpot) { return (isSpot ? 10000 : 0) + (['BTC','UBTC'].includes(symbol) ? 1 : 2); },
    getCoinForOrderbook(symbol, id) { return id >= 10000 ? '@' + (id - 10000) : symbol; },
    getAssetInfo() { return { szDecimals: 4 }; },
    async getFreshBidAsk() { return { bid: 99.99, ask: 100.01, mid: 100, timestamp: Date.now() }; },
    roundSize: HyperliquidConnector.prototype.roundSize,
    async signAction() { return {}; },
    async fetchJsonWithTimeout(url, init) { e.updates.push(JSON.parse(init.body).action); return e.leverageResponse ?? { status: 'ok' }; },
    async getUserFundingHistory() { return { accumulated: { BTC: 0 } }; },
    async createMarketOrder(symbol, side, size, options) {
      const call = { symbol, side, size, options, index: e.calls.length }; e.calls.push(call);
      const execution = e.execution ? e.execution(call) : { size, price: 100 };
      if (execution.error) throw execution.error;
      if (execution.reject) return { status: 'ok', response: { data: { statuses: [{ error: 'Rejected' }] } } };
      const inventory = options.isSpot ? e.spots : e.perps;
      inventory[symbol] = (inventory[symbol] ?? 0) + execution.size * (side === 'buy' ? 1 : -1);
      if (Math.abs(inventory[symbol]) < 1e-12) delete inventory[symbol];
      return { status: 'ok', response: { data: { statuses: [{ filled: {
        totalSz: String(execution.size), avgPx: String(execution.price), oid: e.calls.length,
        ...(execution.fee === undefined ? {} : { fee: String(execution.fee) })
      } }] } } };
    }
  };
  return e;
}
