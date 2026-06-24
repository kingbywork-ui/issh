import { Injectable } from '@angular/core'
import { PlatformService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { TerminalContextService } from './terminalContext.service'

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
        this.loadFromDiskSync()
    }

    private loadFromDiskSync (): void {
        if (!this.historyFilePath) {
            this.loaded = true
            return
        }
        try {
            if (fsSync.existsSync(this.historyFilePath)) {
                const data = fsSync.readFileSync(this.historyFilePath, 'utf-8')
                const parsed = JSON.parse(data) as HistoryEntry[]
                if (Array.isArray(parsed)) {
                    this.history = parsed.slice(0, this.maxHistory)
                }
            }
        } catch (e) {
            this.logger.warn('Failed to load command history:', e)
        } finally {
            this.loaded = true
        }
    }

    bootstrapFromTerminal (tab: BaseTerminalTabComponent<any>): void {
        const lines = this.context.getRecentOutput(tab, 300)
        for (const line of lines) {
            const command = this.context.stripPrompt(line).trim()
            if (this.isLikelyCommand(command)) {
                this.addCommand(command, false)
            }
        }
        void this.saveToDisk()
    }

    private isLikelyCommand (command: string): boolean {
        if (!command || command.length < 2 || command.length > 500) {
            return false
        }
        if (/^[\s\-_=.+#%$>]+$/.test(command)) {
            return false
        }
        if (command.startsWith('[') || command.startsWith('---')) {
            return false
        }
        return true
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
        const trimmed = command.trim()
        if (!trimmed) {
            return
        }
        const existing = this.history.find(e => e.command === trimmed)
        if (existing) {
            existing.useCount++
            existing.timestamp = Date.now()
            this.history.sort((a, b) => b.timestamp - a.timestamp)
            if (scheduleSave) {
                this.scheduleSave()
            }
            return
        }
        this.history.unshift({ command: trimmed, timestamp: Date.now(), useCount: 1 })
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
            } else if (cmd.includes(lower)) {
                score = 50 + lower.length / cmd.length * 30
            } else if (this.fuzzyMatch(lower, cmd)) {
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
}
