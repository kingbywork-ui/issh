import * as path from 'path'
import * as fs from 'fs'
import * as semver from 'semver'
import * as childProcess from 'child_process'

process.env.ARCH = (((process.env.ARCH || process.arch).trim()) === 'arm')
    ? 'armv7l'
    : (process.env.ARCH || process.arch).trim()

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const appPackageInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')))

export let version
if (process.env.ISSH_BUILD_VERSION) {
    version = process.env.ISSH_BUILD_VERSION.trim()
} else try {
    version = childProcess.execSync('git describe --tags', { encoding:'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    version = version.substring(1).trim()
    version = version.replace('-', '-c')

    if (version.includes('-c')) {
        version = semver.inc(version, 'prepatch').replace('-0', `-nightly.${process.env.REV ?? 0}`)
    }
} catch {
    version = appPackageInfo.version
}

export const builtinPlugins = [
    'issh-core',
    'issh-settings',
    'issh-terminal',
    'issh-community-color-schemes',
    'issh-ssh',
    'issh-local',
    'issh-linkifier',
    'issh-auto-sudo-password',
    'issh-llm',
]

export const packagesWithDocs = [
    ['.', 'issh-core'],
    ['terminal', 'issh-terminal'],
    ['local', 'issh-local'],
    ['settings', 'issh-settings'],
]

export const allPackages = [
    ...builtinPlugins,
]

export const bundledModules = [
    '@angular',
    '@ng-bootstrap',
]
