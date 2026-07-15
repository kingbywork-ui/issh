import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class LLMConfigProvider extends ConfigProvider {
    defaults = {
        llm: {
            enabled: false,
            historyAutocompleteEnabled: true,
            aiAutocompleteEnabled: true,
            scriptAutocompleteEnabled: false,
            triggerWithoutSpaceEnabled: true,
            minTriggerLength: 2,
            lightweightHintEnabled: false,
            agentBridgeEnabled: false,
            agentBridgePort: 0,
            agentBridgeSseEnabled: true,
            agentBridgeDefaultExecTimeoutMs: 60000,
            agentBridgeToken: null as string | null,
            agentBridgeTokenScopes: null as string[] | null,
            agentBridgeAuditLogEnabled: true,
            agentBridgePublicDiscoveryEnabled: false,
            agentBridgePublicDiscoveryFile: null as string | null,
            agentBridgeSftpRoot: null as string | null,
            agentBridgeSftpMaxWriteBytes: 1024 * 1024,
            baseUrl: 'https://api.openai.com/v1',
            apiKey: null as string | null,
            model: 'gpt-4o-mini',
            debounceMs: 300,
            maxContextLines: 20,
            sendContextToCloud: true,
            autoCompleteOnType: true,
            executeOnConfirm: false,
        },
        about: {
            giteaBaseUrl: '' as string,
            giteaRepo: '' as string,
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
