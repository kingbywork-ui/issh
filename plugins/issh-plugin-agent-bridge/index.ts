import BridgeSettingsTab from './src/BridgeSettingsTab.svelte'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-agent-bridge',
    name: 'Agent 桥接',
    version: '0.1.1',
    description: 'Workspace/Agent 管理：工作区创建、终端会话绑定、agent 注册与授权（对接 isshd workspace.*/agent.* RPC）',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['workspace:read', 'workspace:write', 'agent:read', 'agent:write', 'session:read', 'settings:tab'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-agent-bridge',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-agent-bridge',
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.registerSettingsTab({
            id: 'agent-bridge',
            title: 'Agent 桥接',
            order: 11,
            component: BridgeSettingsTab,
        })
        ctx.log('info', 'agent-bridge plugin activated')
    },
}

export default plugin
