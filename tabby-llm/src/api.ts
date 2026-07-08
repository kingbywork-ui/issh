export type SuggestionCategory = 'history' | 'ai' | 'script'

export interface AutocompleteSuggestion {
    id: string
    command: string
    description: string
    category: SuggestionCategory
    confidence?: number
}

export interface AutocompleteRequest {
    tabKey: string
    partialCommand: string
    cwd: string | null
    shell: string
    os: string
    recentOutput: string[]
    excludeCommands: string[]
    limit?: number
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

