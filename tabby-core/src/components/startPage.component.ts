import { Component } from '@angular/core'
import { HomeBaseService } from '../services/homeBase.service'
import { ProfilesService } from '../services/profiles.service'
import { ConfigService } from '../services/config.service'
import { AppService } from '../services/app.service'
import { BaseComponent } from './base.component'
import { PartialProfile, PartialProfileGroup, Profile, ProfileGroup } from '../api'
import { MenuItemOptions } from '../api/menu'
import { SelectorOption } from '../api/selector'
import { PlatformService } from '../api/platform'
import { SelectorService } from '../services/selector.service'

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

interface ConnectionInfo {
    user?: string
    host?: string
    port?: number
}

/** @hidden */
@Component({
    selector: 'start-page',
    templateUrl: './startPage.component.pug',
    styleUrls: ['./startPage.component.scss'],
})
export class StartPageComponent extends BaseComponent {
    // Sidebar state
    activeGroupId: string | null = null
    favoritesOnly = false
    recentOnly = false
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    customProfiles: PartialProfile<Profile>[] = []
    recentProfileIds = new Set<string>()
    private lastGroupContextMenuAt = 0
    private lastProfileContextMenuAt = 0

    constructor (
        public homeBase: HomeBaseService,
        private profilesService: ProfilesService,
        private config: ConfigService,
        private app: AppService,
        private platform: PlatformService,
        private selector: SelectorService,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        await this.refreshAll()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshAll())
    }

    async refreshAll (): Promise<void> {
        await this.refreshProfiles()
        await this.refreshProfileGroups()
    }

    async refreshProfiles (): Promise<void> {
        const allProfiles = await this.profilesService.getProfiles()
        this.customProfiles = allProfiles.filter(x => !x.isBuiltin && !x.isTemplate)

        const recent = this.profilesService.getRecentProfiles()
        this.recentProfileIds = new Set(recent.map(x => x.id).filter((id): id is string => !!id))
    }

    async refreshProfileGroups (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        const groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })
        this.profileGroups = groups
            .map(group => ({
                ...StartPageComponent.intoPartialCollapsableProfileGroup(group, profileGroupCollapsed[group.id] ?? false),
                profiles: (group.profiles ?? []).filter(p => !p.isTemplate),
            }))
            .sort((a, b) => this.compareGroups(a, b))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
    }

    // Sidebar navigation
    showAllHosts (): void {
        this.activeGroupId = null
        this.favoritesOnly = false
        this.recentOnly = false
    }

    showFavorites (): void {
        this.activeGroupId = null
        this.recentOnly = false
        this.favoritesOnly = true
    }

    showRecentHosts (): void {
        this.activeGroupId = null
        this.favoritesOnly = false
        this.recentOnly = true
    }

    selectGroupView (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.activeGroupId = group.id
        this.favoritesOnly = false
        this.recentOnly = false
    }

    isGroupActive (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        return this.activeGroupId === group.id
    }

    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    isSidebarGroupVisible (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        return this.getSidebarVisibleProfiles(group).length > 0 || (group.children ?? []).some(child => this.isSidebarGroupVisible(child))
    }

    getSidebarVisibleProfiles (group: PartialProfileGroup<ProfileGroup>): PartialProfile<Profile>[] {
        return (group.profiles ?? []).filter(profile => !profile.isTemplate)
    }

    getGroupVisibleProfileCount (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        return this.getSidebarVisibleProfiles(group).length + (group.children ?? []).reduce((count, child) => count + this.getGroupVisibleProfileCount(child), 0)
    }

    getVisibleCustomProfilesCount (): number {
        return this.customProfiles.filter(p => !p.isTemplate).length
    }

    getFavoriteVisibleCount (): number {
        return this.customProfiles.filter(profile => !!profile.favorite).length
    }

    getRecentVisibleCount (): number {
        return this.customProfiles.filter(profile => !!profile.id && this.recentProfileIds.has(profile.id)).length
    }

    // Right panel: filtered host list
    getRightPanelProfiles (): PartialProfile<Profile>[] {
        if (this.favoritesOnly) {
            return this.customProfiles.filter(p => !!p.favorite && !p.isTemplate)
                .sort((a, b) => a.name.localeCompare(b.name))
        }
        if (this.recentOnly) {
            return this.customProfiles.filter(p => !!p.id && this.recentProfileIds.has(p.id) && !p.isTemplate)
                .sort((a, b) => {
                    const recent = this.profilesService.getRecentProfiles()
                    const aIndex = recent.findIndex(r => r.id === a.id)
                    const bIndex = recent.findIndex(r => r.id === b.id)
                    return aIndex - bIndex
                })
        }
        if (this.activeGroupId) {
            const group = this.findGroupById(this.activeGroupId, this.rootGroups)
            if (group) {
                return this.collectProfilesFromGroup(group)
            }
            return []
        }
        // Default: show all
        return this.customProfiles.filter(p => !p.isTemplate)
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    getRightPanelTitle (): string {
        if (this.favoritesOnly) {
            return '收藏主机'
        }
        if (this.recentOnly) {
            return '最近主机'
        }
        if (this.activeGroupId) {
            const group = this.findGroupById(this.activeGroupId, this.rootGroups)
            return group?.name ?? '分组'
        }
        return '全部主机'
    }

    private findGroupById (id: string, groups: PartialProfileGroup<CollapsableProfileGroup>[]): PartialProfileGroup<CollapsableProfileGroup> | null {
        for (const group of groups) {
            if (group.id === id) {
                return group
            }
            const found = this.findGroupById(id, group.children ?? [])
            if (found) {
                return found
            }
        }
        return null
    }

    private collectProfilesFromGroup (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfile<Profile>[] {
        const profiles = (group.profiles ?? []).filter(p => !p.isTemplate)
        const childProfiles = (group.children ?? []).reduce<PartialProfile<Profile>[]>((acc, child) => {
            return acc.concat(this.collectProfilesFromGroup(child))
        }, [])
        return [...profiles, ...childProfiles].sort((a, b) => a.name.localeCompare(b.name))
    }

    onGroupMouseDown (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        if (event.button === 2) {
            this.showGroupContextMenu(event, group)
        }
    }

    onGroupContextMenu (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        if (Date.now() - this.lastGroupContextMenuAt < 500) {
            event.preventDefault()
            event.stopPropagation()
            return
        }
        this.showGroupContextMenu(event, group)
    }

    private showGroupContextMenu (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        event.preventDefault()
        event.stopPropagation()
        this.lastGroupContextMenuAt = Date.now()
        this.platform.popupContextMenu(this.buildGroupContextMenu(group), event)
    }

    private buildGroupContextMenu (group: PartialProfileGroup<CollapsableProfileGroup>): MenuItemOptions[] {
        const profiles = this.getGroupSSHProfiles(group)
        return [{
            label: `连接 (${profiles.length})`,
            enabled: profiles.length > 0,
            click: () => {
                void this.connectGroupSSHProfiles(group)
            },
        }]
    }

    private getGroupSSHProfiles (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfile<Profile>[] {
        return this.collectProfilesFromGroup(group).filter(profile => profile.type === 'ssh')
    }

    private async connectGroupSSHProfiles (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const profiles = this.getGroupSSHProfiles(group)
        if (!profiles.length) {
            return
        }

        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `连接分组 "${group.name || 'Ungrouped'}" 中的 ${profiles.length} 台 SSH 主机？`,
            buttons: [
                '连接',
                '取消',
            ],
            defaultId: 0,
            cancelId: 1,
        })
        if (result.response !== 0) {
            return
        }

        const failedProfiles: PartialProfile<Profile>[] = []
        for (const profile of profiles) {
            try {
                await this.profilesService.launchProfile(profile)
            } catch {
                failedProfiles.push(profile)
            }
        }

        if (failedProfiles.length) {
            await this.platform.showMessageBox({
                type: 'error',
                message: `有 ${failedProfiles.length} 台 SSH 主机连接失败。`,
                detail: failedProfiles.map(profile => profile.name).join('\n'),
                buttons: ['OK'],
            })
        }
    }

    onProfileMouseDown (event: MouseEvent, profile: PartialProfile<Profile>): void {
        if (event.button === 2) {
            this.showProfileContextMenu(event, profile)
        }
    }

    onProfileContextMenu (event: MouseEvent, profile: PartialProfile<Profile>): void {
        if (Date.now() - this.lastProfileContextMenuAt < 500) {
            event.preventDefault()
            event.stopPropagation()
            return
        }
        this.showProfileContextMenu(event, profile)
    }

    private showProfileContextMenu (event: MouseEvent, profile: PartialProfile<Profile>): void {
        event.preventDefault()
        event.stopPropagation()
        this.lastProfileContextMenuAt = Date.now()
        this.platform.popupContextMenu(this.buildProfileContextMenu(profile), event)
    }

    private buildProfileContextMenu (profile: PartialProfile<Profile>): MenuItemOptions[] {
        return [
            {
                label: '更改分组',
                enabled: !profile.isBuiltin,
                click: () => {
                    void this.changeProfileGroup(profile)
                },
            },
            { type: 'separator' },
            {
                label: '删除',
                enabled: !profile.isBuiltin,
                click: () => {
                    void this.deleteProfile(profile)
                },
            },
        ]
    }

    private async changeProfileGroup (profile: PartialProfile<Profile>): Promise<void> {
        if (profile.isBuiltin) {
            return
        }

        const targetGroupId = await this.selector.show<string>(
            `选择 "${profile.name}" 的分组`,
            this.getProfileGroupSelectorOptions(profile),
        ).catch(() => null)
        if (targetGroupId === null || targetGroupId === (profile.group ?? '')) {
            return
        }

        profile.group = targetGroupId || undefined
        await this.profilesService.writeProfile(profile)
        await this.config.save()
        await this.refreshAll()
    }

    private getProfileGroupSelectorOptions (profile: PartialProfile<Profile>): SelectorOption<string>[] {
        const options: SelectorOption<string>[] = [{
            name: '未分组',
            description: profile.group ? undefined : '当前分组',
            result: '',
            weight: 0,
        }]

        return options.concat(
            this.profileGroups
                .filter(group => group.editable)
                .map((group): SelectorOption<string> => ({
                    name: group.name,
                    description: group.id === profile.group ? '当前分组' : undefined,
                    group: this.profilesService.resolveProfileGroupPath(group.parentGroupId ?? '').join(' / '),
                    result: group.id,
                    weight: 1,
                })),
        )
    }

    private async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if (profile.isBuiltin) {
            return
        }

        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: `删除 "${profile.name}"？`,
            buttons: [
                '删除',
                '取消',
            ],
            defaultId: 1,
            cancelId: 1,
        })).response !== 0) {
            return
        }

        await this.profilesService.deleteProfile(profile)
        await this.config.save()
        await this.refreshAll()
    }

    // Open settings page HOSTMANAGER
    openSettingsProfiles (): void {
        try {
            const { SettingsTabComponent } = window['nodeRequire']('tabby-settings')
            this.app.openNewTabRaw({
                type: SettingsTabComponent,
                inputs: { activeTab: 'profiles' },
            })
        } catch {
            // tabby-settings not available
        }
    }

    async launchProfile (profile: PartialProfile<Profile>): Promise<void> {
        await this.profilesService.launchProfile(profile)
    }

    getProfileConnectionInfo (profile: PartialProfile<Profile>): ConnectionInfo | null {
        if (profile.type !== 'ssh') {
            return null
        }
        return {
            user: profile.options?.user,
            host: profile.options?.host,
            port: profile.options?.port,
        }
    }

    getEnvironmentBadgeClass (environment?: string | null): string {
        const value = (environment ?? '').toLowerCase()
        if (value.includes('prod')) {
            return 'text-bg-danger'
        }
        if (value.includes('stage')) {
            return 'text-bg-primary'
        }
        if (value.includes('test')) {
            return 'text-bg-warning'
        }
        if (value.includes('dev')) {
            return 'text-bg-success'
        }
        return 'text-bg-dark'
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    profilesTrackBy (_, profile: PartialProfile<Profile>): any {
        return profile.id ?? `${profile.type}:${profile.name}`
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    groupTrackBy (_, group: PartialProfileGroup<CollapsableProfileGroup>): any {
        return group.id
    }

    private compareGroups (a: PartialProfileGroup<CollapsableProfileGroup>, b: PartialProfileGroup<CollapsableProfileGroup>): number {
        const ungroupedDelta = Number(a.id === 'ungrouped') - Number(b.id === 'ungrouped')
        if (ungroupedDelta !== 0) {
            return ungroupedDelta
        }
        const builtinEditableDelta = Number(a.id === 'built-in' || !a.editable) - Number(b.id === 'built-in' || !b.editable)
        if (builtinEditableDelta !== 0) {
            return builtinEditableDelta
        }
        return a.name.localeCompare(b.name)
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        return {
            ...group,
            collapsed,
            children: [],
        }
    }
}
