"""Shared helpers for Tabby UI smoke tests."""
from __future__ import annotations

import os
import subprocess
import time
from typing import Any

import requests

CDP_URL = os.environ.get('TABBY_CDP_URL', 'http://127.0.0.1:9222')
ROOT = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_DIR = os.path.join(ROOT, 'test_screenshots')


def wait_for_cdp(timeout: float = 90) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            requests.get(f'{CDP_URL}/json', timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f'CDP not available at {CDP_URL}')


def ensure_tabby_running() -> None:
    healthy = False
    try:
        requests.get(f'{CDP_URL}/json', timeout=2)
        healthy = _tabby_bootstrap_healthy()
    except Exception:
        pass

    if healthy:
        return

    _kill_tabby()

    electron = os.path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    app_dir = os.path.join(ROOT, 'app')
    env = os.environ.copy()
    env['TABBY_DEV'] = '1'
    env['TABBY_FORCE_ANGULAR_PROD'] = '1'
    env['TABBY_DISABLE_GLASSTRON'] = '1'
    env['TABBY_SMOKE_DISABLE_GPU'] = '1'
    env['TABBY_CONFIG_DIRECTORY'] = os.path.join(ROOT, '.tabby-smoke')
    os.makedirs(env['TABBY_CONFIG_DIRECTORY'], exist_ok=True)
    config_path = os.path.join(env['TABBY_CONFIG_DIRECTORY'], 'config.yaml')
    if not os.path.exists(config_path):
        with open(config_path, 'w', encoding='utf-8') as f:
            f.write('hacks:\n  disableGPU: true\nappearance:\n  vibrancy: false\n  opacity: 1\n')
    log = open(os.path.join(ROOT, 'smoke_launch.log'), 'w', encoding='utf-8')
    subprocess.Popen(
        [electron, app_dir, '--remote-debugging-port=9222', '--disable-gpu', '--disable-software-rasterizer'],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=log,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
    )
    wait_for_cdp(120)


def _kill_tabby() -> None:
    if os.name != 'nt':
        return
    subprocess.run(
        ['taskkill', '/F', '/IM', 'electron.exe'],
        capture_output=True,
        check=False,
    )
    time.sleep(2)


def _tabby_bootstrap_healthy() -> bool:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return True

    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(CDP_URL)
            page = browser.contexts[0].pages[0]
            return bool(page.evaluate('''() => {
                const progress = document.querySelector('.progress .bar')?.style?.width
                if (progress && progress !== '0%' && progress !== '') return true
                if (document.querySelector('app-root .content')) return true
                if (document.querySelector('start-page')) return true
                if (document.querySelector('ngb-modal-window')) return true
                return !!(window.pluginModules && window.pluginModules.length)
            }'''))
    except Exception:
        return False


def get_page(playwright):
    browser = playwright.chromium.connect_over_cdp(CDP_URL)
    for ctx in browser.contexts:
        for pg in ctx.pages:
            if pg.url and 'devtools' not in pg.url.lower():
                return browser, pg
    if browser.contexts and browser.contexts[0].pages:
        return browser, browser.contexts[0].pages[0]
    raise RuntimeError('No page found in CDP browser')


def eval_ssh_layout(page) -> dict[str, Any]:
    return page.evaluate('''() => {
        const q = (sel) => document.querySelector(sel)
        const qa = (sel) => Array.from(document.querySelectorAll(sel))
        const sshTab = q('ssh-tab')
        const appWorkspace = q('app-root .app-workspace')
        const sftpPanel = q('app-root .app-panel-left sftp-panel')
        const sendPanel = q('app-root .app-panel-bottom batch-input-panel')
        const sendTextarea = q('app-root .app-panel-bottom batch-input-panel textarea')
        const content = q('ssh-tab .content')
        const aiSidecar = q('app-root .app-panel-right llm-app-sidecar-host command-sidecar')
        const aiSidecarHost = q('app-root .app-panel-right llm-app-sidecar-host')
        const xterm = q('ssh-tab .xterm') || q('ssh-tab .terminal')
        const rect = (el) => {
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }
        }
        const xtermRect = rect(xterm)
        const aiRect = rect(aiSidecar || aiSidecarHost)
        const sendRect = rect(sendPanel)
        const contentRect = rect(content)
        let aiOverlapsXterm = false
        if (aiSidecar && aiSidecar.offsetParent !== null && xtermRect && aiRect) {
            aiOverlapsXterm = xtermRect.right > aiRect.left + 8
        }
        let sendOverlapsXterm = false
        if (sendPanel && sendPanel.offsetParent !== null && xtermRect && sendRect) {
            sendOverlapsXterm = xtermRect.bottom > sendRect.top + 8
        }
        let xtermLeftClipped = false
        if (xtermRect && contentRect) {
            xtermLeftClipped = xtermRect.left < contentRect.left - 4
        }
        const appWorkspaceClasses = appWorkspace ? appWorkspace.className : ''
        return {
            hasSshTab: !!sshTab,
            hasAppWorkspace: !!appWorkspace,
            appWorkspaceClasses,
            sftpVisible: !!(sftpPanel && sftpPanel.offsetParent !== null),
            sendVisible: !!(sendPanel && sendPanel.offsetParent !== null),
            sendTextareaVisible: !!(sendTextarea && sendTextarea.offsetParent !== null),
            contentRect,
            sftpRect: rect(sftpPanel),
            sendRect,
            xtermRect,
            contentLeft: content ? content.getBoundingClientRect().left : null,
            llmHostRect: aiRect,
            aiSidebarVisible: !!(aiSidecar && aiSidecar.offsetParent !== null),
            llmHostSidecarOpen: !!(aiSidecar && aiSidecar.offsetParent !== null),
            sshTabCount: qa('ssh-tab').length,
            aiOverlapsXterm,
            sendOverlapsXterm,
            xtermLeftClipped,
        }
    }''')


def unlock_vault_if_needed(page) -> bool:
    locked = page.locator('text=Vault is locked')
    if not locked.count():
        return True

    passphrase = os.environ.get('TABBY_VAULT_PASSPHRASE', '')
    if not passphrase:
        print('  [BLOCKED] Vault is locked. Set TABBY_VAULT_PASSPHRASE to run smoke tests.')
        return False

    input_el = page.locator("input[placeholder='Master passphrase']")
    if not input_el.count():
        return False
    input_el.first.fill(passphrase)
    page.keyboard.press('Enter')
    time.sleep(4)
    return page.locator('text=Vault is locked').count() == 0


def open_ssh_tab(page, connect_timeout: float = 45) -> bool:
    if not unlock_vault_if_needed(page):
        return False

    if page.locator('ssh-tab').count():
        return True

    try:
        page.wait_for_selector('start-page', timeout=15000)
    except Exception:
        return False

    deadline = time.time() + 10
    while time.time() < deadline:
        if page.locator('start-page .host-list-item').count():
            break
        time.sleep(0.5)

    connect = page.locator('start-page .connect-btn')
    if connect.count():
        try:
            connect.first.click(timeout=5000)
        except Exception:
            pass
    elif page.locator('start-page .host-list-item').count():
        try:
            page.locator('start-page .host-list-item').first.click(timeout=5000)
        except Exception:
            return False
    else:
        return False

    try:
        page.wait_for_selector('ssh-tab', timeout=int(connect_timeout * 1000))
    except Exception:
        return False

    time.sleep(8)
    return page.locator('ssh-tab').count() > 0


def click_by_text(page, *keywords: str) -> bool:
    for kw in keywords:
        loc = page.locator(f'button:has-text("{kw}"), a:has-text("{kw}"), span:has-text("{kw}")')
        if loc.count():
            try:
                loc.first.click(timeout=3000)
                return True
            except Exception:
                pass
    return False


def open_ai_sidecar(page) -> bool:
    for sel in ['[title="AI 助手"]', '.toolbar-button[title*="AI"]']:
        loc = page.locator(sel)
        if loc.count():
            try:
                loc.first.click(timeout=2000)
                return True
            except Exception:
                pass
    if page.locator('ssh-tab .content').count():
        page.locator('ssh-tab .content').first.click()
        time.sleep(0.3)
        page.keyboard.press('Control+Shift+N')
        return True
    return False
