import { execFile } from 'child_process'
import * as path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export class PluginManager {
    async install (prefix: string, name: string, version: string): Promise<void> {
        await this.runNpm(prefix, ['install', `${name}@${version}`, '--save-exact'])
    }

    async uninstall (prefix: string, name: string): Promise<void> {
        await this.runNpm(prefix, ['uninstall', name])
    }

    private async runNpm (prefix: string, args: string[]): Promise<void> {
        const npmCli = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js')
        await execFileAsync(process.execPath, [
            npmCli,
            ...args,
            '--prefix',
            prefix,
            '--no-audit',
            '--no-fund',
        ], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
            },
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
        })
    }
}


export const pluginManager = new PluginManager()
