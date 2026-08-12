const warnedLegacyEnvironmentVariables = new Set()

export function getISSHEnvironmentVariable (
    suffix,
    environment = process.env,
    warn = message => console.warn(message),
) {
    const primaryName = `ISSH_${suffix}`
    const legacyName = `TABBY_${suffix}`
    if (environment[primaryName] !== undefined) {
        return environment[primaryName]
    }
    if (environment[legacyName] !== undefined) {
        if (!warnedLegacyEnvironmentVariables.has(legacyName)) {
            warnedLegacyEnvironmentVariables.add(legacyName)
            warn(`[deprecated] ${legacyName} is deprecated; use ${primaryName}.`)
        }
        return environment[legacyName]
    }
    return undefined
}
