import LlmSettingsTab from './src/LlmSettingsTab.svelte'
import panelCss from './src/panel.css?inline'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, TerminalDecoratorDefinition } from './src/types'
import { fetchAutocomplete, loadConfig, type AutocompleteSuggestion } from './src/llmApi'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-llm',
    name: 'AI 命令补全',
    version: '0.2.0',
    description: 'LLM 驱动的 shell 命令补全：输入时防抖请求 LLM API，候选列表面板，Ctrl+Y 接受',
    kind: 'feature',
    entry: 'index.js',
    permissions: ['terminal:decorate', 'settings:tab'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-llm',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-llm',
}

interface SuggestionState {
    suggestions: AutocompleteSuggestion[]
    index: number
    loading: boolean
}

const decorator: TerminalDecoratorDefinition = {
    id: 'llm-autocomplete',
    async decorate (options) {
        const { terminal } = options
        if (!document.getElementById('issh-plugin-llm-panel-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-llm-panel-style'
            style.textContent = panelCss
            document.head.appendChild(style)
        }
        const state: SuggestionState = { suggestions: [], index: 0, loading: false }
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        let requestGeneration = 0

        const keyHandler = terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') return true
            if (event.ctrlKey && event.key.toLowerCase() === 'y' && state.suggestions.length > 0) {
                const suggestion = state.suggestions[state.index]
                if (suggestion) {
                    options.write(suggestion.command)
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
            const end = buffer.cursorY
            const start = Math.max(0, end - 20)
            for (let y = start; y < end; y++) {
                const line = buffer.getLine(y)
                if (line) lines.push(line.translateToString(true))
            }
            return lines
        }

        let panelElement: HTMLDivElement | null = null

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
            showPanel(partial)
        }

        function showPanel (partial: string): void {
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
                        state.suggestions = []
                        render()
                    }
                })
            })
            const rect = (terminal.element as HTMLElement).getBoundingClientRect()
            panelElement.style.left = `${rect.left + buffer.cursorX * 9}px`
            panelElement.style.top = `${rect.top + (buffer.cursorY + 1) * 18}px`
        }

        function hidePanel (): void {
            panelElement?.remove()
            panelElement = null
        }

        function escapeHtml (text: string): string {
            const div = document.createElement('div')
            div.textContent = text
            return div.innerHTML
        }

        const dataListener = terminal.onData((data) => {
            if (debounceTimer) clearTimeout(debounceTimer)
            if (/[\r\n]/.test(data)) {
                state.suggestions = []
                state.loading = false
                hidePanel()
                return
            }
            const config = loadConfig()
            if (!config.apiKey) return
            debounceTimer = setTimeout(() => {
                requestGeneration += 1
                const generation = requestGeneration
                const partial = readCurrentLine()
                if (partial.length < 2) {
                    state.suggestions = []
                    state.loading = false
                    hidePanel()
                    return
                }
                const context = readContext()
                state.loading = true
                render()
                void fetchAutocomplete(config, partial, context).then((suggestions) => {
                    if (generation !== requestGeneration) return
                    state.suggestions = suggestions.filter((item) => item.command !== partial)
                    state.index = 0
                    state.loading = false
                    render()
                })
            }, config.debounceMs)
        })

        options.dispose(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            keyHandler?.()
            dataListener.dispose()
            hidePanel()
        })
    },
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.registerSettingsTab({
            id: 'llm',
            title: 'AI 命令补全',
            order: 13,
            component: LlmSettingsTab,
        })
        ctx.registerTerminalDecorator(decorator)
        ctx.log('info', 'llm plugin activated')
    },
}

export default plugin
