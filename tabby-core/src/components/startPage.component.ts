import { Component } from '@angular/core'
import { HomeBaseService } from '../services/homeBase.service'
import { ProfilesService } from '../services/profiles.service'
import { ConfigService } from '../services/config.service'
import { AppService } from '../services/app.service'
import { BaseComponent } from './base.component'
import { PartialProfile, PartialProfileGroup, Profile, ProfileGroup } from '../api'

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

    constructor (
        public homeBase: HomeBaseService,
        private profilesService: ProfilesService,
        private config: ConfigService,
        private app: AppService,
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
                .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
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
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
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
        return [...profiles, ...childProfiles].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
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
        return (a.name ?? '').localeCompare(b.name ?? '')
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        return {
            ...group,
            collapsed,
            children: [],
        }
    }
}
