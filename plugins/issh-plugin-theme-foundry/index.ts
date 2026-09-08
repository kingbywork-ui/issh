import { mount, unmount } from 'svelte'
import Settings from './src/Settings.svelte'
import { foundryChromeCss, foundryTerminalScheme } from './src/theme'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-theme-foundry',
    name: 'Foundry — 铸造车间',
    version: '0.1.0',
    description: '深海军蓝哑光钢 + 信号橙：日常运维的暗色常驻皮肤，贯穿 WebView2 chrome 与 xterm 16 色',
    kind: 'appearance',
    entry: 'index.js',
    permissions: ['settings:tab', 'terminal:decorate'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-theme-foundry',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-theme-foundry',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'terminal.decorate'],
}

let styleEl: HTMLStyleElement | null = null

function injectChrome() {
    if (styleEl) return
    styleEl = document.createElement('style')
    styleEl.id = 'issh-theme-foundry'
    styleEl.textContent = foundryChromeCss
    document.head.appendChild(styleEl)
}

function removeChrome() {
    styleEl?.remove()
    const preview = document.getElementById('issh-foundry-preview') as HTMLStyleElement | null
    preview?.remove()
    styleEl = null
}

function applyTerminalTheme(terminal: import('@xterm/xterm').Terminal) {
    const s = foundryTerminalScheme
    // 覆盖当前终端实例的 16 色与 bg/fg/cursor；不触 storage，保证主题由插件接管
    terminal.options.theme = {
        background: s.background,
        foreground: s.foreground,
        cursor: s.cursor,
        black: s.colors[0],
        red: s.colors[1],
        green: s.colors[2],
        yellow: s.colors[3],
        blue: s.colors[4],
        magenta: s.colors[5],
        cyan: s.colors[6],
        white: s.colors[7],
        brightBlack: s.colors[8],
        brightRed: s.colors[9],
        brightGreen: s.colors[10],
        brightYellow: s.colors[11],
        brightBlue: s.colors[12],
        brightMagenta: s.colors[13],
        brightCyan: s.colors[14],
        brightWhite: s.colors[15],
        selectionBackground: 'rgba(255,122,69,.18)',
    } as never
}

const plugin: IsshPlugin = {
    manifest,
    activate(ctx: IsshPluginContext) {
        injectChrome()
        ctx.gateway.ui.registerSettingsTab({
            id: 'foundry',
            title: 'Foundry 皮肤',
            order: 20,
            mount: (target) => {
                const inst = mount(Settings as never, { target })
                return () => unmount(inst)
            },
        } as never)
        ctx.gateway.ui.registerTerminalDecorator({
            id: 'foundry-terminal',
            decorate(options) {
                applyTerminalTheme(options.terminal)
            },
        } as never)
        ctx.gateway.log('info', 'Foundry theme activated')
    },
    deactivate() {
        removeChrome()
    },
}

export default plugin
