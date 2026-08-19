#!/usr/bin/env node
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appModules = path.join(repositoryRoot, 'app', 'node_modules')
const checkOnly = process.argv.includes('--check')
const embeddedNpm = path.join(appModules, 'npm')

if (fsSync.existsSync(embeddedNpm)) {
    throw new Error(`Embedded npm must not be present in this build: ${embeddedNpm}`)
}

console.log(`${checkOnly ? 'verified' : 'checked'} embedded npm is not shipped`)
