import { mount, unmount } from 'svelte'
import Settings from './src/Settings.svelte'
import { voidChromeCss, voidTerminalScheme } from './src/theme'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-theme-void',
    name: 'Void — 虚空暮色',
    version: '0.1.2',
    description: '深靛紫暮色 + 光纤微光：让人在危险操作前慢下来的夜间专注皮肤，贯穿 chrome 与 xterm 16 色',
    kind: 'appearance',
    entry: 'index.js',
    permissions: ['settings:tab', 'terminal:decorate'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-theme-void',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-theme-void',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'terminal.decorate'],
}

let styleEl: HTMLStyleElement | null = null
function inject(){ if(styleEl) return; styleEl=document.createElement('style'); styleEl.id='issh-theme-void'; styleEl.textContent=voidChromeCss; document.head.appendChild(styleEl) }
function remove(){ styleEl?.remove(); (document.getElementById('issh-void-preview') as HTMLStyleElement|null)?.remove(); styleEl=null }
function apply(t: import('@xterm/xterm').Terminal){
    const s=voidTerminalScheme
    t.options.theme={ background:s.background, foreground:s.foreground, cursor:s.cursor, black:s.colors[0], red:s.colors[1], green:s.colors[2], yellow:s.colors[3], blue:s.colors[4], magenta:s.colors[5], cyan:s.colors[6], white:s.colors[7], brightBlack:s.colors[8], brightRed:s.colors[9], brightGreen:s.colors[10], brightYellow:s.colors[11], brightBlue:s.colors[12], brightMagenta:s.colors[13], brightCyan:s.colors[14], brightWhite:s.colors[15], selectionBackground:'rgba(163,140,255,.18)' } as never
}

const plugin: IsshPlugin = {
    manifest,
    activate(ctx: IsshPluginContext){
        inject()
        ctx.gateway.ui.registerSettingsTab({ id:'void', title:'Void 皮肤', order:20, mount:(target)=>{ const i=mount(Settings as never,{target}); return ()=>unmount(i) } } as never)
        ctx.gateway.ui.registerTerminalDecorator({ id:'void-terminal', decorate(o){ apply(o.terminal) } } as never)
        ctx.gateway.log('info','Void theme activated')
    },
    deactivate(){ remove() },
}

export default plugin
