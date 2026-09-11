import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import ts from 'typescript'

// Execute the actual methods without starting an Angular/Electron host.
function methods(file, names, globals = {}) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const cls = source.statements.find(ts.isClassDeclaration)
    const body = cls.members.filter(m => names.includes(m.name?.getText(source))).map(m => m.getText(source)).join('\n')
    const code = ts.transpileModule(`class Subject extends Base { ${body} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    return vm.runInNewContext(code, { Base: class {}, Buffer, path, fs, process, ...globals }).prototype
}
const serviceFile = 'issh-llm/src/services/agentBridge.service.ts'
const service = methods(serviceFile, ['execViaPty', 'unregisterController', 'registerController', 'syncRegisteredTabs', 'readBody', 'resolveSftpPath', 'getRemotePath', 'getString', 'isPathWithinRoot', 'getTokenScopes', 'ensureScopesMigrated', 'testCliClient', 'readAuditLog', 'clearAuditLog', 'findAgentBridgePackage'], {
    ALL_SCOPES: ['read', 'write', 'exec', 'sftp'],
    execFile: (_exe, _args, _options, cb) => cb(new Error('Command failed'), '', 'SyntaxError: diagnostic detail'),
})
function bridge(llm = {}) {
    return Object.assign(Object.create(service), { config: { store: { llm }, save() {} }, logger: { info() {}, warn() {} }, tabs: new Map(), unregisteredTabs: new WeakSet(), nextTabId: 1 })
}

test('silent PTY waits for an explicit shell completion marker', async () => {
    let now = 0
    const marker = '__issh_done_0102030405060708__'
    const sent = []
    const p = methods(serviceFile, ['execViaPty'], {
        Date: { now: () => now },
        crypto: { randomBytes: () => Buffer.from('0102030405060708', 'hex') },
    })
    const subject = Object.assign(Object.create(p), {
        context: { getRecentOutput: () => now >= 1250 ? [`echo ${marker}`, marker] : [] },
        sleep: async ms => { now += ms },
    })
    const result = await subject.execViaPty({ tab: { sendInput(value) { sent.push(value) } } }, 'true', 2000)
    assert.equal(result.timedOut, false)
    assert.equal(result.stdout, '')
    assert.equal(now, 1250)
    assert.deepEqual(sent, ['true\r', `echo ${marker}\r`])
})
test('PTY input echo without marker output times out', async () => {
    let now = 0
    const sent = []
    const p = methods(serviceFile, ['execViaPty'], {
        Date: { now: () => now },
        crypto: { randomBytes: () => Buffer.from('0102030405060708', 'hex') },
    })
    const subject = Object.assign(Object.create(p), {
        context: { getRecentOutput: () => sent.map(value => value.trim()) },
        sleep: async ms => { now += ms },
    })
    const result = await subject.execViaPty({ tab: { sendInput(value) { sent.push(value) } } }, 'slow-command', 1000)
    assert.equal(result.timedOut, true)
    assert.equal(result.stdout, 'slow-command')
})
test('unregistered tab stays absent while still in app tabs; explicit attach restores it', () => {
    const b = bridge(), tab = {}
    b.app = { tabs: [tab] }; b.flattenTerminalTabs = tabs => tabs
    b.registerController(tab, {})
    b.unregisterController(tab)
    b.syncRegisteredTabs(); b.syncRegisteredTabs()
    assert.equal(b.tabs.size, 0)
    b.registerController(tab, {})
    assert.equal(b.tabs.size, 1)
})
test('queued decorator setup cannot register a detached tab', () => {
    const queued = []
    class Frontend {}
    const p = methods('issh-llm/src/decorator.ts', ['attach', 'detach'], {
        Base: class { detach() {} }, XTermFrontend: Frontend,
        setTimeout: fn => queued.push(fn),
        TabLLMController: class { constructor() { assert.fail('detached setup ran') } },
    })
    let unregistered = false
    const decorator = Object.assign(Object.create(p), {
        controllers: new Map(), attachments: new WeakMap(),
        agentBridge: { unregisterController() { unregistered = true } },
    })
    const tab = { frontend: new Frontend(), frontendIsReady: true, content: { nativeElement: {} } }
    decorator.attach(tab); decorator.detach(tab)
    queued.forEach(fn => fn())
    assert.equal(unregistered, true)
})
test('scope UI matches backend defaults and first toggle', () => {
    const ui = methods('issh-llm/src/components/agentBridgeSettingsTab.component.ts', ['hasScope', 'toggleScope'])
    for (const token of [undefined, 'legacy-token']) {
        for (const scopes of [undefined, [], ['read']]) {
            const b = bridge({ agentBridgeToken: token, agentBridgeTokenScopes: scopes })
            const u = Object.assign(Object.create(ui), { config: b.config, agentBridge: b, scopeOptions: ['read', 'write', 'exec', 'sftp'] })
            const displayed = u.hasScope('exec')
            assert.equal(displayed, b.getTokenScopes().includes('exec'))
            u.toggleScope('sftp')
            assert.equal(u.hasScope('exec'), b.getTokenScopes().includes('exec'))
        }
    }
})
test('HTTP body limit counts UTF-8 bytes including split characters', async () => {
    const request = new PassThrough()
    const result = bridge().readBody(request)
    const check = assert.rejects(result, /too large/)
    const bytes = Buffer.from('中'.repeat(500000))
    request.write(bytes.subarray(0, 1)); request.end(bytes.subarray(1))
    await check
})
test('HTTP body accepts exactly 1 MiB and preserves UTF-8 split across chunks', async () => {
    const request = new PassThrough(), result = bridge().readBody(request)
    const bytes = Buffer.from('中' + 'a'.repeat(1024 * 1024 - 3))
    request.write(bytes.subarray(0, 1)); request.end(bytes.subarray(1))
    assert.equal(await result, bytes.toString('utf8'))
})
test('deep missing SFTP parents resolve; symlink escapes and permission errors fail', async () => {
    const b = bridge({ agentBridgeSftpRoot: '/root' })
    const canonicalize = async p => {
        if (p === '/root') return '/root'
        if (p === '/root/link') return '/outside'
        if (p === '/root/denied') throw Object.assign(new Error('Permission denied'), { code: 3 })
        throw Object.assign(new Error('No such file'), { code: 2 })
    }
    assert.equal(await b.resolveSftpPath({ canonicalize }, 'a/b/file', '', true), '/root/a/b/file')
    await assert.rejects(b.resolveSftpPath({ canonicalize }, 'link/a/file', '', true), /escapes/)
    await assert.rejects(b.resolveSftpPath({ canonicalize }, 'denied/file', '', true), /Permission denied/)
    assert.throws(() => b.getRemotePath('../file', ''), /traversal/)
    assert.equal(b.getRemotePath('%2e%2e/file', ''), '/root/%2e%2e/file')
    assert.equal(b.getRemotePath('..\\file', ''), '/root/..\\file')
})
test('CLI failure includes stderr', async () => {
    await assert.rejects(bridge().testCliClient('cli', 'config'), /SyntaxError: diagnostic detail/)
})
test('package discovery selects an unpacked directory for external Node', () => {
    const p = methods(serviceFile, ['findAgentBridgePackage'], {
        process: { cwd: () => '/missing', execPath: '/app/issh', resourcesPath: '/resources' },
        fs: { existsSync: file => file.includes('app.asar') },
    })
    assert.equal(p.findAgentBridgePackage(), path.join('/resources', 'app.asar.unpacked', 'issh-agent'))
})
test('prompt stripping preserves dollar signs and redirection in commands', () => {
    const ctx = methods('issh-llm/src/services/terminalContext.service.ts', ['stripPrompt'])
    for (const command of ['echo $ value', 'echo hello > file', 'printf "price $ 5"', 'echo user@host:~$ hello']) assert.equal(ctx.stripPrompt(command), command)
    assert.equal(ctx.stripPrompt('user@host:~$ echo hi'), 'echo hi')
    assert.equal(ctx.stripPrompt('PS C:\\tmp> echo hi'), 'echo hi')
})
test('audit pagination and filtering span active and rotated logs; clear removes both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issh-audit-test-'))
    try {
        const b = bridge(); b.auditLogFilePath = path.join(dir, 'audit.jsonl')
        fs.writeFileSync(b.auditLogFilePath + '.1', '{"method":"old"}\ninvalid\n')
        fs.writeFileSync(b.auditLogFilePath, '{"method":"new"}\n')
        const result = await b.readAuditLog(1, 1)
        assert.equal(result.total, 2); assert.equal(result.entries[0].method, 'old')
        assert.equal((await b.readAuditLog(10, 0, 'old')).total, 1)
        const many = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ method: `方法${i}` })).join('\n')
        fs.writeFileSync(b.auditLogFilePath, many)
        const boundary = await b.readAuditLog(3, 3500)
        assert.equal(boundary.total, 4001)
        assert.equal(boundary.entries.map(e => e.method).join(','), '方法499,方法498,方法497')
        await b.clearAuditLog()
        assert.equal((await b.readAuditLog()).total, 0)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
