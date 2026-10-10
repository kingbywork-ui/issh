import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { main as runCli } from '../src/cli.mjs'
import { handleMcpMessage } from '../src/mcp-server.mjs'

let server
let bridgeFile
let tempDir

before(async () => {
    server = http.createServer((request, response) => {
        assert.equal(request.headers.authorization, 'Bearer connect-test-token')
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
            const call = JSON.parse(body)
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ id: call.id, result: { method: call.method, params: call.params } }))
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issh-connect-timeout-test-'))
    bridgeFile = path.join(tempDir, 'bridge.json')
    fs.writeFileSync(bridgeFile, JSON.stringify({
        token: 'connect-test-token',
        rpcUrl: `http://127.0.0.1:${server.address().port}/rpc`,
    }))
})

after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
})

function captureHttpTimeouts (context) {
    const timeouts = []
    const request = http.request
    context.mock.method(http, 'request', (endpoint, options, onResponse) => {
        timeouts.push(options.timeout)
        return request(endpoint, options, onResponse)
    })
    return timeouts
}

test('MCP connect waits through its total budget plus RPC response grace', async context => {
    const timeouts = captureHttpTimeouts(context)
    const originalBridgeFile = process.env.ISSH_AGENT_BRIDGE_FILE
    process.env.ISSH_AGENT_BRIDGE_FILE = bridgeFile
    try {
        for (const [timeoutMs, expected] of [[undefined, 95000], [1, 5001], [45000, 50000], [3600000, 3605000], [4000000, 3605000]]) {
            const args = { id: 'never-opened-profile', ...(timeoutMs === undefined ? {} : { timeoutMs }) }
            const response = await handleMcpMessage({
                jsonrpc: '2.0', id: timeouts.length + 1, method: 'tools/call',
                params: { name: 'issh_connect_profile', arguments: args },
            })
            assert.equal(response.result.isError, false)
            assert.deepEqual(JSON.parse(response.result.content[0].text), { method: 'issh_connect_profile', params: args })
            assert.equal(timeouts.at(-1), expected, `MCP HTTP wait must outlast connection budget ${timeoutMs ?? 'default'}`)
        }
    } finally {
        if (originalBridgeFile === undefined) delete process.env.ISSH_AGENT_BRIDGE_FILE
        else process.env.ISSH_AGENT_BRIDGE_FILE = originalBridgeFile
    }
})

test('CLI connect defaults to 90 seconds and preserves explicit budgets with response grace', async context => {
    const timeouts = captureHttpTimeouts(context)
    for (const [timeoutMs, expected] of [[undefined, 95000], [1, 5001], [45000, 50000], [3600000, 3605000], [4000000, 3605000]]) {
        let result
        await runCli([
            'connect', '--id', 'never-opened-profile', '--bridge-file', bridgeFile, '--json',
            ...(timeoutMs === undefined ? [] : ['--timeout-ms', String(timeoutMs)]),
        ], { log: value => { result = JSON.parse(value) } })
        assert.equal(result.method, 'issh_connect_profile')
        assert.equal(result.params.timeoutMs, timeoutMs ?? 90000)
        assert.equal(timeouts.at(-1), expected, `CLI HTTP wait must outlast connection budget ${timeoutMs ?? 'default'}`)
    }
})

test('other CLI and MCP tools keep their existing HTTP waits', async context => {
    const timeouts = captureHttpTimeouts(context)
    const originalBridgeFile = process.env.ISSH_AGENT_BRIDGE_FILE
    process.env.ISSH_AGENT_BRIDGE_FILE = bridgeFile
    try {
        for (const [name, args, expected] of [
            ['issh_health', {}, 2000],
            ['issh_sftp_list', { path: '/' }, 30000],
            ['issh_exec_command', { command: 'true' }, 65000],
        ]) {
            const response = await handleMcpMessage({
                jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args },
            })
            assert.equal(response.result.isError, false)
            assert.equal(timeouts.at(-1), expected)
        }
        for (const [argv, expected] of [[['health'], 2000], [['sftp-list', '--path', '/'], 60000], [['exec', '--', 'true'], 65000]]) {
            await runCli([argv[0], '--bridge-file', bridgeFile, ...argv.slice(1)], { log () {} })
            assert.equal(timeouts.at(-1), expected)
        }
    } finally {
        if (originalBridgeFile === undefined) delete process.env.ISSH_AGENT_BRIDGE_FILE
        else process.env.ISSH_AGENT_BRIDGE_FILE = originalBridgeFile
    }
})
