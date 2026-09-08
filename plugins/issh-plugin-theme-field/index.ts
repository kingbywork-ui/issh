import { mount, unmount } from 'svelte'
import Settings from './src/Settings.svelte'
import { fieldChromeCss, fieldTerminalScheme } from './src/theme'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-theme-field',
    name: 'Field — 现场纸与蓝图',
    version: '0.1.2',
    description: '暖纸低对比 + 蓝图蓝选中：白天与投屏的浅色皮肤，贯穿 chrome 与 xterm 16 色',
    kind: 'appearance',
    entry: 'index.js',
    permissions: ['settings:tab', 'terminal:decorate'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-theme-field',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-theme-field',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'terminal.decorate'],
}

let styleEl: HTMLStyleElement | null = null
function inject(){ if(styleEl) return; styleEl=document.createElement('style'); styleEl.id='issh-theme-field'; styleEl.textContent=fieldChromeCss; document.head.appendChild(styleEl) }
function remove(){ styleEl?.remove(); (document.getElementById('issh-field-preview') as HTMLStyleElement|null)?.remove(); styleEl=null }

function apply(t: import('@xterm/xterm').Terminal){
    const s=fieldTerminalScheme
    t.options.theme={ background:s.background, foreground:s.foreground, cursor:s.cursor, black:s.colors[0], red:s.colors[1], green:s.colors[2], yellow:s.colors[3], blue:s.colors[4], magenta:s.colors[5], cyan:s.colors[6], white:s.colors[7], brightBlack:s.colors[8], brightRed:s.colors[9], brightGreen:s.colors[10], brightYellow:s.colors[11], brightBlue:s.colors[12], brightMagenta:s.colors[13], brightCyan:s.colors[14], brightWhite:s.colors[15], selectionBackground:'rgba(46,124,246,.14)' } as never
}

const plugin: IsshPlugin = {
    manifest,
    activate(ctx: IsshPluginContext){
        inject()
        ctx.gateway.ui.registerSettingsTab({ id:'field', title:'Field 皮肤', order:20, mount:(target)=>{ const i=mount(Settings as never,{target}); return ()=>unmount(i) } } as never)
        ctx.gateway.ui.registerTerminalDecorator({ id:'field-terminal', decorate(o){ apply(o.terminal) } } as never)
        ctx.gateway.log('info','Field theme activated')
    },
    deactivate(){ remove() },
}

export default plugin
