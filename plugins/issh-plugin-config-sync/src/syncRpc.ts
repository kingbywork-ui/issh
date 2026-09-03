import type { IsshPluginContext } from './types'

export interface SshHostProfile {
    id: string
    name: string
    host: string
    port?: number
    user?: string
    groupId?: string | null
    favorite?: boolean
    authMethod?: string
    keyPath?: string | null
    jumpHostId?: string | null
    notes?: string | null
    tags?: string[]
}

export interface SshHostGroup {
    id: string
    name: string
    parentGroupId?: string | null
    profileIds?: string[]
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

type Gateway = IsshPluginContext['gateway']
let gateway: Gateway | null = null

export function setGateway (value: Gateway): void {
    gateway = value
}

function requireGateway (): Gateway {
    if (!gateway) throw new Error('配置同步网关尚未初始化')
    return gateway
}

export function networkFetch (url: string, options?: Parameters<Gateway['network']['fetch']>[1]): Promise<{ status: number; ok: boolean; body: string }> {
    return requireGateway().network.fetch(url, options)
}

export function pluginStorage (): Gateway['storage'] {
    return requireGateway().storage
}

export function hostProfiles (): Promise<HostProfilesResult> {
    return requireGateway().profiles.read() as Promise<HostProfilesResult>
}

export function mutateHostProfiles (mutation: HostProfileMutation): Promise<HostProfilesResult> {
    return requireGateway().profiles.mutate(mutation) as Promise<HostProfilesResult>
}

export function unlockHostProfiles (passphrase: string): Promise<HostProfilesResult> {
    return requireGateway().request<HostProfilesResult>('vault.unlock', { passphrase })
}

export interface SyncPayload {
    schema: 1
    exportedAt: string
    profiles: SshHostProfile[]
    groups: SshHostGroup[]
}

export function buildPayload (result: HostProfilesResult): SyncPayload {
    return {
        schema: 1,
        exportedAt: new Date().toISOString(),
        profiles: result.profiles,
        groups: result.groups,
    }
}

export function validatePayload (raw: string): SyncPayload {
    const parsed = JSON.parse(raw) as SyncPayload
    if (parsed.schema !== 1) throw new Error(`不支持的配置格式：schema ${parsed.schema}`)
    if (!Array.isArray(parsed.profiles) || !Array.isArray(parsed.groups)) throw new Error('配置缺少 profiles/groups 数组')
    return parsed
}

export async function applyPayload (payload: SyncPayload): Promise<{ created: number; updated: number }> {
    const current = await hostProfiles()
    const existingProfileIds = new Set(current.profiles.map((profile) => profile.id))
    const existingGroupIds = new Set(current.groups.map((group) => group.id))
    let created = 0
    let updated = 0
    for (const group of payload.groups) {
        if (existingGroupIds.has(group.id)) {
            await mutateHostProfiles({ action: 'updateGroup', group })
            updated += 1
        } else {
            await mutateHostProfiles({ action: 'createGroup', group })
            created += 1
        }
    }
    for (const profile of payload.profiles) {
        if (existingProfileIds.has(profile.id)) {
            await mutateHostProfiles({ action: 'updateProfile', profile })
            updated += 1
        } else {
            await mutateHostProfiles({ action: 'createProfile', profile })
            created += 1
        }
    }
    return { created, updated }
}
