import LlmSettingsTab from './src/LlmSettingsTab.svelte'
import hintCss from './src/hint.css?inline'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, TerminalDecoratorDefinition } from './src/types'
import { fetchAutocomplete, loadConfig, type AutocompleteSuggestion } from './src/llmApi'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-llm',
    name: 'AI 命令补全',
    version: '0.1.0',
    description: 'LLM 驱动的 shell 命令补全：输入时防抖请求 LLM API，Ctrl+Y 接受候选',
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
}

const decorator: TerminalDecoratorDefinition = {
    id: 'llm-autocomplete',
    async decorate (options) {
        const { terminal } = options
        if (!document.getElementById('issh-plugin-llm-hint-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-llm-hint-style'
            style.textContent = hintCss
            document.head.appendChild(style)
        }
        const state: SuggestionState = { suggestions: [], index: 0 }
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

        function render (): void {
            const buffer = terminal.buffer.active
            const line = buffer.getLine(buffer.cursorY)
            if (!line) return
            const text = line.translateToString(true)
            const cursorX = buffer.cursorX
            const partial = text.slice(0, cursorX).trim()
            if (state.suggestions.length === 0 || !partial) {
                hideHint()
                return
            }
            showHint(state.suggestions[state.index]?.command ?? '', state.index + 1, state.suggestions.length)
        }

        let hintElement: HTMLDivElement | null = null
        function showHint (command: string, index: number, total: number): void {
            if (!hintElement) {
                hintElement = document.createElement('div')
                hintElement.className = 'issh-llm-hint'
                document.body.appendChild(hintElement)
            }
            hintElement.textContent = `${command}（${index}/${total}，Ctrl+Y 接受 Ctrl+N/U 切换）`
            const rect = (terminal.element as HTMLElement).getBoundingClientRect()
            hintElement.style.left = `${rect.left + bufferX(terminal) * 9}px`
            hintElement.style.top = `${rect.top + (bufferY(terminal) + 1) * 18}px`
        }
        function hideHint (): void {
            hintElement?.remove()
            hintElement = null
        }
        function bufferX (t: { buffer: { active: { cursorX: number } } }): number { return t.buffer.active.cursorX }
        function bufferY (t: { buffer: { active: { cursorY: number } } }): number { return t.buffer.active.cursorY }

        const dataListener = terminal.onData((data) => {
            if (debounceTimer) clearTimeout(debounceTimer)
            if (/[\r\n]/.test(data)) {
                state.suggestions = []
                hideHint()
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
                    hideHint()
                    return
                }
                const context = readContext()
                void fetchAutocomplete(config, partial, context).then((suggestions) => {
                    if (generation !== requestGeneration) return
                    state.suggestions = suggestions.filter((item) => item.command !== partial)
                    state.index = 0
                    render()
                })
            }, config.debounceMs)
        })

        options.dispose(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            keyHandler?.()
            dataListener.dispose()
            hideHint()
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
