import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const testDir = path.dirname(fileURLToPath(import.meta.url))

function loadStandaloneTypeScriptModule (relativePath) {
    const filename = path.resolve(testDir, relativePath)
    const source = fs.readFileSync(filename, 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: filename,
    }).outputText
    const module = { exports: {} }
    Function('exports', 'module', compiled)(module.exports, module)
    return module.exports
}

test('danger guard catches destructive PowerShell storage commands', () => {
    const { DangerousCommandGuard } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/dangerousCommandGuard.ts',
    )
    const guard = new DangerousCommandGuard()
    for (const command of [
        'Format-Volume -DriveLetter C -Confirm:$false',
        'Clear-Disk -Number 0 -RemoveData -Confirm:$false',
        'Initialize-Disk -Number 0',
        'Remove-Partition -DiskNumber 0 -PartitionNumber 1 -Confirm:$false',
    ]) {
        assert.equal(guard.isDangerous(command).dangerous, true, command)
    }
    assert.equal(guard.isDangerous('Get-Volume').dangerous, false)
})

test('danger guard catches wrapped and cross-platform destructive commands', () => {
    const { DangerousCommandGuard } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/dangerousCommandGuard.ts',
    )
    const guard = new DangerousCommandGuard()
    for (const command of [
        'env rm -rf /',
        'busybox rm -rf /',
        "sh -c 'rm -rf /'",
        'Remove-Item C:\\ -Recurse -Force',
        'del /s /q C:\\*',
        'diskpart /s wipe.txt',
        'powershell -EncodedCommand ZQBjAGgAbwAgAHgA',
    ]) {
        assert.equal(guard.isDangerous(command).dangerous, true, command)
    }
    for (const command of ['echo safe', 'Get-Volume', 'Remove-Item note.txt']) {
        assert.equal(guard.isDangerous(command).dangerous, false, command)
    }
})

test('danger guard catches shell-obfuscated destructive commands after normalization', () => {
    const { normalizeCommand } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/commandValidation.ts',
    )
    const { DangerousCommandGuard } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/dangerousCommandGuard.ts',
    )
    const guard = new DangerousCommandGuard()
    for (const command of [
        'command r\\m -rf /',
        'command mkf\\s.ext4 /dev/sda',
        'command r\'m\' -rf /',
        'command $\'mkfs.ext4\' /dev/sda',
        'rm --recurs\'\'ive --fo""rce /',
        'cmd /c d^el /s /q C:\\*',
        'powershell -Command "& (\'Remove-\'+\'Item\') C:\\ -Recurse -Force"',
    ]) {
        const normalized = normalizeCommand(command, { allowMultiline: true })
        assert.notEqual(normalized, null, command)
        assert.equal(guard.isDangerous(normalized).dangerous, true, command)
    }
    for (const command of [
        'command e\\cho safe',
        'cmd /c e^cho safe',
        'powershell -Command "Write-Output (\'safe-\'+\'value\')"',
        'Get-ChildItem C:\\Windows',
    ]) {
        const normalized = normalizeCommand(command, { allowMultiline: true })
        assert.notEqual(normalized, null, command)
        assert.equal(guard.isDangerous(normalized).dangerous, false, command)
    }
})

test('danger guard redacts common command-line credential formats', () => {
    const { DangerousCommandGuard } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/dangerousCommandGuard.ts',
    )
    const guard = new DangerousCommandGuard()
    for (const value of [
        'curl -u user:secret https://example.test',
        'curl -H "Authorization: Basic dXNlcjpzZWNyZXQ=" https://example.test',
        'mysql -uroot -pSecret123!',
        'https://user:secret@example.test/private',
        'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    ]) {
        const redacted = guard.redact(value)
        assert.match(redacted, /\[REDACTED\]/, value)
        assert.doesNotMatch(redacted, /user:secret|dXNlcjpzZWNyZXQ=|Secret123|AKIAIOSFODNN7EXAMPLE/, value)
    }
})

test('security-sensitive source boundaries remain enabled', () => {
    const coreRoot = path.resolve(testDir, '../../issh-core/src')
    const llmRoot = path.resolve(testDir, '../../issh-llm/src')
    const sshRoot = path.resolve(testDir, '../../issh-ssh/src')
    const appRoot = path.resolve(testDir, '../test')

    const htmlBinding = fs.readFileSync(path.join(coreRoot, 'directives/fastHtmlBind.directive.ts'), 'utf8')
    assert.match(htmlBinding, /DOMPurify\.sanitize/)
    assert.match(htmlBinding, /FORBID_ATTR: \['srcdoc', 'style'\]/)
    assert.doesNotMatch(htmlBinding, /innerHTML\s*=\s*this\.fastHtmlBind/)

    const vault = fs.readFileSync(path.join(coreRoot, 'services/vault.service.ts'), 'utf8')
    assert.match(vault, /aes-256-gcm/)
    assert.match(vault, /setAuthTag/)
    assert.match(vault, /vault\.version === 1/)

    const llm = fs.readFileSync(path.join(llmRoot, 'services/llm.service.ts'), 'utf8')
    assert.match(llm, /sendContextToCloud\)\s*\{\s*parts\.push\(`OS:/)

    const bridge = fs.readFileSync(path.join(llmRoot, 'services/agentBridge.service.ts'), 'utf8')
    assert.match(bridge, /AUDIT_LOG_MAX_BYTES/)
    assert.match(bridge, /rotateAuditLogIfNeeded/)
    assert.match(bridge, /scope: 'command\.execute'/)
    assert.match(bridge, /task\.output\.includes\(command\)/)
    assert.match(bridge, /confirmDangerous: true/)

    const cordis = fs.readFileSync(path.join(llmRoot, 'services/cordisOrchestrator.service.ts'), 'utf8')
    assert.match(cordis, /new Context\(\)/)
    assert.match(cordis, /runContext\.effect/)
    assert.match(cordis, /entry\.fiber\.dispose\(\)/)

    const herdrAdapter = fs.readFileSync(path.join(llmRoot, 'services/herdrAdapter.service.ts'), 'utf8')
    assert.match(herdrAdapter, /herdrWorkspaceLinks/)
    assert.match(herdrAdapter, /agentCount: agents\.length/)
    assert.match(herdrAdapter, /Herdr integration is disabled in issh settings/)
    assert.doesNotMatch(herdrAdapter, /recentOutput|apiKey|agentBridgeToken/)

    const herdrMain = fs.readFileSync(path.join(appRoot, 'herdr-manager.fixture.ts'), 'utf8')
    assert.match(herdrMain, /EXPECTED_PROTOCOL = 20/)
    assert.match(herdrMain, /MAX_OUTPUT_BYTES = 2 \* 1024 \* 1024/)
    assert.match(herdrMain, /MAX_QUEUE_DEPTH = 32/)
    assert.match(herdrMain, /reason: 'not_owned'/)
    assert.match(herdrMain, /restartAttempts >= 5/)
    assert.match(herdrMain, /replayWorkspaceSyncs/)

    const winscp = fs.readFileSync(path.join(sshRoot, 'services/ssh.service.ts'), 'utf8')
    assert.doesNotMatch(winscp, /x-tunnelpasswordplain|x-tunnelpassphraseplain|\/passphrase=/)
    assert.doesNotMatch(winscp, /encodeURIComponent\(password\)/)

    const algorithms = fs.readFileSync(path.join(sshRoot, 'algorithms.ts'), 'utf8')
    const defaults = algorithms.slice(algorithms.indexOf('export const defaultAlgorithms'))
    assert.doesNotMatch(defaults, /'ssh-rsa'|'hmac-sha1/)

    const windowSource = fs.readFileSync(path.join(appRoot, 'window.fixture.ts'), 'utf8')
    assert.match(windowSource, /setDevicePermissionHandler\(\(\) => false\)/)
    assert.match(windowSource, /will-navigate/)
})

test('agent process detection covers Codex CLI and Hermes without broad substring matches', () => {
    const { isKnownAgentProcess } = loadStandaloneTypeScriptModule(
        '../../issh-llm/src/services/agentProcessDetection.ts',
    )
    for (const command of [
        'codex.exe',
        'codex-cli',
        'C:\\tools\\hermes-agent.exe',
        '/usr/local/bin/hermes',
        'node /opt/node_modules/@openai/codex/bin/codex.js',
        'npx @openai/codex',
    ]) {
        assert.equal(isKnownAgentProcess(command), true, command)
    }
    for (const command of ['code.exe', 'node.exe', 'codex-notes.txt', 'hermes-backup']) {
        assert.equal(isKnownAgentProcess(command), false, command)
    }
})

test('autocomplete controller enforces the two-character gate before deferred prediction', () => {
    const controller = fs.readFileSync(
        path.resolve(testDir, '../../issh-llm/src/tabLLMController.ts'),
        'utf8',
    )
    assert.match(controller, /Math\.max\(2,\s*this\.config\.store\.llm\.minTriggerLength/)
    assert.match(controller, /startDeferredNextCommandPrediction\(partial\)/)
    assert.match(controller, /this\.agentCommandActive\s*&&\s*processList\.length\s*>\s*0/)
    const submitGate = controller.slice(
        controller.indexOf('private startNextCommandPrediction'),
        controller.indexOf('private startDeferredNextCommandPrediction'),
    )
    assert.match(submitGate, /this\.pendingPredictionCommand = previousCommand/)
    assert.doesNotMatch(submitGate, /prefetchNextCommands/)
})
