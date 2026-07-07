"""UI smoke test for SSH three-panel + bottom Send layout."""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field

from smoke_helpers import (
    CDP_URL,
    SCREENSHOT_DIR,
    click_by_text,
    ensure_tabby_running,
    eval_ssh_layout,
    get_page,
    open_ai_sidecar,
    open_ssh_tab,
)

REPORT_PATH = os.path.join(os.path.dirname(__file__), 'test_layout_ui_report.json')


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ''


@dataclass
class Report:
    checks: list[CheckResult] = field(default_factory=list)

    def add(self, name: str, passed: bool, detail: str = '') -> None:
        self.checks.append(CheckResult(name, passed, detail))
        status = 'PASS' if passed else 'FAIL'
        print(f'  [{status}] {name}' + (f' — {detail}' if detail else ''))

    def save(self) -> None:
        with open(REPORT_PATH, 'w', encoding='utf-8') as f:
            json.dump({
                'passed': all(c.passed for c in self.checks),
                'total': len(self.checks),
                'failed': [c.name for c in self.checks if not c.passed],
                'checks': [c.__dict__ for c in self.checks],
            }, f, ensure_ascii=False, indent=2)


def main() -> int:
    from playwright.sync_api import sync_playwright

    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    report = Report()

    print('Ensuring Tabby CDP...')
    ensure_tabby_running()

    with sync_playwright() as p:
        browser, page = get_page(p)
        print(f'Connected: {page.url}')
        page.wait_for_load_state('domcontentloaded')
        time.sleep(3)

        opened = open_ssh_tab(page)
        report.add('Vault unlocked / SSH profile opened', opened,
                     'set TABBY_VAULT_PASSPHRASE if vault locked' if not opened else '')
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'ui_01_ssh_tab.png'))

        layout = eval_ssh_layout(page)
        report.add('SSH tab present', layout['hasSshTab'], f"count={layout['sshTabCount']}")
        report.add('App-level panel workspace', layout['hasAppWorkspace'],
                     layout.get('appWorkspaceClasses', ''))
        report.add('Send panel auto-visible on connect', layout['sendVisible'],
                     f"sendRect={layout['sendRect']}")
        report.add('Send panel does not overlap terminal', not layout['sendOverlapsXterm'],
                     f"sendRect={layout['sendRect']} xtermRect={layout['xtermRect']}")
        report.add('Terminal text not clipped on left', not layout.get('xtermLeftClipped'),
                     f"xtermLeft={(layout.get('xtermRect') or {}).get('left')} contentLeft={(layout.get('contentRect') or {}).get('left')}")

        if not layout['hasSshTab']:
            report.add('Skipped panel interaction tests', False, 'no SSH tab available')
            browser.close()
            report.save()
            return 1

        before = eval_ssh_layout(page)
        if before['sftpVisible']:
            click_by_text(page, 'SFTP')
            time.sleep(1)
            before = eval_ssh_layout(page)
        sftp_clicked = click_by_text(page, 'SFTP')
        time.sleep(1.5)
        after = eval_ssh_layout(page)
        report.add('SFTP toolbar button works', sftp_clicked)
        report.add('SFTP left panel opens', after['sftpVisible'] and not before['sftpVisible'],
                     f"before={before['sftpVisible']} after={after['sftpVisible']}")
        if after['xtermRect'] and before.get('xtermRect'):
            xterm_narrowed = after['xtermRect']['w'] < before['xtermRect']['w'] - 30
            report.add('Terminal narrows when SFTP opens', xterm_narrowed,
                         f"xtermW {before['xtermRect']['w']:.0f} -> {after['xtermRect']['w']:.0f}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'ui_02_sftp_open.png'))

        layout = eval_ssh_layout(page)
        if layout['sendVisible'] and layout['sendTextareaVisible']:
            textarea = page.locator('app-root .app-panel-bottom batch-input-panel textarea').first
            textarea.fill('echo layout-test')
            textarea.press('Control+Enter')
            time.sleep(1)
            cleared = page.locator('app-root .app-panel-bottom batch-input-panel textarea').first.input_value() == ''
            report.add('Send clears command after send', cleared)
        else:
            report.add('Send panel textarea available', False, 'textarea not visible')

        pre_ai = eval_ssh_layout(page)
        xterm_before_ai = pre_ai.get('xtermRect', {}).get('w') if pre_ai.get('xtermRect') else None
        ai_clicked = open_ai_sidecar(page)
        time.sleep(2)
        ai_layout = eval_ssh_layout(page)
        report.add('AI assistant opens', ai_clicked)
        report.add('AI right sidebar opens', ai_layout['aiSidebarVisible'] or ai_layout['llmHostSidecarOpen'],
                     f"sidecarOpen={ai_layout['llmHostSidecarOpen']} rect={ai_layout['llmHostRect']}")
        report.add('AI panel does not overlap terminal', not ai_layout['aiOverlapsXterm'],
                     f"xtermRect={ai_layout['xtermRect']} llmRect={ai_layout['llmHostRect']}")
        if ai_layout['xtermRect'] and xterm_before_ai:
            ai_narrowed = ai_layout['xtermRect']['w'] < xterm_before_ai - 30
            report.add('Terminal narrows when AI opens', ai_narrowed,
                         f"xtermW {xterm_before_ai:.0f} -> {ai_layout['xtermRect']['w']:.0f}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'ui_03_ai_open.png'))

        send_before = eval_ssh_layout(page)['sendVisible']
        click_by_text(page, 'Send')
        time.sleep(1)
        send_after = eval_ssh_layout(page)['sendVisible']
        report.add('Toolbar Send toggles bottom panel', send_before != send_after,
                     f"{send_before} -> {send_after}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'ui_04_send_toggle.png'))

        browser.close()

    report.save()
    failed = [c for c in report.checks if not c.passed]
    print(f'\nReport saved: {REPORT_PATH}')
    print(f'Result: {len(report.checks) - len(failed)}/{len(report.checks)} passed')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
