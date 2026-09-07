import { mount, unmount } from 'svelte'
import BridgeSettingsTab from './src/BridgeSettingsTab.svelte'
import { setGateway } from './src/bridgeRpc'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-agent-bridge',
    name: 'Agent Hub Connector',
    version: '0.4.0',
    description: '显示 Agent Hub 与 issh Provider 状态并打开独立管理界面',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['agentHub:read', 'settings:tab'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-agent-bridge',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-agent-bridge',
    gatewayApiVersion: '1',
    minAppVersion: '0.0.4',
    capabilities: ['ui.settings.register', 'agentHub.read'],
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        setGateway(ctx.gateway)
        ctx.gateway.ui.registerSettingsTab({
            id: 'agent-hub',
            title: 'Agent Hub',
            order: 11,
            mount: (target) => {
                const instance = mount(BridgeSettingsTab, { target })
                return () => unmount(instance)
            },
        })
        ctx.gateway.log('info', 'agent-hub connector activated')
    },
}

export default plugin
