#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appModules = path.join(repositoryRoot, 'app', 'node_modules')
const embeddedNpmModules = path.join(appModules, 'npm', 'node_modules')
const checkOnly = process.argv.includes('--check')
const replacements = [
    ['tar', '7.5.22'],
    ['brace-expansion', '5.0.8'],
    ['minimatch', '10.2.6'],
]

function assertChildPath (parent, target) {
    const relative = path.relative(parent, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Unsafe embedded npm dependency path: ${target}`)
    }
}

async function readVersion (packageDirectory) {
    const packageJSON = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
    return packageJSON.version
}

for (const [name, expectedVersion] of replacements) {
    const source = path.join(appModules, name)
    const target = path.join(embeddedNpmModules, name)
    assertChildPath(appModules, source)
    assertChildPath(embeddedNpmModules, target)

    const sourceVersion = await readVersion(source)
    if (sourceVersion !== expectedVersion) {
        throw new Error(`Expected ${name} ${expectedVersion}, found source version ${sourceVersion}`)
    }

    if (!checkOnly) {
        await fs.rm(target, { recursive: true, force: true })
        await fs.cp(source, target, { recursive: true })
    }

    const installedVersion = await readVersion(target)
    if (installedVersion !== expectedVersion) {
        throw new Error(`Embedded npm still contains ${name} ${installedVersion}; expected ${expectedVersion}`)
    }
    console.log(`${checkOnly ? 'verified' : 'hardened'} npm/node_modules/${name}@${installedVersion}`)
}
