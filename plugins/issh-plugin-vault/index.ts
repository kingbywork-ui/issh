import VaultSettingsTab from './src/VaultSettingsTab.svelte'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-vault',
    name: '保险库',
    version: '0.1.1',
    description: 'SSH 凭据保险库：passphrase 管理、锁定/解锁、机密存取，接入主机配置加密存储',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['vault:read', 'vault:write', 'settings:tab'],
    author: 'kingbywork-ui',
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.registerSettingsTab({
            id: 'vault',
            title: '保险库',
            order: 10,
            component: VaultSettingsTab,
        })
        ctx.log('info', 'vault plugin activated')
    },
}

export default plugin
