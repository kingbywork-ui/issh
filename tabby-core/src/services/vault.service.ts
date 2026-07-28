import * as crypto from 'crypto'
import { promisify } from 'util'
import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AsyncSubject, Subject, Observable } from 'rxjs'
import { wrapPromise, serializeFunction } from '../utils'
import { UnlockVaultModalComponent } from '../components/unlockVaultModal.component'
import { NotificationsService } from './notifications.service'
import { SelectorService } from './selector.service'
import { FileProvider } from '../api/fileProvider'
import { PlatformService } from '../api/platform'

const PBKDF_ITERATIONS_V1 = 100000
const PBKDF_ITERATIONS_V2 = 310000
const PBKDF_DIGEST = 'sha512'
const PBKDF_SALT_LENGTH = 64 / 8
const CRYPT_ALG_V1 = 'aes-256-cbc'
const CRYPT_ALG_V2 = 'aes-256-gcm'
const CRYPT_KEY_LENGTH = 256 / 8
const CRYPT_IV_LENGTH_V2 = 96 / 8

export interface StoredVault {
    version: number
    contents: string
    keySalt: string
    iv: string
    authTag?: string
    keyIterations?: number
}

export interface VaultSecret {
    type: string
    key: VaultSecretKey
    value: string
}

export interface VaultFileSecret extends VaultSecret {
    key: {
        id: string
        description: string
    }
}

export interface Vault {
    config: any
    secrets: VaultSecret[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface VaultSecretKey { }

function migrateVaultContent (content: any): Vault {
    return {
        config: content.config,
        secrets: content.secrets ?? [],
    }
}

function deriveVaultKey (passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
    return promisify(crypto.pbkdf2)(
        Buffer.from(passphrase),
        salt,
        iterations,
        CRYPT_KEY_LENGTH,
        PBKDF_DIGEST,
    )
}

async function encryptVault (content: Vault, passphrase: string): Promise<StoredVault> {
    const keySalt = await promisify(crypto.randomBytes)(PBKDF_SALT_LENGTH)
    const iv = await promisify(crypto.randomBytes)(CRYPT_IV_LENGTH_V2)
    const key = await deriveVaultKey(passphrase, keySalt, PBKDF_ITERATIONS_V2)

    const plaintext = JSON.stringify(content)
    const cipher = crypto.createCipheriv(CRYPT_ALG_V2, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])

    return {
        version: 2,
        contents: encrypted.toString('base64'),
        keySalt: keySalt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        keyIterations: PBKDF_ITERATIONS_V2,
    }
}

async function decryptVault (vault: StoredVault, passphrase: string): Promise<Vault> {
    const keySalt = Buffer.from(vault.keySalt, 'hex')
    const iv = Buffer.from(vault.iv, 'hex')
    const encrypted = Buffer.from(vault.contents, 'base64')

    if (vault.version === 1) {
        const key = await deriveVaultKey(passphrase, keySalt, PBKDF_ITERATIONS_V1)
        const decipher = crypto.createDecipheriv(CRYPT_ALG_V1, key, iv)
        const plaintext = decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8')
        return migrateVaultContent(JSON.parse(plaintext))
    }
    if (vault.version !== 2 || !vault.authTag) {
        throw new Error(`Unsupported vault format version ${vault.version}`)
    }
    const iterations = vault.keyIterations ?? PBKDF_ITERATIONS_V2
    const key = await deriveVaultKey(passphrase, keySalt, iterations)
    const decipher = crypto.createDecipheriv(CRYPT_ALG_V2, key, iv)
    decipher.setAuthTag(Buffer.from(vault.authTag, 'hex'))
    const plaintext = decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8')
    return migrateVaultContent(JSON.parse(plaintext))
}

export const VAULT_SECRET_TYPE_FILE = 'file'

// Don't make it accessible through VaultService fields
let _rememberedPassphrase: string|null = null
let _rejectedEnvPassphrase: string|null = null

@Injectable({ providedIn: 'root' })
export class VaultService {
    /** Fires once when the config is loaded */
    get ready$ (): Observable<boolean> { return this.ready }

    get contentChanged$ (): Observable<void> { return this.contentChanged }

    store: StoredVault|null = null
    private ready = new AsyncSubject<boolean>()
    private contentChanged = new Subject<void>()
    private _requireReauth = false

    /** @hidden */
    private constructor (
        private zone: NgZone,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
    ) {
        this.getPassphrase = serializeFunction(this.getPassphrase.bind(this))
    }

    async setEnabled (enabled: boolean, passphrase?: string): Promise<void> {
        if (enabled) {
            if (!this.store) {
                await this.save(migrateVaultContent({}), passphrase)
            }
        } else {
            this.store = null
            this.contentChanged.next()
        }
    }

    isOpen (): boolean {
        return !!_rememberedPassphrase
    }

    forgetPassphrase (): void {
        _rememberedPassphrase = null
    }

    requireReauth (): void {
        this._requireReauth = true
    }

    async decrypt (storage: StoredVault, passphrase?: string): Promise<Vault> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        try {
            return await wrapPromise(this.zone, decryptVault(storage, passphrase))
        } catch (e) {
            if (passphrase === process.env.TABBY_VAULT_PASSPHRASE) {
                _rejectedEnvPassphrase = passphrase
            }
            this.forgetPassphrase()
            if (/BAD_DECRYPT|authenticate data/i.test(e.toString())) {
                this.notifications.error('Incorrect passphrase or corrupted vault')
            }
            throw e
        }
    }

    async load (passphrase?: string): Promise<Vault|null> {
        if (!this.store) {
            return null
        }
        return this.decrypt(this.store, passphrase)
    }

    async encrypt (vault: Vault, passphrase?: string): Promise<StoredVault|null> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        if (_rememberedPassphrase) {
            _rememberedPassphrase = passphrase
        }
        return wrapPromise(this.zone, encryptVault(vault, passphrase))
    }

    async save (vault: Vault, passphrase?: string): Promise<void> {
        await this.ready$.toPromise()
        this.store = await this.encrypt(vault, passphrase)
        this.contentChanged.next()
    }

    async getPassphrase (): Promise<string> {
        const envPassphrase = process.env.TABBY_VAULT_PASSPHRASE
        if (envPassphrase && envPassphrase !== _rejectedEnvPassphrase && (!_rememberedPassphrase || this._requireReauth)) {
            _rememberedPassphrase = envPassphrase
            this._requireReauth = false
            return envPassphrase
        }

        if (!_rememberedPassphrase || this._requireReauth) {
            const savedPassphrase = _rememberedPassphrase
            this._requireReauth = false
            // Config may decrypt during bootstrap before modal host renders.
            await new Promise(resolve => setTimeout(resolve, 300))
            const modal = this.ngbModal.open(UnlockVaultModalComponent, { backdrop: 'static', keyboard: false })
            try {
                const { passphrase, rememberFor } = await modal.result
                setTimeout(() => {
                    _rememberedPassphrase = null
                    // avoid multiple consequent prompts
                }, Math.max(1000, rememberFor * 60000))
                _rememberedPassphrase = passphrase
            } catch {
                _rememberedPassphrase = savedPassphrase
                throw new Error('Vault unlock cancelled')
            }
        }

        return _rememberedPassphrase!
    }

    async getSecret (type: string, key: VaultSecretKey): Promise<VaultSecret|null> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return null
        }
        let vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        if (!vaultSecret) {
            // search for secret without host in vault (like a default user/password used in multiple servers)
            key['host'] = null
            vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        }
        return vaultSecret ?? null
    }

    async addSecret (secret: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== secret.type || !this.keyMatches(secret.key, s))
        vault.secrets.push(secret)
        await this.save(vault)
    }

    async updateSecret (secret: VaultSecret, update: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        const target = vault.secrets.find(s => s.type === secret.type && this.keyMatches(secret.key, s))
        if (!target) {
            return
        }
        Object.assign(target, update)
        await this.save(vault)
    }

    async removeSecret (type: string, key: VaultSecretKey): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== type || !this.keyMatches(key, s))
        await this.save(vault)
    }

    private keyMatches (key: VaultSecretKey, secret: VaultSecret): boolean {
        return Object.keys(key).every(k => secret.key[k] === key[k])
    }

    setStore (store: StoredVault): void {
        this.store = store
        this.ready.next(true)
        this.ready.complete()
    }

    isEnabled (): boolean {
        return !!this.store
    }
}


@Injectable()
export class VaultFileProvider extends FileProvider {
    name = 'Vault'
    prefix = 'vault://'

    constructor (
        private vault: VaultService,
        private platform: PlatformService,
        private selector: SelectorService,
        private zone: NgZone,
    ) {
        super()
    }

    async isAvailable (): Promise<boolean> {
        return this.vault.isEnabled()
    }

    async selectAndStoreFile (description: string): Promise<string> {
        const vault = await this.vault.load()
        if (!vault) {
            throw new Error('Vault is locked')
        }
        const files = vault.secrets.filter(x => x.type === VAULT_SECRET_TYPE_FILE) as VaultFileSecret[]
        if (files.length) {
            const result = await this.selector.show<VaultFileSecret|null>('Select file', [
                {
                    name: 'Add a new file',
                    icon: 'fas fa-plus',
                    result: null,
                },
                ...files.map(f => ({
                    name: f.key.description,
                    icon: 'fas fa-file',
                    result: f,
                })),
            ]).catch(() => null)
            if (result) {
                return `${this.prefix}${result.key.id}`
            }
        }
        return this.addNewFile(description)
    }

    async addNewFile (description: string): Promise<string> {
        const transfers = await this.platform.startUpload()
        if (!transfers.length) {
            throw new Error('Nothing selected')
        }
        const transfer = transfers[0]
        const id = (await wrapPromise(this.zone, promisify(crypto.randomBytes)(32))).toString('hex')
        await this.vault.addSecret({
            type: VAULT_SECRET_TYPE_FILE,
            key: {
                id,
                description: `${description} (${transfer.getName()})`,
            },
            value: Buffer.from(await transfer.readAll()).toString('base64'),
        })
        return `${this.prefix}${id}`
    }

    async retrieveFile (key: string): Promise<Buffer> {
        if (!key.startsWith(this.prefix)) {
            throw new Error('Incorrect type')
        }
        const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_FILE, { id: key.substring(this.prefix.length) })
        if (!secret) {
            throw new Error('Not found')
        }
        return Buffer.from(secret.value, 'base64')
    }
}
