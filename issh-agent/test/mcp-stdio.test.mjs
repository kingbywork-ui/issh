import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { handleMcpMessage } from '../src/mcp-server.mjs'

let child
let lines
const testDir = path.dirname(fileURLToPath(import.meta.url))

before(() => {
    child = spawn(process.execPath, [path.resolve(testDir, '../bin/issh-mcp-server.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    lines = readline.createInterface({ input: child.stdout })
})

after(() => {
    lines.close()
    child.kill()
})

test('stdio MCP uses newline-delimited JSON and exposes current schemas', async () => {
    const initialize = waitForLine()
    child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
    })}\n`)
    const initialized = JSON.parse(await initialize)
    assert.equal(initialized.id, 1)
    assert.equal(initialized.result.serverInfo.name, 'issh-agent-bridge')

    const toolsResponse = waitForLine()
    child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
    })}\n`)
    const listed = JSON.parse(await toolsResponse)
    assert.equal(listed.result.tools.length, 19)
    assert(!listed.result.tools.some(tool => tool.name.includes('rag')))
    assert.deepEqual(
        listed.result.tools.find(tool => tool.name === 'issh_sftp_write').inputSchema.required,
        ['path', 'content'],
    )
    // 未实现服务端的超前工具不得暴露给外部 agent（诚实降级）
    assert.equal(
        listed.result.tools.find(tool => tool.name === 'issh_pane_write'),
        undefined,
        'issh_pane_write must not be advertised until the server implements it',
    )
})

test('MCP rejects command tools with missing command arguments before RPC', async () => {
    const response = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
            name: 'issh_run_command',
            arguments: {},
        },
    })
    assert.equal(response.id, 3)
    assert.equal(response.result.isError, true)
    assert.deepEqual(JSON.parse(response.result.content[0].text), {
        code: 'invalid_params',
        error: 'The command argument is required and must be a non-empty string.',
    })
})

test('MCP accepts legacy tabby tool aliases during the compatibility window', async () => {
    const response = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
            name: 'tabby_run_command',
            arguments: {},
        },
    })
    assert.equal(response.id, 4)
    assert.equal(response.result.isError, true)
    assert.equal(JSON.parse(response.result.content[0].text).code, 'invalid_params')
})

function waitForLine () {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 3000)
        lines.once('line', line => {
            clearTimeout(timer)
            resolve(line)
        })
    })
}
