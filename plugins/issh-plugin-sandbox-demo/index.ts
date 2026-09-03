import { convertFileSrc } from '@tauri-apps/api/core'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, SandboxPanelDefinition } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-sandbox-demo',
    name: '沙箱演示插件',
    version: '0.4.0',
    description: '演示 iframe 沙箱面板：postMessage RPC 存储读写、终端读写、事件接收',
    kind: 'feature',
    entry: 'index.js',
    permissions: ['panel:register', 'terminal:decorate', 'profiles:write'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-sandbox-demo',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-sandbox-demo',
    gatewayApiVersion: '1',
    capabilities: ['ui.panel.register', 'terminal.decorate', 'profiles.write'],
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        const directory = ctx.directory
        const sandboxUrl = convertFileSrc(`${directory.replace(/\\/g, '/')}/sandbox.html`)
        const panel: SandboxPanelDefinition = {
            id: 'demo',
            title: '沙箱演示',
            placement: 'bottom',
            sandboxUrl,
            sandboxOrigin: new URL(sandboxUrl).origin,
            height: 140,
        }
        ctx.gateway.ui.registerSandboxPanel(panel)
        ctx.gateway.log('info', 'sandbox demo plugin activated')
    },
}

export default plugin
