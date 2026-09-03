import HerdrSettingsTab from './src/HerdrSettingsTab.svelte'
import { setGateway } from './src/herdrRpc'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-herdr',
    name: 'Herdr 工作区',
    version: '0.1.1',
    description: 'Herdr/Workspace 管理：工作区创建、终端会话绑定（对接 isshd workspace.* RPC）',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['workspace:read', 'workspace:write', 'session:read', 'settings:tab'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-herdr',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-herdr',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'workspace.read', 'workspace.write', 'session.read'],
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        setGateway(ctx.gateway)
        ctx.gateway.ui.registerSettingsTab({
            id: 'herdr',
            title: 'Herdr 工作区',
            order: 12,
            component: HerdrSettingsTab,
        })
        ctx.gateway.log('info', 'herdr plugin activated')
    },
}

export default plugin
