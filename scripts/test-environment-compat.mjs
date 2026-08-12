import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { getISSHEnvironmentVariable } from './environment.mjs'

const warnings = []
assert.equal(getISSHEnvironmentVariable('DEV', {
    ISSH_DEV: 'primary',
    TABBY_DEV: 'legacy',
}, message => warnings.push(message)), 'primary')
assert.deepEqual(warnings, [])

assert.equal(getISSHEnvironmentVariable('SKIP_PREPACKAGE', {
    TABBY_SKIP_PREPACKAGE: '1',
}, message => warnings.push(message)), '1')
assert.match(warnings[0], /TABBY_SKIP_PREPACKAGE.*ISSH_SKIP_PREPACKAGE/)

const sourcePath = path.resolve('app/lib/environment.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
    process: { env: {} },
}, {
    filename: sourcePath,
})

const {
    ISSH_ENVIRONMENT_VARIABLE_SUFFIXES,
    promoteLegacyEnvironmentVariables,
} = module.exports
assert.deepEqual([...ISSH_ENVIRONMENT_VARIABLE_SUFFIXES], [
    'AGENT_BRIDGE_FILE',
    'AGENT_BRIDGE_PORT',
    'AGENT_BRIDGE_PUBLIC_FILE',
    'CONFIG_DIRECTORY',
    'DEV',
    'DISABLE_GLASSTRON',
    'ENABLE_SENTRY',
    'FORCE_ANGULAR_PROD',
    'PLUGINS',
    'SKIP_PREPACKAGE',
    'SMOKE_DISABLE_GPU',
    'SMOKE_KEEP_CONFIG',
    'VAULT_PASSPHRASE',
])

const environment = {
    ISSH_DEV: 'primary',
    TABBY_DEV: 'legacy',
    TABBY_CONFIG_DIRECTORY: 'legacy-config',
}
const promoted = promoteLegacyEnvironmentVariables(environment)
assert.equal(environment.ISSH_DEV, 'primary')
assert.equal(environment.ISSH_CONFIG_DIRECTORY, 'legacy-config')
assert.deepEqual(JSON.parse(JSON.stringify(promoted)), [{
    legacyName: 'TABBY_CONFIG_DIRECTORY',
    primaryName: 'ISSH_CONFIG_DIRECTORY',
}])

console.log('ISSH environment compatibility tests passed')
