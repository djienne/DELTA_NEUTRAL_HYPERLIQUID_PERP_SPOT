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
- USDC split ~50/50 between PERP and SPOT: the position size is min(PERP, SPOT) × 95%, and the API key cannot move funds
- **A dedicated account**: the bot treats every PERP position and SPOT balance of the configured pairs as its own, and will hedge, close or resize them

### Option 1: Native Node.js

```bash
npm install
cp hyperliquid.env.example hyperliquid.env
# Edit hyperliquid.env: wallet_address, private_key, is_vault
node bot.js
```

### Option 2: Docker

```bash
cp hyperliquid.env.example hyperliquid.env
# Edit hyperliquid.env (mounted read-only into the container, never copied into the image)
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
- Ranks pairs by **7-day average funding** (the one-hour rate is too noisy to predict the next weeks)
- Filters by liquidity ($75M+ volume, tight spreads)
- Sets leverage to 1x isolated per-pair before opening
- Opens positions using 95% of balance
- Holds at least 7 days (configurable), then **switches only if the expected gain beats the cost**:
  `(candidate 7d avg − held 7d avg) × switchHorizonDays > taker fees on 4 legs + spreads` (≈12 APY-point gap at base fees)
- Closes a position whose 7d average turned negative when its expected loss over the horizon exceeds the closing cost, even inside the minimum hold
- Rebalances imbalanced positions at startup

The switch parameters were measured on 2 years of Hyperliquid funding history (a 7d-average gap is worth ≈8 days of funding over the next 14 days) and checked out-of-sample. Re-run `node tests/check-switch-calibration.js` (read-only) every month or so and update `config.json` only if the estimate leaves its plateau.

---

## Common Commands

### Market Analysis
```bash
node tests/check-funding-rates.js      # Funding accruing this hour
node tests/check-funding-history.js    # 7-day averages (what the bot trades on)
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
npm test                                 # Unit tests (no network, no orders)
node tests/check-switch-calibration.js   # Re-estimate switch parameters from public history (read-only)
```

---

## Configuration

**Credentials (`hyperliquid.env`, gitignored)**:
```bash
wallet_address=0x...   # account the bot trades (the sub-account address if is_vault=true)
private_key=0x...      # API wallet key from Hyperliquid (More → API)
is_vault=false         # true for a sub-account/vault: orders and leverage are signed with vaultAddress
```
For a sub-account, create the API key on the master account. Move USDC between the sub-account's PERP and SPOT from the master in the Hyperliquid UI.

**Bot Config (`config.json`)**:
- `trading.pairs`: Symbols to trade (BTC, ETH, SOL, etc.)
- `trading.balanceUtilizationPercent`: Use 95% of balance
- `trading.maxOrderSizeUSD`: Optional hard cap for each new position size (`null` means uncapped)
- `trading.maxSlippagePercent`: Market order slippage budget, expressed as a percent
- `trading.takerFeeRate` / `trading.spotTakerFeeRate`: Taker fee per leg (perp 0.045%, spot 0.07% at base tier); used by the switch rule and when fills lack fee data
- `bot.minHoldTimeDays`: Minimum hold before a switch (default: 7)
- `bot.switchHorizonDays`: Days of a 7d-average funding gap expected to be earned (default: 8, measured)
- `thresholds.minVolumeUSDC`: Min 24h volume (default: $75M)
- `thresholds.minFundingRatePercent`: Min funding APY (default: 5%)
- `risk.minFillRatio`: Minimum fill ratio required before an order is treated as complete
- `risk.startupCleanupMode`: Startup behavior for imbalanced exposure (`report-only`, `hedge-only`, or `hedge-or-close`; default: `hedge-only`)

---

## Key Features

* ✅ **Automated Selection**: Ranks opportunities by 7-day average funding
* ✅ **Parallel Execution**: Opens PERP+SPOT simultaneously
* ✅ **State Persistence**: Recovers positions after restart
* ✅ **Auto-fixing**: Fixes imbalanced positions at startup
* ✅ **Cost-Aware Switching**: Switches or closes only when the expected funding gain beats fees + spread
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

**Utilities**: `position-decision.js` (switch rule), `funding.js`, `volume.js`, `spread.js`, `arbitrage.js`, `positions.js`, `leverage.js`, `risk.js`

**Connector**: `hyperliquid.js` (WebSocket + REST API, EIP-712 signatures, rate limiting)

---

## Detailed Documentation

See [CLAUDE.md](CLAUDE.md) for the decision flow, order-execution rules, Hyperliquid API specifics and known pitfalls.
