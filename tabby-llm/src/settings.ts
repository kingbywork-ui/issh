import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
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
