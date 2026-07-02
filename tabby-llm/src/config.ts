import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class LLMConfigProvider extends ConfigProvider {
    defaults = {
        llm: {
            enabled: false,
            historyAutocompleteEnabled: true,
            aiAutocompleteEnabled: true,
            scriptAutocompleteEnabled: false,
            ragAutocompleteEnabled: false,
            ragBaseUrl: 'http://127.0.0.1:5000',
            ragTopK: 5,
            ragUseSemanticSearch: true,
            triggerWithoutSpaceEnabled: true,
            minTriggerLength: 2,
            lightweightHintEnabled: false,
            baseUrl: 'https://api.openai.com/v1',
            apiKey: null as string | null,
            model: 'gpt-4o-mini',
            debounceMs: 300,
            maxContextLines: 20,
            sendContextToCloud: true,
            autoCompleteOnType: true,
            executeOnConfirm: false,
        },
        hotkeys: {
            'llm-autocomplete': ['Ctrl-Shift-Space'],
            'llm-nl2command': ['Ctrl-Shift-N'],
            'llm-accept-suggestion': ['Ctrl-Y'],
            'llm-next-suggestion': ['Ctrl-N'],
            'llm-prev-suggestion': ['Ctrl-U'],
            'llm-dismiss': [],
        },
    }

    platformDefaults = {}
}
