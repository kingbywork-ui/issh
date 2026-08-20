import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || [
    path.join(runtimeRoot, 'target', 'x86_64-pc-windows-msvc', 'debug', 'isshd.exe'),
    path.join(runtimeRoot, 'target', 'debug', 'isshd.exe'),
    path.join(runtimeRoot, 'target', 'x86_64-pc-windows-msvc', 'release', 'isshd.exe'),
].find(candidate => existsSync(candidate))
const pipeName = '\\\\.\\pipe\\issh-pane-smoke-' + process.pid
const databasePath = path.join(os.tmpdir(), `issh-pane-smoke-${process.pid}.sqlite3`)

await access(binary)
await rm(databasePath, { force: true })

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function startRuntime () {
    return spawn(binary, ['--pipe', pipeName, '--database', databasePath], {
        cwd: runtimeRoot,
        stdio: 'ignore',
        windowsHide: true,
    })
}

function waitForExit (child, timeoutMs = 5000) {
    return Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        wait(timeoutMs).then(() => { throw new Error(`isshd did not exit within ${timeoutMs} ms`) }),
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
                    if (settled) return
                    settled = true
                    try { resolve(JSON.parse(response.trim())) } catch (error) { reject(error) }
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
            await wait(50)
        }
    }
    throw lastError
}

const runtime = startRuntime()
try {
    const health = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'health', method: 'runtime.health', params: {},
    }))
    assert.ok(health.result.capabilities.includes('pane.subscribe'))

    const open = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'open',
        method: 'pane.open',
        params: {
            id: 'pane-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            title: 'Operations',
            columns: 120,
            rows: 40,
            producerId: 'herdr-session',
        },
    }))
    assert.equal(open.result.state, 'attached')
    assert.equal((await request(JSON.stringify({
        jsonrpc: '2.0', id: 'list', method: 'pane.list', params: {},
    }))).result.length, 1)

    const claim = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'claim', method: 'pane.claimInput',
        params: { paneId: 'pane-1', ownerId: 'agent-a' },
    }))
    assert.equal(claim.result.inputOwner, 'agent-a')
    const deniedClaim = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'denied-claim', method: 'pane.claimInput',
        params: { paneId: 'pane-1', ownerId: 'agent-b' },
    }))
    assert.equal(deniedClaim.error.code, -32602)

    const wrongWrite = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'wrong-write', method: 'pane.write',
        params: { paneId: 'pane-1', ownerId: 'agent-b', data: [3] },
    }))
    assert.equal(wrongWrite.error.code, -32602)
    const write = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'write', method: 'pane.write',
        params: { paneId: 'pane-1', ownerId: 'agent-a', data: [27, 91, 65] },
    }))
    assert.equal(write.result.acceptedBytes, 3)

    const resized = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'resize', method: 'pane.resize',
        params: { paneId: 'pane-1', actorId: 'agent-a', columns: 160, rows: 48 },
    }))
    assert.equal(resized.result.columns, 160)
    const output = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'output', method: 'pane.pushOutput',
        params: { paneId: 'pane-1', producerId: 'herdr-session', data: [0, 255, 27, 91, 50, 74] },
    }))
    assert.deepEqual(output.result.data, [0, 255, 27, 91, 50, 74])

    const subscription = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'subscribe', method: 'pane.subscribe',
        params: { paneId: 'pane-1', afterSequence: 0, maxEvents: 10, maxBytes: 100 },
    }))
    assert.equal(subscription.result.events.length, 1)
    assert.deepEqual(subscription.result.events[0].data, [0, 255, 27, 91, 50, 74])
    assert.equal(subscription.result.nextAfterSequence, 1)

    const released = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'release', method: 'pane.releaseInput',
        params: { paneId: 'pane-1', ownerId: 'agent-a' },
    }))
    assert.equal(released.result.inputOwner, null)
    const closed = await request(JSON.stringify({
        jsonrpc: '2.0', id: 'close', method: 'pane.close',
        params: { paneId: 'pane-1', producerId: 'herdr-session' },
    }))
    assert.equal(closed.result.state, 'closed')
} finally {
    runtime.kill()
    await waitForExit(runtime).catch(() => {})
}

await rm(databasePath, { force: true })
await rm(`${databasePath}-wal`, { force: true })
await rm(`${databasePath}-shm`, { force: true })
console.log('isshd pane proxy smoke test passed')
