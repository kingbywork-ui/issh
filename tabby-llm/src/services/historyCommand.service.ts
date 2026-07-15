import { Injectable } from '@angular/core'
import { PlatformService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { TerminalContextService } from './terminalContext.service'
import { normalizeCommand } from './commandValidation'
import { SensitiveInputService } from './sensitiveInput.service'

interface HistoryEntry {
    command: string
    timestamp: number
    useCount: number
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class HistoryCommandService {
    private history: HistoryEntry[] = []
    private logger: Logger
    private historyFilePath: string | null = null
    private saveTimer: ReturnType<typeof setTimeout> | null = null
    private loaded = false
    private shellHistoryLoaded = new Set<string>()
    private bootstrapPromises = new Map<string, Promise<void>>()
    private tabHistory = new Map<string, HistoryEntry[]>()

    constructor (
        log: LogService,
        platform: PlatformService,
        private context: TerminalContextService,
        private sensitiveInput: SensitiveInputService,
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
                this.history = this.compactHistory(parsed)
                // Re-persist if tightened validation dropped polluted entries.
                if (this.history.length !== parsed.length) {
                    this.scheduleSave()
                }
            }
        } catch (e) {
            this.logger.warn('Failed to load command history:', e)
        } finally {
            this.loaded = true
        }
    }

    async bootstrap (tab: BaseTerminalTabComponent<any>): Promise<void> {
        await this.ensureShellHistoryLoaded(tab)
    }

    usesRemoteHistory (tab: BaseTerminalTabComponent<any>): boolean {
        return tab.profile?.type === 'ssh'
    }

    async refreshRemoteHistory (tab: BaseTerminalTabComponent<any>, tabKey: string): Promise<void> {
        if (!this.usesRemoteHistory(tab)) {
            return
        }
        const commands = [
            ...await this.fetchRemoteHistoryCommands(tab),
            ...this.getTerminalHistoryOutputCommands(tab),
        ]
        if (commands.length) {
            this.replaceTabHistory(tabKey, commands)
        }
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
        if (this.usesRemoteHistory(tab)) {
            await this.refreshRemoteHistory(tab, this.getTabKey(tab))
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
                        this.addCommand(normalized, { scheduleSave: false })
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

    private async fetchRemoteHistoryCommands (tab: BaseTerminalTabComponent<any>): Promise<string[]> {
        const sshSession = (tab as any).sshSession
        const runReadonlyCommand = sshSession?.runReadonlyCommand?.bind(sshSession)
        if (typeof runReadonlyCommand !== 'function') {
            return []
        }

        const commandsToTry = [
            'history 2>/dev/null',
            'fc -ln 2>/dev/null',
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
            'cat ~/.bash_history 2>/dev/null || cat ~/.zsh_history 2>/dev/null',
        ]

        const commands: string[] = []
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
            commands.push(...normalizedCommands)
        }
        return Array.from(new Set(commands))
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
            const withoutNumber = stripped.replace(/^\s*\d+\s+/, '')
            const normalized = normalizeCommand(withoutNumber, { allowMultiline: true })
            if (normalized) {
                commands.push(normalized)
            }
        }
        return Array.from(new Set(commands))
    }

    private getTerminalHistoryOutputCommands (tab: BaseTerminalTabComponent<any>): string[] {
        const commands: string[] = []
        for (const line of this.context.getRecentOutput(tab, 5000)) {
            const historyMatch = /^\s*\d+\s+(.*)$/.exec(line)
            if (!historyMatch) {
                continue
            }
            const normalized = normalizeCommand(historyMatch[1].trim(), { allowMultiline: true })
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

    addCommand (
        command: string,
        options: { scheduleSave?: boolean, tabKey?: string, persistGlobal?: boolean } = {},
    ): void {
        const scheduleSave = options.scheduleSave ?? true
        const persistGlobal = options.persistGlobal ?? true
        const normalized = this.normalizeHistoryCommand(command)
        if (!normalized || !this.sensitiveInput.shouldStoreCommand(normalized)) {
            return
        }

        if (options.tabKey) {
            this.addToTabHistory(options.tabKey, normalized)
        }

        if (persistGlobal) {
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
        }
        if (scheduleSave) {
            this.scheduleSave()
        }
    }

    search (
        partial: string,
        limit?: number,
        tabKey?: string,
        options: { includeGlobal?: boolean } = {},
    ): { command: string, score: number }[] {
        if (!partial.trim()) {
            return []
        }
        const includeGlobal = options.includeGlobal ?? true
        const lower = partial.toLowerCase().trim()
        const tabResults = this.limitResults(
            tabKey ? this.scoreEntries(this.tabHistory.get(tabKey) ?? [], lower, true) : [],
            limit,
        )
        if (!includeGlobal || !this.loaded) {
            return tabResults
        }
        const seen = new Set(tabResults.map(result => result.command))
        const globalLimit = limit === undefined ? undefined : Math.max(0, limit - tabResults.length)
        const globalResults = this.limitResults(
            this.scoreEntries(this.history, lower, false)
                .filter(result => !seen.has(result.command)),
            globalLimit,
        )

        return [...tabResults, ...globalResults]
    }

    clearTabHistory (tabKey: string): void {
        this.tabHistory.delete(tabKey)
    }

    getTabKey (tab: BaseTerminalTabComponent<any>): string {
        const target = tab as any
        const profile = tab.profile
        if (!target.__tabbyLLMKey) {
            const profilePart = profile?.id ?? profile?.name ?? profile?.type ?? 'tab'
            const sessionPart = target.session?.constructor?.name ?? profile?.options?.host ?? 'session'
            target.__tabbyLLMKey = `${profilePart}:${sessionPart}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
        }
        return target.__tabbyLLMKey
    }

    private scoreEntries (entries: HistoryEntry[], lower: string, preferTabLocal: boolean): { command: string, score: number }[] {
        if (!entries.length) {
            return []
        }

        // History autocomplete: prefix-only match, return every hit (caller may still pass limit).
        const scored = entries.map((entry, index) => {
            const cmd = entry.command.toLowerCase()
            if (!cmd.startsWith(lower) || !this.normalizeHistoryCommand(entry.command)) {
                return { command: entry.command, score: 0 }
            }

            let score = cmd === lower
                ? 200
                : 100 + lower.length / Math.max(cmd.length, 1) * 50
            const recencyBonus = Math.max(0, (preferTabLocal ? 14 : 10) - index)
            const frequencyBonus = Math.min(15, entry.useCount * 3)
            score += recencyBonus + frequencyBonus + (preferTabLocal ? 20 : 0)

            return { command: entry.command, score }
        })

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
    }

    private limitResults<T> (results: T[], limit?: number): T[] {
        return limit === undefined ? results : results.slice(0, limit)
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

    private addToTabHistory (tabKey: string, command: string): void {
        const entries = this.tabHistory.get(tabKey) ?? []
        const existing = entries.find(entry => entry.command === command)
        if (existing) {
            existing.useCount++
            existing.timestamp = Date.now()
            entries.sort((a, b) => b.timestamp - a.timestamp)
        } else {
            entries.unshift({ command, timestamp: Date.now(), useCount: 1 })
        }
        this.tabHistory.set(tabKey, entries)
    }

    private replaceTabHistory (tabKey: string, commands: string[]): void {
        const entries: HistoryEntry[] = []
        const seen = new Set<string>()
        for (const command of commands.slice().reverse()) {
            const normalized = this.normalizeHistoryCommand(command)
            if (!normalized || seen.has(normalized) || !this.sensitiveInput.shouldStoreCommand(normalized)) {
                continue
            }
            seen.add(normalized)
            entries.push({
                command: normalized,
                timestamp: Date.now() - entries.length,
                useCount: 1,
            })
        }
        this.tabHistory.set(tabKey, entries)
    }
}
