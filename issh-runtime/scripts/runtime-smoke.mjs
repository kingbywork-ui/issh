import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || path.join(runtimeRoot, 'target', 'debug', 'isshd.exe')
const pipeName = `\\\\.\\pipe\\issh-runtime-smoke-${process.pid}`

await access(binary)

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function startRuntime (...args) {
    return spawn(binary, ['--pipe', pipeName, ...args], {
        cwd: runtimeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    })
}

function waitForExit (child, timeoutMs = 5000) {
    return Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        wait(timeoutMs).then(() => {
            throw new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms`)
        }),
    ])
}

async function request (payload, attempts = 50) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
                const finish = () => {
                    if (settled) {
                        return
                    }
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
                    if (error.code === 'EPIPE' && response.trim()) {
                        finish()
                    } else if (!settled) {
                        settled = true
                        reject(error)
                    }
                })
                socket.once('close', finish)
            })
        } catch (error) {
            lastError = error
            await wait(50)
        }
    }
    throw lastError
}

const primary = startRuntime()
try {
    const health = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'health',
        method: 'runtime.health',
        params: {},
    }))
    assert.equal(health.jsonrpc, '2.0')
    assert.equal(health.id, 'health')
    assert.equal(health.result.protocolVersion, '0.1.0')
    assert.equal(health.result.runtimeVersion, '0.1.0')
    assert.ok(Number.isInteger(health.result.pid))
    assert.ok(Number.isInteger(health.result.startedAtUnixMs))
    assert.deepEqual(health.result.capabilities, ['runtime.health'])

    const invalid = await request('{invalid-json')
    assert.equal(invalid.error.code, -32700)

    const unknown = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'missing.method',
    }))
    assert.equal(unknown.id, 7)
    assert.equal(unknown.error.code, -32601)

    const oversized = await request(`{"padding":"${'x'.repeat(64 * 1024)}"}`)
    assert.equal(oversized.error.code, -32001)

    const duplicate = startRuntime()
    const duplicateExit = await waitForExit(duplicate)
    assert.notEqual(duplicateExit.code, 0, 'a second runtime must not own the same pipe')
} finally {
    primary.kill()
    await waitForExit(primary).catch(() => {})
}

const once = startRuntime('--once')
const recovered = await request(JSON.stringify({
    jsonrpc: '2.0',
    id: 'recovered',
    method: 'runtime.health',
}))
assert.equal(recovered.id, 'recovered')
assert.equal((await waitForExit(once)).code, 0)

console.log('isshd runtime smoke test passed')
