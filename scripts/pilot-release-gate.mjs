import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = path.join(repositoryRoot, 'issh-runtime')
const runtimeCandidates = [
    path.join(runtimeRoot, 'target', 'x86_64-pc-windows-msvc', 'release', 'isshd.exe'),
    path.join(runtimeRoot, 'target', 'debug', 'isshd.exe'),
]
const binary = runtimeCandidates.find(candidate => fs.existsSync(candidate))
assert.ok(binary, 'isshd.exe is required for the pilot release gate')

const pipeName = `\\\\.\\pipe\\issh-runtime-pilot-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-runtime-pilot-${process.pid}.sqlite3`)
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function waitForExit (child, timeoutMs = 5000) {
    return Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        sleep(timeoutMs).then(() => { throw new Error(`isshd did not exit within ${timeoutMs} ms`) }),
    ])
}

async function request (payload, attempts = 40) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
                const finish = () => {
                    if (settled) return
                    settled = true
                    try {
                        resolve(JSON.parse(response.trim()))
                    } catch (error) {
                        reject(error)
                    }
                }
                socket.setEncoding('utf8')
                socket.once('connect', () => socket.write(`${payload}\n`))
                socket.on('data', chunk => { response += chunk })
                socket.once('error', error => {
                    if (error.code === 'EPIPE' && response.trim()) finish()
                    else if (!settled) { settled = true; reject(error) }
                })
                socket.once('close', finish)
            })
        } catch (error) {
            lastError = error
            await sleep(25)
        }
    }
    throw lastError
}

function percentile (values, fraction) {
    const sorted = [...values].sort((left, right) => left - right)
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    return sorted[index]
}

async function runRuntimePerformanceBaseline () {
    fs.rmSync(databasePath, { force: true })
    const child = spawn(binary, ['--pipe', pipeName, '--database', databasePath], {
        cwd: runtimeRoot,
        stdio: 'ignore',
        windowsHide: true,
    })
    try {
        await request(JSON.stringify({
            jsonrpc: '2.0',
            id: 'pilot-warmup',
            method: 'runtime.health',
            params: {},
        }))
        const latencies = []
        for (let index = 0; index < 40; index++) {
            const started = performance.now()
            const response = await request(JSON.stringify({
                jsonrpc: '2.0',
                id: `pilot-${index}`,
                method: 'runtime.health',
                params: {},
            }))
            latencies.push(performance.now() - started)
            assert.equal(response.result?.protocolVersion, '0.4.0')
            assert.equal(response.result?.runtimeVersion, '0.4.0')
        }
        const p50 = percentile(latencies, 0.5)
        const p95 = percentile(latencies, 0.95)
        const max = Math.max(...latencies)
        assert.ok(p95 < 100, `runtime.health p95 exceeded 100ms: ${p95.toFixed(2)}ms`)
        assert.ok(max < 1000, `runtime.health max exceeded 1000ms: ${max.toFixed(2)}ms`)
        console.log(JSON.stringify({
            check: 'runtime.health local named-pipe latency',
            samples: latencies.length,
            p50Ms: Number(p50.toFixed(2)),
            p95Ms: Number(p95.toFixed(2)),
            maxMs: Number(max.toFixed(2)),
            binary: path.relative(repositoryRoot, binary),
        }))
    } finally {
        child.kill()
        await waitForExit(child).catch(() => {})
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${databasePath}${suffix}`, { force: true })
    }
}

function runAccessibilityStaticChecks () {
    const workspaceTemplate = fs.readFileSync(path.join(repositoryRoot, 'issh-llm', 'src', 'components', 'workspaceSettingsTab.component.pug'), 'utf8')
    const bridgeTemplate = fs.readFileSync(path.join(repositoryRoot, 'issh-llm', 'src', 'components', 'agentBridgeSettingsTab.component.pug'), 'utf8')
    const checks = [
        ['Herdr enabled checkbox has an explicit label', workspaceTemplate.includes("id='herdr-enabled'") && workspaceTemplate.includes("for='herdr-enabled'")],
        ['Herdr autostart checkbox has an explicit label', workspaceTemplate.includes("id='herdr-autostart'") && workspaceTemplate.includes("for='herdr-autostart'")],
        ['Agent bridge tablist has an accessible name', bridgeTemplate.includes("role='tablist', aria-label='选择智能体'")],
        ['Agent bridge tabs expose selection state', bridgeTemplate.includes("role='tab'") && bridgeTemplate.includes('[attr.aria-selected]')],
        ['Scope controls expose pressed state', bridgeTemplate.includes('[attr.aria-pressed]')],
        ['Copy controls expose accessible labels', bridgeTemplate.includes("[attr.aria-label]='\"复制\" + item.label'")],
        ['Collapsible service settings expose expanded state', bridgeTemplate.includes('[attr.aria-expanded]')],
    ]
    for (const [description, passed] of checks) assert.ok(passed, description)
    console.log(JSON.stringify({ check: 'settings accessibility static contract', checks: checks.length, passed: checks.length }))
}

await runRuntimePerformanceBaseline()
runAccessibilityStaticChecks()
console.log('pilot release gate passed')
