import { ConfigProvider } from 'issh-core'
import { autocompleteSuggestionHotkeyId, MAX_AUTOCOMPLETE_SUGGESTIONS } from './api'

const autocompleteSuggestionHotkeys = Array.from(
    { length: MAX_AUTOCOMPLETE_SUGGESTIONS },
    (_, index) => index + 1,
).reduce<Record<string, string[]>>((hotkeys, position) => {
    hotkeys[autocompleteSuggestionHotkeyId(position)] = [`Ctrl-${position}`]
    return hotkeys
}, {})

/** @hidden */
export class LLMConfigProvider extends ConfigProvider {
    defaults = {
        llm: {
            enabled: false,
            historyAutocompleteEnabled: true,
            historyAutocompleteLimit: 10,
            aiAutocompleteEnabled: true,
            editorAutocompleteEnabled: false,
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
            herdrEnabled: false,
            herdrAutoStart: false,
            herdrBinaryPath: '' as string,
            herdrSession: 'issh' as string,
            herdrWorkspaceLinks: {} as Record<string, string>,
            baseUrl: 'https://api.openai.com/v1',
            apiKey: null as string | null,
            model: 'gpt-4o-mini',
            autocompleteModel: '' as string,
            autocompleteDisableThinking: true,
            autocompleteTimeoutMs: 3000,
            debounceMs: 600,
            maxContextLines: 20,
            sendContextToCloud: true,
            autoCompleteOnType: true,
            executeOnConfirm: false,
            autocompletePanelOffsetX: 32,
            autocompletePanelOffsetY: 52,
            autocompletePanelOpacity: 20,
        },
        about: {
            githubBaseUrl: '' as string,
            githubRepo: '' as string,
            githubToken: null as string | null,
            // Legacy keys retained so existing update-source settings can be migrated.
            giteaBaseUrl: '' as string,
            giteaRepo: '' as string,
        },
        hotkeys: {
            'llm-autocomplete': ['Ctrl-Shift-Space'],
            'llm-accept-suggestion': ['Ctrl-Y'],
            'llm-next-suggestion': ['Ctrl-N'],
            'llm-prev-suggestion': ['Ctrl-U'],
            'llm-dismiss': [],
            ...autocompleteSuggestionHotkeys,
        },
    }

    platformDefaults = {}
}
