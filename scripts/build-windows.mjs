#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'
import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

function getExecutableArchitecture (executable) {
    const bytes = readFileSync(executable)
    if (bytes.length < 0x40) {
        throw new Error('Electron executable is too small to contain a PE header')
    }

    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
        throw new Error('Electron executable has an invalid PE header')
    }

    const machine = bytes.readUInt16LE(peOffset + 4)
    const architectures = new Map([
        [0x014c, 'ia32'],
        [0x8664, 'x64'],
        [0xaa64, 'arm64'],
    ])
    const architecture = architectures.get(machine)
    if (!architecture) {
        throw new Error(`Electron executable has an unsupported PE machine type: 0x${machine.toString(16)}`)
    }
    return architecture
}

function getLocalElectronDist (targetArchitecture) {
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
    const electronRoot = path.join(repositoryRoot, 'node_modules', 'electron')
    const dist = path.join(electronRoot, 'dist')
    const packageFile = path.join(electronRoot, 'package.json')
    const pathFile = path.join(electronRoot, 'path.txt')
    const versionFile = path.join(dist, 'version')
    const executable = path.join(dist, 'electron.exe')
    const defaultApp = path.join(dist, 'resources', 'default_app.asar')

    try {
        if (![packageFile, pathFile, versionFile, executable, defaultApp].every(existsSync)) {
            throw new Error('required runtime files are missing')
        }

        const packageVersion = JSON.parse(readFileSync(packageFile, 'utf8')).version
        const distVersion = readFileSync(versionFile, 'utf8').trim()
        if (!packageVersion || distVersion !== packageVersion) {
            throw new Error(`version mismatch (package=${packageVersion || 'unknown'}, dist=${distVersion || 'unknown'})`)
        }

        if (!readFileSync(pathFile).equals(Buffer.from('electron.exe'))) {
            throw new Error('path.txt must contain exactly "electron.exe" without a BOM or newline')
        }

        const runtimeArchitecture = getExecutableArchitecture(executable)
        if (runtimeArchitecture !== targetArchitecture) {
            throw new Error(`architecture mismatch (target=${targetArchitecture}, runtime=${runtimeArchitecture})`)
        }

        return dist
    } catch (error) {
        console.warn(`Local Electron runtime is not reusable: ${error.message}`)
        return null
    }
}

const isTag = (process.env.GITHUB_REF || process.env.BUILD_SOURCEBRANCH || '').startsWith('refs/tags/')
const keypair = process.env.SM_KEYPAIR_ALIAS

process.env.ARCH = process.env.ARCH || process.arch
const electronDist = getLocalElectronDist(process.env.ARCH)

console.log('Signing enabled:', !!keypair)
console.log(electronDist
    ? `Electron source: validated local runtime (${electronDist})`
    : 'Electron source: download cache/network fallback')
if (process.env.TABBY_SKIP_PREPACKAGE !== '1') {
    console.log('Refreshing builtin plugins...')
    execFileSync(process.execPath, ['scripts/prepackage-plugins.mjs'], {
        cwd: new URL('..', import.meta.url),
        stdio: 'inherit',
    })
}

builder({
    dir: true,
    win: ['nsis'],
    arm64: process.env.ARCH === 'arm64',
    config: {
        ...(electronDist ? { electronDist } : {}),
        extraMetadata: {
            version: vars.version,
        },
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
        forceCodeSigning: !!keypair,
        win: {
            signtoolOptions: {
                certificateSha1: process.env.SM_CODE_SIGNING_CERT_SHA1_HASH,
                publisherName: process.env.SM_PUBLISHER_NAME,
                signingHashAlgorithms: ['sha256'],
                sign: keypair ? async function (configuration) {
                    console.log('Signing', configuration)
                    if (configuration.path) {
                        try {
                            const cmd = `smctl sign --keypair-alias=${keypair} --input "${String(configuration.path)}"`
                            console.log(cmd)
                            const out = execSync(cmd)
                            if (out.toString().includes('FAILED')) {
                                throw new Error(out.toString())
                            }
                            console.log(out.toString())
                        } catch (e) {
                            console.error(`Failed to sign ${configuration.path}`)
                            if (e.stdout) {
                                console.error('stdout:', e.stdout.toString())
                            }
                            if (e.stderr) {
                                console.error('stderr:', e.stderr.toString())
                            }
                            console.error(e)
                            process.exit(1)
                        }
                    }
                } : undefined,
            },
        },
    },

    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
