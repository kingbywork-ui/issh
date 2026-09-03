import type { IsshPlugin, IsshPluginContext, IsshPluginManifest, SandboxPanelDefinition } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-sandbox-demo',
    name: '沙箱演示插件',
    version: '0.4.2',
    description: '演示 iframe 沙箱面板：postMessage RPC 存储读写、终端读写、事件接收',
    kind: 'feature',
    entry: 'index.js',
    permissions: ['panel:register', 'terminal:decorate', 'profiles:read', 'profiles:write'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-sandbox-demo',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-sandbox-demo',
    gatewayApiVersion: '1',
    capabilities: ['ui.panel.register', 'terminal.decorate', 'profiles.read', 'profiles.write'],
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        const panel: SandboxPanelDefinition = {
            id: 'demo',
            title: '沙箱演示',
            placement: 'bottom',
            // 相对文件名：宿主在注册时用插件目录解析为 asset URL 并计算 origin
            sandboxUrl: 'sandbox.html',
            sandboxOrigin: '',
            height: 140,
        }
        ctx.gateway.ui.registerSandboxPanel(panel)
        ctx.gateway.log('info', 'sandbox demo plugin activated')
    },
}

export default plugin
