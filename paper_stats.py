#!/usr/bin/env python3
"""Paper-trading statistics for the delta-neutral bot (reads what the paper-bot container writes to ./data-paper).

Usage:  python paper_stats.py [--dir data-paper] [--config config.json] [--plot]

Money comes from events.jsonl, the simulated exchange's own log (fills with fees and mid, hourly funding,
liquidations, transfers, 15-min equity snapshots). Holding times, switches and close reasons come from bot-state.json.
The PnL decomposition is checked against the ledger: "books check residual" = (equity at the last snapshot - start)
- (sum of the components) and must be ~0; anything else means the events and the ledger disagree.
Standard library only; --plot needs matplotlib and writes paper-equity.png next to the data.
"""
import argparse
import itertools
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HOUR = 3600_000
DAY = 24 * HOUR


def ts(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def dur(ms):
    return f'{ms / DAY:.1f} d' if ms >= 2 * DAY else f'{ms / HOUR:.1f} h' if ms >= 2 * HOUR else f'{ms / 60000:.0f} min'


def load_events(path):
    events, bad = [], 0
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1  # a partial last line while the bot is writing
    return events, bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dir', default='data-paper', help='paper data directory (default: data-paper)')
    ap.add_argument('--config', default='config.json', help='for the spot token -> pair mapping')
    ap.add_argument('--plot', action='store_true', help='save an equity / drawdown plot (needs matplotlib)')
    args = ap.parse_args()
    d = Path(args.dir)
    if not (d / 'events.jsonl').exists():
        raise SystemExit(f'No paper run in {d}/ (start it with: docker compose --profile paper up -d paper-bot)')

    events, bad = load_events(d / 'events.jsonl')
    start = next((e for e in events if e['type'] == 'start'), None)
    if start is None:
        raise SystemExit(f'{d}/events.jsonl has no start event: not a paper run, or its first line is damaged.')
    start_cap = start['perpUSDC'] + start['spotUSDC']
    snap_idx = [i for i, e in enumerate(events) if e['type'] == 'equity']
    if not snap_idx:
        raise SystemExit('No equity snapshot yet (the first one is written when the paper bot connects).')
    last = events[snap_idx[-1]]
    snaps = [events[i] for i in snap_idx]

    try:
        perp_to_spot = json.loads(Path(args.config).read_text(encoding='utf-8'))['symbolMapping']['perpToSpot']
    except (OSError, KeyError, ValueError):
        perp_to_spot = {}
    spot_to_perp = {s: p for p, s in perp_to_spot.items()}
    pair = lambda coin: spot_to_perp.get(coin, coin)  # noqa: E731

    # ---- money: flows up to the last snapshot (file order = ledger order), then that snapshot's marks
    per = defaultdict(lambda: defaultdict(float))
    fund_pos = fund_n = 0
    fund_notional = 0.0
    for e in events[:snap_idx[-1] + 1]:
        k = e['type']
        if k == 'fill':
            p = per[pair(e['coin'])]
            p['perp_fee' if e['market'] == 'perp' else 'spot_fee'] += e.get('feeUSD', 0)
            p['trading'] += e.get('realizedPnl', 0) + e.get('cashFlow', 0)
            p['slippage'] += (e['px'] - (e.get('mid') or e['px'])) * e['sz'] * (1 if e['side'] == 'buy' else -1)
        elif k == 'funding':
            p = per[pair(e['coin'])]
            p['funding'] += e['usdc']
            p['hours'] += 1
            fund_n += 1
            fund_pos += e['usdc'] > 0
            fund_notional += abs(e['szi']) * e['px']
        elif k == 'liquidation':
            per[pair(e['coin'])]['liq'] += e['pnl']
    for coin, p in last['positions'].items():
        per[pair(coin)]['trading'] += p['szi'] * (p['mark'] - p['entryPx'])  # unrealized perp PnL
    for token, t in last['tokens'].items():
        per[pair(token)]['trading'] += t['amount'] * t['mid']                 # spot holdings at mid
    for p in per.values():
        # trading = perp realized + unrealized + spot cash flows + spot holdings (spot fees already inside)
        p['fees'] = p['perp_fee'] + p['spot_fee']
        p['price'] = p['trading'] + p['spot_fee']
        p['net'] = p['funding'] + p['price'] - p['fees'] + p['liq']
    tot = {k: sum(p[k] for p in per.values()) for k in ('funding', 'perp_fee', 'spot_fee', 'slippage', 'price', 'liq', 'net')}
    net = last['equity'] - start_cap
    days = (last['t'] - start['t']) / DAY

    # ---- time use, from the 15-min snapshots (gaps while the PC is off are simply not counted)
    in_mkt = [s for s in snaps if s['positions']]
    waiting = [s for s in snaps if not s['positions'] and s['transit'] > 0]
    util = [sum(abs(p['szi']) * p['mark'] for p in s['positions'].values()) / s['equity'] for s in in_mkt]

    # ---- risk: drawdown on the equity curve (transfers in transit included), daily Sharpe
    curve = [(start['t'], start_cap)] + [(s['t'], s['equity']) for s in snaps]
    peak, mdd, mdd_abs, mdd_t = -math.inf, 0.0, 0.0, None
    for t, eq in curve:
        peak = max(peak, eq)
        if (peak - eq) / peak > mdd:
            mdd, mdd_abs, mdd_t = (peak - eq) / peak, peak - eq, t
    cur_dd = (peak - curve[-1][1]) / peak
    daily = {}
    for t, eq in curve:
        daily[t // DAY] = eq  # last equity of each UTC day
    vals = list(daily.values())
    rets = [b / a - 1 for a, b in zip(vals, vals[1:])]
    sharpe = statistics.mean(rets) / statistics.stdev(rets) * math.sqrt(365) if len(rets) >= 5 and statistics.stdev(rets) > 0 else None

    # ---- bot decisions, from bot-state.json
    state_file = d / 'bot-state.json'
    state = json.loads(state_file.read_text(encoding='utf-8')) if state_file.exists() else {}
    history = state.get('history', [])
    current = state.get('position')
    positions = sorted(history + ([current] if current else []), key=lambda p: p.get('openTime', 0))
    opens = Counter(p['symbol'] for p in positions)
    switches = sum(a['symbol'] != b['symbol'] for a, b in zip(positions, positions[1:]))
    holds = [p['duration'] for p in history if p.get('duration')]
    reasons = Counter(p.get('closeReason') or '?' for p in history)
    counts = Counter(e['type'] for e in events)
    rejects = Counter(e['reason'] for e in events if e['type'] == 'reject')
    transfers = [e for e in events if e['type'] == 'transfer_done']

    # ---- report
    s = lambda x: f'{x:+.2f}'  # noqa: E731
    print(f'Paper trading stats  ({d}, {ts(start["t"])} -> {ts(last["t"])}, {days:.1f} days)')
    apr = f'   APR {net / start_cap / days * 365 * 100:+.1f}%' if days >= 1 else ''
    print(f'Equity  start {start_cap:.2f}   now {last["equity"]:.2f}   net {s(net)} ({net / start_cap * 100:+.2f}%){apr}')
    print(f'        time: in market {len(in_mkt) / len(snaps):.0%} | waiting for a transfer {len(waiting) / len(snaps):.0%}'
          f' | flat {1 - (len(in_mkt) + len(waiting)) / len(snaps):.0%}')
    print('\nPnL decomposition (USDC, marked at the last snapshot)')
    for label, v in [('Funding', tot['funding']), ('Perp fees', -tot['perp_fee']), ('Spot fees', -tot['spot_fee']),
                     ('Price / basis', tot['price']), ('  of which spread + slippage vs mid', -tot['slippage']),
                     ('  of which basis + delta drift', tot['price'] + tot['slippage']), ('Liquidations', tot['liq']),
                     ('= Net', tot['net'])]:
        print(f'  {label:<36}{s(v):>10}')
    print(f'  {"Books check residual (must be ~0)":<36}{net - tot["net"]:>+10.4f}')

    print('\nPer pair')
    print(f'  {"Pair":<10}{"Opens":>6}{"Hours":>7}{"Funding":>10}{"Fees":>9}{"Price":>9}{"Liq":>9}{"Net":>9}')
    for name, p in sorted(per.items(), key=lambda kv: -kv[1]['net']):
        print(f'  {name:<10}{opens.get(name, 0):>6}{int(p["hours"]):>7}{s(p["funding"]):>10}{s(-p["fees"]):>9}'
              f'{s(p["price"]):>9}{s(p["liq"]):>9}{s(p["net"]):>9}')

    print('\nActivity')
    print(f'  Positions opened {len(positions)}, switches {switches}, closes by reason: '
          + (', '.join(f'{r} {n}' for r, n in reasons.most_common()) or 'none'))
    if holds:
        print(f'  Holding time (closed positions): mean {dur(statistics.mean(holds))}, median {dur(statistics.median(holds))}')
    if current:
        print(f'  Current position: {current["symbol"]}, held {dur(last["t"] - current["openTime"])}')
    if transfers:
        waits = [e['t'] - e['startedAt'] for e in transfers]
        print(f'  Simulated manual transfers: {len(transfers)}, {sum(e["amount"] for e in transfers):.2f} USDC, mean wait {dur(statistics.mean(waits))}')
    if fund_n:
        print(f'  Funding hours {fund_n}: {fund_pos / fund_n:.0%} positive; realized funding APR on perp notional '
              f'{tot["funding"] / fund_notional * 24 * 365 * 100:.1f}%')
    if util:
        print(f'  Notional per leg while in market: {statistics.mean(util):.0%} of equity')
    print(f'  Rejected orders {counts["reject"]}' + (f' ({dict(rejects)})' if rejects else '')
          + f', would_reject_strict {counts["would_reject_strict"]}, funding_missing {counts["funding_missing"]},'
          f' liquidations {counts["liquidation"]}' + (f', unreadable event lines {bad}' if bad else ''))

    print('\nRisk')
    print(f'  Max drawdown {mdd:.2%} ({mdd_abs:.2f} USDC' + (f', {ts(mdd_t)})' if mdd_t else ')') + f', current {cur_dd:.2%}')
    print(f'  Daily Sharpe (annualized): {sharpe:.2f} over {len(rets)} days' if sharpe is not None
          else f'  Daily Sharpe: needs >= 5 daily returns (have {len(rets)})')

    if args.plot:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        x = [datetime.fromtimestamp(t / 1000, timezone.utc) for t, _ in curve]
        eq = [v for _, v in curve]
        peaks = list(itertools.accumulate(eq, max))
        fig, (a1, a2) = plt.subplots(2, 1, sharex=True, figsize=(10, 6), height_ratios=[3, 1])
        a1.plot(x, eq)
        a1.ticklabel_format(axis='y', useOffset=False)
        a1.set_ylabel('Equity (USDC)')
        a1.set_title('Paper trading equity')
        a2.fill_between(x, [-(pk - v) / pk * 100 for pk, v in zip(peaks, eq)], color='tab:red')
        a2.set_ylabel('Drawdown %')
        fig.tight_layout()
        out = d / 'paper-equity.png'
        fig.savefig(out, dpi=120)
        print(f'\nPlot saved: {out}')


if __name__ == '__main__':
    main()
