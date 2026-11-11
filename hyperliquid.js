import fs from 'fs';
import { SlidingWindowRateLimiter } from './utils/rate-limiter.js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { UnknownOrderOutcomeError } from './utils/order-fill.js';

const CREDENTIALS_FILE = 'hyperliquid.env';  // wallet_address, private_key, is_vault (relative to the working dir)

class HyperliquidConnector {
  constructor(options = {}) {
    this.restUrl = options.restUrl || 'https://api.hyperliquid.xyz/info';
    this.exchangeUrl = options.exchangeUrl || 'https://api.hyperliquid.xyz/exchange';
    this.testnet = options.testnet || false;
    this.marketDataHub = this.testnet ? '' : (options.marketDataHub ?? process.env.HL_PUBLIC_HTTP ?? '');
    if (this.marketDataHub) {
      this.marketDataHub = this.marketDataHub.replace(/\/$/, '');
    }

    if (this.testnet) {
      this.restUrl = 'https://api.hyperliquid-testnet.xyz/info';
      this.exchangeUrl = 'https://api.hyperliquid-testnet.xyz/exchange';
    }

    // Credentials come from hyperliquid.env unless a wallet is passed explicitly (tests, read-only tools).
    // is_vault=true (sub-account or vault): wallet_address is the account queried for balances and is named as
    // vaultAddress in every signed action; without it the API key would trade its master account instead.
    const creds = options.wallet === undefined && fs.existsSync(CREDENTIALS_FILE)
      ? dotenv.parse(fs.readFileSync(CREDENTIALS_FILE))
      : {};
    this.wallet = options.wallet !== undefined ? options.wallet : creds.wallet_address;
    this.privateKey = options.privateKey !== undefined ? options.privateKey : creds.private_key;
    this.vaultAddress = options.vaultAddress ?? (creds.is_vault?.toLowerCase() === 'true' ? this.wallet : null);
    this.fetch = options.fetch || fetch;

    // Initialize signer if private key is provided
    if (this.privateKey) {
      this.signer = new ethers.Wallet(this.privateKey);
    }

    this.maxOrderbookAgeMs = options.maxOrderbookAgeMs || 10000;
    this.infoTimeoutMs = options.infoTimeoutMs || 15000;
    this.orderTimeoutMs = options.orderTimeoutMs || 20000;

    // Orderbook data cache
    this.orderbooks = new Map();

    // Request tracking
    this.lastNonce = options.lastNonce || 0;

    // REST: max 1200 weight per minute (l2Book has weight 2)
    this.restRateLimiter = new SlidingWindowRateLimiter({
      maxRequests: 1200, // counted in request weight (see infoRequest)
      windowMs: 60000 // 1 minute
    });
  }

  nextNonce() {
    const now = Date.now();
    this.lastNonce = Math.max(now, this.lastNonce + 1);
    return this.lastNonce;
  }

  generateCloid() {
    return ethers.hexlify(ethers.randomBytes(16));
  }

  // Lifecycle hooks: orders and data are all REST, nothing to open or close. PaperConnector runs its simulator here.
  async connect() {}

  disconnect() {}

  buildL2BookPayload(coin, options = {}) {
    const { nSigFigs = 5 } = options;
    const payload = {
      type: 'l2Book',
      coin
    };

    if (nSigFigs !== null && nSigFigs !== undefined) {
      payload.nSigFigs = nSigFigs;
    }

    return payload;
  }

  async fetchJsonWithTimeout(url, requestOptions, options = {}) {
    const {
      timeoutMs = this.infoTimeoutMs,
      unknownOnTimeout = false,
      context = {}
    } = options;
    const controller = new AbortController();
    let timeoutId;
    let status;  // HTTP status, once the server answered

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          const error = new Error(`REST request timed out after ${timeoutMs}ms`);
          error.name = 'AbortError';
          reject(error);
        }, timeoutMs);
      });

      const response = await Promise.race([
        this.fetch(url, {
          ...requestOptions,
          signal: controller.signal
        }),
        timeoutPromise
      ]);
      status = response.status;

      if (!response.ok) {
        const errorText = typeof response.text === 'function'
          ? await response.text()
          : response.statusText;
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      try {
        return await response.json();
      } catch (error) {
        if (unknownOnTimeout) {
          throw new UnknownOrderOutcomeError(
            `Order response was not valid JSON: ${error.message}`,
            context
          );
        }
        throw new Error(`Invalid JSON response: ${error.message}`);
      }
    } catch (error) {
      // An order with no definitive answer (timeout, network failure, 5xx) may have reached the exchange: only the
      // chain can tell, so the caller reconciles before retrying. A 4xx answer means it was refused.
      if (unknownOnTimeout && !error.isUnknownOrderOutcome && !(status < 500)) {
        throw new UnknownOrderOutcomeError(`Order outcome unknown: ${error.message}`, context);
      }
      if (error.name === 'AbortError') {
        throw new Error(`REST request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async infoRequest(payload, weight = 2) {
    if (this.marketDataHub && payload.type === 'l2Book') {
      const query = new URLSearchParams(Object.entries(payload).filter(([key]) => key !== 'type'));
      return await this.fetchJsonWithTimeout(`${this.marketDataHub}/book?${query}`, { method: 'GET' });
    }
    await this.restRateLimiter.waitForSlot(weight);

    return await this.fetchJsonWithTimeout(this.restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, {
      timeoutMs: this.infoTimeoutMs,
      context: { requestType: payload?.type || 'info' }
    });
  }

  /**
   * Update orderbook cache
   */
  updateOrderbook(data) {
    const { coin, levels, time } = data;

    if (!coin || !levels || levels.length < 2) {
      return;
    }

    const [bids, asks] = levels;

    // Extract best bid and ask
    let bestBid = null;
    let bestAsk = null;

    if (bids && bids.length > 0) {
      bestBid = {
        price: parseFloat(bids[0].px),
        size: parseFloat(bids[0].sz),
        numOrders: bids[0].n
      };
    }

    if (asks && asks.length > 0) {
      bestAsk = {
        price: parseFloat(asks[0].px),
        size: parseFloat(asks[0].sz),
        numOrders: asks[0].n
      };
    }

    const orderbook = {
      coin,
      bestBid,
      bestAsk,
      bids,
      asks,
      timestamp: time || Date.now(),  // exchange time
      receivedAt: Date.now()          // local time
    };

    this.orderbooks.set(coin, orderbook);
  }

  /**
   * Get bid and ask prices for a coin
   */
  getBidAsk(coin) {
    const orderbook = this.orderbooks.get(coin);

    if (!orderbook) {
      return null;
    }
    const bid = orderbook.bestBid?.price || null;
    const ask = orderbook.bestAsk?.price || null;
    const mid = bid && ask ? (bid + ask) / 2 : null;

    return {
      coin,
      bid,
      ask,
      mid,
      bidSize: orderbook.bestBid?.size || null,
      askSize: orderbook.bestAsk?.size || null,
      timestamp: orderbook.timestamp,
      receivedAt: orderbook.receivedAt
    };
  }

  /**
   * Request L2 orderbook via REST API
   */
  async requestL2BookRest(coin, options = {}) {
    try {
      return await this.infoRequest(this.buildL2BookPayload(coin, options), 2);
    } catch (error) {
      console.error(`[Hyperliquid] REST API error for ${coin}:`, error.message);
      throw error;
    }
  }

  /**
   * Get asset metadata (to find asset IDs and szDecimals), fetched once
   */
  async getMeta() {
    return this.metaCache ??= await this.infoRequest({ type: 'meta' }, 20);
  }

  /**
   * Get spot metadata, fetched once
   */
  async getSpotMeta() {
    return this.spotMetaCache ??= await this.infoRequest({ type: 'spotMeta' }, 20);
  }

  /**
   * Get asset ID from coin name
   * Returns assetId for perp or 10000 + index for spot
   */
  async getAssetId(coin, isSpot = false) {
    await this.getMeta();
    await this.getSpotMeta();

    // Try perp first if not explicitly spot
    if (!isSpot) {
      const perpIndex = this.metaCache.universe.findIndex(asset => asset.name === coin);
      if (perpIndex !== -1) {
        return perpIndex;
      }
    }

    // Try spot
    // For spot, we need to find the token in the universe and match it to the spot pairs
    // spotMeta.universe contains arrays of [token_index, token_index] representing pairs
    // We need to find a pair where one token is USDC (token 0) and the other is our coin
    const spotPair = this.spotMetaCache.universe.find(pair => {
      // pair is [baseTokenIndex, quoteTokenIndex]
      // We want pairs with USDC (token 0) as quote
      if (pair.tokens[1] !== 0) return false;

      // Find the base token
      const baseTokenIndex = pair.tokens[0];
      const token = this.spotMetaCache.tokens.find(t => t.index === baseTokenIndex);

      return token && token.name === coin;
    });

    if (spotPair) {
      // Use the pair's index field, not its array position
      return 10000 + spotPair.index;
    }

    throw new Error(`Asset ${coin} not found in ${isSpot ? 'spot' : 'perp'} meta`);
  }

  /**
   * Get asset metadata (szDecimals, etc.)
   */
  getAssetInfo(coin, assetId = null) {
    if (!this.metaCache) {
      throw new Error('Meta cache not loaded. Call getAssetId first.');
    }

    const isSpot = assetId !== null && assetId >= 10000;

    if (isSpot) {
      if (!this.spotMetaCache) {
        throw new Error('Spot meta cache not loaded.');
      }

      const spotIndex = assetId - 10000;
      // Find pair by its index field, not array position
      const pair = this.spotMetaCache.universe.find(p => p.index === spotIndex);

      if (!pair) {
        throw new Error(`Spot asset ${coin} not found at index ${spotIndex}`);
      }

      // Get szDecimals from the base token
      const baseTokenIndex = pair.tokens[0];
      const token = this.spotMetaCache.tokens.find(t => t.index === baseTokenIndex);

      if (!token) {
        throw new Error(`Base token not found for ${coin}`);
      }

      return {
        name: coin,
        szDecimals: token.szDecimals,
        spotCoin: pair.name  // The coin name to use for orderbook subscription (@{index} format)
      };
    } else {
      const asset = this.metaCache.universe.find(a => a.name === coin);
      if (!asset) {
        throw new Error(`Asset ${coin} not found in meta`);
      }

      return asset;
    }
  }

  /**
   * Get the coin name to use for orderbook subscription
   * For spot, this returns the @{index} format
   */
  getCoinForOrderbook(coin, assetId = null) {
    const isSpot = assetId !== null && assetId >= 10000;

    if (isSpot) {
      const assetInfo = this.getAssetInfo(coin, assetId);
      return assetInfo.spotCoin; // Returns @{index} format
    }

    return coin; // For perp, use coin name as-is
  }

  /**
   * Get all mid prices for all symbols
   * @returns {Promise<Object>} Object with symbol -> mid price mapping
   */
  async getAllMids() {
    const payload = {
      type: 'allMids'
    };

    return await this.infoRequest(payload, 2);
  }

  /**
   * Round price to proper tick size per Hyperliquid rules:
   * - Up to 5 significant figures
   * - Max decimals = MAX_DECIMALS - szDecimals (6 for perps, 8 for spot)
   * - Integer prices always allowed (even >5 sig figs)
   * - Remove trailing zeros
   */
  roundPrice(price, szDecimals, isSpot = false) {
    const MAX_DECIMALS = isSpot ? 8 : 6;
    const decimalsAllowed = MAX_DECIMALS - szDecimals;
    const numericPrice = Number(price);

    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      throw new Error(`Invalid price: ${price}`);
    }

    // Step 1: Round to 5 significant figures
    let rounded = Number(numericPrice.toPrecision(5));

    // Step 2: Limit to decimalsAllowed decimal places
    let priceStr = rounded.toFixed(Math.max(0, decimalsAllowed));

    // Step 3: Remove trailing zeros without switching to exponential notation
    if (priceStr.includes('.')) {
      priceStr = priceStr.replace(/\.?0+$/, '');
    }

    return priceStr;
  }

  /**
   * Round size to proper lot size per Hyperliquid rules:
   * - Rounded to multiples of 10^-szDecimals
   * - Formatted with at most szDecimals decimal places
   */
  roundSize(size, szDecimals, mode = 'nearest') {
    const numericSize = Number(size);
    if (!Number.isFinite(numericSize) || numericSize <= 0) {
      throw new Error(`Invalid size: ${size}`);
    }

    // Size tick = 10^-szDecimals
    const sizeTick = Math.pow(10, -szDecimals);

    // Scale UP by 10^szDecimals rather than dividing by a tiny tick, then strip the
    // binary-representation tail before flooring.
    //
    // The old code did `numericSize / sizeTick` and floored the result. In IEEE-754
    // that is wrong for a large fraction of exact lot sizes:
    //
    //     0.00123 / 1e-5  ===  122.99999999999999   -> floor 122 -> 0.00122
    //     1234.56 * 100   ===  123455.99999999999   -> floor     -> 1234.55
    //
    // A scan of 120k exact lot sizes found ~22% shrink by one full tick this way,
    // and every order path here passes sizeRoundingMode 'down'. The consequence was
    // not just a slightly small order: closing 0.00122 of a 0.00123 position leaves
    // a 0.00001 residual, the fill-ratio check fails, the retry tries to close the
    // residual, and Hyperliquid rejects it as below the $10 minimum. The position
    // becomes permanently un-closeable and every subsequent cycle repeats the
    // failure.
    //
    // toPrecision(12) keeps far more significant digits than any real lot size
    // needs while discarding the error tail, so exact values land on integers and
    // genuinely fractional values are untouched.
    const units = Number((numericSize * Math.pow(10, szDecimals)).toPrecision(12));
    let roundedUnits;
    if (mode === 'down') {
      roundedUnits = Math.floor(units);
    } else if (mode === 'up') {
      roundedUnits = Math.ceil(units);
    } else {
      roundedUnits = Math.round(units);
    }

    const rounded = roundedUnits * sizeTick;
    if (rounded <= 0) {
      throw new Error(`Rounded size is zero for ${size} with szDecimals ${szDecimals}`);
    }

    // Format with at most szDecimals decimal places
    let sizeStr = rounded.toFixed(szDecimals);

    // Remove trailing zeros
    if (sizeStr.includes('.')) {
      sizeStr = sizeStr.replace(/\.?0+$/, '');
    }

    return sizeStr;
  }

  /**
   * Convert a non-negative integer to an unsigned 64-bit big-endian byte array.
   */
  numberToUint64Bytes(value, label = 'value') {
    const bigintValue = BigInt(value);
    const maxUint64 = (1n << 64n) - 1n;

    if (bigintValue < 0n || bigintValue > maxUint64) {
      throw new Error(`${label} must fit in uint64`);
    }

    const hex = bigintValue.toString(16).padStart(16, '0');
    return Array.from(ethers.getBytes(`0x${hex}`));
  }

  normalizeVaultAddress(vaultAddress) {
    return ethers.getAddress(vaultAddress);
  }

  /**
   * Sign an action using EIP-712
   * Based on Hyperliquid Python SDK sign_l1_action
   */
  async signAction(action, nonce, vaultAddress = null) {
    if (!this.signer) {
      throw new Error('Signer not initialized. Private key required.');
    }

    // Construct EIP-712 domain
    // chainId is always 1337 for Hyperliquid
    const domain = {
      chainId: 1337,
      name: 'Exchange',
      verifyingContract: '0x0000000000000000000000000000000000000000',
      version: '1'
    };

    // Construct EIP-712 types
    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    // Construct phantom agent
    // source: "a" for mainnet, "b" for testnet
    const source = this.testnet ? 'b' : 'a';

    // Create connection ID hash
    // This is keccak256 of msgpack encoded data + nonce + vault indicator
    const connectionId = await this.constructConnectionId(action, nonce, vaultAddress);

    const agentMessage = {
      source,
      connectionId
    };

    // Sign the typed data
    const signature = await this.signer.signTypedData(domain, types, agentMessage);
    const sig = ethers.Signature.from(signature);

    return {
      r: sig.r,
      s: sig.s,
      v: sig.v
    };
  }

  /**
   * Construct connection ID for EIP-712 signing
   * This is a keccak256 hash of msgpack-encoded action + nonce + vault (no expiresAfter: the bot never sets one)
   */
  async constructConnectionId(action, nonce, vaultAddress) {
    // Encode action with msgpack
    const actionBytes = msgpackEncode(action);

    // Create data array to hash
    const dataToHash = [];

    // Add action bytes
    dataToHash.push(...actionBytes);

    // Add nonce as uint64 big-endian bytes
    dataToHash.push(...this.numberToUint64Bytes(nonce, 'nonce'));

    if (vaultAddress) {
      dataToHash.push(1);
      dataToHash.push(...ethers.getBytes(this.normalizeVaultAddress(vaultAddress)));
    } else {
      dataToHash.push(0);
    }

    // Hash the combined data
    const hash = ethers.keccak256(new Uint8Array(dataToHash));

    return hash;
  }

  normalizeSlippagePercent(slippagePercent = 5) {
    const value = Number(slippagePercent);
    if (!Number.isFinite(value) || value < 0 || value >= 100) {
      throw new Error(`Invalid slippage percent: ${slippagePercent}`);
    }
    return value / 100;
  }

  async refreshOrderbookSnapshot(coin) {
    const data = await this.requestL2BookRest(coin);
    this.updateOrderbook({
      coin,
      levels: data.levels,
      time: data.time || Date.now()
    });
    return this.getBidAsk(coin);
  }

  async getFreshBidAsk(coin, { force = false, maxAgeMs = this.maxOrderbookAgeMs } = {}) {
    // Fresh = received within maxAgeMs AND exchange time not older than maxAgeMs. An exchange time AHEAD of the local
    // clock is fine (Docker/WSL2 clocks lag after sleep). An old exchange time means stale data (e.g. a halted chain)
    // or a host clock running ahead: indistinguishable without an outside clock, so both block orders.
    const valid = book => book && Number.isFinite(book.bid) && Number.isFinite(book.ask) &&
      book.bid > 0 && book.ask >= book.bid && Number.isFinite(book.receivedAt) && Number.isFinite(book.timestamp) &&
      Date.now() - book.receivedAt <= maxAgeMs && Date.now() - book.timestamp <= maxAgeMs;
    let book = this.getBidAsk(coin);
    if (force || !valid(book)) book = await this.refreshOrderbookSnapshot(coin);
    if (!valid(book)) throw new Error(`No fresh valid orderbook for ${coin}`);
    return book;
  }

  /**
   * Create a market order
   * For Hyperliquid, market orders are IOC (Immediate or Cancel) limit orders with aggressive pricing
   *
   * @param {string} coin - Coin symbol (e.g., 'SOL', 'BTC')
   * @param {string} side - 'buy' or 'sell'
   * @param {number} size - Order size
   * @param {object} options - isSpot, slippage (percent), reduceOnly, sizeRoundingMode
   * @returns {Promise<object>} Order result
   */
  async createMarketOrder(coin, side, size, options = {}) {
    if (!this.wallet || !this.signer) {
      throw new Error('Wallet and private key required for trading');
    }

    // Get asset ID and metadata
    const isSpot = options.isSpot || false;
    const assetId = await this.getAssetId(coin, isSpot);
    const assetInfo = this.getAssetInfo(coin, assetId);

    // Determine the correct orderbook coin (for spot, use @{index} format)
    const orderbookCoin = this.getCoinForOrderbook(coin, assetId);

    const isBuy = side === 'buy';
    const reduceOnly = isSpot ? false : (options.reduceOnly || false);
    const slippagePercent = options.slippage ?? 5;
    const slippageDecimal = this.normalizeSlippagePercent(slippagePercent);

    if (options.overrideMidPrice !== undefined) {
      throw new Error('overrideMidPrice is unsupported; orders require a fresh orderbook');
    }
    const bidAsk = await this.getFreshBidAsk(orderbookCoin);
    const midPrice = (bidAsk.bid + bidAsk.ask) / 2;

    // Calculate limit price with slippage (matching Python SDK logic):
    // - For buy: midPrice * (1 + slippage)
    // - For sell: midPrice * (1 - slippage)
    // IOC ensures immediate execution at best available price
    // Note: slippageDecimal is normalized from a percent input (e.g., 5 for 5%)
    let limitPrice;
    if (isBuy) {
      limitPrice = midPrice * (1 + slippageDecimal);
    } else {
      limitPrice = midPrice * (1 - slippageDecimal);
    }

    // Round price to proper tick size (5 sig figs, max decimals based on szDecimals)
    // isSpot already defined from options above
    const limitPriceStr = this.roundPrice(limitPrice, assetInfo.szDecimals, isSpot);

    // Round size to proper lot size (szDecimals)
    const sizeStr = this.roundSize(size, assetInfo.szDecimals, options.sizeRoundingMode || 'nearest');

    // Check minimum notional ($10 minimum per Hyperliquid docs). Valued at mid, not at the
    // slippage-adjusted limit, which would reject a $10.40 sell as $9.88.
    const notional = midPrice * parseFloat(sizeStr);
    if (notional < 10) {
      throw new Error(`Order notional ($${notional.toFixed(2)}) is below minimum ($10). Increase order size.`);
    }

    console.log(`[Hyperliquid] Market order ${side} ${sizeStr} ${coin} at limit ${limitPriceStr} (mid: ${midPrice.toFixed(6)}, notional: $${notional.toFixed(2)}, slippage: ${slippagePercent}%, szDecimals: ${assetInfo.szDecimals})`);
    console.log(`[Hyperliquid] Price calculation: ${midPrice} * ${1 + (isBuy ? slippageDecimal : -slippageDecimal)} = ${limitPrice} -> rounded: ${limitPriceStr}`);

    // Construct order (the cloid identifies it if its outcome is unknown)
    const cloid = this.generateCloid();
    const order = {
      a: assetId,          // asset
      b: isBuy,            // is buy
      p: limitPriceStr,    // limit price with slippage (properly rounded)
      s: sizeStr,          // size (properly rounded to szDecimals)
      r: reduceOnly,       // reduce only
      t: {
        limit: {
          tif: 'Ioc'  // Immediate or Cancel - executes immediately at market price
        }
      },
      c: cloid
    };

    const action = {
      type: 'order',
      orders: [order],
      grouping: 'na'
    };

    console.log(`[Hyperliquid] Order object:`, JSON.stringify(order, null, 2));

    const nonce = this.nextNonce();
    const orderContext = {
      coin,
      side,
      size: parseFloat(sizeStr),
      isSpot,
      reduceOnly,
      cloid,
      nonce
    };

    return await this.createOrderRest(action, nonce, orderContext);
  }

  // The signed /exchange body. A sub-account/vault must be named in every action, or the API key acts on its master.
  async signedPayload(action, nonce) {
    const payload = { action, nonce, signature: await this.signAction(action, nonce, this.vaultAddress) };
    if (this.vaultAddress) payload.vaultAddress = this.normalizeVaultAddress(this.vaultAddress);
    return payload;
  }

  // The one REST /exchange call. unknownOnTimeout (orders): no definitive reply (timeout, network failure, 5xx,
  // unreadable body) is an UnknownOrderOutcomeError.
  async postAction(action, nonce, { unknownOnTimeout = false, context = {} } = {}) {
    return this.fetchJsonWithTimeout(this.exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await this.signedPayload(action, nonce))
    }, { timeoutMs: this.orderTimeoutMs, unknownOnTimeout, context });
  }

  /**
   * Create order via REST API
   */
  async createOrderRest(action, nonce, context = {}) {
    const result = await this.postAction(action, nonce, { unknownOnTimeout: true, context: { ...context, nonce, transport: 'rest' } });
    console.log('[Hyperliquid] Order placed via REST:', result);
    return result;
  }

  /**
   * Get user funding payment history
   * @param {string} user - User wallet address (optional, defaults to this.wallet)
   * @param {number} startTime - Start timestamp in milliseconds (optional)
   * @returns {Promise<Object>} Funding history with payments and summary
   */
  async getUserFundingHistory(user = null, startTime = null) {
    user = user || this.wallet;

    if (!user) {
      throw new Error('User address required to get funding history');
    }

    try {
      const requestBody = {
        type: 'userFunding',
        user: user
      };

      // Add startTime if provided (expects milliseconds)
      if (startTime !== null) {
        requestBody.startTime = startTime;
      }

      // At most 500 rows per call (~20 days of one position): page forward from the latest time seen. That time is
      // asked for again (coins funded in the same hour can straddle the page boundary) and duplicates are skipped.
      const data = [];
      const seen = new Set();
      for (;;) {
        const page = await this.infoRequest(requestBody, 20);
        const fresh = page.filter(p => !seen.has(`${p.time}:${p.delta?.coin}`));
        fresh.forEach(p => seen.add(`${p.time}:${p.delta?.coin}`));
        data.push(...fresh);
        if (page.length < 500 || fresh.length === 0) break;
        requestBody.startTime = Math.max(...page.map(p => p.time));
      }

      // Data format: array of payment objects
      // Each payment: { time, hash, delta: { type: "funding", coin, fundingRate, szi, usdc, nSamples } }

      // Calculate accumulated funding per coin
      const accumulated = {};
      let totalAccumulated = 0;

      for (const payment of data) {
        // Funding data is nested in delta object
        if (payment.delta && payment.delta.type === 'funding') {
          const coin = payment.delta.coin;
          const usdc = parseFloat(payment.delta.usdc);

          if (!accumulated[coin]) {
            accumulated[coin] = 0;
          }

          accumulated[coin] += usdc;
          totalAccumulated += usdc;
        }
      }

      return {
        payments: data,
        accumulated: accumulated,
        totalAccumulated: totalAccumulated,
        count: data.length
      };
    } catch (error) {
      console.error('[Hyperliquid] Error fetching funding history:', error.message);
      throw error;
    }
  }
}

export default HyperliquidConnector;
