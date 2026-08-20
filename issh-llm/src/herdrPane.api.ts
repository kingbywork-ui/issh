import { BaseTerminalProfile } from 'issh-terminal'

export interface HerdrPaneDescriptor {
    paneId: string
    terminalId: string
    workspaceId: string
    tabId: string
    title: string
    cwd: string | null
    focused: boolean
    agent: string | null
}

export interface HerdrPaneOptions {
    paneId: string
    target: string
    herdrWorkspaceId: string
    isshWorkspaceId: string
    ownerId: string
    title: string
    cwd: string | null
}

export interface HerdrPaneProfile extends BaseTerminalProfile {
    options: HerdrPaneOptions
}

export interface HerdrPaneEvent {
    paneId: string
    type: 'output' | 'state'
    data?: number[]
    full?: boolean
    width?: number
    height?: number
    state?: 'attached' | 'reconnecting' | 'closed' | 'error'
    reason?: string
    reconnectAttempt?: number
}
