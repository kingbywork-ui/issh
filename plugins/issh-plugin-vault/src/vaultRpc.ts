import { invoke } from '@tauri-apps/api/core'

interface RuntimeResponse<T> {
    result?: T
    error?: {
        code: number
        message: string
    }
}

let requestId = 0

async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    const response = await invoke<RuntimeResponse<T>>('runtime_request', {
        request: {
            jsonrpc: '2.0',
            id: `vault-${requestId}`,
            method,
            ...(params === undefined ? {} : { params }),
        },
    })
    if (response.error || response.result === undefined) {
        throw new Error(response.error?.message ?? `${method} 未返回结果`)
    }
    return response.result
}

export interface VaultStatus {
    enabled: boolean
    unlocked: boolean
    secretCount: number
}

export interface VaultSecretKey {
    id: string
    description: string
}

export interface VaultSecretValue {
    id: string
    description: string
    value: string
}

export function vaultStatus (): Promise<VaultStatus> {
    return runtimeRequest<VaultStatus>('vault.status')
}

export function vaultUnlock (passphrase: string): Promise<VaultStatus> {
    return runtimeRequest<VaultStatus>('vault.unlock', { passphrase })
}

export function vaultLock (): Promise<VaultStatus> {
    return runtimeRequest<VaultStatus>('vault.lock')
}

export function vaultSetEnabled (enabled: boolean, passphrase?: string): Promise<VaultStatus> {
    return runtimeRequest<VaultStatus>('vault.setEnabled', {
        enabled,
        ...(passphrase === undefined ? {} : { passphrase }),
    })
}

export function vaultListSecrets (): Promise<VaultSecretKey[]> {
    return runtimeRequest<VaultSecretKey[]>('vault.listSecrets')
}

export function vaultGetSecret (id: string): Promise<VaultSecretValue> {
    return runtimeRequest<VaultSecretValue>('vault.getSecret', { id })
}

export function vaultPutSecret (id: string, description: string, value: string): Promise<{ saved: boolean }> {
    return runtimeRequest<{ saved: boolean }>('vault.putSecret', { id, description, value })
}

export function vaultDeleteSecret (id: string): Promise<{ deleted: boolean }> {
    return runtimeRequest<{ deleted: boolean }>('vault.deleteSecret', { id })
}
