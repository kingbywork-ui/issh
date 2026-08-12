#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import sh from 'shelljs'
import path from 'node:path'
import fs from 'node:fs'
import * as vars from './vars.mjs'
import log from 'npmlog'
import './patch-node-gyp-vs18.mjs'
import { createRequire } from 'node:module'
import { builtinModules } from 'node:module'
import { configureReleaseTarget } from './release-target.mjs'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

let target = path.resolve(__dirname, '../builtin-plugins')
const releaseTarget = configureReleaseTarget(process.env.ISSH_TARGET_PLATFORM ?? process.platform, process.env.ARCH ?? process.arch)
sh.rm('-rf', target)
sh.mkdir('-p', target)
fs.writeFileSync(path.join(target, 'package.json'), '{}')
sh.cd(target)

for (const plugin of vars.builtinPlugins) {
    log.info('install', plugin)
    sh.rm('-rf', plugin)
    sh.cp('-r', path.join('..', plugin), '.')
    sh.rm('-rf', path.join(plugin, 'node_modules'))
    sh.cd(plugin)
    sh.exec(`corepack yarn install --force --production --ignore-scripts`, { fatal: true })

    log.info('rebuild', 'native')
    const wptGyp = path.resolve('node_modules/@tabby-gang/windows-process-tree/binding.gyp')
    if (fs.existsSync(wptGyp)) {
        let gyp = fs.readFileSync(wptGyp, 'utf-8')
        if (gyp.includes('SpectreMitigation')) {
            gyp = gyp.replace(/"msvs_configuration_attributes":\s*\{[^}]*"SpectreMitigation":\s*"Spectre"[^}]*\},?\s*/g, '')
            fs.writeFileSync(wptGyp, gyp)
            log.info('patch', 'Removed SpectreMitigation from windows-process-tree binding.gyp')
        }
    }
    if (fs.existsSync('node_modules')) {
        await rebuild({
            buildPath: path.resolve('.'),
            electronVersion: vars.electronVersion,
            arch: process.env.ARCH ?? process.arch,
            force: true,
            useCache: false,
        })
    }
    pruneReleaseTree(path.resolve('.'), plugin, releaseTarget)
    sh.cd('..')
}
fs.unlinkSync(path.join(target, 'package.json'))

function removeByPredicate (root, predicate) {
    if (!fs.existsSync(root)) {
        return
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name)
        if (predicate(entryPath, entry)) {
            fs.rmSync(entryPath, { recursive: true, force: true })
        } else if (entry.isDirectory()) {
            removeByPredicate(entryPath, predicate)
        }
    }
}

function pruneReleaseTree (pluginDir, plugin, target) {
    // The runtime package consists of package.json, dist, and declared runtime
    // dependencies. Sources, generated typings, docs, locks, and maps stay in
    // the workspace for diagnostics but never cross into builtin-plugins.
    for (const name of ['src', 'typings', 'test', 'tests', 'docs', 'examples', '.github']) {
        fs.rmSync(path.join(pluginDir, name), { recursive: true, force: true })
    }
    removeByPredicate(pluginDir, (entryPath, entry) => {
        if (entryPath === path.join(pluginDir, 'package.json') || entry.name === 'node_modules') {
            return false
        }
        if (entry.isFile()) {
            return /\.(map|d\.ts|ts|md|markdown|lock|log|pdb|obj|iobj|ipdb|tlog|ilk|exp|lib)$/i.test(entry.name) || /^(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|webpack\.config\.)/i.test(entry.name)
        }
        return false
    })

    const nodeModules = path.join(pluginDir, 'node_modules')
    if (plugin === 'issh-llm') {
        fs.rmSync(nodeModules, { recursive: true, force: true })
    } else {
        // Native packages may contain several prebuilds and a full compiler
        // output. Keep only the ABI/platform selected for this artifact.
        removeByPredicate(nodeModules, (entryPath, entry) => {
            if (entry.isFile() && /\.(pdb|obj|iobj|ipdb|tlog|ilk|exp|lib)$/i.test(entry.name)) {
                return true
            }
            if (!entry.isDirectory()) {
                return false
            }
            const normalized = entryPath.replaceAll('\\', '/')
            if (normalized.includes('/bin/') && !normalized.endsWith(`/bin/${target.nativeBin}`)) {
                return true
            }
            return false
        })
        if (plugin === 'issh-ssh') {
            fs.rmSync(path.join(nodeModules, '@napi-rs', 'cli'), { recursive: true, force: true })
            const russhDir = path.join(nodeModules, 'russh')
            // russh's nested .bin shim and Rust build metadata are only used
            // while compiling the native addon, never at runtime.
            fs.rmSync(path.join(russhDir, 'node_modules'), { recursive: true, force: true })
            for (const name of ['.bumpversion.cfg', 'rust-toolchain.toml']) {
                fs.rmSync(path.join(russhDir, name), { force: true })
            }
            removeByPredicate(russhDir, (entryPath, entry) => entry.isFile() && entry.name.endsWith('.node') && !entry.name.endsWith(`.${target.russh}.node`))
        }
    }

    assertExternalDependencies(pluginDir, nodeModules, path.join(path.dirname(pluginDir), '..', 'app'), path.dirname(pluginDir), target)
}

function assertExternalDependencies (pluginDir, _nodeModules, appDir, builtinDir, target) {
    const requireFromPlugin = createRequire(path.join(pluginDir, 'package.json'))
    const externalNames = new Set()
    const distDir = path.join(pluginDir, 'dist')
    if (!fs.existsSync(distDir)) {
        throw new Error(`Missing runtime dist for ${path.basename(pluginDir)}`)
    }
    const files = []
    const collect = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name)
            if (entry.isDirectory()) collect(entryPath)
            else if (entry.name.endsWith('.js')) files.push(entryPath)
        }
    }
    collect(distDir)
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
        for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            const name = match[1]
            if (name.startsWith('.') || name.startsWith('/') || builtinModules.includes(name) || name.startsWith('node:')) continue
            externalNames.add(name)
        }
    }
    for (const name of externalNames) {
        if (target.platform !== 'win32' && name === 'windows-native-registry') {
            continue
        }
        try {
            if (name.startsWith('issh-') && fs.existsSync(path.join(builtinDir, name, 'package.json'))) {
                continue
            }
            requireFromPlugin.resolve(name, { paths: [pluginDir, appDir, builtinDir] })
        } catch (error) {
            throw new Error(`Unresolvable external dependency ${name} in ${path.basename(pluginDir)}: ${error.message}`)
        }
    }
}
