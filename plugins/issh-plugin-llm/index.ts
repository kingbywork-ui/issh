import LlmSettingsTab from './src/LlmSettingsTab.svelte'
import panelCss from './src/panel.css?inline'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, TerminalDecoratorDefinition } from './src/types'
import { fetchAutocomplete, fetchEditorAutocomplete, fetchPrediction, loadConfig, type AutocompleteSuggestion } from './src/llmApi'
import { HistoryCommandService } from './src/historyCommand'
import { normalizeCommand } from './src/commandValidation'
import { looksLikeSensitivePrompt } from './src/sensitiveInput'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-llm',
    name: 'AI 命令补全',
    version: '0.2.0',
    description: 'LLM 驱动的 shell 命令补全：本地/远程历史 + AI live 候选统一面板，Ctrl+Y 接受',
    kind: 'feature',
    entry: 'index.js',
    permissions: ['terminal:decorate', 'settings:tab'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-llm',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-llm',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'terminal.decorate'],
}

interface SuggestionState {
    suggestions: AutocompleteSuggestion[]
    index: number
    loading: boolean
}

const historyService = new HistoryCommandService()

/** B2：候选统一过滤——AI/脚本候选经 normalizeCommand 清洗，剔除输出噪音/非法/不完整命令 */
function sanitizeCommandSuggestions (list: AutocompleteSuggestion[]): AutocompleteSuggestion[] {
    return list
        .map((item) => ({ command: normalizeCommand(item.command) ?? '', confidence: item.confidence }))
        .filter((item) => item.command.length > 0)
}

/** B1：候选统一 confidence 降序排序 + 去重（同 confidence 稳定保持来源顺序：历史→脚本→AI） */
function mergeAndSortCandidates (candidates: AutocompleteSuggestion[]): AutocompleteSuggestion[] {
    const best = new Map<string, AutocompleteSuggestion>()
    for (const item of candidates) {
        const existing = best.get(item.command)
        if (!existing || item.confidence > existing.confidence) {
            best.set(item.command, item)
        }
    }
    return Array.from(best.values()).sort((a, b) => b.confidence - a.confidence)
}

const decorator: TerminalDecoratorDefinition = {
    id: 'llm-autocomplete',
    async decorate (options) {
        const { terminal } = options
        const tabKey = options.sessionId
        // SSH 会话关联的登录脚本命令（Login Script 候选来源，Beta）
        const loginScriptCommands: string[] = options.profile?.loginScript
            ? options.profile.loginScript.split(/&&|\r?\n/)
                .map((part) => part.trim())
                .filter((part) => part.length > 0)
            : []
        if (!document.getElementById('issh-plugin-llm-panel-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-llm-panel-style'
            style.textContent = panelCss
            document.head.appendChild(style)
        }
        void historyService.bootstrap(
            { kind: options.kind, sessionId: options.sessionId },
            tabKey,
        )
        const state: SuggestionState = { suggestions: [], index: 0, loading: false }
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        let requestGeneration = 0
        let completedCommandCount = 0
        let prefetchedSuggestions: AutocompleteSuggestion[] = []
        let predictionGeneration = 0
        let sensitivePromptActive = false
        // 对齐 issh 分支 autocompletePanelOffsetX/Y 默认值
        const PANEL_OFFSET_X = 32
        const PANEL_OFFSET_Y = 52

        const keyHandler = terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') return true
            if (event.ctrlKey && event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
                // Ctrl+Shift+Space 手动触发：跳过防抖立即拉取候选
                if (debounceTimer) clearTimeout(debounceTimer)
                runSuggestionFetch()
                return false
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'y' && state.suggestions.length > 0) {
                const suggestion = state.suggestions[state.index]
                if (suggestion) {
                    options.write(suggestion.command)
                    if (loadConfig().executeOnConfirm) {
                        options.write('\r')
                    }
                    state.suggestions = []
                    render()
                }
                return false
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'n' && state.suggestions.length > 0) {
                state.index = (state.index + 1) % state.suggestions.length
                render()
                return false
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'u' && state.suggestions.length > 0) {
                state.index = (state.index - 1 + state.suggestions.length) % state.suggestions.length
                render()
                return false
            }
            if (event.key === 'Escape' && state.suggestions.length > 0) {
                state.suggestions = []
                render()
                return false
            }
            return true
        })

        function readCurrentLine (): string {
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            return line ? line.translateToString(true).trim() : ''
        }

        function readContext (): string[] {
            const buffer = terminal.buffer.active
            const lines: string[] = []
            // cursorY 是视口相对行号，需加 baseY 得到绝对行号
            const end = buffer.baseY + buffer.cursorY
            const start = Math.max(0, end - 20)
            for (let y = start; y < end; y++) {
                const line = buffer.getLine(y)
                if (line) lines.push(line.translateToString(true))
            }
            return lines
        }

        // B4：检测最近输出是否出现密码/口令等敏感提示（password/passphrase/验证码等）
        function detectSensitivePrompt (): boolean {
            return readContext().some((line) => looksLikeSensitivePrompt(line))
        }

        // 下一条命令预测：命令提交后用上一条命令 + 终端上下文预取，缓存到当前 tab
        function startPrediction (submitted: string): void {
            const config = loadConfig()
            if (!config.apiKey || !config.predictionEnabled) return
            prefetchedSuggestions = []
            predictionGeneration += 1
            const generation = predictionGeneration
            const context = readContext()
            void fetchPrediction(config, submitted, context).then((suggestions) => {
                if (generation !== predictionGeneration) return
                prefetchedSuggestions = suggestions
            }).catch(() => {
                prefetchedSuggestions = []
            })
        }

        let panelElement: HTMLDivElement | null = null
        let ghostElement: HTMLSpanElement | null = null

        function render (): void {
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            if (!line) return
            const text = line.translateToString(true)
            const cursorX = buffer.cursorX
            const partial = text.slice(0, cursorX).trim()
            if (state.suggestions.length === 0 && !state.loading) {
                hidePanel()
                return
            }
            // B5 ghost text 轻提示：开启时以行内幽灵文本替代浮动面板
            const config = loadConfig()
            const hint = config.lightweightHintEnabled ? getHintText(partial) : ''
            if (config.lightweightHintEnabled && hint) {
                hidePanel()
                showGhost(hint)
            } else {
                showPanel(partial)
            }
        }

        function showPanel (partial: string): void {
            // 隐藏 tab（offsetParent 为 null）不显示面板，避免面板挂在看不见的终端上
            if (!terminal.element || !(terminal.element as HTMLElement).offsetParent) {
                hidePanel()
                return
            }
            if (!panelElement) {
                panelElement = document.createElement('div')
                panelElement.className = 'issh-llm-panel'
                document.body.appendChild(panelElement)
            }
            const rows = state.suggestions.map((suggestion, index) => `
                <div class="issh-llm-row${index === state.index ? ' active' : ''}" data-index="${index}">
                    <span class="issh-llm-command"></span>
                    <span class="issh-llm-confidence">${Math.round(suggestion.confidence * 100)}%</span>
                </div>
            `).join('')
            const loadingRow = state.loading ? '<div class="issh-llm-loading">AI 补全请求中…</div>' : ''
            panelElement.innerHTML = `
                <div class="issh-llm-header">AI 补全${partial ? ` · ${escapeHtml(partial)}` : ''}</div>
                ${rows}
                ${loadingRow}
                <div class="issh-llm-footer">Ctrl+Y 接受 · Ctrl+N/U 切换 · Esc 关闭</div>
            `
            const commandCells = panelElement.querySelectorAll('.issh-llm-command')
            state.suggestions.forEach((suggestion, index) => {
                const cell = commandCells[index]
                if (cell) cell.textContent = suggestion.command
            })
            panelElement.querySelectorAll('.issh-llm-row').forEach((row) => {
                row.addEventListener('click', () => {
                    const index = Number.parseInt((row as HTMLElement).dataset.index ?? '0', 10)
                    const suggestion = state.suggestions[index]
                    if (suggestion) {
                        options.write(suggestion.command)
                        if (loadConfig().executeOnConfirm) {
                            options.write('\r')
                        }
                        state.suggestions = []
                        render()
                    }
                })
            })
            const rect = (terminal.element as HTMLElement).getBoundingClientRect()
            // 用渲染器实际 cell 尺寸计算像素位置（fontSize/fontFamily 不同时 9/18 硬编码会错位）
            const dimensions = (terminal as unknown as {
                _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
            })._core?._renderService?.dimensions?.css?.cell
            const cellWidth = dimensions?.width ?? 9
            const cellHeight = dimensions?.height ?? 18
            // 对齐 issh 分支：光标右下偏移 (32, 52)，避免遮挡当前输入
            let left = rect.left + buffer.cursorX * cellWidth + PANEL_OFFSET_X
            let top = rect.top + (buffer.cursorY + 1) * cellHeight + PANEL_OFFSET_Y
            // 视口边界限制
            panelElement.style.left = `${left}px`
            panelElement.style.top = `${top}px`
            const panelRect = panelElement.getBoundingClientRect()
            left = Math.min(left, Math.max(8, window.innerWidth - panelRect.width - 8))
            top = Math.min(top, Math.max(8, window.innerHeight - panelRect.height - 8))
            panelElement.style.left = `${left}px`
            panelElement.style.top = `${top}px`
        }

        function hidePanel (): void {
            panelElement?.remove()
            panelElement = null
            hideGhost()
        }

        function getHintText (partial: string): string {
            const suggestion = state.suggestions[state.index]
            if (!suggestion) return ''
            if (partial && suggestion.command.startsWith(partial)) {
                return suggestion.command.substring(partial.length)
            }
            const trimmed = partial.trim()
            if (trimmed && suggestion.command.startsWith(trimmed)) {
                return suggestion.command.substring(trimmed.length)
            }
            return ''
        }

        function showGhost (hint: string): void {
            if (!terminal.element || !(terminal.element as HTMLElement).offsetParent) return
            if (!ghostElement) {
                ghostElement = document.createElement('span')
                ghostElement.className = 'issh-llm-ghost'
                document.body.appendChild(ghostElement)
            }
            ghostElement.textContent = hint
            const rect = (terminal.element as HTMLElement).getBoundingClientRect()
            const dimensions = (terminal as unknown as {
                _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
            })._core?._renderService?.dimensions?.css?.cell
            const cellWidth = dimensions?.width ?? 9
            const cellHeight = dimensions?.height ?? 18
            const options = (terminal as unknown as { options?: { fontSize?: number; fontFamily?: string } }).options
            ghostElement.style.fontSize = `${options?.fontSize ?? 14}px`
            if (options?.fontFamily) ghostElement.style.fontFamily = options.fontFamily
            const buffer = terminal.buffer.active
            ghostElement.style.left = `${rect.left + buffer.cursorX * cellWidth}px`
            ghostElement.style.top = `${rect.top + buffer.cursorY * cellHeight}px`
        }

        function hideGhost (): void {
            ghostElement?.remove()
            ghostElement = null
        }

        function escapeHtml (text: string): string {
            const div = document.createElement('div')
            div.textContent = text
            return div.innerHTML
        }

        const dataListener = terminal.onData((data) => {
            if (debounceTimer) clearTimeout(debounceTimer)
            if (/\r|\n|\r/.test(data)) {
                const submitted = readCurrentLine()
                if (submitted.trim()) {
                    historyService.addCommand(tabKey, submitted)
                    completedCommandCount += 1
                    startPrediction(submitted)
                }
                sensitivePromptActive = false
                state.suggestions = []
                state.loading = false
                hidePanel()
                return
            }
            // B4 敏感输入 gate：密码 prompt 出现后立即停止补全并清空候选，回车后复位
            if (detectSensitivePrompt()) {
                sensitivePromptActive = true
                state.suggestions = []
                state.loading = false
                hidePanel()
                return
            }
            if (sensitivePromptActive) {
                return
            }
            const config = loadConfig()
            if (!config.apiKey || !config.aiAutocompleteEnabled) return
            debounceTimer = setTimeout(() => {
                runSuggestionFetch()
            }, config.debounceMs)
        })

        function runSuggestionFetch (): void {
            requestGeneration += 1
            const generation = requestGeneration
            const config = loadConfig()
            const partial = readCurrentLine()
            // 编辑器模式：vim/nano 等 alternate screen 中，默认关闭；开启后走文本补全分支
            const inAlternateScreen = terminal.buffer.active.type === 'alternate'
            if (inAlternateScreen) {
                if (!config.editorAutocompleteEnabled || !config.apiKey) {
                    hidePanel()
                    return
                }
                state.loading = true
                render()
                void fetchEditorAutocomplete(config, partial, readContext()).then((suggestions) => {
                    if (generation !== requestGeneration) return
                    state.suggestions = suggestions.filter(item => item.command !== partial)
                    state.index = 0
                    state.loading = false
                    render()
                })
                return
            }
            if (partial.length < config.minTriggerLength) {
                state.suggestions = []
                state.loading = false
                hidePanel()
                return
            }
            const context = readContext()
            const historyCommands = config.historyAutocompleteEnabled
                ? historyService.search(tabKey, partial, config.historyAutocompleteLimit)
                : []
            // 登录脚本候选：前缀匹配当前输入，排在历史之后（Beta）；经 normalizeCommand 清洗
            const scriptCommands = config.scriptAutocompleteEnabled
                ? loginScriptCommands
                    .map(command => normalizeCommand(command) ?? '')
                    .filter(command => command.length > 0 && command.startsWith(partial) && command !== partial)
                : []
            const historySuggestions: AutocompleteSuggestion[] = [
                ...historyCommands.map(command => ({ command, confidence: 1 })),
                ...scriptCommands.map(command => ({ command, confidence: 0.9 })),
            ]
            // 首条命令 gate：session 未提交过命令时不请求 AI live，只出历史候选
            // AI 关闭/未配置/未输入空格（无空格触发关闭时）同样只出历史候选
            const aiLive = !!config.apiKey && config.aiAutocompleteEnabled
                && (config.triggerWithoutSpaceEnabled || /\s/.test(partial))
            if (!aiLive || completedCommandCount === 0) {
                state.suggestions = historySuggestions.filter(item => item.command !== partial)
                state.index = 0
                state.loading = false
                render()
                return
            }
            // 预取缓存匹配当前输入时直接使用，跳过 live AI 请求
            const prefetchMatches = prefetchedSuggestions.filter(item =>
                item.command.startsWith(partial) && item.command !== partial,
            )
            if (prefetchMatches.length > 0) {
                const sanitized = sanitizeCommandSuggestions(prefetchMatches)
                state.suggestions = mergeAndSortCandidates([...historySuggestions, ...sanitized])
                    .filter(item => item.command !== partial)
                    .slice(0, 8)
                state.index = 0
                state.loading = false
                render()
                return
            }
            state.loading = true
            render()
            void fetchAutocomplete(config, partial, context).then((suggestions) => {
                if (generation !== requestGeneration) return
                const sanitized = sanitizeCommandSuggestions(suggestions)
                state.suggestions = mergeAndSortCandidates([...historySuggestions, ...sanitized])
                    .filter((item) => item.command !== partial)
                    .slice(0, 8)
                state.index = 0
                state.loading = false
                render()
            })
        }

        options.dispose(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            keyHandler?.()
            dataListener.dispose()
            historyService.disposeTab(tabKey)
            hidePanel()
        })
    },
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.gateway.ui.registerSettingsTab({
            id: 'llm',
            title: 'AI 命令补全',
            order: 13,
            component: LlmSettingsTab,
        })
        ctx.gateway.ui.registerTerminalDecorator(decorator)
        ctx.gateway.log('info', 'llm plugin activated')
    },
}

export default plugin
