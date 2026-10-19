"""Isolated test RPC: real contracts/cross-contract reads with fixture-backed consensus.

The simulator's RPC drops payable value. This test-only method explicitly supplies
transaction value to the VM and restores storage on rejected execution. It does
not claim to verify native-token delivery or production GenVM execution.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/direct'))
from conftest import AETNA_0157, CMS_100_1, real_quote, verdict_json, support_json
from glsim.server import create_app, run_server, RPC_METHODS, _reinstall_persistent_mocks
from glsim.consensus import run_consensus

app = create_app(num_validators=3, max_rotations=2, chain_id=61999, seed='ombuds-milestone-tests')
engine = app.state.engine
engine._persistent_web_mocks = {
    AETNA_0157.replace('?', r'\?'): {'status': 200, 'body': (ROOT / 'tests/fixtures/aetna_cpb_0157.html').read_text()},
    CMS_100_1.replace('?', r'\?'): {'status': 200, 'body': (ROOT / 'tests/fixtures/cms_ncd_100_1.json').read_text()},
}
quote = real_quote((ROOT / 'tests/fixtures/aetna_cpb_0157.html').read_bytes())
engine._persistent_llm_mocks = {
    r'(?s).*adjudicating a denied health insurance claim.*': verdict_json(quote),
    r'(?s).*checking one paragraph of reasoning.*': support_json(),
}
engine.vm._strict_mock_mode = True

def test_call(state, engine, params):
    snapshot = engine.create_snapshot()
    _reinstall_persistent_mocks(engine)
    engine.vm.value = int(params.get('value', '0'))
    if params.get('overturn') is not None:
        engine._persistent_llm_mocks[r'(?s).*adjudicating a denied health insurance claim.*'] = verdict_json(quote, overturn=params['overturn'])
    try:
        def execute():
            engine.vm._llm_mocks.clear()
            engine.vm._web_mocks.clear()
            _reinstall_persistent_mocks(engine)
            result = engine.call_method(params['to'], params['method'], params.get('args', []), sender=params.get('sender'))
            return result, b''
        outcome = run_consensus(engine, execute, 3, 2)
        if outcome.error:
            engine.restore_snapshot(snapshot)
        return {'result': outcome.result, 'error': outcome.error, 'status': str(outcome.status.value), 'votes': outcome.votes}
    finally:
        engine.vm.value = 0

RPC_METHODS['ombuds_testCall'] = test_call
run_server(app, port=4010)
