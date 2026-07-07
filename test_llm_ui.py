"""UI smoke test for tabby-llm sidecar and autocomplete."""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field

from smoke_helpers import (
    SCREENSHOT_DIR,
    ensure_tabby_running,
    eval_ssh_layout,
    get_page,
    open_ai_sidecar,
    open_ssh_tab,
)

REPORT_PATH = os.path.join(os.path.dirname(__file__), 'test_llm_ui_report.json')


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


def eval_llm(page) -> dict:
    layout = eval_ssh_layout(page)
    sidecar_input = page.evaluate('''() => {
        const input = document.querySelector('ssh-tab command-sidecar input.form-control')
        const modePill = document.querySelector('ssh-tab command-sidecar .mode-pill')
        return {
            sidecarInput: input ? input.value : null,
            modePillText: modePill ? modePill.textContent.trim() : null,
            errorText: document.querySelector('ssh-tab .error-row span')?.textContent?.trim() ?? null,
            chatMessageCount: document.querySelectorAll('ssh-tab .chat-message').length,
        }
    }''')
    return {**layout, **sidecar_input}


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
        report.add('Open SSH profile from start page', opened)
        layout = eval_llm(page)
        report.add('SSH tab present', layout['hasSshTab'])
        report.add('llm-terminal-host mounted', layout.get('llmHostRect') is not None or layout['llmHostSidecarOpen'])

        if not layout['hasSshTab']:
            report.add('Skipped LLM interaction tests', False, 'no SSH tab')
            browser.close()
            report.save()
            return 1

        open_ai_sidecar(page)
        time.sleep(2)
        ai = eval_llm(page)
        report.add('AI sidecar opens', ai['aiSidebarVisible'] or ai['llmHostSidecarOpen'])
        report.add('AI mode pill shows /ai', ai.get('modePillText') == '/ai', f"pill={ai.get('modePillText')}")
        report.add('AI input has /ai prefix', bool(ai.get('sidecarInput', '').startswith('/ai')),
                     f"input={ai.get('sidecarInput')!r}")
        report.add('llm-host width expands when sidecar open',
                     bool(ai.get('llmHostRect') and ai['llmHostRect']['w'] >= 350),
                     f"rect={ai.get('llmHostRect')}")
        report.add('AI panel does not overlap terminal', not ai['aiOverlapsXterm'],
                     f"xtermRect={ai.get('xtermRect')} llmRect={ai.get('llmHostRect')}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'llm_01_ai_open.png'))

        clear_btn = page.locator('ssh-tab command-sidecar button[title="清空"]')
        if clear_btn.count():
            clear_btn.first.click()
            time.sleep(0.5)
            cleared = eval_llm(page)
            report.add('Clear resets AI input prefix', cleared.get('sidecarInput') == '/ai ',
                         f"input={cleared.get('sidecarInput')!r}")
        else:
            report.add('Clear button present', False)

        dismiss_btn = page.locator('ssh-tab command-sidecar button[title="关闭"]')
        if dismiss_btn.count():
            dismiss_btn.first.click()
            time.sleep(1)
        closed = eval_llm(page)
        report.add('Sidecar dismiss closes panel', not closed['aiSidebarVisible'] and not closed['llmHostSidecarOpen'])

        page.locator('ssh-tab .content').first.click()
        time.sleep(0.3)
        page.keyboard.press('Control+Shift+Space')
        time.sleep(2)
        rag = eval_llm(page)
        report.add('Empty input Ctrl+Shift+Space opens RAG sidecar', rag['llmHostSidecarOpen'] or rag['aiSidebarVisible'],
                     f"mode={rag.get('modePillText')}")
        report.add('RAG mode pill shows /rag', rag.get('modePillText') == '/rag', f"pill={rag.get('modePillText')}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'llm_02_rag_open.png'))

        rag_input = page.locator('ssh-tab command-sidecar input.form-control').first
        rag_input.fill('/rag dnf')
        rag_input.press('Enter')
        time.sleep(3)
        rag_result = eval_llm(page)
        has_feedback = bool(rag_result.get('errorText')) or rag_result.get('chatMessageCount', 0) == 0
        report.add('RAG query shows feedback', has_feedback, f"error={rag_result.get('errorText')!r}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'llm_03_rag_query.png'))

        browser.close()

    report.save()
    failed = [c for c in report.checks if not c.passed]
    print(f'\nReport saved: {REPORT_PATH}')
    print(f'Result: {len(report.checks) - len(failed)}/{len(report.checks)} passed')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
