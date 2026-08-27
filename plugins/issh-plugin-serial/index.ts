import SerialPanel from './src/SerialPanel.svelte'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-serial',
    name: '串口终端',
    version: '0.1.0',
    description: 'Web Serial API 串口连接：选择串口/波特率，收发数据（底部面板）',
    kind: 'integration',
    entry: 'index.js',
    permissions: ['panel:register'],
    author: 'kingbywork-ui',
    homepage: 'https://github.com/kingbywork-ui/issh-plugin-serial',
    repository: 'https://github.com/kingbywork-ui/issh-plugin-serial',
}

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        ctx.registerPanel({
            id: 'serial',
            title: '串口',
            placement: 'bottom',
            component: SerialPanel,
        })
        ctx.log('info', 'serial plugin activated')
    },
}

export default plugin
