/**
 * Resolve the build-time development switch without relying on JavaScript
 * truthiness.  In particular, an unset environment variable must not become
 * the literal string "undefined" (which would accidentally select webpack's
 * development mode).
 */
export function isTruthyDevelopmentValue (value) {
    return value === '1' || String(value ?? '').toLowerCase() === 'true'
}

export function isDevelopmentBuild (env = process.env) {
    const value = env.ISSH_DEV !== undefined ? env.ISSH_DEV : env.TABBY_DEV
    return isTruthyDevelopmentValue(value)
}
