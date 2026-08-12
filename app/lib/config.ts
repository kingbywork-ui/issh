import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { writeFile } from 'atomically'


export const configPath = path.join(process.env.ISSH_CONFIG_DIRECTORY!, 'config.yaml')

export function getLegacyConfigPaths (
    configDirectory: string = path.dirname(configPath),
    homeDirectory: string = os.homedir(),
): string[] {
    const candidates = [
        path.resolve(configDirectory, '..', 'terminus', 'config.yaml'),
    ]
    if (path.basename(configDirectory).toLowerCase() === 'issh') {
        const parent = path.dirname(configDirectory)
        candidates.unshift(
            path.join(parent, 'Tabby', 'config.yaml'),
            path.join(parent, 'tabby', 'config.yaml'),
            path.join(homeDirectory, '.config', 'tabby', 'config.yaml'),
            path.join(homeDirectory, '.tabby', 'config.yaml'),
        )
    }
    const seen = new Set<string>()
    return candidates.filter(candidate => {
        const resolved = path.resolve(candidate)
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    })
}

export function migrateConfig (legacyPaths: string[] = getLegacyConfigPaths()): string | null {
    if (fs.existsSync(configPath)) {
        return null
    }
    for (const legacyPath of legacyPaths) {
        if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isFile()) {
            fs.copyFileSync(legacyPath, configPath)
            return legacyPath
        }
    }
    return null
}

export function loadConfig (): any {
    const migratedFrom = migrateConfig()
    if (migratedFrom) {
        console.warn(`[deprecated] Migrated legacy config from ${migratedFrom} to ${configPath}.`)
    }

    if (fs.existsSync(configPath)) {
        return yaml.load(fs.readFileSync(configPath, 'utf8'))
    } else {
        return {}
    }
}

export async function saveConfig (content: string): Promise<void> {
    await writeFile(configPath, content, { encoding: 'utf8' })
    await writeFile(configPath + '.backup', content, { encoding: 'utf8' })
}
