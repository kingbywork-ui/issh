import * as fs from 'fs'
import * as path from 'path'

const preloadDebugLogPath = path.join(process.env.ISSH_CONFIG_DIRECTORY || process.cwd(), 'bootstrap-debug.log')

function debugLog (message: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [preload] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    try {
        fs.appendFileSync(preloadDebugLogPath, line)
    } catch {
        console.warn(line)
    }
}

import '../lib/lru'
import 'source-sans-pro/source-sans-pro.css'
import 'source-code-pro/source-code-pro.css'
import '@fortawesome/fontawesome-free/css/solid.css'
import '@fortawesome/fontawesome-free/css/brands.css'
import '@fortawesome/fontawesome-free/css/regular.css'
import '@fortawesome/fontawesome-free/css/fontawesome.css'
import './preload.scss'

const rendererNodeRequire = global['require']
if (typeof window !== 'undefined') {
    window['nodeRequire'] = rendererNodeRequire
    console.timeStamp('index')
}

debugLog('preload-entry-loaded')
