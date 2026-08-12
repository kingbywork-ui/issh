import { createParserConfig } from './cli'
import { parse as parseShellCommand } from 'shell-quote'

const PRIMARY_URL_PREFIX = 'issh://'
const LEGACY_URL_PREFIX = 'tabby://'
let legacyURLWarningEmitted = false

export function isISSHURL (arg: string): boolean {
    const lowerArg = arg.toLowerCase()
    return lowerArg.startsWith(PRIMARY_URL_PREFIX) || lowerArg.startsWith(LEGACY_URL_PREFIX)
}

export function parseISSHURL (url: string, cwd: string = process.cwd()): any {
    try {
        if (!isISSHURL(url)) {
            return null
        }

        if (url.toLowerCase().startsWith(LEGACY_URL_PREFIX) && !legacyURLWarningEmitted) {
            legacyURLWarningEmitted = true
            console.warn('[deprecated] tabby:// URLs are deprecated; use issh://.')
        }

        // NOTE: the url host may be lowercased (xdg-open), need to use the original command
        const urlInstance = new URL(url)
        const command = urlInstance.host || urlInstance.pathname.replace(/^\/+/, '')
        const config = createParserConfig(cwd)
        const commandConfig = config.commands.find(cmd => {
            const primaryCommand = Array.isArray(cmd.command) ? cmd.command[0] : cmd.command
            return command.toLowerCase() === primaryCommand.split(/\s+/)[0].toLowerCase()
        })
        if (!commandConfig) {
            console.error(`Unknown command in issh:// URL: ${command}`)
            return null
        }
        const primaryCommand = Array.isArray(commandConfig.command) ? commandConfig.command[0] : commandConfig.command
        const actualCommand = primaryCommand.split(/\s+/)[0]
        const argv: any = {
            _: [actualCommand],
        }
        for (const [key, value] of urlInstance.searchParams.entries()) {
            let parsedValue: any = value
            const optionConfig = commandConfig.options?.[key] ?? commandConfig.positionals?.[key]
            if (optionConfig) {
                switch (optionConfig.type) {
                    case 'boolean':
                        parsedValue = value === 'true' || value === ''
                        break
                    case 'number':
                        parsedValue = parseInt(value, 10)
                        break
                    case 'array':
                        parsedValue = parseShellCommand(value).filter(item => typeof item === 'string')
                        break
                    case 'string':
                    default:
                        parsedValue = value
                        break
                }
            } else {
                parsedValue = value
            }
            argv[key] = parsedValue
        }

        console.log(`URL Handler - Safely parsed [${url}] to:`, JSON.stringify(argv))
        return argv
    } catch (e) {
        console.error('Failed to parse issh:// URL:', e)
        return null
    }
}
