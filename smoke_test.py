"""Run all Tabby UI smoke tests (layout + LLM)."""
from __future__ import annotations

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPORT_PATH = os.path.join(ROOT, 'smoke_test_report.json')


def run_script(name: str) -> dict:
    path = os.path.join(ROOT, name)
    print(f'\n=== {name} ===')
    proc = subprocess.run([sys.executable, path], cwd=ROOT)
    report_name = name.replace('.py', '_report.json')
    report_file = os.path.join(ROOT, report_name)
    detail = {}
    if os.path.exists(report_file):
        with open(report_file, encoding='utf-8') as f:
            detail = json.load(f)
    passed = proc.returncode == 0
    return {
        'script': name,
        'passed': passed,
        'exit_code': proc.returncode,
        'detail': detail,
    }


def main() -> int:
    from smoke_helpers import ensure_tabby_running

    print('Ensuring Tabby CDP is available...')
    ensure_tabby_running()

    results = [
        run_script('test_layout_ui.py'),
        run_script('test_llm_ui.py'),
    ]
    all_passed = all(r['passed'] for r in results)
    summary = {
        'passed': all_passed,
        'total_scripts': len(results),
        'failed_scripts': [r['script'] for r in results if not r['passed']],
        'results': results,
    }
    with open(REPORT_PATH, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f'\nSmoke summary: {sum(1 for r in results if r["passed"])}/{len(results)} scripts passed')
    print(f'Report: {REPORT_PATH}')
    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())
