import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { SSHProfile } from '../api'

export const VAULT_SECRET_TYPE_PASSWORD = 'ssh:password'
export const VAULT_SECRET_TYPE_PASSPHRASE = 'ssh:key-passphrase'

type KeytarModule = {
    setPassword: (service: string, account: string, password: string) => Promise<void>
    getPassword: (service: string, account: string) => Promise<string | null>
    deletePassword: (service: string, account: string) => Promise<boolean>
}

let keytar: KeytarModule | null = null
let keytarLoadFailed = false

function getKeytar (): KeytarModule | null {
    if (keytar) {
        return keytar
    }
    if (keytarLoadFailed) {
        return null
    }
    try {
        const runtimeRequire = eval('require') as NodeRequire
        keytar = runtimeRequire('keytar')
        return keytar
    } catch (error) {
        keytarLoadFailed = true
        console.warn('Keytar is unavailable, password storage will be disabled unless the vault is enabled', error)
        return null
    }
}

@Injectable({ providedIn: 'root' })
export class PasswordStorageService {
    constructor (private vault: VaultService) { }

    async savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSWORD, key, value: password })
        } else {
            if (!account) {
                return
            }
            const keytar = getKeytar()
            if (!keytar) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            return keytar.setPassword(key, account, password)
        }
    }

    async deletePassword (profile: SSHProfile, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.removeSecret(VAULT_SECRET_TYPE_PASSWORD, key)
        } else {
            if (!account) {
                return
            }
            const keytar = getKeytar()
            if (!keytar) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            await keytar.deletePassword(key, account)
        }
    }

    async loadPassword (profile: SSHProfile, username?: string): Promise<string|null> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSWORD, key))?.value ?? null
        } else {
            if (!account) {
                return null
            }
            const keytar = getKeytar()
            if (!keytar) {
                return null
            }
            const key = this.getKeytarKeyForConnection(profile)
            try {
                return await keytar.getPassword(key, account)
            } catch (e) {
                console.warn(`Failed to load stored password for ${account}@${profile.options.host}:${profile.options.port ?? 22}`, e)
                return null
            }
        }
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            await this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSPHRASE, key, value: password })
        } else {
            const keytar = getKeytar()
            if (!keytar) {
                return
            }
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.setPassword(key, 'user', password)
        }
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            await this.vault.removeSecret(VAULT_SECRET_TYPE_PASSPHRASE, key)
        } else {
            const keytar = getKeytar()
            if (!keytar) {
                return
            }
            const key = this.getKeytarKeyForPrivateKey(id)
            await keytar.deletePassword(key, 'user')
        }
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSPHRASE, key))?.value ?? null
        } else {
            const keytar = getKeytar()
            if (!keytar) {
                return null
            }
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.getPassword(key, 'user')
        }
    }

    private getKeytarKeyForConnection (profile: SSHProfile): string {
        let key = `ssh@${profile.options.host}`
        if (profile.options.port) {
            key = `ssh@${profile.options.host}:${profile.options.port}`
        }
        return key
    }

    private getKeytarKeyForPrivateKey (id: string): string {
        return `ssh-private-key:${id}`
    }

    private getVaultKeyForConnection (profile: SSHProfile, username?: string) {
        return {
            user: username ?? profile.options.user,
            host: profile.options.host,
            port: profile.options.port,
        }
    }

    private getVaultKeyForPrivateKey (id: string) {
        return { hash: id }
    }
}
