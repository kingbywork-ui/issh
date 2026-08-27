import type { TerminalDecoratorDefinition } from './plugins/types'

// 历史 key 前缀沿用插件时代格式（issh-plugin-auto-sudo:user:），保证升级内置后已保存密码不丢失
const STORAGE_PREFIX = 'issh-plugin-auto-sudo:user:'
const ENABLED_KEY = 'issh.autoSudo.enabled'

export function isAutoSudoEnabled (): boolean {
    try { return localStorage.getItem(ENABLED_KEY) !== 'false' } catch { return true }
}

export function setAutoSudoEnabled (enabled: boolean): void {
    try { localStorage.setItem(ENABLED_KEY, String(enabled)) } catch {}
}

export function listSavedSudoUsers (): Array<{ user: string }> {
    const users: Array<{ user: string }> = []
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && key.startsWith(STORAGE_PREFIX)) {
                users.push({ user: key.slice(STORAGE_PREFIX.length) })
            }
        }
    } catch {}
    return users.sort((a, b) => a.user.localeCompare(b.user))
}

export function deleteSavedSudoUser (user: string): void {
    try { localStorage.removeItem(`${STORAGE_PREFIX}${user}`) } catch {}
}

const SUDO_PROMPT_MARKER = '[sudo'
// 多语言 sudo 密码提示（捕获组为用户名；sudo-rs 无用户名）
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

// 内置功能：检测终端 sudo 密码提示（多语言），Ctrl+Enter 填充已保存密码
export const autoSudoDecorator: TerminalDecoratorDefinition = {
    id: 'auto-sudo',
    decorate (options) {
        const { terminal } = options
        let pendingPassword: string | null = null

        // xterm 的 attachCustomKeyEventHandler 为单槽位替换式（无注销 API）；
        // tab 重建时先 runDecoratorCleanups 再整体重新 decorate，handler 被替换，无泄漏
        terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') return true
            if (!isAutoSudoEnabled()) return true
            if (event.ctrlKey && event.key === 'Enter' && pendingPassword !== null) {
                options.write(`${pendingPassword}\r`)
                pendingPassword = null
                return false
            }
            return true
        })

        const dataListener = terminal.onWriteParsed(() => {
            if (!isAutoSudoEnabled()) {
                pendingPassword = null
                return
            }
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            if (!line) return
            const text = line.translateToString(true)
            const user = matchSudoPrompt(text)
            if (user !== null) {
                // 密码按用户名持久化（跨会话可用）；sessionId 不参与 key，避免会话关闭即失效
                let saved: string | null = null
                try { saved = localStorage.getItem(`${STORAGE_PREFIX}${user}`) } catch {}
                pendingPassword = saved
                if (saved !== null) {
                    terminal.write('\x1b[s\x1b[999;999H\x1b[8;5;2m[issh] Ctrl+Enter 填充已存密码\x1b[0m\x1b[u')
                }
            }
        })

        options.dispose(() => {
            dataListener.dispose()
        })
    },
}
