"""Project managed Laya phases and summary fallback through the shipped SDK profile."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / 'snapshots/session/laya-managed-progress'
EXPECTED = ROOT / 'scripts/snapshots/python-sdk-single-exe/laya-managed-progress/result.json'


def test_laya_managed_progress(tmp_path: Path) -> None:
    records = [json.loads(line) for line in (FIXTURE / 'session.v4.jsonl').read_text().splitlines()]
    request = next(event['data'] for event in records if event['type'] == 'user/message'
                   and event['data'].get('source', {}).get('kind') == 'user')
    task = ''.join(block['text'] for block in request['content'] if block['type'] == 'text')
    sources = [ROOT / 'snapshots/session/text-turn/cordis.yml', FIXTURE / 'cordis.snapshot.yml',
               ROOT / 'snapshots/session/text-turn/model.cordis.yml']
    patch_dir = tmp_path / 'patches'
    patch_dir.mkdir()
    materializer = """
import { materializeProfilePatch } from './packages/test-support/session-snapshot/src/launcher.ts';
const [cwd, output, ...sources] = process.argv.slice(1);
console.log(JSON.stringify(sources.map((source, index) => materializeProfilePatch(source, cwd, 'sdk', output, index))));
"""
    patches = json.loads(subprocess.check_output(
        ['node', '--import', 'tsx', '--input-type=module', '-e', materializer,
         str(tmp_path), str(patch_dir), *(str(source) for source in sources)], cwd=ROOT, text=True))
    with DeepSeekHarness(
        dsh_bin=str(ROOT / 'apps/cli/lib/bin.js'),
        dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path), profile='sdk',
        patches=tuple(patches),
        provider='deepseek-official', model='deepseek-v4-flash',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay',
             'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_SNAPSHOT_PROVIDER': 'deepseek-official', 'DSH_SNAPSHOT_MODEL': 'deepseek-v4-flash',
             'DSH_SNAPSHOT_FILE': str(FIXTURE / 'session.v4.jsonl')},
    ) as harness:
        result = harness.run(task)
    phases = [event['data']['phase'] for event in result.events if event['type'] == 'laya-pruner/progress']
    notifications = [note.payload['event']['data']['phase'] for note in result.notifications
                     if note.method == 'session.event' and note.payload['event']['type'] == 'laya-pruner/progress']
    assert phases, (result.final_response, result.finish_reason, [event['type'] for event in result.events])
    end = next(event for event in result.events if event['type'] == 'laya-pruner/end')
    summary = next(event for event in result.events if event['type'] == 'compaction/start')
    actual = {'finalResponse': result.final_response, 'phases': phases, 'notificationPhases': notifications,
              'outcome': end['data']['outcome'], 'summaryAfterPruning': end['seq'] < summary['seq']}
    assert actual == json.loads(EXPECTED.read_text())
