export const ISSH_ENVIRONMENT_VARIABLE_SUFFIXES = [
    'AGENT_BRIDGE_FILE',
    'AGENT_BRIDGE_PORT',
    'AGENT_BRIDGE_PUBLIC_FILE',
    'CONFIG_DIRECTORY',
    'DEV',
    'DISABLE_GLASSTRON',
    'ENABLE_SENTRY',
    'FORCE_ANGULAR_PROD',
    'PLUGINS',
    'SKIP_PREPACKAGE',
    'SMOKE_DISABLE_GPU',
    'SMOKE_KEEP_CONFIG',
    'VAULT_PASSPHRASE',
] as const

export interface PromotedEnvironmentVariable {
    legacyName: string
    primaryName: string
}

export function promoteLegacyEnvironmentVariables (
    environment: Record<string, string | undefined> = process.env,
): PromotedEnvironmentVariable[] {
    const promoted: PromotedEnvironmentVariable[] = []
    for (const suffix of ISSH_ENVIRONMENT_VARIABLE_SUFFIXES) {
        const primaryName = `ISSH_${suffix}`
        const legacyName = `TABBY_${suffix}`
        if (environment[primaryName] === undefined && environment[legacyName] !== undefined) {
            environment[primaryName] = environment[legacyName]
            promoted.push({ legacyName, primaryName })
        }
    }
    return promoted
}
