import { normalizeCommand } from './commandValidation'
import { shouldStoreCommand } from './sensitiveInput'
import { stripPrompt } from './terminalContext'
import type { LlmGateway } from './types'

// 移植自 issh 分支 historyCommand.service.ts（去 Angular 依赖）
// dev 端差异：本地历史文件经网关 fs.readLocalText（路径白名单）；远程经网关 ssh.execReadonly；
// 持久化用 localStorage（Tauri webview 无 Node fs，宿主无 config.yaml 直写通道）。

let gateway: LlmGateway | null = null

export function setGateway (value: LlmGateway): void { gateway = value }

function requireGateway (): LlmGateway {
    if (!gateway) throw new Error('LLM 插件网关尚未初始化')
    return gateway
}

export interface HistoryEntry {
    command: string
    timestamp: number
    useCount: number
}

export interface HistoryBootstrapContext {
    kind: 'local' | 'ssh'
    sessionId: string
}

const STORAGE_KEY = 'issh-plugin-llm-history'
const SAVE_DEBOUNCE_MS = 2000
const REMOTE_TIMEOUT_MS = 5000
const MAX_HISTORY = 1000

export class HistoryCommandService {
    private history: HistoryEntry[] = []
    private loaded = false
    private shellHistoryLoaded = new Set<string>()
    private bootstrapPromises = new Map<string, Promise<void>>()
    private tabHistory = new Map<string, HistoryEntry[]>()
    private saveTimer: ReturnType<typeof setTimeout> | null = null

    constructor () {
        this.loadFromStorage()
    }

    private loadFromStorage (): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            if (raw) {
                const parsed = JSON.parse(raw) as HistoryEntry[]
                if (Array.isArray(parsed)) {
                    this.history = this.compactHistory(parsed)
                    if (this.history.length !== parsed.length) {
                        this.scheduleSave()
                    }
                }
            }
        } catch {
            // 损坏数据按空历史处理
        } finally {
            this.loaded = true
        }
    }

    private compactHistory (entries: HistoryEntry[]): HistoryEntry[] {
        const seen = new Set<string>()
        const result: HistoryEntry[] = []
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]
            if (!entry || typeof entry.command !== 'string' || !entry.command.trim()) {
                continue
            }
            const key = entry.command
            if (seen.has(key)) {
                continue
            }
            seen.add(key)
            result.unshift({
                command: entry.command,
                timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : 0,
                useCount: typeof entry.useCount === 'number' ? entry.useCount : 1,
            })
        }
        return result.slice(-MAX_HISTORY)
    }

    private scheduleSave (): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer)
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history.slice(-MAX_HISTORY)))
            } catch {
                // 存储满时静默放弃，不影响补全
            }
        }, SAVE_DEBOUNCE_MS)
    }

    /** 命令提交时入库：敏感过滤 + 归一化 + tab 局部与全局双写 */
    addCommand (tabKey: string, rawCommand: string): void {
        const command = normalizeCommand(rawCommand)
        if (!command || !shouldStoreCommand(command)) {
            return
        }
        this.addEntry(this.history, command)
        const tabList = this.tabHistory.get(tabKey)
        if (tabList) {
            this.addEntry(tabList, command)
        } else {
            this.tabHistory.set(tabKey, [{ command, timestamp: Date.now(), useCount: 1 }])
        }
        this.scheduleSave()
    }

    private addEntry (list: HistoryEntry[], command: string): void {
        const existing = list.find(entry => entry.command === command)
        if (existing) {
            existing.timestamp = Date.now()
            existing.useCount += 1
            list.splice(list.indexOf(existing), 1)
            list.push(existing)
        } else {
            list.push({ command, timestamp: Date.now(), useCount: 1 })
            if (list.length > MAX_HISTORY) {
                list.splice(0, list.length - MAX_HISTORY)
            }
        }
    }

    /** 清理已关闭 tab 的局部历史 */
    disposeTab (tabKey: string): void {
        this.tabHistory.delete(tabKey)
    }

    /** 前缀匹配搜索：tab 局部优先 + recency/frequency 评分 + 去重合并 */
    search (tabKey: string, partial: string, limit: number): string[] {
        const trimmed = partial.trim()
        if (!trimmed || !this.loaded) {
            return []
        }
        const lowerPartial = trimmed.toLowerCase()
        const scored = new Map<string, { score: number, command: string }>()

        const consider = (entry: HistoryEntry, listIndex: number, isTab: boolean): void => {
            const lower = entry.command.toLowerCase()
            if (!lower.startsWith(lowerPartial)) {
                return
            }
            const lengthRatio = trimmed.length / Math.max(1, entry.command.length)
            let score = 100 + lengthRatio * 50
            if (lower === lowerPartial) {
                score = 200
            }
            score += Math.max(0, (isTab ? 14 : 10) - listIndex)
            score += Math.min(15, entry.useCount * 3)
            if (isTab) {
                score += 20
            }
            const existing = scored.get(entry.command)
            if (!existing || existing.score < score) {
                scored.set(entry.command, { score, command: entry.command })
            }
        }

        const tabList = this.tabHistory.get(tabKey) ?? []
        tabList.forEach((entry, index) => consider(entry, index, true))
        this.history.forEach((entry, index) => consider(entry, index, false))

        return Array.from(scored.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(item => item.command)
    }

    /** tab 局部历史是否已有该命令（用于预测缓存匹配判断） */
    hasCommand (tabKey: string, command: string): boolean {
        const tabList = this.tabHistory.get(tabKey)
        return !!tabList?.some(entry => entry.command === command)
    }

    /** 合并远程/本地 shell 历史快照到 tab 局部历史，保留 tab 内新记录 */
    mergeTabHistory (tabKey: string, commands: string[]): void {
        if (!commands.length) {
            return
        }
        let tabList = this.tabHistory.get(tabKey)
        if (!tabList) {
            tabList = []
            this.tabHistory.set(tabKey, tabList)
        }
        const known = new Set(tabList.map(entry => entry.command))
        for (const rawCommand of commands) {
            const command = normalizeCommand(rawCommand, { allowMultiline: true })
            if (!command || !shouldStoreCommand(command) || known.has(command)) {
                continue
            }
            known.add(command)
            tabList.push({ command, timestamp: 0, useCount: 1 })
        }
        if (tabList.length > MAX_HISTORY) {
            tabList.splice(0, tabList.length - MAX_HISTORY)
        }
    }

    /** tab 打开时引导加载：本地/远程 shell 历史快照合并进 tab 局部历史 */
    async bootstrap (ctx: HistoryBootstrapContext, tabKey: string): Promise<void> {
        const key = `${ctx.kind}:${ctx.sessionId}`
        const existing = this.bootstrapPromises.get(key)
        if (existing) {
            await existing
            return
        }
        const promise = (async () => {
            try {
                if (ctx.kind === 'ssh') {
                    await this.loadRemoteHistory(ctx, tabKey)
                } else {
                    await this.loadLocalShellHistory(tabKey)
                }
            } catch (error) {
                ctxLog(String(error))
            } finally {
                this.bootstrapPromises.delete(key)
            }
        })()
        this.bootstrapPromises.set(key, promise)
        await promise
    }

    private async loadLocalShellHistory (tabKey: string): Promise<void> {
        if (this.shellHistoryLoaded.has('local')) {
            return
        }
        this.shellHistoryLoaded.add('local')
        const commands = await readLocalShellHistoryFiles()
        if (commands.length) {
            this.mergeTabHistory(tabKey, commands)
        }
    }

    private async loadRemoteHistory (ctx: HistoryBootstrapContext, tabKey: string): Promise<void> {
        const key = `remote:${ctx.sessionId}`
        if (this.shellHistoryLoaded.has(key)) {
            return
        }
        this.shellHistoryLoaded.add(key)
        const commands = await fetchRemoteHistoryCommands(ctx.sessionId)
        if (commands.length) {
            this.mergeTabHistory(tabKey, commands)
        }
    }
}

function ctxLog (message: string): void {
    console.warn(`[issh-plugin-llm] history bootstrap: ${message}`)
}

/** 读取本地 shell 历史文件（经宿主白名单命令，webview 无 fs） */
async function readLocalShellHistoryFiles (): Promise<string[]> {
    const candidates: string[] = []
    const paths = await getUserPaths()
    if (paths.home) {
        candidates.push(
            `${paths.home}\\.bash_history`,
            `${paths.home}\\.zsh_history`,
            `${paths.home}\\.local\\share\\fish\\fish_history`,
        )
    }
    if (paths.appData) {
        candidates.push(`${paths.appData}\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt`)
    }
    const results = await Promise.all(candidates.map(async (path) => {
        try {
            const content = await requireGateway().fs.readLocalText(path)
            return parseHistoryFile(path, typeof content === 'string' ? content : '')
        } catch {
            return [] as string[]
        }
    }))
    const merged: string[] = []
    for (const list of results) {
        for (const command of list) {
            if (!merged.includes(command)) {
                merged.push(command)
            }
        }
    }
    return merged
}

/** bash/zsh/fish/PSReadLine 历史文件格式解析 */
function parseHistoryFile (path: string, content: string): string[] {
    const commands: string[] = []
    if (!content) {
        return commands
    }
    if (path.includes('fish_history')) {
        for (const match of content.matchAll(/- cmd: (.+)/g)) {
            commands.push(match[1])
        }
        return commands
    }
    if (path.includes('zsh_history')) {
        for (const line of content.split(/\r?\n/)) {
            const match = /^:\s+\d+:\d+;(.*)$/.exec(line)
            commands.push(match ? match[1] : line)
        }
        return commands
    }
    for (const line of content.split(/\r?\n/)) {
        commands.push(line)
    }
    return commands
}

/** 宿主用户目录（home/appData），供本地 shell 历史文件定位 */
interface UserPaths {
    home: string | null
    appData: string | null
}

async function getUserPaths (): Promise<UserPaths> {
    try {
        return await requireGateway().fs.userPaths()
    } catch {
        return { home: null, appData: null }
    }
}

/** 远程历史获取命令序列（对齐 issh 分支：history → fc → bash_history/zsh_history 回退） */
function remoteHistoryCommandSequence (): string[] {
    return [
        'history 2>/dev/null',
        'fc -ln 2>/dev/null',
        'cat ~/.bash_history 2>/dev/null || cat ~/.zsh_history 2>/dev/null',
    ]
}

/** 经网关 ssh.execReadonly 执行远程只读命令（isshd 端无 PTY、带超时、输出上限） */
async function fetchRemoteHistoryCommands (sessionId: string): Promise<string[]> {
    for (const command of remoteHistoryCommandSequence()) {
        try {
            const result = await requireGateway().request<{ output: string }>('ssh.execReadonly', {
                sessionId,
                command,
                timeoutMs: REMOTE_TIMEOUT_MS,
                maxOutputBytes: 1024 * 1024,
            })
            const commands = parseRemoteHistoryOutput(result?.output ?? '')
            if (commands.length) {
                return commands
            }
        } catch {
            // 尝试下一个回退命令
        }
    }
    return []
}

/** 解析 history/fc/raw 文件输出：剥序号 + stripPrompt + 去重 */
function parseRemoteHistoryOutput (output: string): string[] {
    const commands: string[] = []
    for (const rawLine of output.split(/\r?\n/)) {
        let line = rawLine
        const fcMatch = /^\s*\d+\s+(.*)$/.exec(line)
        if (fcMatch) {
            line = fcMatch[1]
        }
        line = stripPrompt(line)
        if (!line.trim()) {
            continue
        }
        const normalized = normalizeCommand(line, { allowMultiline: true })
        if (normalized && !commands.includes(normalized)) {
            commands.push(normalized)
        }
    }
    return commands
}
