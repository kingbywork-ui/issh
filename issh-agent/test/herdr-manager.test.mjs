import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function loadHerdrManager () {
    const filename = path.resolve(testDir, '../../app/lib/herdr.ts')
    const source = fs.readFileSync(filename, 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: filename,
    }).outputText
    const module = { exports: {} }
    Function('exports', 'module', 'require', compiled)(module.exports, module, require)
    return module.exports.HerdrManager
}

const compatibleStatus = JSON.stringify({
    client: { version: '0.8.1', protocol: 20 },
    server: {
        running: true,
        version: '0.8.1',
        protocol: 20,
        compatible: true,
        socket: '\\\\.\\pipe\\herdr-test',
        restart_needed: false,
    },
})

test('Herdr manager enforces the version contract and external ownership boundary', async () => {
    const HerdrManager = loadHerdrManager()
    const manager = new HerdrManager()
    manager.runCli = async () => ({ stdout: compatibleStatus, stderr: '' })

    const status = await manager.request({ action: 'status', session: 'issh' })
    assert.equal(status.compatible, true)
    assert.equal(status.protocol, 20)
    assert.equal(status.nativeOnly, false)

    const stopped = await manager.request({ action: 'stop', session: 'issh' })
    assert.equal(stopped.stopped, false)
    assert.equal(stopped.reason, 'not_owned')
    assert.equal(stopped.running, true)
})

test('Herdr manager downgrades incompatible servers without mutating them', async () => {
    const HerdrManager = loadHerdrManager()
    const manager = new HerdrManager()
    manager.runCli = async () => ({
        stdout: JSON.stringify({
            client: { version: '0.8.1', protocol: 20 },
            server: { running: true, version: '0.7.0', protocol: 19, compatible: false },
        }),
        stderr: '',
    })

    const status = await manager.request({ action: 'status', session: 'issh' })
    assert.equal(status.compatible, false)
    assert.equal(status.nativeOnly, true)
    assert.match(status.lastError, /contract mismatch/)
})

test('Herdr workspace sync sends bounded aggregate metadata only', async () => {
    const HerdrManager = loadHerdrManager()
    const manager = new HerdrManager()
    let syncArgs = null
    manager.runCli = async (_request, args) => {
        if (args[0] === 'status') {
            return { stdout: compatibleStatus, stderr: '' }
        }
        syncArgs = args
        return { stdout: JSON.stringify({ id: 'test', result: { type: 'ok' } }), stderr: '' }
    }

    await manager.request({
        action: 'sync-workspace',
        session: 'issh',
        workspaceId: 'w1',
        isshWorkspaceId: 'ws-1',
        name: 'Production checks',
        agentCount: 4,
        taskCount: 12,
        sequence: 9,
    })
    const rendered = syncArgs.join(' ')
    assert.match(rendered, /issh_workspace_id=ws-1/)
    assert.match(rendered, /issh_agents=4/)
    assert.match(rendered, /issh_tasks=12/)
    assert.doesNotMatch(rendered, /password=|secret=|recentOutput=|apiKey=/)
})

test('Herdr manager rejects excess queued work with bounded backpressure', async () => {
    const HerdrManager = loadHerdrManager()
    const manager = new HerdrManager()
    let release
    const blocked = new Promise(resolve => { release = resolve })
    manager.perform = async () => blocked

    const requests = Array.from({ length: 35 }, () => manager.request({ action: 'status', session: 'issh' }))
    const rejected = await requests[34].then(() => false, () => true)
    assert.equal(rejected, true)
    release()
    await Promise.allSettled(requests)
    manager.shutdown()
})
