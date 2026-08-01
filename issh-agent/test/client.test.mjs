import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { loadConnection, rpc } from '../src/client.mjs'

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
