import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const component = await readFile(new URL('../src/BridgeSettingsTab.svelte', import.meta.url), 'utf8')
const rpc = await readFile(new URL('../src/bridgeRpc.ts', import.meta.url), 'utf8')

function extractBlock (source, startText) {
    const start = source.indexOf(startText)
    assert.notEqual(start, -1, `missing source block: ${startText}`)
    const open = source.indexOf('{', start)
    let depth = 0
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1
        if (source[index] === '}') depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
    }
    throw new Error(`unterminated source block: ${startText}`)
}

function loadDetectAgents ({ probeRemoteAgents, readSessionOutput }) {
    const commandsStart = component.indexOf('const REMOTE_AGENT_COMMANDS')
    const commandsEnd = component.indexOf('] as const', commandsStart) + '] as const'.length
    const source = `${component.slice(commandsStart, commandsEnd)}\n${extractBlock(component, 'async function detectAgents')}\nglobalThis.detectAgents = detectAgents`
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const context = { probeRemoteAgents, readSessionOutput, console, scanErrors: [] }
    vm.createContext(context)
    vm.runInContext(javascript, context)
    return { detectAgents: context.detectAgents, context }
}

async function captureProbeCommand () {
    const javascript = ts.transpileModule(rpc, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
    let request
    module.setGateway({ request: async (method, params) => { request = { method, params }; return { output: '' } } })
    await module.probeRemoteAgents('fixture-session')
    assert.equal(request.method, 'ssh.execReadonly')
    return request.params.command
}

test('terminal scrollback is not accepted as installation evidence', async () => {
    const { detectAgents, context } = loadDetectAgents({
        probeRemoteAgents: async () => { throw new Error('readonly probe denied') },
        readSessionOutput: async () => '$ codex --help\nPi coding agent is documented here',
    })
    const result = await detectAgents(
        [{ id: 'ssh-1', title: 'fixture', profileType: 'ssh', connected: true }],
        { bindings: [{ sessionId: 'ssh-1' }] },
    )
    assert.deepEqual(Array.from(result), [], 'terminal history/documentation must not become an installed-agent result')
    assert.equal(context.scanErrors.length, 1, 'the failed remote probe must be retained for UI feedback')
})

test('a successful remote executable probe remains authoritative', async () => {
    const { detectAgents } = loadDetectAgents({
        probeRemoteAgents: async () => ({ output: 'codex\t/home/test/.local/bin/codex\n' }),
        readSessionOutput: async () => 'unrelated terminal text',
    })
    const result = await detectAgents(
        [{ id: 'ssh-1', title: 'fixture', profileType: 'ssh', connected: true }],
        { bindings: [{ sessionId: 'ssh-1' }] },
    )
    assert.equal(result.length, 1)
    assert.equal(result[0].name, 'Codex')
    assert.equal(result[0].path, '/home/test/.local/bin/codex')
    assert.equal(result[0].source, 'remote')
})

test('a rescan exposes progress and per-session probe failures', () => {
    assert.match(component, /let\s+scanning\s*=\s*\$state\(/, 'the rescan needs its own visible running state')
    assert.match(component, /let\s+scanStatus\s*=\s*\$state\(/, 'the rescan result needs visible status text')
    assert.match(component, /let\s+scanErrors\s*=\s*\$state[<(]/, 'remote probe failures must be retained instead of silently swallowed')
    assert.doesNotMatch(component, /catch\s*\{\s*\/\/\s*SSH exec[^}]*\}/, 'SSH probe failure must not be silently ignored')
    assert.match(component, /disabled=\{[^}]*scanning[^}]*\}/, 'the rescan button must reflect that a scan is running')
})

test('actual remote probe command finds Codex installed under an nvm user directory', async () => {
    const command = await captureProbeCommand()
    const fixtureHome = await mkdtemp(join(tmpdir(), 'issh-agent-scan-'))
    try {
        const bin = join(fixtureHome, '.nvm', 'versions', 'node', 'v22.0.0', 'bin')
        await mkdir(bin, { recursive: true })
        await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        const output = execFileSync('C:\\Program Files\\Git\\bin\\bash.exe', ['-c', command], {
            encoding: 'utf8',
            env: { ...process.env, HOME: fixtureHome.replaceAll('\\\\', '/'), PATH: '/usr/bin:/bin' },
        })
        assert.match(output, /^codex\t.+\/\.nvm\/versions\/node\/v22\.0\.0\/bin\/codex$/m)
    } finally {
        await rm(fixtureHome, { recursive: true, force: true })
    }
})
