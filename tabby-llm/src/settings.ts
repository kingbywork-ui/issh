import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { TranslateService } from 'tabby-core'
import { LLMSettingsTabComponent } from './components/llmSettingsTab.component'

/** @hidden */
@Injectable()
export class LLMSettingsTabProvider extends SettingsTabProvider {
    id = 'llm'
    icon = 'robot'
    title = this.translate.instant('AI assistant')

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return LLMSettingsTabComponent
    }
}
