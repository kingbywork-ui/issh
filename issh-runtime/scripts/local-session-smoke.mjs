import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || path.join(runtimeRoot, 'target', 'debug', 'isshd.exe')
const pipeName = `\\\\.\\pipe\\issh-local-session-smoke-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-local-session-smoke-${process.pid}.sqlite3`)

await access(binary)
await rm(databasePath, { force: true })

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const child = spawn(binary, ['--pipe', pipeName, '--database', databasePath], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
})

async function request (payload, attempts = 300) {
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
                socket.setTimeout(2000, () => socket.destroy(new Error('Runtime request timed out')))
                socket.once('connect', () => socket.write(`${payload}\n`))
                socket.on('data', chunk => { response += chunk })
                socket.once('error', error => {
                    if (!settled) {
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

async function subscribeUntil (sessionId, marker, initialCursor = 0) {
    let cursor = initialCursor
    let output = ''
    for (let attempt = 0; attempt < 80; attempt++) {
        const response = await request(JSON.stringify({
            jsonrpc: '2.0',
            id: `subscribe-${attempt}`,
            method: 'session.subscribe',
            params: { sessionId, afterSequence: cursor, maxEvents: 64, maxBytes: 12288 },
        }))
        assert.ok(response.result, JSON.stringify(response))
        cursor = response.result.nextAfterSequence
        output += Buffer.concat(response.result.events.map(event => Buffer.from(event.data))).toString('utf8')
        if (output.includes(marker)) return { output, result: response.result }
        await wait(50)
    }
    throw new Error(`PTY output did not contain ${marker}: ${JSON.stringify(output)}`)
}

try {
    const opened = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'open',
        method: 'session.openLocal',
        params: { title: 'Local smoke', columns: 100, rows: 30 },
    }))
    assert.ok(opened.result)
    assert.equal(opened.result.kind, 'local')
    assert.equal(opened.result.state, 'running')
    assert.equal(opened.result.columns, 100)
    assert.equal(opened.result.rows, 30)
    const sessionId = opened.result.id

    const resized = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'resize',
        method: 'session.resize',
        params: { sessionId, columns: 120, rows: 36 },
    }))
    assert.equal(resized.result.columns, 120)
    assert.equal(resized.result.rows, 36)

    const marker = `ISSH_LOCAL_PTY_${process.pid}`
    const initial = await subscribeUntil(sessionId, '\u001b[6n')
    await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'cursor-report',
        method: 'session.write',
        params: { sessionId, data: Array.from(Buffer.from('\u001b[1;1R')) },
    }))
    const command = `echo ${marker}\r`
    const written = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'write',
        method: 'session.write',
        params: { sessionId, data: Array.from(Buffer.from(command)) },
    }))
    assert.equal(written.result.acceptedBytes, Buffer.byteLength(command))

    const received = await subscribeUntil(sessionId, marker, initial.result.nextAfterSequence)
    assert.match(received.output, new RegExp(marker))

    const closed = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'close',
        method: 'session.close',
        params: { sessionId },
    }))
    assert.equal(closed.result.id, sessionId)
    assert.equal(closed.result.state, 'closed')

    const missing = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'closed-snapshot',
        method: 'session.snapshot',
        params: { sessionId },
    }))
    assert.equal(missing.error.code, -32602)
} finally {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            wait(2000),
        ])
    }
    await rm(databasePath, { force: true })
    await rm(`${databasePath}-wal`, { force: true })
    await rm(`${databasePath}-shm`, { force: true })
}

console.log('isshd local session smoke test passed')
