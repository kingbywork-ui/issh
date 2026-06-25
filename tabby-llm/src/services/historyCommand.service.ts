import { Injectable } from '@angular/core'
import { PlatformService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { TerminalContextService } from './terminalContext.service'
import { normalizeCommand } from './commandValidation'

interface HistoryEntry {
    command: string
    timestamp: number
    useCount: number
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class HistoryCommandService {
    private history: HistoryEntry[] = []
    private maxHistory = 500
    private logger: Logger
    private historyFilePath: string | null = null
    private saveTimer: ReturnType<typeof setTimeout> | null = null
    private loaded = false
    private shellHistoryLoaded = new Set<string>()
    private bootstrapPromises = new Map<string, Promise<void>>()

    constructor (
        log: LogService,
        platform: PlatformService,
        private context: TerminalContextService,
    ) {
        this.logger = log.create('llm-history')
        const configPath = platform.getConfigPath()
        if (configPath) {
            this.historyFilePath = path.join(path.dirname(configPath), 'llm-command-history.json')
        }
        this.loadFromDisk()
    }

    private async loadFromDisk (): Promise<void> {
        if (!this.historyFilePath) {
            this.loaded = true
            return
        }
        try {
            await fs.access(this.historyFilePath)
            const data = await fs.readFile(this.historyFilePath, 'utf-8')
            const parsed = JSON.parse(data) as HistoryEntry[]
            if (Array.isArray(parsed)) {
                this.history = this.compactHistory(parsed).slice(0, this.maxHistory)
            }
        } catch (e) {
            this.logger.warn('Failed to load command history:', e)
        } finally {
            this.loaded = true
        }
    }

    async bootstrap (tab: BaseTerminalTabComponent<any>): Promise<void> {
        await this.ensureShellHistoryLoaded(tab)
        this.bootstrapFromTerminal(tab)
    }

    bootstrapFromTerminal (tab: BaseTerminalTabComponent<any>): void {
        const commands = this.context.extractCommandsFromTerminal(tab, 300)
        for (const command of commands) {
            const normalized = normalizeCommand(command, { allowMultiline: true })
            if (normalized) {
                this.addCommand(normalized, false)
            }
        }
        void this.saveToDisk()
    }

    async ensureShellHistoryLoaded (tab: BaseTerminalTabComponent<any>): Promise<void> {
        const key = this.getHistoryBootstrapKey(tab)
        if (!key) {
            return
        }
        const existing = this.bootstrapPromises.get(key)
        if (existing) {
            await existing
            return
        }
        const promise = this.bootstrapFromShellHistory(tab)
            .finally(() => {
                this.bootstrapPromises.delete(key)
            })
        this.bootstrapPromises.set(key, promise)
        await promise
    }

    private async bootstrapFromShellHistory (tab: BaseTerminalTabComponent<any>): Promise<void> {
        if (tab.profile?.type === 'ssh') {
            await this.bootstrapFromRemoteHistory(tab)
            return
        }

        const files = this.getShellHistoryFiles(tab)
        for (const file of files) {
            if (this.shellHistoryLoaded.has(file)) {
                continue
            }
            this.shellHistoryLoaded.add(file)
            try {
                const data = await fs.readFile(file, 'utf-8')
                for (const command of this.parseShellHistory(file, data)) {
                    const normalized = normalizeCommand(command, { allowMultiline: true })
                    if (normalized) {
                        this.addCommand(normalized, false)
                    }
                }
            } catch (e) {
                const code = e instanceof Error && 'code' in e ? e.code : null
                if (code !== 'ENOENT') {
                    this.logger.warn('Failed to load shell history:', file, e)
                }
            }
        }
        void this.saveToDisk()
    }

    private async bootstrapFromRemoteHistory (tab: BaseTerminalTabComponent<any>): Promise<void> {
        const sshSession = (tab as any).sshSession
        const runReadonlyCommand = sshSession?.runReadonlyCommand?.bind(sshSession)
        if (typeof runReadonlyCommand !== 'function') {
            return
        }

        const commandsToTry = [
            `python3 - <<'PY'
import os
from pathlib import Path
paths = [
    Path.home() / '.bash_history',
    Path.home() / '.zsh_history',
    Path.home() / '.local/share/fish/fish_history',
]
for path in paths:
    if path.exists():
        print(f'@@TABBY_HISTORY_FILE@@ {path}')
        try:
            print(path.read_text(errors='ignore'))
        except Exception:
            pass
PY`,
            'fc -ln -200 2>/dev/null || history 200 2>/dev/null || cat ~/.bash_history 2>/dev/null || cat ~/.zsh_history 2>/dev/null',
        ]

        for (const command of commandsToTry) {
            let output: string
            try {
                output = await runReadonlyCommand(command, 5000)
            } catch (e) {
                this.logger.warn('Remote history command failed:', e)
                continue
            }
            if (!output?.trim()) {
                continue
            }

            const normalizedCommands = this.parseRemoteHistoryOutput(output)
            for (const item of normalizedCommands) {
                this.addCommand(item, false)
            }
            if (normalizedCommands.length > 0) {
                void this.saveToDisk()
                return
            }
        }
    }

    private parseRemoteHistoryOutput (output: string): string[] {
        const chunks = output
            .split('@@TABBY_HISTORY_FILE@@')
            .map(chunk => chunk.trim())
            .filter(Boolean)

        const commands: string[] = []
        if (chunks.length > 1) {
            for (const chunk of chunks) {
                const lines = chunk.split(/\r?\n/)
                const [, ...contentLines] = lines
                for (const command of this.parseShellHistory('', contentLines.join('\n'))) {
                    const normalized = normalizeCommand(command, { allowMultiline: true })
                    if (normalized) {
                        commands.push(normalized)
                    }
                }
            }
            return Array.from(new Set(commands))
        }

        for (const line of output.split(/\r?\n/)) {
            const stripped = this.context.stripPrompt(line).trim()
            const normalized = normalizeCommand(stripped, { allowMultiline: true })
            if (normalized) {
                commands.push(normalized)
            }
        }
        return Array.from(new Set(commands))
    }

    private getHistoryBootstrapKey (tab: BaseTerminalTabComponent<any>): string | null {
        const files = this.getShellHistoryFiles(tab)
        if (files.length) {
            return files.join('|')
        }
        const profile = tab.profile
        return profile?.id ?? profile?.name ?? profile?.type ?? null
    }

    private getShellHistoryFiles (tab: BaseTerminalTabComponent<any>): string[] {
        const profile = tab.profile
        if (profile?.type && profile.type !== 'local') {
            return []
        }

        const options = profile?.options ?? {}
        const shell = `${options.shellType ?? ''} ${options.shell ?? ''} ${options.command ?? ''}`.toLowerCase()
        const home = os.homedir()
        const files: string[] = []

        if (!shell || /bash|sh|wsl|git-bash/.test(shell)) {
            files.push(path.join(home, '.bash_history'))
        }
        if (!shell || shell.includes('zsh')) {
            files.push(path.join(home, '.zsh_history'))
        }
        if (!shell || shell.includes('fish')) {
            files.push(path.join(home, '.local', 'share', 'fish', 'fish_history'))
        }
        if (!shell || /powershell|pwsh/.test(shell)) {
            const appData = process.env.APPDATA
            if (appData) {
                files.push(
                    path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
                    path.join(appData, 'Microsoft', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
                )
            }
        }

        return Array.from(new Set(files))
    }

    private parseShellHistory (file: string, data: string): string[] {
        if (file.endsWith('fish_history') || data.includes('- cmd: ')) {
            return data.split(/\r?\n/)
                .map(line => /^- cmd: (.*)$/.exec(line)?.[1] ?? '')
                .map(command => command.replace(/\\n/g, '\n').trim())
                .filter(command => command)
        }

        return data.split(/\r?\n/)
            .map(line => {
                const zshExtended = /^: \d+:\d+;(.*)$/.exec(line)
                return (zshExtended?.[1] ?? line).trim()
            })
            .filter(command => command)
    }

    private scheduleSave (): void {
        if (!this.historyFilePath) {
            return
        }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer)
        }
        this.saveTimer = setTimeout(() => {
            void this.saveToDisk()
        }, 2000)
    }

    private async saveToDisk (): Promise<void> {
        if (!this.historyFilePath) {
            return
        }
        try {
            const data = JSON.stringify(this.history)
            await fs.writeFile(this.historyFilePath, data, 'utf-8')
        } catch (e) {
            this.logger.warn('Failed to save command history:', e)
        }
    }

    addCommand (command: string, scheduleSave = true): void {
        const normalized = this.normalizeHistoryCommand(command)
        if (!normalized) {
            return
        }
        const existing = this.history.find(e => e.command === normalized)
        if (existing) {
            existing.useCount++
            existing.timestamp = Date.now()
            this.history.sort((a, b) => b.timestamp - a.timestamp)
            if (scheduleSave) {
                this.scheduleSave()
            }
            return
        }
        this.history.unshift({ command: normalized, timestamp: Date.now(), useCount: 1 })
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory)
        }
        if (scheduleSave) {
            this.scheduleSave()
        }
    }

    search (partial: string, limit: number): { command: string, score: number }[] {
        if (!this.loaded || !partial.trim() || this.history.length === 0) {
            return []
        }
        const lower = partial.toLowerCase().trim()
        const scored = this.history.map((entry, index) => {
            const cmd = entry.command.toLowerCase()
            let score = 0

            if (cmd === lower) {
                score = 200
            } else if (cmd.startsWith(lower)) {
                score = 100 + lower.length / cmd.length * 50
            } else if (lower.length >= 4 && this.wordStartsWith(cmd, lower)) {
                score = 70 + lower.length / cmd.length * 30
            } else if (lower.length >= 4 && cmd.includes(lower)) {
                score = 50 + lower.length / cmd.length * 30
            } else if (lower.length >= 5 && this.fuzzyMatch(lower, cmd)) {
                score = 20
            }

            if (score > 0) {
                const recencyBonus = Math.max(0, 10 - index)
                const frequencyBonus = Math.min(15, entry.useCount * 3)
                score += recencyBonus + frequencyBonus
            }

            return { command: entry.command, score }
        })

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
    }

    private fuzzyMatch (pattern: string, text: string): boolean {
        let pi = 0
        for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
            if (text[ti] === pattern[pi]) {
                pi++
            }
        }
        return pi === pattern.length
    }

    private wordStartsWith (command: string, partial: string): boolean {
        return command
            .split(/[\s/._-]+/)
            .some(word => word.startsWith(partial))
    }

    private normalizeHistoryCommand (command: string): string | null {
        return normalizeCommand(
            this.context.stripPrompt(command).trim(),
            { allowMultiline: true },
        )
    }

    private compactHistory (entries: HistoryEntry[]): HistoryEntry[] {
        const merged = new Map<string, HistoryEntry>()
        for (const entry of entries) {
            if (!entry?.command) {
                continue
            }
            const command = this.normalizeHistoryCommand(entry.command)
            if (!command) {
                continue
            }
            const existing = merged.get(command)
            if (existing) {
                existing.useCount += entry.useCount || 1
                existing.timestamp = Math.max(existing.timestamp, entry.timestamp || 0)
            } else {
                merged.set(command, {
                    command,
                    timestamp: entry.timestamp || Date.now(),
                    useCount: entry.useCount || 1,
                })
            }
        }
        return Array.from(merged.values())
            .sort((a, b) => b.timestamp - a.timestamp)
    }
}
