export type ConnectionAuth = 'auto' | 'password' | 'publicKey' | 'agent' | 'keyboardInteractive'

export function connectionCredentials (input: {
    auth: ConnectionAuth
    user: string
    originalUser: string
    password: string
    storedPassword: string
    keyPath: string
    originalKeyPath: string
    keyPassphrase: string
    storedKeyPassphrase: string
}): { useKey: boolean, password: string, keyPassphrase: string } {
    const useKey = input.auth !== 'password' && input.auth !== 'keyboardInteractive'
    const usePassword = input.auth !== 'publicKey'
    const sameUser = input.user === input.originalUser
    return {
        useKey,
        password: usePassword ? input.password || (sameUser ? input.storedPassword : '') : '',
        keyPassphrase: useKey ? input.keyPassphrase || (sameUser && input.keyPath === input.originalKeyPath ? input.storedKeyPassphrase : '') : '',
    }
}

export function retryConnectionCredentials (input: {
    previous: {
        host: string
        port: number
        user: string
        password: string
        keyPath: string
        keyPassphrase: string
        profileKeyPath?: string
    } | null
    host: string
    port: number
    user: string
    keyPath: string
    password: string
    keyPassphrase: string
}): { sameIdentity: boolean, sameKeyPath: boolean, password: string, keyPassphrase: string } {
    const previous = input.previous
    const sameIdentity = previous !== null && previous.host === input.host && previous.port === input.port && previous.user === input.user
    const sameKeyPath = previous !== null && input.keyPath === (previous.profileKeyPath ?? previous.keyPath)
    return {
        sameIdentity,
        sameKeyPath,
        password: input.password || (sameIdentity ? previous.password : ''),
        keyPassphrase: input.keyPassphrase || (sameIdentity && sameKeyPath ? previous.keyPassphrase : ''),
    }
}
