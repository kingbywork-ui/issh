import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || path.join(runtimeRoot, 'target', 'debug', 'isshd.exe')
const pipeName = `\\\\.\\pipe\\issh-ssh-probe-smoke-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-ssh-probe-smoke-${process.pid}.sqlite3`)

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
async function request (payload) {
    let lastError
    for (let attempt = 0; attempt < 300; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
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
    const response = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'probe-invalid',
        method: 'ssh.probe',
        params: {
            host: 'example.test',
            port: 22,
            username: 'developer',
            password: 'not-used',
        },
    }))
    assert.equal(response.error.code, -32602)
    assert.match(response.error.message, /expectedHostKey/i)
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

console.log('isshd SSH probe smoke test passed')
