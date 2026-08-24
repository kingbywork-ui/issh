import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || path.join(runtimeRoot, 'target', 'debug', 'isshd.exe')
const pipeName = `\\\\.\\pipe\\issh-ssh-session-smoke-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-ssh-session-smoke-${process.pid}.sqlite3`)

await access(binary)
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function removeFile (filePath) {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await rm(filePath, { force: true })
            return
        } catch (error) {
            if (error.code !== 'EBUSY') throw error
            await wait(100)
        }
    }
    throw new Error(`Could not remove locked file: ${filePath}`)
}

await removeFile(databasePath)
const child = spawn(binary, ['--pipe', pipeName, '--database', databasePath], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
})
async function request (payload, attempts = 300, timeoutMs = 2000) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
                socket.setEncoding('utf8')
                socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Runtime request timed out')))
                socket.once('connect', () => socket.write(`${payload}\n`))
                socket.on('data', chunk => { response += chunk })
                socket.once('error', error => {
                    if (!settled) {
                        settled = true
                        reject(error)
                    }
                })
                socket.once('close', () => {
                    if (settled) return
                    settled = true
                    try { resolve(JSON.parse(response.trim())) } catch (error) { reject(error) }
                })
            })
        } catch (error) {
            lastError = error
            await wait(50)
        }
    }
    throw lastError
}

try {
    const missingKey = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'ssh-open-missing-key',
        method: 'session.openSsh',
        params: {
            host: 'example.test',
            port: 22,
            username: 'developer',
            password: 'not-used',
        },
    }))
    assert.equal(missingKey.error.code, -32602)
    assert.match(missingKey.error.message, /expectedHostKey/i)

    const badDimensions = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'ssh-open-bad-dimensions',
        method: 'session.openSsh',
        params: {
            host: 'example.test',
            port: 22,
            username: 'developer',
            password: 'not-used',
            expectedHostKey: 'SHA256:test-fingerprint',
            columns: 0,
            rows: 0,
        },
    }))
    assert.equal(badDimensions.error.code, -32602)

    const unreachable = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'ssh-open-unreachable',
        method: 'session.openSsh',
        params: {
            title: 'SSH smoke',
            host: '127.0.0.1',
            port: 1,
            username: 'developer',
            password: 'not-used',
            expectedHostKey: 'SHA256:test-fingerprint',
            columns: 100,
            rows: 30,
        },
    }), 10, 30000)
    assert.equal(unreachable.error.code, -32602)
    assert.match(unreachable.error.message, /transport|connect|refused/i)
} finally {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            wait(2000),
        ])
    }
    await removeFile(databasePath)
    await removeFile(`${databasePath}-wal`)
    await removeFile(`${databasePath}-shm`)
}

console.log('isshd SSH session smoke test passed')
