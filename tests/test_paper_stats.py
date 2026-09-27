"""Small CLI regression for pending operator transfers and unknown recovered position times."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='hl-stats-check-') as folder:
    d = Path(folder)
    events = [
        {'t': 1790524800000, 'type': 'start', 'perpUSDC': 440, 'spotUSDC': 560},
        {'t': 1790525700000, 'type': 'equity', 'equity': 1000, 'positions': {}, 'tokens': {},
         'transit': 0, 'pendingOperatorTransfer': True},
        {'t': 1790526600000, 'type': 'equity', 'equity': 1000, 'positions': {}, 'tokens': {},
         'transit': 60}  # legacy snapshots have no pendingOperatorTransfer field
    ]
    (d / 'events.jsonl').write_text('\n'.join(map(json.dumps, events)), encoding='utf8')
    (d / 'bot-state.json').write_text(json.dumps({
        'position': {'symbol': 'BTC', 'openTime': None},
        'history': [{'symbol': 'ETH', 'openTime': None, 'totalPnl': None, 'accountingComplete': False}]
    }), encoding='utf8')
    run = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'paper_stats.py'), '--dir', folder],
                         check=True, text=True, capture_output=True)
    assert 'waiting for a transfer 100%' in run.stdout, run.stdout
    assert 'BTC, held unknown' in run.stdout, run.stdout
    assert 'unavailable bot PnL: 1' in run.stdout, run.stdout
    assert '+0.0000' in run.stdout, run.stdout
    print('Paper statistics: delayed and legacy transfers, unknown times and unavailable PnL passed.')
