export type SuggestionCategory = 'history' | 'ai' | 'script' | 'rag'

export interface AutocompleteSuggestion {
    id: string
    command: string
    description: string
    category: SuggestionCategory
    confidence?: number
}

export interface CommandDetail {
    name: string
    description?: string
    examples?: string[]
    options?: Array<{ flag?: string, description?: string }>
    useCases?: string[]
    related?: string[]
    tags?: string[]
    category?: string
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

