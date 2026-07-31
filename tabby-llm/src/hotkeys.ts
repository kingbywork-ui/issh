import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'
import { autocompleteSuggestionHotkeyId, MAX_AUTOCOMPLETE_SUGGESTIONS } from './api'

/** @hidden */
@Injectable()
export class LLMHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        {
            id: 'llm-autocomplete',
            name: this.translate.instant('AI 命令补全'),
        },
        {
            id: 'llm-accept-suggestion',
            name: this.translate.instant('接受 AI 建议（Ctrl+Y）'),
        },
        {
            id: 'llm-next-suggestion',
            name: this.translate.instant('下一条建议（Ctrl+N）'),
        },
        {
            id: 'llm-prev-suggestion',
            name: this.translate.instant('上一条建议（Ctrl+U）'),
        },
        {
            id: 'llm-dismiss',
            name: this.translate.instant('关闭 AI 补全面板'),
        },
        ...Array.from(
            { length: MAX_AUTOCOMPLETE_SUGGESTIONS },
            (_, index): HotkeyDescription => ({
                id: autocompleteSuggestionHotkeyId(index + 1),
                name: this.translate.instant('快速选择第 {position} 条补全建议', {
                    position: index + 1,
                }),
            }),
        ),
    ]

    constructor (private translate: TranslateService) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
