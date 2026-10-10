import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const browser = process.env.ISSH_TEST_BROWSER || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)
assert.ok(browser, 'Set ISSH_TEST_BROWSER to a Chromium browser executable')
const directory = mkdtempSync(path.join(tmpdir(), 'issh-dialog-layout-'))
const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8') + readFileSync(new URL('../../plugins/issh-plugin-config-sync/src/sync.css', import.meta.url), 'utf8')
const classes = ['connect-panel', 'editor-panel', 'profile-selector', 'confirm-modal', 'install-dialog', 'confirm-dialog', 'settings-panel', 'sftp-delete-dialog', 'app-dialog', 'sync-modal']
try {
    const fixture = path.join(directory, 'layout.html')
    writeFileSync(fixture, `<!doctype html><meta charset="UTF-8"><style>${css}</style><body><pre id="result"></pre><script>
        const results = [];
        for (const name of ${JSON.stringify(classes)}) {
            const native = name === 'sftp-delete-dialog' || name === 'app-dialog';
            const backdrop = document.createElement('div');
            backdrop.className = name === 'settings-panel' ? 'settings-backdrop' : name === 'confirm-dialog' ? 'confirm-backdrop' : name === 'sync-modal' ? 'sync-modal-mask' : 'modal-backdrop';
            const panel = document.createElement(native ? 'dialog' : 'div');
            panel.className = name;
            panel.innerHTML = '<h2>Dialog</h2><p>' + 'Content '.repeat(100) + '</p><button>Close</button>';
            if (name === 'settings-panel') panel.innerHTML = '<header class="settings-header">Settings</header><div class="settings-body"><main class="settings-content">' + '<p>Content</p>'.repeat(100) + '</main></div>';
            if (native) { document.body.append(panel); panel.showModal(); }
            else { backdrop.append(panel); document.body.append(backdrop); }
            const rect = panel.getBoundingClientRect();
            results.push({ name, dx: rect.x + rect.width / 2 - innerWidth / 2, dy: rect.y + rect.height / 2 - innerHeight / 2, inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 });
            if (native) panel.remove(); else backdrop.remove();
        }
        document.getElementById('result').textContent = JSON.stringify(results);
    </script>`)
    for (const size of ['1200,800', '640,480']) {
        const run = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(directory, 'profile')}`, `--window-size=${size}`, '--dump-dom', pathToFileURL(fixture).href], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        assert.equal(run.status, 0, run.error?.message || run.stderr)
        const result = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1]
        assert.ok(result, 'Chromium did not return the layout measurements')
        const entries = JSON.parse(result.replaceAll('&quot;', '"'))
        console.log(`${size}: ${JSON.stringify(entries)}`)
        const failures = entries.filter((entry) => Math.abs(entry.dx) > 1 || Math.abs(entry.dy) > 1 || !entry.inside)
        assert.deepEqual(failures, [], 'Dialogs must stay centered and inside the application viewport')
    }
    console.log('Dialog layout: centered and bounded at desktop and small-window sizes passed')
} finally {
    const absoluteDirectory = path.resolve(directory)
    assert.equal(path.dirname(absoluteDirectory), path.resolve(tmpdir()))
    assert.ok(path.basename(absoluteDirectory).startsWith('issh-dialog-layout-'))
    rmSync(absoluteDirectory, { recursive: true, force: true })
}
