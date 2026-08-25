import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadTypeScriptModule (relativePath, mocks = {}, globals = {}) {
    const sourcePath = path.join(repositoryRoot, relativePath)
    const source = fs.readFileSync(sourcePath, 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            experimentalDecorators: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: sourcePath,
    })
    const module = { exports: {} }
    vm.runInNewContext(compiled.outputText, {
        exports: module.exports,
        module,
        require: name => mocks[name] ?? require(name),
        process,
        console,
        URL,
        ...globals,
    }, { filename: sourcePath })
    return module.exports
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'issh-migration-test-'))
try {
    const pluginPackages = [
        'issh-auto-sudo-password',
        'issh-community-color-schemes',
        'issh-core',
        'issh-linkifier',
        'issh-llm',
        'issh-local',
        'issh-serial',
        'issh-settings',
        'issh-ssh',
        'issh-terminal',
    ]
    for (const plugin of pluginPackages) {
        const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, plugin, 'package.json'), 'utf8'))
        assert.ok(manifest.keywords.includes('issh-builtin-plugin'), `${plugin} has no issh builtin marker`)
        assert.ok(!manifest.keywords.includes('tabby-builtin-plugin'), `${plugin} still publishes the legacy marker`)
    }

    const storageValues = new Map([['tabby.appPanel.bottomHeightPx', '234']])
    const localStorage = {
        getItem: key => storageValues.get(key) ?? null,
        setItem: (key, value) => storageValues.set(key, value),
        removeItem: key => storageValues.delete(key),
    }
    const appPanelModule = loadTypeScriptModule('issh-core/src/services/appPanel.service.ts', {
        '@angular/core': { Injectable: () => target => target },
        rxjs: { Subject: class { next () {} } },
    }, {
        localStorage,
        window: { dispatchEvent: () => {} },
        document: { querySelector: () => null },
        HTMLElement: class {},
        Event: class {},
        setTimeout: () => 0,
    })
    const migratedPanel = new appPanelModule.AppPanelService()
    assert.equal(migratedPanel.bottomHeightPx, 234)
    assert.equal(storageValues.get('issh.appPanel.bottomHeightPx'), '234')
    assert.equal(storageValues.has('tabby.appPanel.bottomHeightPx'), false)

    storageValues.set('issh.appPanel.bottomHeightPx', '200')
    storageValues.set('tabby.appPanel.bottomHeightPx', '300')
    const currentPanel = new appPanelModule.AppPanelService()
    assert.equal(currentPanel.bottomHeightPx, 200)
    assert.equal(storageValues.get('issh.appPanel.bottomHeightPx'), '200')

    const bridgeSource = fs.readFileSync(path.join(repositoryRoot, 'issh-llm/src/services/agentBridge.service.ts'), 'utf8')
    assert.match(bridgeSource, /const CONNECTION_FILE_NAME = 'issh-agent-bridge\.json'/)
    assert.match(bridgeSource, /removeFile\(legacyConnectionFilePath, 'legacy connection file'\)/)
    const configServiceSource = fs.readFileSync(path.join(repositoryRoot, 'issh-core/src/services/config.service.ts'), 'utf8')
    assert.match(configServiceSource, /legacyConfigSyncHost = 'https:\/\/api\.tabby\.sh'/)
    assert.match(configServiceSource, /delete config\.configSync\.host/)
    assert.match(configServiceSource, /delete config\.configSync\.token/)

    console.log('ISSH plugin and user-data migration tests passed')
} finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
}
