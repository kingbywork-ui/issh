import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_BRIDGE_METHOD_SCOPES, AGENT_BRIDGE_TOOLS, getMcpTools, normalizeAgentBridgeMethod } from '../src/protocol.js'
import { buildCall, parseAgentArgs } from '../src/cli.mjs'

test('protocol exposes the complete current bridge surface without removed RAG tools', () => {
    const names = AGENT_BRIDGE_TOOLS.map(tool => tool.name)
    assert.equal(names.length, 52)
    assert(names.includes('issh_get_output'))
    assert(names.includes('issh_workspace_bind'))
    assert(names.includes('issh_agent_prompt'))
    assert(names.includes('issh_task_cancel'))
    assert(names.includes('issh_herdr_sync'))
    assert(names.includes('issh_pane_subscribe'))
    assert(names.includes('issh_pane_write'))
    assert(!names.some(name => name.includes('rag')))
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_select_session, 'write')
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.tabby_select_session, 'write')
    assert.equal(normalizeAgentBridgeMethod('tabby_select_session'), 'issh_select_session')
})

test('MCP tools expose only the implemented core surface with operation-specific schemas', () => {
    const tools = getMcpTools()
    assert.equal(tools.length, 38)
    const exec = tools.find(tool => tool.name === 'issh_exec_command')
    assert.deepEqual(exec.inputSchema.required, ['command'])
    assert.equal(exec.inputSchema.properties.timeoutMs.maximum, 3600000)
    assert(!('scope' in exec))
    // 未实现服务端的超前工具不得暴露给外部 agent（诚实降级）：runtime 深层健康、cordis 并发 run、herdr 商城插件仍降级
    for (const name of ['issh_runtime_health', 'issh_cordis_health', 'issh_agent_dispatch', 'issh_run_wait', 'issh_run_collect', 'issh_run_cancel', 'issh_task_run_command', 'issh_herdr_status', 'issh_herdr_start', 'issh_herdr_stop', 'issh_herdr_snapshot', 'issh_herdr_link', 'issh_herdr_unlink', 'issh_herdr_sync']) {
        assert.equal(tools.find(tool => tool.name === name), undefined, `${name} must not be advertised`)
    }
    // scope 表仍覆盖全量协议（未来服务端实现沿用）
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_pane_subscribe, 'read')
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_pane_write, 'write')
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_herdr_stop, 'exec')
    assert.equal(AGENT_BRIDGE_METHOD_SCOPES.issh_herdr_snapshot, 'read')
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

test('CLI exposes bounded Herdr lifecycle and workspace mapping calls', () => {
    const link = parseAgentArgs(['herdr-link', '--workspace-id', 'ws-1', '--herdr-workspace-id', 'w1'])
    assert.deepEqual(buildCall(link.command, link.options, link.positionals), [
        'issh_herdr_link',
        { workspaceId: 'ws-1', herdrWorkspaceId: 'w1' },
    ])
    assert.throws(
        () => buildCall('herdr-sync', {}, []),
        /requires --workspace-id/,
    )
})

test('CLI maps native pane proxy calls and raw byte input', () => {
    const subscribe = parseAgentArgs(['pane-subscribe', '--pane-id', 'pane-1', '--after-sequence', '4'])
    assert.deepEqual(buildCall(subscribe.command, subscribe.options, subscribe.positionals), [
        'issh_pane_subscribe',
        { paneId: 'pane-1', afterSequence: 4, maxEvents: 64, maxBytes: 49152 },
    ])
    const write = parseAgentArgs(['pane-write', '--pane-id', 'pane-1', '--owner-id', 'agent-a', '--hex', '1b5b324a'])
    assert.deepEqual(buildCall(write.command, write.options, write.positionals), [
        'issh_pane_write',
        { paneId: 'pane-1', ownerId: 'agent-a', data: [0x1b, 0x5b, 0x32, 0x4a] },
    ])
    assert.throws(() => buildCall('pane-write', { paneId: 'pane-1', ownerId: 'agent-a', hex: '0' }, []), /even-length hexadecimal/)
})
