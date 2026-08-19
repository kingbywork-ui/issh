import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_BRIDGE_METHOD_SCOPES, AGENT_BRIDGE_TOOLS, getMcpTools, normalizeAgentBridgeMethod } from '../src/protocol.js'
import { buildCall, parseAgentArgs } from '../src/cli.mjs'

test('protocol exposes the complete current bridge surface without removed RAG tools', () => {
    const names = AGENT_BRIDGE_TOOLS.map(tool => tool.name)
    assert.equal(names.length, 30)
    assert(names.includes('issh_get_output'))
    assert(names.includes('issh_workspace_bind'))
    assert(names.includes('issh_agent_prompt'))
    assert(names.includes('issh_task_cancel'))
    assert(!names.some(name => name.includes('rag')))
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_select_session, 'write')
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.tabby_select_session, 'write')
    assert.equal(normalizeAgentBridgeMethod('tabby_select_session'), 'issh_select_session')
})

test('MCP tools contain operation-specific schemas', () => {
    const tools = getMcpTools()
    const exec = tools.find(tool => tool.name === 'issh_exec_command')
    assert.deepEqual(exec.inputSchema.required, ['command'])
    assert.equal(exec.inputSchema.properties.timeoutMs.maximum, 3600000)
    assert(!('scope' in exec))
    const bind = tools.find(tool => tool.name === 'issh_workspace_bind')
    assert.deepEqual(bind.inputSchema.required, ['workspaceId', 'sessionId'])
    const prompt = tools.find(tool => tool.name === 'issh_agent_prompt')
    assert.deepEqual(prompt.inputSchema.required, ['agentId', 'prompt'])
})

test('every published tool has a issh service dispatch case', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url))
    const service = fs.readFileSync(
        path.resolve(testDir, '../../issh-llm/src/services/agentBridge.service.ts'),
        'utf8',
    )
    for (const tool of AGENT_BRIDGE_TOOLS) {
        assert(service.includes(`case '${tool.name}':`), `Missing service dispatch for ${tool.name}`)
    }
})

test('CLI maps output pagination and rejects removed commands', () => {
    const parsed = parseAgentArgs(['output', '--output-id', 'out-1', '--offset', '10', '--limit', '20'])
    assert.deepEqual(buildCall(parsed.command, parsed.options, parsed.positionals), [
        'issh_get_output',
        { outputId: 'out-1', offset: 10, limit: 20 },
    ])
    assert.throws(() => buildCall('rag', {}, []), /Unknown command/)
})

test('CLI preserves command arguments after the separator', () => {
    const parsed = parseAgentArgs(['exec', '--tab', 'tab-2', '--', 'git', 'status', '--short'])
    assert.deepEqual(buildCall(parsed.command, parsed.options, parsed.positionals), [
        'issh_exec_command',
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
