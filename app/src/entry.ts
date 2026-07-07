import 'zone.js'
import 'core-js/proposals/reflect-metadata'
import 'rxjs'

import './global.scss'
import './toastr.scss'

// Importing before @angular/*
import { findPlugins, initModuleLookup, loadPlugins } from './plugins'

import { enableProdMode, NgModuleRef, ApplicationRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
import { ipcRenderer } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

import { getRootModule } from './app.module'
import { BootstrapData, BOOTSTRAP_DATA, PluginInfo } from '../../tabby-core/src/api/mainProcess'

// Always land on the start view
location.hash = ''

;(process as any).enablePromiseAPI = true

if (process.platform === 'win32' && !('HOME' in process.env)) {
    process.env.HOME = `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
}

if (process.env.TABBY_DEV && !process.env.TABBY_FORCE_ANGULAR_PROD) {
    console.warn('Running in debug mode')
} else {
    enableProdMode()
}

const bootstrapDebugLogPath = path.join(process.env.TABBY_CONFIG_DIRECTORY || process.cwd(), 'bootstrap-debug.log')

function debugLog (message: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [renderer] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
        fs.appendFileSync(bootstrapDebugLogPath, line)
    } catch {
        console.warn(line)
    }
}

debugLog('entry-loaded', {
    pid: process.pid,
    platform: process.platform,
    dev: !!process.env.TABBY_DEV,
})

async function bootstrap (bootstrapData: BootstrapData, plugins: PluginInfo[], safeMode = false): Promise<NgModuleRef<any>> {
    debugLog('bootstrap-begin', {
        safeMode,
        pluginCount: plugins.length,
    })
    if (safeMode) {
        plugins = plugins.filter(x => x.isBuiltin)
        debugLog('bootstrap-safe-mode-filtered', {
            pluginCount: plugins.length,
        })
    }

    const pluginModules = await loadPlugins(plugins, (current, total) => {
        (document.querySelector('.progress .bar') as HTMLElement).style.width = `${100 * current / total}%` // eslint-disable-line
        if (current === 0 || current === total || current % 3 === 0) {
            debugLog('plugin-load-progress', { current, total })
        }
    })

    window['pluginModules'] = pluginModules
    debugLog('plugin-load-finished', {
        loaded: pluginModules.length,
        names: pluginModules.map(x => x.pluginName ?? x.name ?? 'unknown'),
    })

    const module = getRootModule(pluginModules)
    debugLog('angular-bootstrap-start')
    const moduleRef = await platformBrowserDynamic([
        { provide: BOOTSTRAP_DATA, useValue: bootstrapData },
    ]).bootstrapModule(module)
    debugLog('angular-bootstrap-done')
    if (process.env.TABBY_DEV) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const componentRef = applicationRef.components[0]
        enableDebugTools(componentRef)
    }
    return moduleRef
}

ipcRenderer.once('start', async (_$event, bootstrapData: BootstrapData) => {
    console.log('Window bootstrap data:', bootstrapData)
    debugLog('ipc-start-received', {
        userPluginsPath: bootstrapData.userPluginsPath,
        isMainWindow: bootstrapData.isMainWindow,
        hasVaultPassphrase: !!bootstrapData.vaultPassphrase,
    })

    if (bootstrapData.vaultPassphrase) {
        process.env.TABBY_VAULT_PASSPHRASE = bootstrapData.vaultPassphrase
    }

    initModuleLookup(bootstrapData.userPluginsPath)
    debugLog('module-lookup-initialized')

    let plugins = await findPlugins()
    debugLog('plugins-found', {
        count: plugins.length,
        names: plugins.map(x => x.name),
    })
    bootstrapData.installedPlugins = plugins
    if (bootstrapData.config.pluginBlacklist) {
        plugins = plugins.filter(x => !bootstrapData.config.pluginBlacklist.includes(x.name))
    }
    plugins = plugins.filter(x => x.name !== 'web')

    console.log('Starting with plugins:', plugins)
    debugLog('plugins-after-filter', {
        count: plugins.length,
        names: plugins.map(x => x.name),
    })
    try {
        await bootstrap(bootstrapData, plugins)
    } catch (error) {
        console.error('Angular bootstrapping error:', error)
        console.warn('Trying safe mode')
        window['safeModeReason'] = error
        debugLog('angular-bootstrap-error', {
            error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        })
        try {
            await bootstrap(bootstrapData, plugins, true)
        } catch (error2) {
            console.error('Bootstrap failed:', error2)
            debugLog('angular-bootstrap-safe-mode-error', {
                error: error2 instanceof Error ? { message: error2.message, stack: error2.stack } : String(error2),
            })
        }
    }
})

setTimeout(() => {
    const progressBar = document.querySelector('.progress .bar') as HTMLElement | null
    const payload = {
        rootChildren: document.body?.children?.length,
        appRootExists: !!document.querySelector('app-root'),
        progressWidth: progressBar?.style?.width,
        safeModeReason: window['safeModeReason'] instanceof Error ? {
            message: window['safeModeReason'].message,
            stack: window['safeModeReason'].stack,
        } : window['safeModeReason'],
        pluginModulesLoaded: window['pluginModules']?.length,
    }
    console.warn('Bootstrap watchdog fired', payload)
    debugLog('bootstrap-watchdog', payload)
}, 10000)

debugLog('ipc-ready-sent')
ipcRenderer.send('ready')
