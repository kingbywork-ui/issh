import SyncSettingsTab from './src/SyncSettingsTab.svelte'
import { setGateway } from './src/syncRpc'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-config-sync',
    name: '配置同步',
    version: '0.1.0',
    description: '主机配置导出/导入 JSON + GitHub Gist 云同步',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['settings:tab', 'profiles:read', 'profiles:write'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-config-sync',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-config-sync',
    gatewayApiVersion: '1',
    capabilities: ['ui.settings.register', 'profiles.read', 'profiles.write', 'network.fetch'],
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        setGateway(ctx.gateway)
        ctx.gateway.ui.registerSettingsTab({
            id: 'config-sync',
            title: '配置同步',
            order: 14,
            component: SyncSettingsTab,
        })
        ctx.gateway.log('info', 'config-sync plugin activated')
    },
}

export default plugin
