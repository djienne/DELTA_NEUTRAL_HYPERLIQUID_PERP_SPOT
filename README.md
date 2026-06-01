# Hyperliquid Delta-Neutral Trading Bot

An automated Node.js trading bot that earns funding rate arbitrage on Hyperliquid by maintaining delta-neutral positions (SHORT PERP + LONG SPOT).

**💰 Support this project**:
* Sign up to Hyperliquid with this [referral link](https://app.hyperliquid.xyz/join/FREQTRADE) or use code **FREQTRADE** for 10% fee reduction
* This is an alternative to Liminal, that is also a good option. See [Liminal referral link](https://liminal.money/join/FREQTRADE).

---

## Quick Start

### Prerequisites
- Node.js 18+ (native) or Docker
- Hyperliquid account with API key
- PERP and SPOT balances (~50/50 split recommended)
- Preferably a dedicated account

### Option 1: Native Node.js

```bash
npm install
cp .env.example .env
# Edit .env with your HL_WALLET and HL_PRIVATE_KEY
node bot.js
```

### Option 2: Docker

```bash
cp .env.example .env
# Edit .env with your HL_WALLET and HL_PRIVATE_KEY
docker compose build
docker compose up -d
docker compose logs -f
```

> **Note**: Leverage is automatically set to **1x isolated** before opening each position. No manual setup required.

**Docker Commands**: `up -d` (start) | `logs -f` (view) | `restart` | `down` (stop) | `ps` (status)

Docker persists runtime state under `./data/bot-state.json` by default.

### What It Looks Like

<img src="screen.png" alt="Bot Running Example" width="600">

Real-time display shows: position details, funding info, accumulated earnings, position age, rebalancing status, and market summary.

---

## ⚠️ Important Security Note

**The bot CANNOT transfer funds between PERP/SPOT accounts.** This requires your Ethereum wallet's private key, which is unsafe.

The bot uses **Hyperliquid API key** (from More → API) which can only trade, not transfer funds. You must manually rebalance PERP/SPOT via Hyperliquid interface when needed.

---

## How It Works

**Delta-Neutral Strategy**: SHORT PERP + LONG SPOT in equal sizes to earn funding while eliminating price risk.

**Example**:
- Open SHORT 1 BTC PERP @ $107,500
- Open LONG 1 UBTC SPOT @ $107,500
- Net exposure: $0 (hedged)
- Earn: Funding payments every hour from longs paying people holding short positions (when fundings are positive, that is most of the time)

**The bot automatically**:
- Selects best opportunities by predicted funding when available, with 7-day average funding as context
- Filters by liquidity ($75M+ volume, tight spreads)
- Sets leverage to 1x isolated per-pair before opening
- Opens positions using 95% of balance
- Holds for minimum 2 weeks (configurable)
- Switches if 2x better opportunity found
- Closes immediately if funding turns negative, even before the normal minimum hold time
- Rebalances imbalanced positions at startup

---

## Common Commands

### Market Analysis
```bash
node tests/check-funding-rates.js      # Current funding rates
node tests/check-funding-history.js    # 7-day averages
node tests/check-positions.js          # Your positions
node tests/check-24h-volumes.js        # Trading volumes
```

### Emergency Operations
```bash
node emergency-close.js                # Close all positions
node tests/hedge-positions.js --analyze   # Check for imbalances
node tests/hedge-positions.js --execute   # Fix imbalances
```

### Testing
```bash
node tests/test-rebalancing.js         # Test position switching logic
node tests/test-bot-comprehensive.js   # Test hedge functionality
```

---

## Configuration

**Environment (`.env`)**:
```bash
HL_WALLET=0x...           # Your EVM wallet address
HL_PRIVATE_KEY=0x...      # API key from Hyperliquid (More → API)
```

**Bot Config (`config.json`)**:
- `trading.pairs`: Symbols to trade (BTC, ETH, SOL, etc.)
- `trading.balanceUtilizationPercent`: Use 95% of balance
- `trading.maxOrderSizeUSD`: Optional hard cap for each new position size (`null` means uncapped)
- `trading.maxSlippagePercent`: Market order slippage budget, expressed as a percent
- `trading.takerFeeRate`: Fallback taker fee estimate used when live fills do not include fee data
- `bot.minHoldTimeDays`: Hold time before rebalancing (default: 14)
- `bot.improvementFactor`: Required improvement to switch (default: 2x)
- `thresholds.minVolumeUSDC`: Min 24h volume (default: $75M)
- `thresholds.minFundingRatePercent`: Min funding APY (default: 5%)
- `risk.minFillRatio`: Minimum fill ratio required before an order is treated as complete
- `risk.startupCleanupMode`: Startup behavior for imbalanced exposure (`report-only`, `hedge-only`, or `hedge-or-close`; default: `hedge-only`)

---

## Key Features

* ✅ **Automated Selection**: Ranks opportunities by predicted funding when available
* ✅ **Parallel Execution**: Opens PERP+SPOT simultaneously
* ✅ **State Persistence**: Recovers positions after restart
* ✅ **Auto-fixing**: Fixes imbalanced positions at startup
* ✅ **Negative Funding Protection**: 4-layer defense, auto-switches or closes
* ✅ **Quality Filters**: Volume, spreads, funding thresholds
* ✅ **Real-time Monitoring**: Status updates every 2 minutes
* ✅ **Funding History**: Tracks accumulated earnings
* ✅ **Error Handling**: Exponential backoff on rate limits
* ✅ **Docker Support**: Easy containerized deployment

---

## Performance Expectations

* **Returns**: 5-15% APY from funding rates (market-neutral)
* **Risks**: Funding volatility (becomes negative for a long period), execution risk (orphan leg), liquidation risk (uses 1x leverage to minimize)

---

## Architecture

```
bot.js (main loop)
  ├─ state.js → bot-state.json (persistence)
  ├─ balance.js → PERP/SPOT distribution
  ├─ opportunity.js → funding + volume + spreads
  ├─ trade.js → parallel PERP+SPOT orders
  └─ hedge.js → auto-rebalancing
```

**Utilities**: `funding.js`, `volume.js`, `spread.js`, `arbitrage.js`, `positions.js`, `leverage.js`, `symbols.js`

**Connector**: `hyperliquid.js` (WebSocket + REST API, EIP-712 signatures, rate limiting)

---

## Detailed Documentation

See [CLAUDE.md](CLAUDE.md) for complete technical documentation including:
- Detailed bot decision flow
- Position sizing formulas
- State management
- Order execution details
- Hedge utility documentation
- Test coverage details
- Hyperliquid API specifics
- Common pitfalls and fixes

---












