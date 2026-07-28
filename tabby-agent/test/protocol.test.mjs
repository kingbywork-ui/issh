import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_BRIDGE_METHOD_SCOPES, AGENT_BRIDGE_TOOLS, getMcpTools } from '../src/protocol.js'
import { buildCall, parseAgentArgs } from '../src/cli.mjs'

test('protocol exposes the complete current bridge surface without removed RAG tools', () => {
    const names = AGENT_BRIDGE_TOOLS.map(tool => tool.name)
    assert.equal(names.length, 17)
    assert(names.includes('tabby_get_output'))
    assert(!names.some(name => name.includes('rag')))
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.tabby_select_session, 'write')
})

test('MCP tools contain operation-specific schemas', () => {
    const tools = getMcpTools()
    const exec = tools.find(tool => tool.name === 'tabby_exec_command')
    assert.deepEqual(exec.inputSchema.required, ['command'])
    assert.equal(exec.inputSchema.properties.timeoutMs.maximum, 3600000)
    assert(!('scope' in exec))
})

test('every published tool has a Tabby service dispatch case', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url))
    const service = fs.readFileSync(
        path.resolve(testDir, '../../tabby-llm/src/services/agentBridge.service.ts'),
        'utf8',
    )
    for (const tool of AGENT_BRIDGE_TOOLS) {
        assert(service.includes(`case '${tool.name}':`), `Missing service dispatch for ${tool.name}`)
    }
})

test('CLI maps output pagination and rejects removed commands', () => {
    const parsed = parseAgentArgs(['output', '--output-id', 'out-1', '--offset', '10', '--limit', '20'])
    assert.deepEqual(buildCall(parsed.command, parsed.options, parsed.positionals), [
        'tabby_get_output',
        { outputId: 'out-1', offset: 10, limit: 20 },
    ])
    assert.throws(() => buildCall('rag', {}, []), /Unknown command/)
})

test('CLI preserves command arguments after the separator', () => {
    const parsed = parseAgentArgs(['exec', '--tab', 'tab-2', '--', 'git', 'status', '--short'])
    assert.deepEqual(buildCall(parsed.command, parsed.options, parsed.positionals), [
        'tabby_exec_command',
        {
            tab: 'tab-2',
            command: 'git status --short',
            timeoutMs: 60000,
            confirmDangerous: false,
        },
    ])
})

test('CLI accepts top-level help', () => {
    const parsed = parseAgentArgs(['--help'])
    assert.equal(parsed.command, 'help')
    assert.equal(parsed.options.help, true)
})
