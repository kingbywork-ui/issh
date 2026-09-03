import { invoke } from '@tauri-apps/api/core'

export function clipboardWriteText (text: string): Promise<void> {
    return invoke<void>('clipboard_write_text', { text })
}

export function clipboardReadText (): Promise<string> {
    return invoke<string>('clipboard_read_text')
}

export interface SshHostProfile {
    id: string
    name: string
    group: string
    host: string
    port: number
    user: string
    auth: string | null
    privateKeys: string[]
    environment: string | null
    remark: string | null
    favorite: boolean
    tags: string[]
    loginScript: string | null
    x11?: boolean
    x11Display?: string | null
    agentForward?: boolean
    keyboardInteractive?: boolean
    jumpHost?: string | null
    proxyCommand?: string | null
    forwardedPorts?: ForwardedPortConfig[]
    socksProxyHost?: string | null
    socksProxyPort?: number | null
    httpProxyHost?: string | null
    httpProxyPort?: number | null
    reuseSession?: boolean
    jump?: OpenSshSessionOptions
}

export interface ForwardedPortConfig {
    type: 'Local' | 'Remote' | 'Dynamic'
    host: string
    port: number
    targetAddress: string
    targetPort: number
    description: string
}

export interface SshHostGroup {
    id: string
    name: string
    parentGroupId: string | null
}

export interface HostProfilesResult {
    encrypted: boolean
    unlocked: boolean
    profiles: SshHostProfile[]
    groups: SshHostGroup[]
}

export interface HostProfileMutation {
    action: 'createProfile' | 'updateProfile' | 'deleteProfile' | 'createGroup' | 'updateGroup' | 'deleteGroup' | 'moveProfiles' | 'toggleFavorite'
    profile?: SshHostProfile
    profileId?: string
    group?: SshHostGroup
    groupId?: string
    parentGroupId?: string | null
    profileIds?: string[]
}

export function hostProfiles (): Promise<HostProfilesResult> {
    return invoke<HostProfilesResult>('host_profiles')
}

export function unlockHostProfiles (passphrase: string): Promise<HostProfilesResult> {
    return invoke<HostProfilesResult>('unlock_host_profiles', { passphrase })
}

export function lockHostProfiles (): Promise<HostProfilesResult> {
    return invoke<HostProfilesResult>('lock_host_profiles')
}

export function mutateHostProfiles (mutation: HostProfileMutation): Promise<HostProfilesResult> {
    return invoke<HostProfilesResult>('mutate_host_profiles', { mutation })
}

export interface HostCredential {
    user: string
    host: string
    port: number
    password: string | null
    sudoPassword: string | null
    keyPassphrase: string | null
    passphraseByKey: boolean
}

export interface GenericCredential {
    kind: string
    user: string
    port: number
    value: string | null
    keyPath: string | null
}

export interface HostCredentialsResult {
    encrypted: boolean
    unlocked: boolean
    profiles: SshHostProfile[]
    groups: SshHostGroup[]
    credentials: HostCredential[]
    generic: GenericCredential[]
}

export interface CredentialMutation {
    user: string
    host: string
    port: number
    password?: string
    sudoPassword?: string
    keyPassphrase?: string
}

export function hostCredentials (): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('host_credentials')
}

export function saveHostCredential (mutation: CredentialMutation): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('save_host_credential', { mutation })
}

export function deleteHostCredential (user: string, host: string, port: number): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('delete_host_credential', { user, host, port })
}

export function enableHostVault (passphrase: string): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('enable_host_vault', { passphrase })
}

export function disableHostVault (): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('disable_host_vault')
}

export function changeHostPassphrase (oldPassphrase: string, newPassphrase: string): Promise<HostCredentialsResult> {
    return invoke<HostCredentialsResult>('change_host_passphrase', { oldPassphrase, newPassphrase })
}

export function resolveSshPassword (user: string, host: string, port: number): Promise<string | null> {
    return invoke<string | null>('resolve_ssh_password', { user, host, port })
}

export function resolveSudoPassword (user: string, host: string, port: number): Promise<string | null> {
    return invoke<string | null>('resolve_sudo_password', { user, host, port })
}

export function resolveKeyPassphrase (user: string, host: string, port: number, keyPath?: string): Promise<string | null> {
    return invoke<string | null>('resolve_key_passphrase', { user, host, port, keyPath })
}

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

export function openLocalSession (columns = 120, rows = 36, shell = localStorage.getItem('issh.localShell') ?? 'cmd', cwd?: string): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.openLocal', {
        title: '本地终端',
        shell,
        columns,
        rows,
        ...(cwd ? { cwd } : {}),
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
    agentForward?: boolean
    x11?: boolean
    jumpHost?: string | null
    proxyCommand?: string | null
    forwardedPorts?: ForwardedPortConfig[]
    socksProxyHost?: string | null
    socksProxyPort?: number | null
    httpProxyHost?: string | null
    httpProxyPort?: number | null
    reuseSession?: boolean
}

export function openSshSession (options: OpenSshSessionOptions): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.openSsh', options)
}

export interface LocalForwardResult {
    sessionId: string
    bindHost: string
    bindPort: number
    targetAddress: string
    targetPort: number
}

export function startLocalForward (sessionId: string, forward: ForwardedPortConfig): Promise<LocalForwardResult> {
    return runtimeRequest<LocalForwardResult>('ssh.forwardLocal', {
        sessionId,
        bindHost: forward.host,
        bindPort: forward.port,
        targetAddress: forward.targetAddress,
        targetPort: forward.targetPort,
    })
}

export function startDynamicForward (sessionId: string, forward: ForwardedPortConfig): Promise<LocalForwardResult> {
    return runtimeRequest<LocalForwardResult>('ssh.forwardDynamic', {
        sessionId,
        bindHost: forward.host,
        bindPort: forward.port,
    })
}

export function startRemoteForward (sessionId: string, forward: ForwardedPortConfig): Promise<LocalForwardResult> {
    return runtimeRequest<LocalForwardResult>('ssh.forwardRemote', {
        sessionId,
        bindHost: forward.host,
        bindPort: forward.port,
        targetAddress: forward.targetAddress,
        targetPort: forward.targetPort,
    })
}

export function stopLocalForward (sessionId: string, bindPort: number, kind: 'Local' | 'Dynamic' = 'Local'): Promise<{ stopped: boolean }> {
    return runtimeRequest<{ stopped: boolean }>('ssh.stopForward', { sessionId, bindPort, kind })
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

export function openSftpSession (sessionId: string, sudoPassword?: string): Promise<SftpOpenResult> {
    return runtimeRequest<SftpOpenResult>('sftp.open', {
        sessionId,
        ...(sudoPassword ? { sudoPassword } : {}),
    })
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

export function sftpReadlink (sessionId: string, path: string): Promise<{ target: string }> {
    return runtimeRequest<{ target: string }>('sftp.readlink', { sessionId, path })
}

export function sftpChmod (sessionId: string, path: string, mode: number): Promise<{ changed: boolean }> {
    return runtimeRequest<{ changed: boolean }>('sftp.chmod', { sessionId, path, mode })
}

export function sftpClose (sessionId: string): Promise<unknown> {
    return runtimeRequest('sftp.close', { sessionId })
}

export function sshExecReadonly (
    sessionId: string,
    command: string,
    timeoutMs = 10000,
    maxOutputBytes = 1024 * 1024,
): Promise<{ output: string }> {
    return runtimeRequest<{ output: string }>('ssh.execReadonly', {
        sessionId,
        command,
        timeoutMs,
        maxOutputBytes,
    })
}

export function bytesToBase64 (bytes: Uint8Array): string {
    let binary = ''
    const CHUNK = 0x8000
    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
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

// ---------- 本地文件系统（下载写盘 / 对话框，Tauri 壳提供） ----------

export function pickSavePath (title: string, defaultFileName: string): Promise<string | null> {
    return invoke<string | null>('pick_save_path', { title, defaultFileName })
}

export function pickDirectory (title: string): Promise<string | null> {
    return invoke<string | null>('pick_directory', { title })
}

export function writeLocalChunk (path: string, dataBase64: string, append: boolean): Promise<number> {
    return invoke<number>('write_local_chunk', { path, dataBase64, append })
}

export function deleteLocalFile (path: string): Promise<void> {
    return invoke<void>('delete_local_file', { path })
}

export function createLocalDir (path: string): Promise<void> {
    return invoke<void>('create_local_dir', { path })
}

// ---------- Agent Bridge（CLI / MCP 外部 agent 接入，R-045 安全语义） ----------

export interface AgentBridgeStatus {
    enabled: boolean
    port: number
    token: string
    scopes: string[]
    sftpRoot: string | null
    auditLogEnabled: boolean
    publicDiscovery: boolean
    discoveryPath: string
}

export interface AgentBridgePatch {
    scopes?: string[]
    sftpRoot?: string | null
    auditLogEnabled?: boolean
    publicDiscovery?: boolean
}

export function agentBridgeEnable (): Promise<AgentBridgeStatus> {
    return invoke<AgentBridgeStatus>('agent_bridge_enable')
}

export function agentBridgeDisable (): Promise<AgentBridgeStatus> {
    return invoke<AgentBridgeStatus>('agent_bridge_disable')
}

export function agentBridgeStatus (): Promise<AgentBridgeStatus> {
    return invoke<AgentBridgeStatus>('agent_bridge_status')
}

export function agentBridgeConfigure (patch: AgentBridgePatch): Promise<AgentBridgeStatus> {
    return invoke<AgentBridgeStatus>('agent_bridge_configure', { patch })
}

export function agentBridgeRotateToken (): Promise<AgentBridgeStatus> {
    return invoke<AgentBridgeStatus>('agent_bridge_rotate_token')
}

export function agentBridgeAuditRead (): Promise<string> {
    return invoke<string>('agent_bridge_audit_read')
}

export function agentBridgeAuditClear (): Promise<void> {
    return invoke<void>('agent_bridge_audit_clear')
}

export function setActiveSession (id: string | null): Promise<void> {
    return invoke<void>('set_active_session', { id })
}

export function appQuit (): Promise<void> {
    return invoke<void>('app_quit')
}

export function minimizeToTray (): Promise<void> {
    return invoke<void>('minimize_to_tray')
}

export interface PluginGatewayAuditEntry {
    timestamp: string
    requestId: string
    pluginId: string
    method: string
    ok: boolean
    errorCode?: string
}

export function pluginGatewayAuditRead (): Promise<PluginGatewayAuditEntry[]> {
    return invoke<PluginGatewayAuditEntry[]>('plugin_gateway_audit_read')
}

export function pluginGatewayAuditClear (): Promise<void> {
    return invoke<void>('plugin_gateway_audit_clear')
}
