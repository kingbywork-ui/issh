export type AgentBridgeScope = 'read' | 'write' | 'exec' | 'sftp'

export interface AgentBridgeTool {
    name: string
    scope: AgentBridgeScope
    description: string
    inputSchema: Record<string, unknown>
}

export const AGENT_BRIDGE_PROTOCOL_VERSION: string
export const AGENT_BRIDGE_TOOLS: AgentBridgeTool[]
export const AGENT_BRIDGE_METHOD_SCOPES: Readonly<Record<string, AgentBridgeScope>>
export function getMcpTools (): Array<Omit<AgentBridgeTool, 'scope'>>
