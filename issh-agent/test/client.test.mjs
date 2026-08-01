import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { candidateConnectionFiles, loadConnection, rpc } from '../src/client.mjs'

let server
let port
let tempDir

before(async () => {
    server = http.createServer((request, response) => {
        assert.equal(request.headers.authorization, 'Bearer test-token')
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
            const parsed = JSON.parse(body)
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ id: parsed.id, result: { method: parsed.method, params: parsed.params } }))
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issh-agent-test-'))
})

after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
})

test('loads a validated connection and calls loopback RPC', async () => {
    const file = path.join(tempDir, 'bridge.json')
    fs.writeFileSync(file, JSON.stringify({
        host: '127.0.0.1',
        port,
        token: 'test-token',
        rpcUrl: `http://127.0.0.1:${port}/rpc`,
    }))
    const connection = loadConnection(file)
    const result = await rpc(connection, 'issh_health', { check: true })
    assert.deepEqual(result, { method: 'issh_health', params: { check: true } })
})

test('rejects non-loopback connection files', () => {
    const file = path.join(tempDir, 'remote.json')
    fs.writeFileSync(file, JSON.stringify({
        token: 'test-token',
        rpcUrl: 'http://example.com/rpc',
    }))
    assert.throws(() => loadConnection(file), /loopback host/)
})

test('prefers ISSH connection environment variables', () => {
    const names = [
        'ISSH_AGENT_BRIDGE_FILE',
        'TABBY_AGENT_BRIDGE_FILE',
        'ISSH_CONFIG_DIRECTORY',
        'TABBY_CONFIG_DIRECTORY',
    ]
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
        process.env.ISSH_AGENT_BRIDGE_FILE = path.join(tempDir, 'primary.json')
        process.env.TABBY_AGENT_BRIDGE_FILE = path.join(tempDir, 'legacy.json')
        process.env.ISSH_CONFIG_DIRECTORY = path.join(tempDir, 'primary-config')
        process.env.TABBY_CONFIG_DIRECTORY = path.join(tempDir, 'legacy-config')
        const candidates = candidateConnectionFiles()
        assert.equal(candidates[0], path.resolve(tempDir, 'primary.json'))
        const primaryConfigFile = path.resolve(tempDir, 'primary-config', 'issh-agent-bridge.json')
        const legacyConfigFile = path.resolve(tempDir, 'primary-config', 'tabby-agent-bridge.json')
        assert.equal(candidates[1], primaryConfigFile)
        assert.ok(candidates.includes(legacyConfigFile))
        assert.ok(candidates.indexOf(primaryConfigFile) < candidates.indexOf(legacyConfigFile))
        assert.ok(!candidates.includes(path.resolve(tempDir, 'legacy.json')))
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) {
                delete process.env[name]
            } else {
                process.env[name] = value
            }
        }
    }
})

test('falls back to legacy connection environment variables', () => {
    const names = [
        'ISSH_AGENT_BRIDGE_FILE',
        'TABBY_AGENT_BRIDGE_FILE',
        'ISSH_CONFIG_DIRECTORY',
        'TABBY_CONFIG_DIRECTORY',
    ]
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
        delete process.env.ISSH_AGENT_BRIDGE_FILE
        delete process.env.ISSH_CONFIG_DIRECTORY
        process.env.TABBY_AGENT_BRIDGE_FILE = path.join(tempDir, 'legacy.json')
        process.env.TABBY_CONFIG_DIRECTORY = path.join(tempDir, 'legacy-config')
        const candidates = candidateConnectionFiles()
        assert.equal(candidates[0], path.resolve(tempDir, 'legacy.json'))
        const primaryConfigFile = path.resolve(tempDir, 'legacy-config', 'issh-agent-bridge.json')
        const legacyConfigFile = path.resolve(tempDir, 'legacy-config', 'tabby-agent-bridge.json')
        assert.equal(candidates[1], primaryConfigFile)
        assert.ok(candidates.includes(legacyConfigFile))
        assert.ok(candidates.indexOf(primaryConfigFile) < candidates.indexOf(legacyConfigFile))
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) {
                delete process.env[name]
            } else {
                process.env[name] = value
            }
        }
    }
})

test('prefers the issh discovery file over the legacy filename', () => {
    const configDirectory = path.join(tempDir, 'discovery-precedence')
    fs.mkdirSync(configDirectory, { recursive: true })
    const primaryFile = path.join(configDirectory, 'issh-agent-bridge.json')
    const legacyFile = path.join(configDirectory, 'tabby-agent-bridge.json')
    const makeConnection = token => ({
        host: '127.0.0.1',
        port,
        token,
        rpcUrl: `http://127.0.0.1:${port}/rpc`,
    })
    fs.writeFileSync(primaryFile, JSON.stringify(makeConnection('primary-token')))
    fs.writeFileSync(legacyFile, JSON.stringify(makeConnection('legacy-token')))

    const names = ['ISSH_AGENT_BRIDGE_FILE', 'TABBY_AGENT_BRIDGE_FILE', 'ISSH_CONFIG_DIRECTORY', 'TABBY_CONFIG_DIRECTORY']
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
        delete process.env.ISSH_AGENT_BRIDGE_FILE
        delete process.env.TABBY_AGENT_BRIDGE_FILE
        delete process.env.TABBY_CONFIG_DIRECTORY
        process.env.ISSH_CONFIG_DIRECTORY = configDirectory
        assert.equal(loadConnection().token, 'primary-token')
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) {
                delete process.env[name]
            } else {
                process.env[name] = value
            }
        }
    }
})

test('loads an explicitly configured legacy discovery file', () => {
    const legacyFile = path.join(tempDir, 'explicit-legacy.json')
    fs.writeFileSync(legacyFile, JSON.stringify({
        host: '127.0.0.1',
        port,
        token: 'legacy-token',
        rpcUrl: `http://127.0.0.1:${port}/rpc`,
    }))
    const names = ['ISSH_AGENT_BRIDGE_FILE', 'TABBY_AGENT_BRIDGE_FILE']
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
        delete process.env.ISSH_AGENT_BRIDGE_FILE
        process.env.TABBY_AGENT_BRIDGE_FILE = legacyFile
        assert.equal(loadConnection().token, 'legacy-token')
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) {
                delete process.env[name]
            } else {
                process.env[name] = value
            }
        }
    }
})
