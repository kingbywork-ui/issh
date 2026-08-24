import { invoke } from '@tauri-apps/api/core'

export interface RuntimeHealth {
    protocolVersion: string
    runtimeVersion: string
    pid: number
    startedAtUnixMs: number
    capabilities: string[]
}

export interface RuntimeSessionSnapshot {
    id: string
    title: string
    kind: string
    state: string
    columns: number
    rows: number
    pid: number | null
    nextSequence: number
    bufferedBytes: number
    droppedBytes: number
}

export interface RuntimeSessionEvent {
    sequence: number
    kind: string
    data: number[]
}

export interface RuntimeSessionSubscription {
    session: RuntimeSessionSnapshot
    events: RuntimeSessionEvent[]
    nextAfterSequence: number
    droppedBytes: number
}

export interface RuntimeSessionWriteResult {
    sessionId: string
    acceptedBytes: number
}

interface RuntimeResponse<T> {
    jsonrpc: '2.0'
    id: string | number | null
    result?: T
    error?: {
        code: number
        message: string
    }
}

export async function runtimeHealth (): Promise<RuntimeHealth> {
    const response = await invoke<RuntimeResponse<RuntimeHealth>>('runtime_health')
    if (response.error || !response.result) {
        throw new Error(response.error?.message ?? 'Runtime 未返回健康信息')
    }
    return response.result
}

let requestId = 0

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    const response = await invoke<RuntimeResponse<T>>('runtime_request', {
        request: {
            jsonrpc: '2.0',
            id: `tauri-${requestId}`,
            method,
            ...(params === undefined ? {} : { params }),
        },
    })
    if (response.error || response.result === undefined) {
        throw new Error(response.error?.message ?? `${method} 未返回结果`)
    }
    return response.result
}

export function openLocalSession (columns = 120, rows = 36): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.openLocal', {
        title: '本地终端',
        columns,
        rows,
    })
}

export function writeSession (sessionId: string, data: Uint8Array): Promise<RuntimeSessionWriteResult> {
    return runtimeRequest<RuntimeSessionWriteResult>('session.write', {
        sessionId,
        data: Array.from(data),
    })
}

export function resizeSession (sessionId: string, columns: number, rows: number): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.resize', {
        sessionId,
        columns,
        rows,
    })
}

export function subscribeSession (sessionId: string, afterSequence: number): Promise<RuntimeSessionSubscription> {
    return runtimeRequest<RuntimeSessionSubscription>('session.subscribe', {
        sessionId,
        afterSequence,
        maxEvents: 64,
        maxBytes: 12288,
    })
}

export function closeSession (sessionId: string): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.close', { sessionId })
}

export interface SshDiscoverHostKeyResult {
    host: string
    port: number
    fingerprint: string
}

export function discoverSshHostKey (host: string, port: number): Promise<SshDiscoverHostKeyResult> {
    return runtimeRequest<SshDiscoverHostKeyResult>('ssh.discoverHostKey', { host, port })
}

export interface OpenSshSessionOptions {
    title?: string
    columns?: number
    rows?: number
    host: string
    port: number
    username: string
    password?: string
    privateKeyPath?: string
    privateKeyPassphrase?: string
    expectedHostKey: string
    vaultSecretId?: string
}

export function openSshSession (options: OpenSshSessionOptions): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.openSsh', options)
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

export interface VaultSecretValue {
    id: string
    description: string
    value: string
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

export interface SftpOpenResult {
    sessionId: string
    sftpId: string
}

export function openSftpSession (sessionId: string): Promise<SftpOpenResult> {
    return runtimeRequest<SftpOpenResult>('sftp.open', { sessionId })
}

export interface SftpReadChunkResult {
    offset: number
    length: number
    dataBase64: string
    eof: boolean
}

export function sftpRead (sessionId: string, path: string, offset = 0, length = 32768): Promise<SftpReadChunkResult> {
    return runtimeRequest<SftpReadChunkResult>('sftp.read', { sessionId, path, offset, length })
}

export interface SftpWriteResult {
    acceptedBytes: number
    totalBytes: number
}

export function sftpWrite (
    sessionId: string,
    path: string,
    dataBase64: string,
    offset = 0,
    truncate = false,
): Promise<SftpWriteResult> {
    return runtimeRequest<SftpWriteResult>('sftp.write', {
        sessionId,
        path,
        offset,
        truncate,
        dataBase64,
    })
}

export interface SftpEntry {
    name: string
    path: string
    isDir: boolean
    isFile: boolean
    isSymlink: boolean
    size: number
    modifiedUnixSecs: number | null
}

export interface SftpListResult {
    path: string
    offset: number
    entries: SftpEntry[]
    total: number
    hasMore: boolean
}

export function sftpList (sessionId: string, path: string, offset = 0, limit = 256): Promise<SftpListResult> {
    return runtimeRequest<SftpListResult>('sftp.list', { sessionId, path, offset, limit })
}

export interface SftpStatResult {
    path: string
    isDir: boolean
    isFile: boolean
    isSymlink: boolean
    size: number
    modifiedUnixSecs: number | null
}

export function sftpStat (sessionId: string, path: string): Promise<SftpStatResult> {
    return runtimeRequest<SftpStatResult>('sftp.stat', { sessionId, path })
}

export function sftpMkdir (sessionId: string, path: string): Promise<unknown> {
    return runtimeRequest('sftp.mkdir', { sessionId, path })
}

export function sftpRemove (sessionId: string, path: string): Promise<unknown> {
    return runtimeRequest('sftp.remove', { sessionId, path })
}

export function sftpRemoveDir (sessionId: string, path: string): Promise<unknown> {
    return runtimeRequest('sftp.removeDir', { sessionId, path })
}

export function sftpRename (sessionId: string, oldPath: string, newPath: string): Promise<unknown> {
    return runtimeRequest('sftp.rename', { sessionId, oldPath, newPath })
}

export function sftpClose (sessionId: string): Promise<unknown> {
    return runtimeRequest('sftp.close', { sessionId })
}

export function bytesToBase64 (bytes: Uint8Array): string {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index])
    }
    return btoa(binary)
}

export function base64ToBytes (base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes
}
