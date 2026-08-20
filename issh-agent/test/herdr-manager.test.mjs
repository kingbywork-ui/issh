import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
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
        return { stdout: '', stderr: '' }
    }

    const response = await manager.request({
        action: 'sync-workspace',
        session: 'issh',
        workspaceId: 'w1',
        isshWorkspaceId: 'ws-1',
        name: 'Production checks',
        agentCount: 4,
        taskCount: 12,
        sequence: 9,
    })
    assert.deepEqual(response, { ok: true, workspaceId: 'w1', sequence: 9 })
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

function paneBridge (overrides = {}) {
    return {
        paneId: 'herdr-pane-test',
        target: 'pane_abc123',
        title: 'Agent pane',
        workspaceId: 'workspace-1',
        ownerId: 'issh-ui-owner',
        producerId: 'herdr:issh:pane_abc123',
        rendererId: 7,
        columns: 120,
        rows: 40,
        request: { action: 'pane-attach', session: 'issh', takeover: true },
        closing: false,
        stdoutBuffer: Buffer.alloc(0),
        outputChain: Promise.resolve(),
        lastHerdrSequence: null,
        reconnectAttempts: 0,
        ...overrides,
    }
}

test('Herdr pane frames preserve full-screen ANSI bytes and enter the Runtime ring', async () => {
    const HerdrManager = loadHerdrManager()
    const runtimeCalls = []
    const paneEvents = []
    const manager = new HerdrManager(async request => {
        runtimeCalls.push(request)
        return { result: { accepted: true } }
    }, (_rendererId, event) => paneEvents.push(event))
    const bridge = paneBridge()
    const ansi = Buffer.from('\x1b[?1049h\x1b[2J\x1b[Hvim\x00\xff', 'latin1')

    await manager.handlePaneRecord(bridge, JSON.stringify({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'ansi',
        width: 120,
        height: 40,
        full: true,
        bytes: ansi.toString('base64'),
    }))

    assert.equal(runtimeCalls.length, 1)
    assert.equal(runtimeCalls[0].method, 'pane.pushOutput')
    assert.deepEqual(Buffer.from(runtimeCalls[0].params.data), ansi)
    assert.equal(paneEvents[0].state, 'attached')
    assert.equal(paneEvents[1].full, true)
    assert.deepEqual(Buffer.from(paneEvents[1].data), ansi)
})

test('Herdr pane output chunks always fit the Runtime 64 KiB JSON-RPC limit', async () => {
    const HerdrManager = loadHerdrManager()
    const runtimeCalls = []
    const manager = new HerdrManager(async request => {
        runtimeCalls.push(request)
        return { result: {} }
    }, () => undefined)
    const bridge = paneBridge()
    const bytes = Buffer.alloc(64 * 1024, 0xff)

    await manager.handlePaneRecord(bridge, JSON.stringify({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'ansi',
        width: 120,
        height: 40,
        full: true,
        bytes: bytes.toString('base64'),
    }))

    assert.ok(runtimeCalls.length > 1)
    assert.deepEqual(
        Buffer.concat(runtimeCalls.map(request => Buffer.from(request.params.data))),
        bytes,
    )
    for (const request of runtimeCalls) {
        assert.ok(Buffer.byteLength(JSON.stringify(request)) < 64 * 1024)
    }
})

test('Herdr pane transport emits the official input and resize NDJSON commands after Runtime authorization', async () => {
    const HerdrManager = loadHerdrManager()
    const runtimeCalls = []
    const manager = new HerdrManager(async request => {
        runtimeCalls.push(request)
        return { result: { accepted: true } }
    }, () => undefined)
    const stdin = new PassThrough()
    let written = ''
    stdin.on('data', chunk => { written += chunk.toString('utf8') })
    const bridge = paneBridge({
        child: { stdin, exitCode: null, signalCode: null },
    })
    manager.paneBridges.set(bridge.paneId, bridge)

    await manager.request({
        action: 'pane-input',
        session: 'issh',
        paneId: bridge.paneId,
        ownerId: 'agent-owner',
        data: [27, 91, 65],
    }, 7)
    await manager.request({
        action: 'pane-resize',
        session: 'issh',
        paneId: bridge.paneId,
        ownerId: 'agent-owner',
        columns: 132,
        rows: 48,
    }, 7)

    assert.equal(runtimeCalls[0].method, 'pane.write')
    assert.equal(runtimeCalls[0].params.ownerId, 'agent-owner')
    assert.equal(runtimeCalls[1].method, 'pane.resize')
    assert.equal(runtimeCalls[1].params.actorId, 'agent-owner')
    const commands = written.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(commands[0], { type: 'terminal.input', bytes: 'G1tB' })
    assert.deepEqual(commands[1], {
        type: 'terminal.resize',
        cols: 132,
        rows: 48,
        cell_width_px: 0,
        cell_height_px: 0,
    })
})

test('Herdr pane parser rejects malformed and out-of-order terminal frames', async () => {
    const HerdrManager = loadHerdrManager()
    const manager = new HerdrManager(async () => ({ result: {} }), () => undefined)
    const bridge = paneBridge({ lastHerdrSequence: 4 })
    const base = {
        type: 'terminal.frame',
        encoding: 'ansi',
        width: 80,
        height: 24,
        full: false,
    }

    await assert.rejects(
        manager.handlePaneRecord(bridge, JSON.stringify({ ...base, seq: 5, bytes: 'not-base64!' })),
        /invalid base64/,
    )
    await assert.rejects(
        manager.handlePaneRecord(bridge, JSON.stringify({ ...base, seq: 4, bytes: '' })),
        /out of order/,
    )
})

test('Herdr pane reconnect loop stops after the bounded retry budget', () => {
    const HerdrManager = loadHerdrManager()
    const paneEvents = []
    const manager = new HerdrManager(async () => ({ result: {} }), (_rendererId, event) => paneEvents.push(event))
    const bridge = paneBridge({ reconnectAttempts: 5 })

    manager.schedulePaneReconnect(bridge, 'server unavailable')

    assert.equal(bridge.reconnectTimer, undefined)
    assert.equal(paneEvents.length, 1)
    assert.equal(paneEvents[0].state, 'error')
    assert.equal(paneEvents[0].reconnectAttempt, 5)
})
