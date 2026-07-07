import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class LLMConfigProvider extends ConfigProvider {
    defaults = {
        llm: {
            enabled: false,
            historyAutocompleteEnabled: true,
            aiAutocompleteEnabled: true,
            scriptAutocompleteEnabled: false,
            ragBaseUrl: 'http://127.0.0.1:5000',
            ragTopK: 5,
            ragUseSemanticSearch: true,
            triggerWithoutSpaceEnabled: true,
            minTriggerLength: 2,
            lightweightHintEnabled: false,
            agentBridgeEnabled: false,
            agentBridgePort: 0,
            agentBridgeDefaultExecTimeoutMs: 60000,
            agentBridgeToken: null as string | null,
            agentBridgeAuditLogEnabled: true,
            agentBridgePublicDiscoveryEnabled: true,
            agentBridgePublicDiscoveryFile: null as string | null,
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
            'llm-accept-suggestion': ['Ctrl-Y'],
            'llm-next-suggestion': ['Ctrl-N'],
            'llm-prev-suggestion': ['Ctrl-U'],
            'llm-dismiss': [],
        },
    }

    platformDefaults = {}
}
