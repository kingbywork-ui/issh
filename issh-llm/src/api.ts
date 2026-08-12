export type SuggestionCategory = 'history' | 'ai' | 'script'

export const MAX_AUTOCOMPLETE_SUGGESTIONS = 9

export function autocompleteSuggestionHotkeyId (position: number): string {
    return `llm-select-suggestion-${position}`
}

export interface AutocompleteSuggestion {
    id: string
    command: string
    description: string
    category: SuggestionCategory
    confidence?: number
}

export type AutocompleteMode = 'shell' | 'editor'
export type AutocompleteRequestKind = 'live' | 'prediction'

export interface AutocompleteRequest {
    tabKey: string
    partialCommand: string
    cwd: string | null
    shell: string
    os: string
    recentOutput: string[]
    excludeCommands: string[]
    /** Last submitted shell command. When partialCommand is empty, predict the next command. */
    previousCommand?: string
    /** Keeps interactive completion and background next-command prediction independently cancellable. */
    requestKind?: AutocompleteRequestKind
    limit?: number
    /** shell = command autocomplete; editor = code/text in vim/nano alternate screen */
    mode?: AutocompleteMode
}

export interface NL2CommandRequest {
    naturalLanguage: string
    cwd: string | null
    shell: string
    os: string
}

export interface NL2CommandResult {
    command: string
    explanation: string
    dangerous: boolean
    dangerReason?: string
}

