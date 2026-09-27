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

## ⚠️ Manual PERP ↔ SPOT Rebalancing

**The bot CANNOT move USDC between PERP and SPOT.** A transfer needs your wallet's own private key, which must never go in a file. The API key in `hyperliquid.env` (More → API) can only trade. You do the transfers yourself in the Hyperliquid UI (for a sub-account: from the master account).

**When the bot needs you.** Each position uses min(PERP, SPOT) × 95%, so an uneven split leaves capital idle. Closing a position moves money: the spot sale returns to SPOT, the perp PnL to PERP. The split shifts by about 0.95 × the price move during the hold, so a move of more than ~10% means the next open (including the reopen of a switch) waits for your transfer. Before opening a position, if the free USDC is outside **50/50 ± 5 points** (`bot.maxBalanceImbalancePercent: 10`, i.e. |PERP − SPOT| > 10% of the total), the bot:

1. **goes ON HOLD**: no trade, no exposure, until the funds arrive (an open position is never affected by this rule);
2. prints an `ACTION REQUIRED` banner in the log every 2 minutes;
3. writes **`rebalance-status.json`** next to the state file (`data/` with Docker, `data-paper/` for paper, the bot folder for a plain `node bot.js`), the file to check:

```json
{
  "rebalanceNeeded": true,
  "status": "ACTION_REQUIRED",
  "action": "Transfer 51.36 USDC from PERP to SPOT (Hyperliquid UI, account 0xYourAccount)",
  "bot": "ON HOLD: no trades, no exposure until the transfer arrives",
  "direction": "PERP_TO_SPOT",
  "amountUSDC": 51.36,
  "perpUSDC": 153.2,
  "spotUSDC": 50.48,
  "imbalancePercent": 50.4,
  "maxImbalancePercent": 10,
  "since": "2026-09-27T15:25:43.000Z",
  "updated": "2026-09-27T15:31:43.000Z"
}
```

**What to do**: make the transfer written in `action`. Within 2 minutes the bot sees it, logs `Transfer received`, and resumes by itself. `"status": "OK"` means nothing to do; `updated` is the last check, so an old value means the bot is not running.

**Why ± 5 points**: an imbalance δ wastes about δ of the capital for a whole holding period H (~25 days), while waiting for you wastes all of it for your response time D. Holding is worth it when δ > D / H: 10% fits a response within ~2.5 days. Answer faster and you can lower it (2% for ~12 h).

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
- Fixes unhedged or mismatched legs at startup (it never moves USDC between PERP and SPOT: see below)

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
node tests/check-paper-smoke.js            # Public-data paper open/close, temporary account, no credentials
node tests/check-switch-calibration.js   # Re-estimate switch parameters from public history (read-only)
```

---

## 🧪 Paper Trading (realistic dry run)

The **same bot code** runs unchanged against a **simulated account**, on **live** Hyperliquid market data. Nothing is sent to the exchange and no credentials are used (the container gets no `hyperliquid.env`; orders are signed with a throwaway key and answered by `utils/paper-exchange.js`).

```bash
docker compose --profile paper up -d paper-bot   # start in the background (restarts by itself)
docker compose logs -f paper-bot                 # watch
python paper_stats.py                            # results (--plot saves data-paper/paper-equity.png)
docker compose stop paper-bot                    # pause; the run continues where it was on the next start
```

- **Reset**: stop it, delete `./data-paper/`, start again: a new $1,000 account (500 PERP / 500 SPOT, `config.json` → `paper`).
- **Without Docker**: `PAPER_TRADING=1 node bot.js` (PowerShell: `$env:PAPER_TRADING=1; node bot.js`, and the variable stays set in that window). State always goes to `./data-paper/`, whatever `BOT_STATE_FILE` says, so paper can never write into the live state.
- **Outages and PC restarts**: network outages are ridden out in-process (requests retry, the WebSocket reconnects with backoff), and `restart: unless-stopped` restarts the container if the process dies. For PC restarts, enable Docker Desktop → Settings → General → *Start Docker Desktop when you sign in*. Every account change is written atomically. On restart, the simulator first replays what the exchange did while it was down (hourly funding, paid exactly once, and a liquidation check on 15-min candles) before the bot may trade.
- **Next to the live bot**: both can run at once (separate containers and folders, `data/` and `data-paper/`). The paper bot caps itself at a third of the per-IP API budget (400 of 1200 weight/min). `emergency-close.js` always acts on the LIVE account and refuses to run with `PAPER_TRADING=1`.

**Real vs simulated**

| | Paper | Live |
|---|---|---|
| Decisions, sizes, rounding, limit prices, signing | same code | same code |
| Market data (funding, books, volumes, prices) | live | live |
| Order fills | walk the live order book up to the limit price (IOC, partial fills possible) | exchange |
| Fees | perp 0.045% in USDC, spot 0.07% taken from the received asset | your fee tier |
| Funding | realized hourly rate × position held at that hour × hourly close price | exchange |
| Liquidation (1x isolated short, ~+70–97%) | 15-min candle highs, the whole margin is lost | exchange (mark price) |
| PERP ↔ SPOT transfer | a simulated you: waits 1 h (`paper.transferDelayMinutes`), then moves the requested funds atomically; balances stay unchanged and the bot stays on hold until then | you, in the UI |

**Known limitations**:
- Your own orders don't move the book. Fine at these sizes; each fill walks every level it needs.
- The oracle price is approximated by the 1-hour candle close for funding, and by 15-min trade highs for liquidation (slightly conservative).
- Funding lands in the isolated margin, not in withdrawable USDC (verified on the live account, 2026-09-27).
- One point is unverified and assumed: spot buys are checked against the fill price, not the limit price. Orders that a strict limit-price check would reject are counted as `would_reject_strict` in the stats.
- Fees are the config rates (base tier by default).
- The simulated operator always answers in exactly 1 h. Pending responses survive restarts; transfers created by older versions that already debited the source settle without a second debit.

**Stats** (`python paper_stats.py`):
- Equity, net PnL and APR.
- A PnL decomposition: funding, fees, spread and slippage, basis. A books check must be ~0.
- A per-pair table.
- Positions opened, switches, close reasons, holding times.
- Transfers, time in market and time waiting for a transfer.
- Funding hit rate, max and current drawdown, daily Sharpe.

Raw data in `data-paper/`: `events.jsonl` (fills, funding, transfers, liquidations, equity every 15 min), `paper-ledger.json` (the simulated account), `bot-state.json`, `rebalance-status.json`.

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
- `bot.maxBalanceImbalancePercent`: Hold and ask for a manual transfer when |PERP − SPOT| exceeds this % of the total (default: 10 = 50/50 ± 5 points)
- `paper.startPerpUSDC` / `paper.startSpotUSDC` / `paper.transferDelayMinutes`: Paper account start and simulated transfer delay (paper only)
- `thresholds.minVolumeUSDC`: Min 24h volume (default: $75M)
- `thresholds.minFundingRatePercent`: Min funding APY (default: 5%)
- `risk.maxHedgeMismatchPercent`: Maximum live size mismatch (default: 2%); differences below the executable order minimum are reported as dust.
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
* ✅ **Paper Trading**: Realistic dry run of the same code on live market data (`paper-bot` container)
* ✅ **Rebalance Hold**: Pauses and asks for a manual PERP ↔ SPOT transfer when the split drifts past ± 5 points

---

## Performance Expectations

* **Returns**: 5-15% APY from funding rates (market-neutral)
* **Risks**: Funding volatility (becomes negative for a long period), execution risk (orphan leg), liquidation risk (uses 1x leverage to minimize)

---

## Architecture

```
bot.js (main loop)
  ├─ state.js → bot-state.json (persistence)
  ├─ balance.js → PERP/SPOT USDC split (hold + rebalance-status.json)
  ├─ opportunity.js → funding + volume + spreads
  ├─ trade.js → parallel PERP+SPOT orders
  └─ hedge.js → fix unhedged / mismatched legs
```

**Utilities**: `position-decision.js` (switch rule), `funding.js`, `volume.js`, `spread.js`, `arbitrage.js`, `positions.js`, `leverage.js`, `risk.js`

**Connector**: `hyperliquid.js` (WebSocket + REST API, EIP-712 signatures, rate limiting); `utils/paper-exchange.js` swaps in the simulated account for paper trading

---

## Detailed Documentation

See [CLAUDE.md](CLAUDE.md) for the decision flow, order-execution rules, Hyperliquid API specifics and known pitfalls.

## Recovery and accounting guarantees

- Pending closes finish reducing the remaining legs; they never recreate a leg that already closed. Recovery runs at startup, before each decision cycle and every 2 minutes while an intent is pending; a failed recovery is logged and retried, it does not crash the bot into a restart loop. Unresolved intents block new positions.
- Verification examines the entire managed account. Multiple pairs or a symbol inconsistent with state require manual resolution. Every recovery order that adds perpetual exposure must first receive confirmation of 1x isolated leverage.
- Entry and live hedge checks use the same size-mismatch definition: absolute size difference divided by the larger leg. The default limit is 2%. Lot-rounded differences below the $10 order minimum remain visible as dust and are not repeatedly ordered.
- Entry and exit funding decisions require 168 distinct consecutive hourly observations in the requested seven-day window. Missing history never falls back to the current hour. Recovery closes do not depend on funding history.
- All orders use validated books no older than ten seconds, both since they were received and by exchange time. An exchange clock ahead of the host (Docker/WSL2 clocks lag after sleep) is fine; exchange data older than ten seconds (a halted chain, or a host clock running ahead) blocks orders. Entries refresh both books and recheck spreads, basis, sizes and hedge mismatch. Exit and cleanup orders use fresh prices without entry filters.
- A position adopted from the chain without a known opening time keeps `openTime: null` for accounting, but its minimum hold counts from `adoptedAt`, so it can still be switched.
- Close accounting includes all fills and retries. Known fees and estimates for missing fees are kept separately. Remaining dust is inventory, not a realized sale. History records `accountingComplete`, nullable `totalPnl`, `closeFills` and `residualInventory`; unavailable PnL is counted separately, not as zero. Existing history is not rewritten. Crash recovery preserves known entry information and labels missing historical costs unknown.
- Paper equity snapshots include `pendingOperatorTransfer` for time waiting for the operator. Cash-flow statistics remain distinct from the bot's history totals.

Liquidation-distance protection is not implemented. Paper liquidation still approximates mark-price events with candle extremes and assumes loss of the whole isolated margin; those stress losses are not a faithful reconstruction of exchange book liquidation. A passing smoke check validates execution/accounting mechanics, not investment returns.
