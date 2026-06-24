export interface AutocompleteSuggestion {
    id: string
    command: string
    description: string
    category: 'ai'
    confidence?: number
}

export interface AutocompleteRequest {
    partialCommand: string
    cwd: string | null
    shell: string
    os: string
    recentOutput: string[]
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
