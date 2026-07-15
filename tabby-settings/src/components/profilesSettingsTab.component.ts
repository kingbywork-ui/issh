import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Component, Inject } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, HostAppService, Profile, SelectorService, ProfilesService, PlatformService, BaseComponent, PartialProfile, ProfileProvider, TranslateService, Platform, ProfileGroup, PartialProfileGroup, QuickConnectProfileProvider, NotificationsService } from 'tabby-core'
import { EditProfileModalComponent } from './editProfileModal.component'
import { EditProfileGroupModalComponent, EditProfileGroupModalComponentResult } from './editProfileGroupModal.component'

_('Filter')
_('Ungrouped')
_('Host manager')
_('Favorites')
_('Recent')
_('SSH only')
_('All environments')
_('Apply environment')
_('Apply tags')
_('Comma-separated tags')

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
    templateUrl: './profilesSettingsTab.component.pug',
    styleUrls: ['./profilesSettingsTab.component.scss'],
})
export class ProfilesSettingsTabComponent extends BaseComponent {
    builtinProfiles: PartialProfile<Profile>[] = []
    profiles: PartialProfile<Profile>[] = []
    templateProfiles: PartialProfile<Profile>[] = []
    customProfiles: PartialProfile<Profile>[] = []
    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []

    filter = ''
    sshOnly = true
    favoritesOnly = false
    recentOnly = false
    environmentFilter = ''
    activeGroupId = ''
    selectedProfileIds = new Set<string>()
    selectedTags: string[] = []
    bulkGroupId = ''
    bulkTagsInput = ''
    bulkEnvironmentInput = ''
    Platform = Platform

    private descriptionCache = new Map<string, string|null>()
    private recentProfileIds = new Set<string>()

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        @Inject(ProfileProvider) public profileProviders: ProfileProvider<Profile>[],
        private profilesService: ProfilesService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
        private platform: PlatformService,
        private translate: TranslateService,
        private notifications: NotificationsService,
    ) {
        super()
        this.profileProviders.sort((a, b) => a.name.localeCompare(b.name))
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
        this.profiles = allProfiles
        this.builtinProfiles = allProfiles.filter(x => x.isBuiltin && !x.isTemplate)
        this.templateProfiles = allProfiles.filter(x => x.isBuiltin && x.isTemplate)
        this.customProfiles = allProfiles.filter(x => !x.isBuiltin)

        this.descriptionCache.clear()
        for (const p of allProfiles) {
            if (p.id) {
                this.descriptionCache.set(p.id, this.profilesService.getDescription(p))
            }
        }

        const recent = this.profilesService.getRecentProfiles()
        this.recentProfileIds = new Set(recent.map(x => x.id).filter((x): x is string => !!x))
        this.selectedProfileIds.forEach(id => {
            if (!this.customProfiles.some(profile => profile.id === id)) {
                this.selectedProfileIds.delete(id)
            }
        })
    }

    launchProfile (profile: PartialProfile<Profile>): void {
        this.profilesService.launchProfile(profile)
    }

    async newProfile (base?: PartialProfile<Profile>): Promise<void> {
        if (!base) {
            let profiles = await this.profilesService.getProfiles()
            profiles = profiles.filter(x => !this.isProfileBlacklisted(x))
            base = await this.selector.show(
                this.translate.instant('Select a base profile to use as a template'),
                profiles.map(p => ({
                    icon: p.icon ?? undefined,
                    description: this.profilesService.getDescription(p) ?? undefined,
                    name: p.group ? `${this.profilesService.resolveProfileGroupName(p.group)} / ${p.name}` : p.name,
                    group: p.isTemplate ? this.translate.instant('Template') : this.translate.instant('Duplicate an existing profile'),
                    result: p,
                    weight: p.isTemplate ? 0 : 1,
                })),
            ).catch(() => undefined)
            if (!base) {
                return
            }
        }
        const baseProfile: PartialProfile<Profile> = deepClone(base)
        delete baseProfile.id
        if (base.isTemplate) {
            baseProfile.name = ''
        } else if (!base.isBuiltin) {
            baseProfile.name = this.translate.instant('{name} copy', base)
        }
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false
        const result = await this.showProfileEditModal(baseProfile)
        if (!result) {
            return
        }
        if (!result.name) {
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = this.profilesService.providerForProfile(result)?.getSuggestedName(cfgProxy) ?? this.translate.instant('{name} copy', base)
        }
        await this.profilesService.newProfile(result)
        await this.config.save()
        await this.refreshAll()
    }

    async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const result = await this.showProfileEditModal(profile)
        if (!result) {
            return
        }
        await this.profilesService.writeProfile(result)
        await this.config.save()
        await this.refreshAll()
    }

    async showProfileEditModal (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            throw new Error('Cannot edit a profile without a provider')
        }
        modal.componentInstance.partialProfile = deepClone(profile)
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        result.type = provider.id
        return result
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', profile),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            await this.profilesService.deleteProfile(profile)
            await this.config.save()
            await this.refreshAll()
        }
    }

    async newProfileGroup (): Promise<void> {
        await this.editProfileGroup({
            id: 'new',
            name: '',
            icon: 'far fa-folder',
            color: '',
            children: [],
            collapsed: false,
        })
    }

    async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const result = await this.showProfileGroupEditModal(group)
        if (!result) {
            return
        }
        if (result.id !== 'new') {
            await this.profilesService.writeProfileGroup(ProfilesSettingsTabComponent.collapsableIntoPartialProfileGroup(result))
        }
        await this.config.save()
        await this.refreshAll()
    }

    async showProfileGroupEditModal (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )

        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profileProviders

        const result: EditProfileGroupModalComponentResult<CollapsableProfileGroup> | null = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        return result.group
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            for (const k in model) {
                delete model[k]
            }
            Object.assign(model, result)
            if (!group.defaults) {
                group.defaults = {}
            }
            group.defaults[provider.id] = model
        }
        return this.showProfileGroupEditModal(group)
    }

    async deleteProfileGroup (group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', group),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            let deleteProfiles = false
            if ((group.profiles?.length ?? 0) > 0 && (await this.platform.showMessageBox(
                {
                    type: 'warning',
                    message: this.translate.instant('Delete the group\'s profiles?'),
                    buttons: [
                        this.translate.instant('Move to "Ungrouped"'),
                        this.translate.instant('Delete'),
                    ],
                    defaultId: 0,
                    cancelId: 0,
                },
            )).response !== 0) {
                deleteProfiles = true
            }

            await this.profilesService.deleteProfileGroup(group, { deleteProfiles })
            await this.config.save()
            await this.refreshAll()
        }
    }

    async refreshProfileGroups (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        const groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })
        this.profileGroups = groups
            .map(group => ({
                ...ProfilesSettingsTabComponent.intoPartialCollapsableProfileGroup(group, profileGroupCollapsed[group.id] ?? false),
                profiles: this.sortProfiles(group.profiles ?? []),
            }))
            .sort((a, b) => this.compareGroups(a, b))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
    }

    isGroupVisible (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        return this.getVisibleProfiles(group).length > 0 || (group.children ?? []).some(child => this.isGroupVisible(child))
    }

    isSidebarGroupVisible (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        return this.getSidebarVisibleProfiles(group).length > 0 || (group.children ?? []).some(child => this.isSidebarGroupVisible(child))
    }

    isProfileVisible (profile: PartialProfile<Profile>): boolean {
        return this.profileMatchesFilters(profile)
    }

    getVisibleProfiles (group: PartialProfileGroup<ProfileGroup>): PartialProfile<Profile>[] {
        return (group.profiles ?? []).filter(profile => this.isProfileVisible(profile))
    }

    getSidebarVisibleProfiles (group: PartialProfileGroup<ProfileGroup>): PartialProfile<Profile>[] {
        return (group.profiles ?? []).filter(profile => this.profileMatchesFilters(profile, { ignoreActiveGroup: true }))
    }

    getDescription (profile: PartialProfile<Profile>): string|null {
        if (profile.id) {
            return this.descriptionCache.get(profile.id) ?? null
        }
        return this.profilesService.getDescription(profile)
    }

    getTypeLabel (profile: PartialProfile<Profile>): string {
        const name = this.profilesService.providerForProfile(profile)?.name
        if (name === 'Local terminal') {
            return ''
        }
        return name ? this.translate.instant(name) : this.translate.instant('Unknown')
    }

    getTypeColorClass (profile: PartialProfile<Profile>): string {
        return {
            ssh: 'secondary',
            serial: 'success',
            telnet: 'info',
            'split-layout': 'primary',
        }[this.profilesService.providerForProfile(profile)?.id ?? ''] ?? 'warning'
    }

    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    async editDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = this.profilesService.getProviderDefaults(provider)
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'enabled'
        const result = await modal.result.catch(() => null)
        if (result) {
            for (const k in model) {
                delete model[k]
            }
            Object.assign(model, result)
            this.profilesService.setProviderDefaults(provider, model)
            await this.config.save()
        }
    }

    async deleteDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Restore settings to defaults ?'),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            this.profilesService.setProviderDefaults(provider, {})
            await this.config.save()
        }
    }

    blacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = [...this.config.store.profileBlacklist, profile.id]
        this.config.save()
    }

    unblacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = this.config.store.profileBlacklist.filter(x => x !== profile.id)
        this.config.save()
    }

    isProfileBlacklisted (profile: PartialProfile<Profile>): boolean {
        return profile.id && this.config.store.profileBlacklist.includes(profile.id)
    }

    getQuickConnectProviders (): ProfileProvider<Profile>[] {
        return this.profileProviders.filter(x => x instanceof QuickConnectProfileProvider)
    }

    clearFilters (): void {
        this.filter = ''
        this.favoritesOnly = false
        this.recentOnly = false
        this.environmentFilter = ''
        this.sshOnly = true
        this.activeGroupId = ''
        this.selectedTags = []
    }

    showAllHosts (): void {
        this.clearFilters()
    }

    showFavorites (): void {
        this.activeGroupId = ''
        this.recentOnly = false
        this.favoritesOnly = true
    }

    showRecentHosts (): void {
        this.activeGroupId = ''
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

    isRecentProfile (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.recentProfileIds.has(profile.id)
    }

    getGroupVisibleProfileCount (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        return this.getSidebarVisibleProfiles(group).length + (group.children ?? []).reduce((count, child) => count + this.getGroupVisibleProfileCount(child), 0)
    }

    getVisibleCustomProfilesCount (): number {
        return this.getVisibleCustomProfiles().length
    }

    getFavoriteVisibleCount (): number {
        return this.customProfiles.filter(profile => !!profile.favorite && this.profileMatchesFilters(profile, { ignoreFavoritesOnly: true, ignoreRecentOnly: true, ignoreActiveGroup: true })).length
    }

    getRecentVisibleCount (): number {
        return this.customProfiles.filter(profile => this.isRecentProfile(profile) && this.profileMatchesFilters(profile, { ignoreFavoritesOnly: true, ignoreRecentOnly: true, ignoreActiveGroup: true })).length
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

    getProfileConnectionInfoText (profile: PartialProfile<Profile>): string {
        const info = this.getProfileConnectionInfo(profile)
        if (!info) {
            return ''
        }
        const parts = [info.user, info.host, info.port ? String(info.port) : '']
        return parts.filter(x => !!x).join(' / ')
    }

    getProfileDescriptionDisplay (profile: PartialProfile<Profile>): string|null {
        const description = this.getDescription(profile)
        const info = this.getProfileConnectionInfo(profile)
        if (!description) {
            return null
        }
        if (!info?.host) {
            return description
        }
        return description === info.host ? null : description
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

    getAvailableTags (): string[] {
        return [...new Set(
            this.customProfiles
                .flatMap(profile => profile.tags ?? [])
                .map(tag => tag.trim())
                .filter((x): x is string => !!x),
        )].sort((a, b) => a.localeCompare(b))
    }

    toggleTag (tag: string): void {
        const idx = this.selectedTags.indexOf(tag)
        if (idx >= 0) {
            this.selectedTags.splice(idx, 1)
        } else {
            this.selectedTags.push(tag)
        }
        this.selectedTags = [...this.selectedTags]
    }

    isTagSelected (tag: string): boolean {
        return this.selectedTags.includes(tag)
    }

    getAvailableEnvironments (): string[] {
        return [...new Set(
            this.customProfiles
                .map(profile => profile.environment?.trim())
                .filter((x): x is string => !!x),
        )].sort((a, b) => a.localeCompare(b))
    }

    isSelected (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.selectedProfileIds.has(profile.id)
    }

    setSelection (profile: PartialProfile<Profile>, selected: boolean): void {
        if (!profile.id) {
            return
        }
        if (selected) {
            this.selectedProfileIds.add(profile.id)
        } else {
            this.selectedProfileIds.delete(profile.id)
        }
        this.selectedProfileIds = new Set(this.selectedProfileIds)
    }

    toggleSelection (profile: PartialProfile<Profile>): void {
        if (!profile.id) {
            return
        }
        if (this.selectedProfileIds.has(profile.id)) {
            this.selectedProfileIds.delete(profile.id)
        } else {
            this.selectedProfileIds.add(profile.id)
        }
        this.selectedProfileIds = new Set(this.selectedProfileIds)
    }

    selectVisibleProfiles (): void {
        for (const profile of this.getVisibleCustomProfiles()) {
            if (profile.id) {
                this.selectedProfileIds.add(profile.id)
            }
        }
        this.selectedProfileIds = new Set(this.selectedProfileIds)
    }

    clearSelection (): void {
        this.selectedProfileIds.clear()
        this.selectedProfileIds = new Set(this.selectedProfileIds)
    }

    async bulkSetFavorite (favorite: boolean): Promise<void> {
        const selected = this.getSelectedProfiles()
        const failures: string[] = []
        for (const profile of selected) {
            try {
                profile.favorite = favorite
                await this.profilesService.writeProfile(profile)
            } catch (error) {
                failures.push(profile.name || profile.id || 'unknown')
            }
        }
        await this.config.save()
        await this.afterBulkUpdate()
        if (failures.length) {
            this.notifications.error(`Failed for ${failures.length} profile(s)`, failures.join(', '))
        }
    }

    async bulkMoveToGroup (): Promise<void> {
        const groupId = this.bulkGroupId || ''
        const selected = this.getSelectedProfiles()
        const failures: string[] = []
        for (const profile of selected) {
            try {
                profile.group = groupId
                await this.profilesService.writeProfile(profile)
            } catch (error) {
                failures.push(profile.name || profile.id || 'unknown')
            }
        }
        await this.config.save()
        this.bulkGroupId = ''
        await this.afterBulkUpdate()
        if (failures.length) {
            this.notifications.error(`Failed for ${failures.length} profile(s)`, failures.join(', '))
        }
    }

    async bulkReplaceTags (): Promise<void> {
        const tags = this.bulkTagsInput
            .split(',')
            .map(x => x.trim())
            .filter(x => !!x)
        const selected = this.getSelectedProfiles()
        const failures: string[] = []
        for (const profile of selected) {
            try {
                profile.tags = tags
                await this.profilesService.writeProfile(profile)
            } catch (error) {
                failures.push(profile.name || profile.id || 'unknown')
            }
        }
        await this.config.save()
        this.bulkTagsInput = ''
        await this.afterBulkUpdate()
        if (failures.length) {
            this.notifications.error(`Failed for ${failures.length} profile(s)`, failures.join(', '))
        }
    }

    async bulkReplaceEnvironment (): Promise<void> {
        const environment = this.bulkEnvironmentInput.trim() || null
        const selected = this.getSelectedProfiles()
        const failures: string[] = []
        for (const profile of selected) {
            try {
                profile.environment = environment
                await this.profilesService.writeProfile(profile)
            } catch (error) {
                failures.push(profile.name || profile.id || 'unknown')
            }
        }
        await this.config.save()
        this.bulkEnvironmentInput = ''
        await this.afterBulkUpdate()
        if (failures.length) {
            this.notifications.error(`Failed for ${failures.length} profile(s)`, failures.join(', '))
        }
    }

    async toggleFavorite (profile: PartialProfile<Profile>, favorite?: boolean): Promise<void> {
        profile.favorite = favorite ?? !profile.favorite
        await this.profilesService.writeProfile(profile)
        await this.config.save()
        await this.refreshAll()
    }

    getVisibleCustomProfiles (): PartialProfile<Profile>[] {
        return this.customProfiles.filter(profile => this.isProfileVisible(profile))
    }

    private getSelectedProfiles (): PartialProfile<Profile>[] {
        return this.customProfiles.filter(profile => profile.id && this.selectedProfileIds.has(profile.id))
    }

    private async afterBulkUpdate (): Promise<void> {
        this.clearSelection()
        await this.refreshAll()
    }

    private sortProfiles (profiles: PartialProfile<Profile>[]): PartialProfile<Profile>[] {
        return [...profiles].sort((a, b) => {
            const favoriteDelta = Number(!!b.favorite) - Number(!!a.favorite)
            if (favoriteDelta !== 0) {
                return favoriteDelta
            }

            const recentDelta = Number(this.isRecentProfile(b)) - Number(this.isRecentProfile(a))
            if (recentDelta !== 0) {
                return recentDelta
            }

            const nameDelta = (a.name ?? '').localeCompare(b.name ?? '')
            if (nameDelta !== 0) {
                return nameDelta
            }

            return (a.id ?? '').localeCompare(b.id ?? '')
        })
    }

    private compareGroups (a: PartialProfileGroup<CollapsableProfileGroup>, b: PartialProfileGroup<CollapsableProfileGroup>): number {
        const groupWeightDelta = this.getGroupWeight(b) - this.getGroupWeight(a)
        if (groupWeightDelta !== 0) {
            return groupWeightDelta
        }

        const ungroupedDelta = Number(a.id === 'ungrouped') - Number(b.id === 'ungrouped')
        if (ungroupedDelta !== 0) {
            return ungroupedDelta
        }

        const builtinEditableDelta = Number(a.id === 'built-in' || !a.editable) - Number(b.id === 'built-in' || !b.editable)
        if (builtinEditableDelta !== 0) {
            return builtinEditableDelta
        }

        const nameDelta = (a.name ?? '').localeCompare(b.name ?? '')
        if (nameDelta !== 0) {
            return nameDelta
        }

        return (a.id ?? '').localeCompare(b.id ?? '')
    }

    private getGroupWeight (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        const visibleProfiles = this.getSidebarVisibleProfiles(group)
        const hasFavorite = visibleProfiles.some(profile => !!profile.favorite)
        const hasRecent = visibleProfiles.some(profile => this.isRecentProfile(profile))
        if (hasFavorite) {
            return 2
        }
        if (hasRecent) {
            return 1
        }
        return 0
    }

    private profileMatchesFilters (
        profile: PartialProfile<Profile>,
        options?: {
            ignoreActiveGroup?: boolean
            ignoreFavoritesOnly?: boolean
            ignoreRecentOnly?: boolean
            ignoreTags?: boolean
        },
    ): boolean {
        if (profile.isTemplate) {
            return false
        }
        if (this.sshOnly && profile.type !== 'ssh') {
            return false
        }
        if (!options?.ignoreFavoritesOnly && this.favoritesOnly && !profile.favorite) {
            return false
        }
        if (!options?.ignoreRecentOnly && this.recentOnly && !this.isRecentProfile(profile)) {
            return false
        }
        if (!options?.ignoreActiveGroup && !this.matchesActiveGroup(profile)) {
            return false
        }
        if (this.environmentFilter) {
            const environment = (profile.environment ?? '').toLowerCase()
            if (environment !== this.environmentFilter.toLowerCase()) {
                return false
            }
        }
        if (!options?.ignoreTags && this.selectedTags.length > 0) {
            const profileTags = (profile.tags ?? []).map(t => t.toLowerCase())
            if (!this.selectedTags.some(selected => profileTags.includes(selected.toLowerCase()))) {
                return false
            }
        }
        if (!this.filter) {
            return true
        }
        const search = [
            profile.name,
            this.getDescription(profile) ?? '',
            profile.environment ?? '',
            profile.remark ?? '',
            ...(profile.tags ?? []),
            this.getProfileConnectionInfoText(profile),
        ].join('$').toLowerCase()
        return search.includes(this.filter.toLowerCase())
    }

    private matchesActiveGroup (profile: PartialProfile<Profile>): boolean {
        if (!this.activeGroupId) {
            return true
        }
        if (this.activeGroupId === 'built-in') {
            return !!profile.isBuiltin
        }
        if (this.activeGroupId === 'ungrouped') {
            return !profile.isBuiltin && !profile.group
        }
        if (!profile.group) {
            return false
        }

        let currentGroupId: string | undefined = profile.group
        let depth = 0
        while (currentGroupId && depth <= 30) {
            if (currentGroupId === this.activeGroupId) {
                return true
            }
            currentGroupId = this.profilesService.resolveProfileGroup(currentGroupId)?.parentGroupId
            depth++
        }
        return false
    }

    /**
    * Save ProfileGroup collapse state in localStorage
    */
    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static collapsableIntoPartialProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfileGroup<ProfileGroup> {
        const g: any = { ...group }
        delete g.collapsed
        delete g.children
        return g
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        return {
            ...group,
            collapsed,
            children: [],
        }
    }
}
