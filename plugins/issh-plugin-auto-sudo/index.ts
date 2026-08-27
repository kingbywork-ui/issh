import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, TerminalDecoratorDefinition } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-auto-sudo',
    name: 'sudo 密码自动填充',
    version: '0.1.1',
    description: '检测终端中的 sudo 密码提示（多语言），按 Ctrl+Enter 自动填充已保存的密码',
    kind: 'feature',
    entry: 'index.js',
    permissions: ['terminal:decorate'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-auto-sudo',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-auto-sudo',
}

const SUDO_PROMPT_MARKER = '[sudo'
const SUDO_PROMPT_PATTERNS: RegExp[] = [
    /^\[sudo\] password for ([^:]+):\s*$/im,
    /^\[sudo\] Passwort für ([^:]+):\s*$/im,
    /^\[sudo\] Mot de passe de ([^:]+)\s+:\s*$/im,
    /^\[sudo\] [Cc]ontraseña para ([^:]+):\s*$/im,
    /^\[sudo\] [Ss]enha para ([^:]+):\s*$/im,
    /^\[sudo\] [Pp]assword di ([^:]+):\s*$/im,
    /^\[sudo\] ([^\s]+) 的密码[：:]\s*$/im,
    /^\[sudo\] ([^\s]+) 的密碼[：:]\s*$/im,
    /^\[sudo\] ([^\s]+) のパスワード[：:]\s*$/im,
    /^\[sudo\] ([^\s]+) 암호[：:]\s*$/im,
    /^\[sudo\] пароль для ([^:]+):\s*$/im,
    /^\[sudo\] hasło użytkownika ([^:]+):\s*$/im,
    /^\[sudo\] ([^\s]+) için parola:\s*$/im,
    /^\[sudo\] [Hh]eslo pro ([^:]+):\s*$/im,
    /^\[sudo\] lösenord för ([^:]+):\s*$/im,
    /^\[sudo\] adgangskode for ([^:]+):\s*$/im,
    /^\[sudo\] kata sandi untuk ([^:]+):\s*$/im,
    /^\[sudo\] пароль до ([^:]+):\s*$/im,
    /^\[sudo\] lozinka za ([^:]+):\s*$/im,
    /^\[sudo: authenticate\] .+?[：:]\s*$/im,
]

function matchSudoPrompt (text: string): string | null {
    if (!text.toLowerCase().includes(SUDO_PROMPT_MARKER)) return null
    for (const pattern of SUDO_PROMPT_PATTERNS) {
        const match = text.match(pattern)
        if (match) return match[1] ?? ''
    }
    return null
}

const decorator: TerminalDecoratorDefinition = {
    id: 'auto-sudo',
    decorate (options) {
        const { terminal } = options
        let lastPromptUser: string | null = null
        let lastPromptLine = -1

        const parser = terminal.registerMarker?.bind(terminal)
        void parser

        const onWriteOriginal = terminal.write.bind(terminal)
        let pendingPassword: string | null = null

        const keyHandler = terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') return true
            if (event.ctrlKey && event.key === 'Enter' && pendingPassword !== null) {
                options.write(`${pendingPassword}\r`)
                pendingPassword = null
                lastPromptUser = null
                return false
            }
            return true
        })

        const onRenderChange = terminal.onLineFeed(() => { lastPromptLine = terminal.buffer.active.cursorY })
        void onWriteOriginal

        const dataListener = terminal.onWriteParsed(() => {
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            if (!line) return
            const text = line.translateToString(true)
            const user = matchSudoPrompt(text)
            if (user !== null) {
                lastPromptUser = user
                const saved = localStorage.getItem(`issh-plugin-auto-sudo:${options.sessionId}:${user}`)
                pendingPassword = saved
                if (saved !== null) {
                    terminal.write('\x1b[s\x1b[999;999H\x1b[8;5;2m[issh] Ctrl+Enter 填充已存密码\x1b[0m\x1b[u')
                }
            }
        })

        options.dispose(() => {
            keyHandler?.()
            onRenderChange.dispose()
            dataListener.dispose()
        })
    },
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.registerTerminalDecorator(decorator)
        ctx.log('info', 'auto-sudo plugin activated')
    },
}

export default plugin
