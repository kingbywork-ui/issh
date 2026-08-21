import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const runtimeRoot = path.resolve(import.meta.dirname, '..')
const binary = process.env.ISSHD_BIN || path.join(runtimeRoot, 'target', 'debug', 'isshd.exe')
const pipeName = `\\\\.\\pipe\\issh-runtime-smoke-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-runtime-smoke-${process.pid}.sqlite3`)

await access(binary)
await rm(databasePath, { force: true })

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function startRuntime (...args) {
    return spawn(binary, ['--pipe', pipeName, '--database', databasePath, ...args], {
        cwd: runtimeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    })
}

function waitForExit (child, timeoutMs = 5000) {
    return Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        wait(timeoutMs).then(() => {
            throw new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms`)
        }),
    ])
}

async function request (payload, attempts = 50) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
                const finish = () => {
                    if (settled) {
                        return
                    }
                    settled = true
                    try {
                        resolve(JSON.parse(response.trim()))
                    } catch (error) {
                        reject(error)
                    }
                }
                socket.setEncoding('utf8')
                socket.once('connect', () => socket.write(`${payload}\n`))
                socket.on('data', chunk => { response += chunk })
                socket.once('error', error => {
                    if (error.code === 'EPIPE' && response.trim()) {
                        finish()
                    } else if (!settled) {
                        settled = true
                        reject(error)
                    }
                })
                socket.once('close', finish)
            })
        } catch (error) {
            lastError = error
            await wait(50)
        }
    }
    throw lastError
}

function requestOnce (payload) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(pipeName)
        let response = ''
        let settled = false
        const finish = () => {
            if (settled) {
                return
            }
            settled = true
            try {
                resolve(JSON.parse(response.trim()))
            } catch (error) {
                reject(error)
            }
        }
        socket.setEncoding('utf8')
        socket.once('connect', () => socket.write(`${payload}\n`))
        socket.on('data', chunk => { response += chunk })
        socket.once('error', error => {
            if (error.code === 'EPIPE' && response.trim()) {
                finish()
            } else if (!settled) {
                settled = true
                reject(error)
            }
        })
        socket.once('close', finish)
    })
}

let interruptedTaskId
const primary = startRuntime()
try {
    const health = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'health',
        method: 'runtime.health',
        params: {},
    }))
    assert.equal(health.jsonrpc, '2.0')
    assert.equal(health.id, 'health')
    assert.equal(health.result.protocolVersion, '0.4.0')
    assert.equal(health.result.runtimeVersion, '0.4.0')
    assert.ok(Number.isInteger(health.result.pid))
    assert.ok(Number.isInteger(health.result.startedAtUnixMs))
    assert.deepEqual(health.result.capabilities, [
        'runtime.health',
        'session.sync',
        'session.list',
        'session.openLocal',
        'session.snapshot',
        'session.write',
        'session.resize',
        'session.subscribe',
        'session.close',
        'workspace.create',
        'workspace.list',
        'workspace.bind',
        'workspace.unbind',
        'agent.register',
        'agent.list',
        'agent.authorize',
        'task.prompt',
        'task.start',
        'task.wait',
        'task.read',
        'task.list',
        'task.cancel',
        'task.complete',
        'task.fail',
        'event.list',
        'pane.list',
        'pane.open',
        'pane.snapshot',
        'pane.close',
        'pane.claimInput',
        'pane.releaseInput',
        'pane.write',
        'pane.resize',
        'pane.pushOutput',
        'pane.subscribe',
    ])

    const immediateHealth = await requestOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 'immediate-health',
        method: 'runtime.health',
    }))
    assert.equal(immediateHealth.result.pid, health.result.pid)

    const synchronized = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'sync',
        method: 'session.sync',
        params: {
            sessions: [{
                id: 'ssh-tab-1',
                title: 'production',
                customTitle: null,
                active: true,
                focused: true,
                profileType: 'ssh',
                profileName: 'Production',
                profileId: 'profile-1',
                host: 'example.test',
                user: 'operator',
                port: 22,
                connected: true,
            }],
        },
    }))
    assert.deepEqual(synchronized.result, {
        sessionCount: 1,
        reconnectedBindings: 0,
        disconnectedBindings: 0,
    })

    const sessions = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'sessions',
        method: 'session.list',
    }))
    assert.equal(sessions.result[0].id, 'ssh-tab-1')

    const created = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'create-workspace',
        method: 'workspace.create',
        params: { name: 'Operations' },
    }))
    assert.equal(created.result.id, 'workspace-1')

    const bound = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'bind-workspace',
        method: 'workspace.bind',
        params: { workspaceId: created.result.id, sessionId: 'ssh-tab-1' },
    }))
    assert.equal(bound.result.bindings[0].sessionId, 'ssh-tab-1')

    const workspaces = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'workspaces',
        method: 'workspace.list',
    }))
    assert.equal(workspaces.result[0].name, 'Operations')

    const agent = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'register-agent',
        method: 'agent.register',
        params: {
            workspaceId: created.result.id,
            name: 'Operator',
            adapter: 'llm',
            sessionId: 'ssh-tab-1',
        },
    }))
    assert.equal(agent.result.status, 'idle')
    assert.deepEqual(agent.result.scopes, ['context.read', 'llm.prompt', 'command.propose'])

    const deniedExecute = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'authorize-agent',
        method: 'agent.authorize',
        params: { agentId: agent.result.id, scope: 'command.execute' },
    }))
    assert.equal(deniedExecute.error.code, -32602, JSON.stringify(deniedExecute))

    const queued = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'prompt-agent',
        method: 'task.prompt',
        params: { agentId: agent.result.id, prompt: 'Summarize host status' },
    }))
    assert.equal(queued.result.status, 'queued')

    const started = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'start-task',
        method: 'task.start',
        params: { taskId: queued.result.id },
    }))
    assert.equal(started.result.status, 'running')

    const waiting = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'wait-task',
        method: 'task.wait',
        params: { taskId: queued.result.id },
    }))
    assert.equal(waiting.result.terminal, false)

    const completed = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'complete-task',
        method: 'task.complete',
        params: { taskId: queued.result.id, output: 'Host is healthy' },
    }))
    assert.equal(completed.result.output, 'Host is healthy')

    const events = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'events',
        method: 'event.list',
        params: { workspaceId: created.result.id },
    }))
    assert.ok(events.result.length >= 6)
    assert.ok(events.result.every((event, index, items) => index === 0 || event.sequence > items[index - 1].sequence))

    const cancellable = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'cancellable',
        method: 'task.prompt',
        params: { agentId: agent.result.id, prompt: 'Long-running task' },
    }))
    const cancelled = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'cancel-task',
        method: 'task.cancel',
        params: { taskId: cancellable.result.id },
    }))
    assert.equal(cancelled.result.status, 'cancelled')

    const interrupted = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'interrupted',
        method: 'task.prompt',
        params: { agentId: agent.result.id, prompt: 'Recover after restart' },
    }))
    await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'start-interrupted',
        method: 'task.start',
        params: { taskId: interrupted.result.id },
    }))
    interruptedTaskId = interrupted.result.id

    const unbound = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 'unbind-workspace',
        method: 'workspace.unbind',
        params: { workspaceId: created.result.id, sessionId: 'ssh-tab-1' },
    }))
    assert.deepEqual(unbound.result.bindings, [])

    const invalid = await request('{invalid-json')
    assert.equal(invalid.error.code, -32700)

    const unknown = await request(JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'missing.method',
    }))
    assert.equal(unknown.id, 7)
    assert.equal(unknown.error.code, -32601)

    const oversized = await request(`{"padding":"${'x'.repeat(64 * 1024)}"}`)
    assert.equal(oversized.error.code, -32001)

    const duplicate = startRuntime()
    const duplicateExit = await waitForExit(duplicate)
    assert.notEqual(duplicateExit.code, 0, 'a second runtime must not own the same pipe')
} finally {
    primary.kill()
    await waitForExit(primary).catch(() => {})
}

const once = startRuntime('--once')
const recovered = await request(JSON.stringify({
    jsonrpc: '2.0',
    id: 'recovered',
    method: 'task.read',
    params: { taskId: interruptedTaskId },
}))
assert.equal(recovered.id, 'recovered')
assert.equal(recovered.result.status, 'interrupted')
assert.equal((await waitForExit(once)).code, 0)

await rm(databasePath, { force: true })
await rm(`${databasePath}-wal`, { force: true })
await rm(`${databasePath}-shm`, { force: true })

console.log('isshd runtime smoke test passed')
