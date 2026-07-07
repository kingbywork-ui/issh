import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { AgentBridgeSettingsTabComponent } from './components/agentBridgeSettingsTab.component'
import { LLMSettingsTabComponent } from './components/llmSettingsTab.component'

/** @hidden */
@Injectable()
export class LLMSettingsTabProvider extends SettingsTabProvider {
    id = 'llm'
    icon = 'robot'
    title = 'AI 助手'

    getComponentType (): any {
        return LLMSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class AgentBridgeSettingsTabProvider extends SettingsTabProvider {
    id = 'agent-bridge'
    icon = 'terminal'
    title = 'CLI / MCP Agent'

    getComponentType (): any {
        return AgentBridgeSettingsTabComponent
    }
}
