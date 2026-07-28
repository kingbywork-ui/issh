import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { AgentBridgeSettingsTabComponent } from './components/agentBridgeSettingsTab.component'
import { LLMSettingsTabComponent } from './components/llmSettingsTab.component'
import { AboutSettingsTabComponent } from './components/aboutSettingsTab.component'

/** @hidden */
@Injectable()
export class LLMSettingsTabProvider extends SettingsTabProvider {
    id = 'llm'
    icon = 'robot'
    title = '命令补全'

    getComponentType (): any {
        return LLMSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class AgentBridgeSettingsTabProvider extends SettingsTabProvider {
    id = 'agent-bridge'
    icon = 'terminal'
    title = 'CLI / MCP 智能体'

    getComponentType (): any {
        return AgentBridgeSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class AboutSettingsTabProvider extends SettingsTabProvider {
    id = 'about'
    icon = 'info-circle'
    title = '关于'
    weight = 1000

    getComponentType (): any {
        return AboutSettingsTabComponent
    }
}
