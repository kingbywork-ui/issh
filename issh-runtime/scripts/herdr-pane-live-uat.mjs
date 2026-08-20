import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, rm } from 'node:fs/promises'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDir, '../..')
const require = createRequire(import.meta.url)

function loadHerdrManager () {
    const filename = path.join(repositoryRoot, 'app/lib/herdr.ts')
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

const binaryPath = process.env.HERDR_BIN
const runtimeBinaryPath = process.env.ISSHD_BIN || [
    path.join(repositoryRoot, 'issh-runtime', 'target', 'x86_64-pc-windows-msvc', 'debug', 'isshd.exe'),
    path.join(repositoryRoot, 'issh-runtime', 'target', 'debug', 'isshd.exe'),
    path.join(repositoryRoot, 'issh-runtime', 'target', 'x86_64-pc-windows-msvc', 'release', 'isshd.exe'),
].find(candidate => fs.existsSync(candidate))
const session = process.env.HERDR_SESSION || 'issh-phase8-uat'
const target = process.env.HERDR_TARGET
if (!binaryPath || !target || !runtimeBinaryPath) {
    throw new Error('Set HERDR_BIN, HERDR_TARGET, and ISSHD_BIN (unless a local isshd build exists) to run the live pane UAT')
}

const runtimeCalls = []
const paneEvents = []
const pipeName = `\\\\.\\pipe\\issh-herdr-pane-uat-${process.pid}`
const databasePath = path.join(os.tmpdir(), `issh-herdr-pane-uat-${process.pid}.sqlite3`)
let runtime

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function waitForExit (child, timeoutMs = 5000) {
    return Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        wait(timeoutMs).then(() => { throw new Error(`isshd did not exit within ${timeoutMs} ms`) }),
    ])
}

async function rawRuntimeRequest (request, attempts = 50) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipeName)
                let response = ''
                let settled = false
                const finish = () => {
                    if (settled) return
                    settled = true
                    try { resolve(JSON.parse(response.trim())) } catch (error) { reject(error) }
                }
                socket.setEncoding('utf8')
                socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
                socket.on('data', chunk => { response += chunk })
                socket.once('error', error => {
                    if (error.code === 'EPIPE' && response.trim()) finish()
                    else if (!settled) { settled = true; reject(error) }
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

const runtimeRequest = async request => {
    runtimeCalls.push(request)
    return rawRuntimeRequest(request)
}
const HerdrManager = loadHerdrManager()
const manager = new HerdrManager(runtimeRequest, (_rendererId, event) => paneEvents.push(event))
const paneId = 'herdr-live-uat-pane'
const ownerId = 'herdr-live-uat-owner'

async function waitFor (predicate, message, timeoutMs = 10000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (predicate()) {
            return
        }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(message)
}

try {
    await access(binaryPath)
    await access(runtimeBinaryPath)
    await rm(databasePath, { force: true })
    runtime = spawn(runtimeBinaryPath, ['--pipe', pipeName, '--database', databasePath], {
        cwd: path.join(repositoryRoot, 'issh-runtime'),
        stdio: 'ignore',
        windowsHide: true,
    })
    const health = await rawRuntimeRequest({
        jsonrpc: '2.0', id: 'health', method: 'runtime.health', params: {},
    })
    assert.ok(health.result.capabilities.includes('pane.pushOutput'))

    await manager.request({
        action: 'pane-attach',
        binaryPath,
        session,
        paneId,
        target,
        workspaceId: 'herdr-live-uat-workspace',
        ownerId,
        title: 'Herdr live UAT',
        columns: 100,
        rows: 30,
        takeover: true,
    }, 99)
    await waitFor(
        () => paneEvents.some(event => event.type === 'state' && event.state === 'attached'),
        'Herdr controller did not emit an attached frame',
    )
    await manager.request({
        action: 'pane-input',
        binaryPath,
        session,
        paneId,
        ownerId,
        data: [...Buffer.from('echo ISSH_PHASE8_UAT\r')],
    }, 99)
    await manager.request({
        action: 'pane-resize',
        binaryPath,
        session,
        paneId,
        ownerId,
        columns: 111,
        rows: 33,
    }, 99)
    try {
        await waitFor(() => {
            const output = Buffer.concat(
                paneEvents.filter(event => event.type === 'output').map(event => Buffer.from(event.data)),
            ).toString('utf8')
            return output.includes('ISSH_PHASE8_UAT')
        }, 'Herdr pane did not echo the live UAT marker', 20000)
    } catch (error) {
        const output = Buffer.concat(
            paneEvents.filter(event => event.type === 'output').map(event => Buffer.from(event.data)),
        ).toString('utf8')
        process.stderr.write(`${JSON.stringify({
            states: paneEvents.filter(event => event.type === 'state'),
            outputTail: output.slice(-2000),
            runtimeMethods: runtimeCalls.map(request => request.method),
        }, null, 2)}\n`)
        throw error
    }
    await manager.request({
        action: 'pane-detach',
        binaryPath,
        session,
        paneId,
        ownerId,
    }, 99)

    const methods = runtimeCalls.map(request => request.method)
    for (const method of ['pane.open', 'pane.claimInput', 'pane.pushOutput', 'pane.write', 'pane.resize', 'pane.releaseInput', 'pane.close']) {
        assert.ok(methods.includes(method), `missing Runtime call ${method}`)
    }
    const panes = await rawRuntimeRequest({
        jsonrpc: '2.0', id: 'list-after-detach', method: 'pane.list', params: {},
    })
    const closedPane = panes.result.find(pane => pane.id === paneId)
    assert.equal(closedPane.state, 'closed')
    assert.equal(closedPane.inputOwner, null)
    assert.equal(closedPane.bufferedBytes, 0)
    process.stdout.write(`${JSON.stringify({
        ok: true,
        herdrTarget: target,
        runtimePid: health.result.pid,
        outputEvents: paneEvents.filter(event => event.type === 'output').length,
        runtimeCalls: runtimeCalls.length,
        sawFullFrame: paneEvents.some(event => event.type === 'output' && event.full === true),
    }, null, 2)}\n`)
} finally {
    manager.shutdown()
    if (runtime) {
        runtime.kill()
        await waitForExit(runtime).catch(() => undefined)
    }
    await rm(databasePath, { force: true })
    await rm(`${databasePath}-wal`, { force: true })
    await rm(`${databasePath}-shm`, { force: true })
}
