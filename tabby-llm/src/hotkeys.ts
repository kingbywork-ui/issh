import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class LLMHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        {
            id: 'llm-autocomplete',
            name: this.translate.instant('AI command autocomplete'),
        },
        {
            id: 'llm-nl2command',
            name: this.translate.instant('Natural language to command'),
        },
        {
            id: 'llm-accept-suggestion',
            name: this.translate.instant('Accept AI suggestion'),
        },
        {
            id: 'llm-dismiss',
            name: this.translate.instant('Dismiss AI panel'),
        },
    ]

    constructor (private translate: TranslateService) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
