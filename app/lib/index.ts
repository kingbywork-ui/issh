import { app, ipcMain, Menu, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// Static imports execute before this module body. Keep startup-sensitive modules
// as controlled runtime requires so config paths and logging are initialized first.
require('dotenv/config')
require('./portable')
const { promoteLegacyEnvironmentVariables } = require('./environment')
for (const { legacyName, primaryName } of promoteLegacyEnvironmentVariables()) {
    console.warn(`[deprecated] ${legacyName} is deprecated; use ${primaryName}.`)
}
process.env.ISSH_PLUGINS ??= ''
process.env.ISSH_CONFIG_DIRECTORY ??= app.getPath('userData')
if (process.env.ISSH_CONFIG_DIRECTORY) {
    fs.mkdirSync(process.env.ISSH_CONFIG_DIRECTORY, { recursive: true })
    app.setPath('userData', process.env.ISSH_CONFIG_DIRECTORY)
}
if (process.env.ISSH_SMOKE_DISABLE_GPU) {
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
    app.commandLine.appendSwitch('disable-software-rasterizer')
    app.commandLine.appendSwitch('in-process-gpu')
}

function ensureDevMode (): void {
    if (process.env.ISSH_DEV) {
        return
    }
    try {
        const appPath = app.getAppPath()
        const repoRoot = path.dirname(appPath)
        if (fs.existsSync(path.join(repoRoot, 'issh-core', 'package.json'))) {
            process.env.ISSH_DEV = '1'
        }
    } catch {
        // ignore — packaged app path may not be ready yet
    }
}
ensureDevMode()

const startupDebugLogPath = path.join(process.env.ISSH_CONFIG_DIRECTORY ?? app.getPath('userData'), 'startup-debug.log')

function debugLog (message: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [main] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
        fs.appendFileSync(startupDebugLogPath, line)
    } catch {
        console.log(line)
    }
}

function serializeError (error: any): any {
    return {
        message: error?.message,
        stack: error?.stack,
        code: error?.code,
    }
}

function loadStartupModule<T> (name: string, loader: () => T): T {
    try {
        debugLog(`module-load-begin:${name}`)
        const result = loader()
        debugLog(`module-load-done:${name}`)
        return result
    } catch (error) {
        debugLog(`module-load-failed:${name}`, serializeError(error))
        dialog.showErrorBox('Startup error', `${name}: ${error?.message ?? error}`)
        app.exit(1)
        throw error
    }
}

loadStartupModule('source-map-support/register', () => require('source-map-support/register'))
loadStartupModule('sentry', () => require('./sentry'))
loadStartupModule('lru', () => require('./lru'))

const { parseArgs } = loadStartupModule('cli', () => require('./cli'))
const { Application } = loadStartupModule('app', () => require('./app'))
const electronDebug = loadStartupModule('electron-debug', () => require('electron-debug').default ?? require('electron-debug'))
const { loadConfig } = loadStartupModule('config', () => require('./config'))

function parseStartupArgs (): any {
    debugLog('args-parse-begin', process.argv)
    if (!process.env.ISSH_DEV) {
        const args = process.argv.slice(1)
        const parsed = {
            d: args.includes('-d') || args.includes('--debug'),
            debug: args.includes('-d') || args.includes('--debug'),
            hidden: args.includes('--hidden'),
            _: args.filter(x => !x.startsWith('-')),
        }
        debugLog('args-parse-done:packaged', parsed)
        return parsed
    }
    const parsed = parseArgs(process.argv, process.cwd())
    debugLog('args-parse-done:dev', parsed)
    return parsed
}

const argv = parseStartupArgs()

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any

try {
    debugLog('config-load-begin')
    configStore = loadConfig()
    debugLog('config-loaded', {
        hasAppearance: !!configStore?.appearance,
    })
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

debugLog('application-constructor-begin')
const application = new Application(configStore)
debugLog('application-constructor-done')

// Register issh:// URL scheme.
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('issh', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('issh')
}

ipcMain.on('app:new-window', event => {
    if (!application.isTrustedRenderer(event.sender)) {
        return
    }
    application.newWindow()
})

process.on('uncaughtException' as any, err => {
    console.log(err)
    application.broadcast('uncaughtException', err)
})

if (argv.d) {
    electronDebug({
        isEnabled: true,
        showDevTools: false,
        devToolsMode: 'undocked',
    })
}

app.on('activate', async () => {
    if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', async (event, url) => {
    event.preventDefault()
    console.log('Received open-url event:', url)
    if (!application.hasWindows()) {
        process.argv.push(url)
    } else {
        await app.whenReady()
        application.handleSecondInstance([url], process.cwd())
    }
})

app.on('second-instance', async (_event, newArgv, cwd) => {
    application.handleSecondInstance(newArgv, cwd)
})

const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE
if (!isPortable && !app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.whenReady().then(async () => {
    debugLog('app-ready')
    if (process.platform === 'darwin') {
        app.dock.setMenu(Menu.buildFromTemplate([
            {
                label: 'New window',
                click () {
                    this.app.newWindow()
                },
            },
        ]))
    }

    application.init()
    debugLog('application-init-called')

    const window = await application.newWindow({ hidden: argv.hidden })
    debugLog('application-new-window-created')
    await window.ready
    debugLog('window-ready-resolved')
    window.passCliArguments(process.argv, process.cwd(), false)
    debugLog('window-cli-passed')
    window.focus()
    debugLog('window-focused')
})
