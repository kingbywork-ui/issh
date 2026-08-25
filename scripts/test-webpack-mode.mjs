#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginConfig = pathToFileURL(path.join(root, 'webpack.plugin.config.mjs')).href
const pluginDir = path.join(root, 'issh-llm').replaceAll('\\', '/')

function readConfig (vars) {
    const env = { ...process.env }
    delete env.ISSH_DEV
    delete env.TABBY_DEV
    Object.assign(env, vars)
    const source = `
        const plugin = (await import(${JSON.stringify(pluginConfig)})).default
        const pluginConfig = plugin({ name: 'test', dirname: ${JSON.stringify(pluginDir)} })
        console.log(JSON.stringify({
            plugin: { mode: pluginConfig.mode, minimize: pluginConfig.optimization.minimize, evalSourceMap: pluginConfig.plugins.some(x => x.constructor.name === 'EvalSourceMapDevToolPlugin') },
        }))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

const production = readConfig({})
assert.deepEqual(production, {
    plugin: { mode: 'production', minimize: true, evalSourceMap: false },
})

for (const vars of [{ ISSH_DEV: '1' }, { TABBY_DEV: '1' }, { ISSH_DEV: 'true' }, { TABBY_DEV: 'true' }]) {
    const development = readConfig(vars)
    assert.equal(development.plugin.mode, 'development')
    assert.equal(development.plugin.minimize, false)
    assert.equal(development.plugin.evalSourceMap, true)
}

console.log('webpack mode tests passed: unset=production, 1/true primary and legacy=development')
