# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Automated delta-neutral bot for Hyperliquid: SHORT PERP + LONG SPOT of the same asset, earning hourly funding
(positive funding = longs pay shorts). It holds one pair at a time, picks the pair with the best **7-day average**
funding, and switches only when the expected gain beats trading costs.

The account must be **dedicated** to the bot: every PERP position and SPOT balance of the configured pairs is
treated as bot exposure and may be hedged, resized or closed.

## Commands

```bash
node bot.js                                  # run the bot (hourly cycles, status every 2 min)
npm test                                     # unit tests (fakes only, no network, no orders)
node tests/check-switch-calibration.js       # re-estimate switch parameters from public funding history (read-only)
node emergency-close.js                      # close everything, PERP and SPOT in parallel

# Read-only diagnostics
node tests/check-funding-history.js          # 7d average vs current funding
node tests/check-funding-rates.js            # funding accruing this hour
node tests/check-24h-volumes.js              # 24h notional volume vs threshold
node tests/check-spreads.js                  # bid-ask spreads
node tests/check-perp-spot-spreads.js        # PERP-SPOT basis
node tests/check-positions.js                # positions + hedge quality
node tests/check-spot-perp-balances.js       # PERP/SPOT USDC split
node tests/hedge-positions.js --analyze      # imbalance report (--execute places orders)

MIN_HOLD_TIME_MS=300000 node bot.js          # override min hold (testing)

PAPER_TRADING=1 node bot.js                  # paper trading: simulated account, live market data (./data-paper/)
docker compose --profile paper up -d paper-bot   # same, persistent container
python paper_stats.py                        # paper results: PnL decomposition, per pair, switches, drawdown
```

Scripts that can place orders (`test-perp-short`, `test-spot-market-orders`, `test-spot-perp-transfer`,
`hedge-positions --execute`) refuse to run unless `RUN_LIVE_TRADING_TESTS=1` (`utils/live-guard.js`).
Never run them from an agent session.

## Architecture

- `bot.js`: orchestrator. Startup recovery, hourly `runCycle`, 2-minute `displayStatus`, `openPosition`, `closeAndReopen`.
- `hyperliquid.js`: connector. WebSocket orderbooks with REST fallback, EIP-712 signing, weighted REST rate limiter
  (1200 weight/min), price/size rounding, PERP↔SPOT symbol mapping.
- `utils/position-decision.js`: the switch rule (`switchEdge`) and the held position's funding signal.
- `utils/opportunity.js`: market data → filters → ranking (`findBestOpportunities`).
- `utils/trade.js`: open/close with parallel PERP+SPOT orders, fill verification, cleanup of orphan legs.
- `utils/positions.js`: on-chain PERP positions / SPOT balances (dust below `MIN_NOTIONAL_USD` = $10 is ignored everywhere).
- `utils/hedge.js`: detect and fix imbalanced exposure (used at startup and after failed trades).
- `utils/state.js`: persistent state (`BOT_STATE_FILE`, default `./bot-state.json`; Docker uses `./data/`; paper is always
  `./data-paper/`), including a
  `pendingIntent` written before every trade so a crash mid-trade is reconciled on restart.
- `utils/risk.js`: config accessors (fees, fill ratio, mismatch limits, managed symbols, startup cleanup mode).
- `utils/paper-exchange.js`: `PaperConnector extends HyperliquidConnector` for `PAPER_TRADING=1`. Signed requests
  (`fetchJsonWithTimeout(exchangeUrl)`) are answered by a simulated account (exchange-style order checks, book-walk
  IOC fills, fees, isolated margin + liquidation, hourly funding replayed after outages, a simulated human who makes
  the transfer asked in `rebalance-status.json`, landing after 1 h); user info queries are served from its ledger,
  anything else is live public data. Header documents every mechanic and assumption.
- Market data: `funding.js` (current + 7d history), `volume.js` (`dayNtlVlm`, already USD), `spread.js`, `arbitrage.js`.

## Decision Flow

```
Startup: load state → verify position on-chain → reconcile pendingIntent → startup cleanup
         (risk.startupCleanupMode: report-only | hedge-only | hedge-or-close)

Hourly cycle, holding position A:
  signal A = A's 7d average funding (even if A no longer passes the filters)
  best     = top-ranked opportunity (ignored if it is A)
  switch   if switchEdge(A, best) > 0
  close    else if switchEdge(A, null) > 0          (negative A whose expected loss beats closing cost)
  hold     otherwise
  Acting requires age >= minHoldTimeDays, unless A's 7d average is negative.

Before any open: free USDC split outside 50/50 ± bot.maxBalanceImbalancePercent/2 → ON HOLD (no trade, no exposure),
  ACTION_REQUIRED banner + <state dir>/rebalance-status.json; displayStatus re-checks every 2 min and resumes.

Hourly cycle, flat:
  filters: bid-ask spread <= 0.15%, PERP-SPOT basis <= 0.5%, 24h volume >= $75M, 7d avg funding >= 5% APY
  rank by 7d avg funding (ties within 0.01% APY → higher volume) → open best, or stay flat if none pass
```

### The switch rule (`switchEdge`)

```
gain = (E_candidate − E_held) × H − cost          E = 7d average funding, annualized; H = switchHorizonDays / 365
cost = 2 × (perp fee + spot fee) + candidate perp + spot spread      (close-only: −E_held × H − one set of leg fees)
```

- **Why the 7d average:** its correlation with the next 14 days of funding is ≈0.53 vs ≈0.23 for the current hour.
  Acting on single negative hours caused churn that lost money.
- **H ≈ 8 days** is measured, not tuned. It is the regression slope of the realized 14-day funding gap on today's 7d-average
  gap (2 years, 8 pairs; ≈9 and ≈7 days on each half). At base fees a switch needs a gap of about 12 APY points.
- **minHoldTimeDays = 7**: out-of-sample results are flat for 1–30 days. 7 days makes each decision use a fresh 7d window.
- `tests/check-switch-calibration.js` re-estimates H and replays the production `switchEdge` out-of-sample against the
  old rule and against never switching. Change config only if the estimates leave the plateau. The configured rule opens only
  ~10–20 positions per year-long half, so P&L differences are noisy; trust the direction and the β estimate, not the exact APY.

## Order Execution Rules

- `status: "ok"` only means the request was valid. Check `response.data.statuses[0]` for `filled` / `error` / `resting`
  (`utils/order-fill.js`).
- PERP and SPOT legs go out together (`Promise.all`). If one leg fails, the filled leg is closed from on-chain state.
- Closes are sized from **on-chain** exposure, not the state file (spot fees are taken in the received token). A close
  counts as done only when the chain shows the managed symbols flat.
- `reduceOnly` is valid for PERP only. It is rejected on SPOT.
- Minimum order notional is $10, checked on `mid × size`.
- Slippage is a **percent** (`5` = 5%). `hyperliquid.normalizeSlippagePercent` divides by 100.
- Price: ≤5 significant figures and ≤ (6 − szDecimals) decimals for perp, (8 − szDecimals) for spot. Size: szDecimals.
  PERP and SPOT round separately. If filled sizes differ by more than `risk.maxOpenHedgeMismatchPercent`, both legs are closed.
- Leverage: 1x isolated, set per pair right before opening. The request goes through `fetchJsonWithTimeout`.
- Position size = min(PERP, SPOT) USDC × `balanceUtilizationPercent`. Do **not** halve it. It must be at least
  `minOrderSizeUSD[symbol]` and at most `maxOrderSizeUSD` (null = uncapped).

## Configuration (`config.json`)

| Key | Meaning |
|---|---|
| `trading.pairs` | PERP symbols; SPOT via `HyperliquidConnector.perpToSpot` (e.g. BTC→UBTC) |
| `trading.minOrderSizeUSD` / `maxOrderSizeUSD` | per-symbol minimum; optional cap |
| `trading.balanceUtilizationPercent` | 95 |
| `trading.maxSlippagePercent` | 5 (percent) |
| `trading.takerFeeRate` / `spotTakerFeeRate` | 0.00045 / 0.0007 per leg, used by `switchEdge` and fee fallback |
| `bot.minHoldTimeDays` / `bot.switchHorizonDays` | 7 / 8 (see above) |
| `bot.maxBalanceImbalancePercent` | 10: hold for a manual transfer when \|PERP − SPOT\| > 10% of free USDC (derivation in `notes.rebalance`) |
| `paper.*` | paper account start USDC per side, simulated transfer delay (paper only) |
| `thresholds.*` | entry filters: volume, bid-ask spread, basis, minimum funding APY |
| `risk.*` | fill ratio, hedge mismatch limits, `startupCleanupMode`, optional `managedSpotSymbols` |
| `rateLimit.*` | concurrency and batch delay for market-data fetches only |

`hyperliquid.env` (gitignored/dockerignored, read by the connector unless a wallet is passed explicitly): `wallet_address`,
`private_key` (API wallet key: can trade, cannot transfer), `is_vault`. With `is_vault=true` the account is a
sub-account/vault: info queries use `wallet_address`, and every signed action (orders, leverage) must carry it as
`vaultAddress`, or the API key trades its master account. `connector.vaultAddress` is the single default for that.

## Hyperliquid API Notes

- Funding is paid hourly. Annualized = hourly × 24 × 365. The 10.95% APY baseline (0.0000125/h) is common, so 7d averages often tie.
- `metaAndAssetCtxs[].funding` is the rate accruing this hour, the same number as `predictedFundings` for Hyperliquid.
- `dayNtlVlm` in `metaAndAssetCtxs` / `spotMetaAndAssetCtxs` is 24h notional in USD. Candle `v` is in coin units.
- SPOT books and contexts use `@{index}` coins (e.g. `@142` = UBTC/USDC). Map with
  `getCoinForOrderbook(spotSymbol, await getAssetId(spotSymbol, true))`. PURR uses `PURR/USDC`.
- `asset.coin` in clearinghouse state is a name string, not an index.
- Info request weights: 2 for `l2Book`, `allMids` and `clearinghouseState`; 20 for most others.
- `userFunding` and `fundingHistory` return at most 500 rows (≈20 days of one position): page with
  `startTime = last.time + 1` (`getUserFundingHistory`). `candleSnapshot` returns at most 5000 candles.
- An API (agent) wallet cannot `usdClassTransfer`: PERP↔SPOT moves need the account's own key (see Development Guidelines).

## Development Guidelines

- **No dry-run branches** in trading functions: anything that creates orders places real orders through the connector.
  Paper trading exists only as a swapped connector (`PAPER_TRADING=1` → `PaperConnector`), so the paper bot runs the
  exact live code; keep it that way (no `if (paper)` in bot/trade/hedge logic beyond the connector choice and banners).
  Analysis-only functions (e.g. `analyzeHedgeNeeds`) are fine.
- **PERP↔SPOT transfers are manual** (the API key cannot transfer; the user will never put the wallet key in a file).
  Never automate them; the bot holds and asks (`rebalance-status.json`).
- Validate market data before use: bid, ask and mid present with mid > 0, and results `Number.isFinite`. Missing volume
  or funding is `null`, so the pair is rejected, never counted as 0.
- Tables reserve a sign column: `n >= 0 ? ' ' + n.toFixed(d) : n.toFixed(d)`.
- Rate-limit (429) errors on market data use `retryWithExponentialBackoff` in `bot.js`.
- Hedge quality: PERFECT < 5% size mismatch, GOOD < 15%, PARTIAL < 30%, WEAK ≥ 30% (`utils/positions.js`).
- New logic gets a unit test in `tests/unit/` with a fake connector; see `trade-cleanup.test.js` for the fake's shape.
