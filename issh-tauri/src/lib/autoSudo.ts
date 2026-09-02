import type { Terminal } from '@xterm/xterm'
import { lockHostProfiles, resolveSudoPassword, unlockHostProfiles } from './runtime'
import type { TerminalDecoratorDefinition } from './plugins/types'

const ENABLED_KEY = 'issh.autoSudo.enabled'
const SUDO_PROMPT_MARKER = '[sudo'
const SUDO_AUTH_FAILURE = /(?:sorry, try again|authentication failure|incorrect password)/i
const LEGACY_PREFIX = 'issh-plugin-auto-sudo:user:'

export function clearLegacySudoPasswords (): number {
    let removed = 0
    try {
        const keys: string[] = []
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (key?.startsWith(LEGACY_PREFIX)) keys.push(key)
        }
        for (const key of keys) {
            localStorage.removeItem(key)
            removed += 1
        }
    } catch {}
    return removed
}

export function isAutoSudoEnabled (): boolean {
    try { return localStorage.getItem(ENABLED_KEY) !== 'false' } catch { return true }
}

export function setAutoSudoEnabled (enabled: boolean): void {
    try { localStorage.setItem(ENABLED_KEY, String(enabled)) } catch {}
}

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

function showTerminalStatus (terminal: Terminal, message: string): void {
    terminal.write(`\x1b[s\x1b[999;999H\x1b[8;5;2m[issh] ${message}\x1b[0m\x1b[u`)
}

// 仅 SSH：提示出现后从已解锁的 Vault 取当前连接的独立 sudo 凭据。
export const autoSudoDecorator: TerminalDecoratorDefinition = {
    id: 'auto-sudo',
    decorate (options) {
        if (options.kind !== 'ssh' || !options.profile) return
        const { terminal, profile } = options
        let pendingPassword: string | null = null
        let lookupGeneration = 0
        let expiryTimer: ReturnType<typeof setTimeout> | null = null
        const clearPending = (): void => {
            pendingPassword = null
            options.setAction?.(null)
            if (expiryTimer !== null) clearTimeout(expiryTimer)
            expiryTimer = null
        }
        const fillPending = (): void => {
            if (pendingPassword === null) return
            options.write(`${pendingPassword}\r`)
            clearPending()
        }
        const unlockAndFill = async (user: string, generation: number): Promise<void> => {
            const passphrase = await options.requestVaultPassphrase?.()
            if (!passphrase || generation !== lookupGeneration) return
            let password: string | null = null
            try {
                await unlockHostProfiles(passphrase)
                password = await resolveSudoPassword(user, profile.host, profile.port)
            } catch {
                if (generation === lookupGeneration) {
                    showTerminalStatus(terminal, '主口令不正确或保险库无法解锁，请点击按钮重试')
                }
                return
            } finally {
                await lockHostProfiles().catch(() => {})
            }
            if (generation !== lookupGeneration) return
            if (password === null) {
                clearPending()
                showTerminalStatus(terminal, '未找到此主机的 sudo 密码，请到 设置 > sudo 密码 添加')
                return
            }
            options.write(`${password}\r`)
            clearPending()
        }

        terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown' || !isAutoSudoEnabled()) return true
            if (event.ctrlKey && event.key === 'Enter' && pendingPassword !== null) {
                fillPending()
                return false
            }
            if (pendingPassword !== null && event.key.length > 0) clearPending()
            return true
        })

        const dataListener = terminal.onWriteParsed(() => {
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            if (!line) return
            const text = line.translateToString(true)
            if (SUDO_AUTH_FAILURE.test(text)) {
                lookupGeneration += 1
                clearPending()
                showTerminalStatus(terminal, 'sudo 认证失败，请在 设置 > sudo 密码 更新后重试')
                return
            }
            if (!isAutoSudoEnabled()) {
                clearPending()
                return
            }
            const promptUser = matchSudoPrompt(text)
            if (promptUser === null) return

            const user = promptUser || profile.user
            if (!user) return
            clearPending()
            const generation = ++lookupGeneration
            void resolveSudoPassword(user, profile.host, profile.port).then((password) => {
                if (generation !== lookupGeneration || password === null) {
                    if (generation === lookupGeneration && password === null) {
                        showTerminalStatus(terminal, '未找到此主机的 sudo 密码，请到 设置 > sudo 密码 添加')
                    }
                    return
                }
                pendingPassword = password
                expiryTimer = setTimeout(clearPending, 10000)
                options.setAction?.({ label: '填充 sudo 密码', invoke: fillPending })
                showTerminalStatus(terminal, '点击“填充 sudo 密码”或按 Ctrl+Enter，任意输入取消')
            }).catch(() => {
                if (generation === lookupGeneration) {
                    expiryTimer = setTimeout(clearPending, 30000)
                    options.setAction?.({
                        label: '解锁并填充 sudo 密码',
                        invoke: () => { void unlockAndFill(user, generation) },
                    })
                    showTerminalStatus(terminal, '点击“解锁并填充 sudo 密码”后输入保险库主口令')
                }
            })
        })

        options.dispose(() => {
            lookupGeneration += 1
            clearPending()
            dataListener.dispose()
        })
    },
}
