import type { Component } from 'svelte'
import AgentBridgeSettings from '../AgentBridgeSettings.svelte'
import { agentBridgeDisable } from '../runtime'
import type { IsshPlugin } from './types'

/**
 * Agent Bridge 内置插件（保持插件接入形态）。
 * 设置页通过插件体系 registerSettingsTab 注册，而不是硬编码进 Settings.svelte。
 * 后端 RPC 服务仍由 Rust 侧 agent_bridge.rs 提供（默认端口 59688，R-073 支持手动配置）。
 */
export const agentBridgePlugin: IsshPlugin = {
    manifest: {
        id: 'issh-plugin-agent-bridge-rpc',
        name: 'Agent Bridge',
        version: '1.0.0',
        description: '把本地 issh 终端会话通过 token 保护的本地 RPC/MCP 暴露给外部 Agent（Codex / Cursor / Claude Desktop）。',
        kind: 'integration',
        entry: 'builtin',
        gatewayApiVersion: '1',
        permissions: ['settings:tab'],
        author: 'iPSA',
    },
    activate (ctx): void {
        ctx.registerSettingsTab({
            id: 'agent-bridge',
            title: 'Agent Bridge',
            order: 10,
            component: AgentBridgeSettings as unknown as Component<Record<string, unknown>>,
        })
    },
    async deactivate (): Promise<void> {
        // 停用插件时停止 Agent Bridge 服务，避免监听端口悬空占用（R-045 安全语义）
        try {
            await agentBridgeDisable()
        } catch { /* 服务未运行或已停止，忽略 */ }
    },
}
