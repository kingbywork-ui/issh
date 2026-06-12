import { app, ipcMain, Menu, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.TABBY_PLUGINS ??= ''
process.env.TABBY_CONFIG_DIRECTORY ??= app.getPath('userData')


import 'v8-compile-cache'
import 'source-map-support/register'
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application } from './app'
import electronDebug from 'electron-debug'
import { loadConfig } from './config'


const argv = parseArgs(process.argv, process.cwd())

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any
const startupDebugLogPath = path.join(process.env.TABBY_CONFIG_DIRECTORY ?? app.getPath('userData'), 'startup-debug.log')

function debugLog (message: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [main] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
        fs.appendFileSync(startupDebugLogPath, line)
    } catch {
        console.log(line)
    }
}

try {
    configStore = loadConfig()
    debugLog('config-loaded', {
        hasAppearance: !!configStore?.appearance,
    })
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

const application = new Application(configStore)

// Register tabby:// URL scheme
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('tabby', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('tabby')
}

ipcMain.on('app:new-window', () => {
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

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.on('ready', async () => {
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
