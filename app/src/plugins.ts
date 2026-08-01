import * as fsSync from 'fs'
import * as fs from 'mz/fs'
import * as path from 'path'
import * as remote from '@electron/remote'
import { PluginInfo } from '../../issh-core/src/api/mainProcess'
import { PLUGIN_BLACKLIST } from './pluginBlacklist'

const nodeModule = require('module') // eslint-disable-line @typescript-eslint/no-var-requires

const nodeRequire = global['require']

function normalizePath (p: string): string {
    const cygwinPrefix = '/cygdrive/'
    if (p.startsWith(cygwinPrefix)) {
        p = p.substring(cygwinPrefix.length).replace('/', '\\')
        p = p[0] + ':' + p.substring(1)
    }
    return p
}

function resolveBuiltinPluginsPath (): string {
    if (process.env.TABBY_DEV) {
        return path.dirname(remote.app.getAppPath())
    }
    const repoRoot = path.dirname(remote.app.getAppPath())
    if (fsSync.existsSync(path.join(repoRoot, 'issh-core', 'package.json'))) {
        process.env.TABBY_DEV = '1'
        return repoRoot
    }
    return path.join((process as any).resourcesPath, 'builtin-plugins')
}

const cachedBuiltinModules = {
    '@angular/animations': require('@angular/animations'),
    '@angular/cdk/drag-drop': require('@angular/cdk/drag-drop'),
    '@angular/cdk/clipboard': require('@angular/cdk/clipboard'),
    '@angular/common': require('@angular/common'),
    '@angular/compiler': require('@angular/compiler'),
    '@angular/core': require('@angular/core'),
    '@angular/forms': require('@angular/forms'),
    '@angular/localize': require('@angular/localize'),
    '@angular/localize/init': require('@angular/localize/init'),
    '@angular/platform-browser': require('@angular/platform-browser'),
    '@angular/platform-browser/animations': require('@angular/platform-browser/animations'),
    '@angular/platform-browser-dynamic': require('@angular/platform-browser-dynamic'),
    '@ng-bootstrap/ng-bootstrap': require('@ng-bootstrap/ng-bootstrap'),
    'ngx-toastr': require('ngx-toastr'),
    rxjs: require('rxjs'),
    'rxjs/operators': require('rxjs/operators'),
    'zone.js/dist/zone.js': require('zone.js'),
    'zone.js': require('zone.js'),
}

const builtinModules = [
    ...Object.keys(cachedBuiltinModules),
    'issh-core',
    'issh-local',
    'issh-settings',
    'issh-terminal',
]

const PLUGIN_PREFIX = 'issh-'
const LEGACY_TABBY_PLUGIN_PREFIX = 'tabby-'
const LEGACY_TERMINUS_PLUGIN_PREFIX = 'terminus-'
const PLUGIN_PREFIXES = [PLUGIN_PREFIX, LEGACY_TABBY_PLUGIN_PREFIX, LEGACY_TERMINUS_PLUGIN_PREFIX]
const PLUGIN_KEYWORDS = [
    'issh-plugin',
    'issh-builtin-plugin',
    'tabby-plugin',
    'tabby-builtin-plugin',
    'terminus-plugin',
    'terminus-builtin-plugin',
]

function cachePluginModule (packageName: string, packageModule: any): void {
    cachedBuiltinModules[packageName] = packageModule

    for (const prefix of PLUGIN_PREFIXES) {
        if (packageName.startsWith(prefix)) {
            const suffix = packageName.substring(prefix.length)
            for (const aliasPrefix of PLUGIN_PREFIXES) {
                cachedBuiltinModules[`${aliasPrefix}${suffix}`] = packageModule
            }
            break
        }
    }
}

function getPluginName (packageName: string): string {
    const prefix = PLUGIN_PREFIXES.find(x => packageName.startsWith(x))
    return prefix ? packageName.substring(prefix.length) : packageName
}

const originalRequire = (global as any).require
;(global as any).require = function (query: string) {
    if (cachedBuiltinModules[query]) {
        return cachedBuiltinModules[query]
    }
    return originalRequire.apply(this, [query])
}

const originalModuleRequire = nodeModule.prototype.require
nodeModule.prototype.require = function (query: string) {
    if (cachedBuiltinModules[query]) {
        return cachedBuiltinModules[query]
    }
    return originalModuleRequire.call(this, query)
}

export type ProgressCallback = (current: number, total: number) => void

export function initModuleLookup (userPluginsPath: string): void {
    const builtinPluginsPath = resolveBuiltinPluginsPath()
    global['module'].paths.map((x: string) => nodeModule.globalPaths.push(normalizePath(x)))

    const paths = []
    paths.unshift(path.join(userPluginsPath, 'node_modules'))
    paths.unshift(path.join(remote.app.getAppPath(), 'node_modules'))

    if (process.env.TABBY_DEV) {
        paths.unshift(path.dirname(remote.app.getAppPath()))
    }

    paths.unshift(builtinPluginsPath)
    // paths.unshift(path.join((process as any).resourcesPath, 'app.asar', 'node_modules'))
    if (process.env.TABBY_PLUGINS) {
        process.env.TABBY_PLUGINS.split(':').map(x => paths.push(normalizePath(x)))
    }

    const nodePath = process.env.NODE_PATH ? `${process.env.NODE_PATH}${path.delimiter}` : ''
    process.env.NODE_PATH = nodePath + paths.join(path.delimiter)
    nodeModule._initPaths()

    builtinModules.forEach(m => {
        const packageModule = cachedBuiltinModules[m] ?? nodeRequire(m)
        cachePluginModule(m, packageModule)
    })
}

async function getCandidateLocationsInPluginDir (pluginDir: any): Promise<{ pluginDir: string, packageName: string }[]> {
    const candidateLocations: { pluginDir: string, packageName: string }[] = []

    if (await fs.exists(pluginDir)) {
        const pluginNames = await fs.readdir(pluginDir)
        if (await fs.exists(path.join(pluginDir, 'package.json'))) {
            candidateLocations.push({
                pluginDir: path.dirname(pluginDir),
                packageName: path.basename(pluginDir),
            })
        }

        const promises = []

        for (const packageName of pluginNames) {
            if (PLUGIN_PREFIXES.some(x => packageName.startsWith(x)) && !PLUGIN_BLACKLIST.includes(packageName)) {
                const pluginPath = path.join(pluginDir, packageName)
                const infoPath = path.join(pluginPath, 'package.json')
                promises.push(fs.exists(infoPath).then(result => {
                    if (result) {
                        candidateLocations.push({ pluginDir, packageName })
                    }
                }))
            }
        }

        await Promise.all(promises)
    }

    return candidateLocations
}

async function getPluginCandidateLocation (paths: any): Promise<{ pluginDir: string, packageName: string }[]> {
    const candidateLocationsPromises: Promise<{ pluginDir: string, packageName: string }[]>[] = []

    const processedPaths = []

    for (let pluginDir of paths) {
        if (processedPaths.includes(pluginDir)) {
            continue
        }
        processedPaths.push(pluginDir)

        pluginDir = normalizePath(pluginDir)

        candidateLocationsPromises.push(getCandidateLocationsInPluginDir(pluginDir))

    }

    const candidateLocations: { pluginDir: string, packageName: string }[] = []
    for (const pluginCandidateLocations of await Promise.all(candidateLocationsPromises)) {
        candidateLocations.push(...pluginCandidateLocations)
    }

    return candidateLocations
}

async function parsePluginInfo (pluginDir: string, packageName: string): Promise<PluginInfo|null> {
    const pluginPath = path.join(pluginDir, packageName)
    const infoPath = path.join(pluginPath, 'package.json')

    const name = getPluginName(packageName)

    try {
        const info = JSON.parse(await fs.readFile(infoPath, { encoding: 'utf-8' }))

        if (!info.keywords || !PLUGIN_KEYWORDS.some(x => info.keywords.includes(x))) {
            return null
        }

        let author = info.author
        author = author.name || author

        console.log(`Found ${name} in ${pluginDir}`)

        return {
            name: name,
            packageName: packageName,
            isBuiltin: pluginDir === resolveBuiltinPluginsPath(),
            isLegacy: packageName.startsWith(LEGACY_TABBY_PLUGIN_PREFIX) || packageName.startsWith(LEGACY_TERMINUS_PLUGIN_PREFIX),
            version: info.version,
            description: info.description,
            author,
            path: pluginPath,
            info,
        }
    } catch (error) {
        console.error('Cannot load package info for', packageName)
        return null
    }
}

export async function findPlugins (): Promise<PluginInfo[]> {
    const paths = nodeModule.globalPaths
    let foundPlugins: PluginInfo[] = []

    const candidateLocations: { pluginDir: string, packageName: string }[] = await getPluginCandidateLocation(paths)

    const foundPluginsPromises: Promise<PluginInfo|null>[] = []
    for (const { pluginDir, packageName } of candidateLocations) {

        if (builtinModules.includes(packageName) && pluginDir !== resolveBuiltinPluginsPath()) {
            continue
        }

        foundPluginsPromises.push(parsePluginInfo(pluginDir, packageName))
    }

    for (const pluginInfo of await Promise.all(foundPluginsPromises)) {
        if (pluginInfo) {
            const existing = foundPlugins.find(x => x.name === pluginInfo.name)
            if (existing) {
                if (existing.isLegacy) {
                    console.info(`Plugin ${pluginInfo.packageName} already exists, overriding`)
                    foundPlugins = foundPlugins.filter(x => x.name !== pluginInfo.name)
                } else {
                    console.info(`Plugin ${pluginInfo.packageName} already exists, skipping`)
                    continue
                }
            }

            foundPlugins.push(pluginInfo)
        }
    }

    foundPlugins.sort((a, b) => a.name > b.name ? 1 : -1)
    foundPlugins.sort((a, b) => a.isBuiltin < b.isBuiltin ? 1 : -1)
    return foundPlugins
}

export async function loadPlugins (foundPlugins: PluginInfo[], progress: ProgressCallback): Promise<any[]> {
    const plugins: any[] = []
    const pluginsPromises: Promise<any>[] = []

    let index = 0
    const setProgress = function () {
        index++
        progress(index, foundPlugins.length)
    }

    progress(0, 1)
    for (const foundPlugin of foundPlugins) {
        pluginsPromises.push(new Promise(x => {
            console.info(`Loading ${foundPlugin.name}: ${nodeRequire.resolve(foundPlugin.path)}`)
            try {
                const packageModule = nodeRequire(foundPlugin.path)
                cachePluginModule(foundPlugin.packageName, packageModule)
                const pluginModule = packageModule.default.forRoot ? packageModule.default.forRoot() : packageModule.default
                pluginModule.pluginName = foundPlugin.name
                pluginModule.bootstrap = packageModule.bootstrap
                plugins.push(pluginModule)
            } catch (error) {
                console.error(`Could not load ${foundPlugin.name}:`, error)
            }
            setProgress()
            setTimeout(x, 50)
        }))
    }
    await Promise.all(pluginsPromises)

    progress(1, 1)
    return plugins
}
