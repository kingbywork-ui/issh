import { Component, ElementRef, Inject, Optional, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { HomeBaseService } from '../services/homeBase.service'
import { ProfilesService } from '../services/profiles.service'
import { ConfigService } from '../services/config.service'
import { AppService } from '../services/app.service'
import { BaseComponent } from './base.component'
import { PartialProfile, PartialProfileGroup, Profile, ProfileGroup, ProfileEditorService } from '../api'
import { MenuItemOptions } from '../api/menu'
import { SelectorOption } from '../api/selector'
import { PlatformService } from '../api/platform'
import { SelectorService } from '../services/selector.service'
import { PromptModalComponent } from './promptModal.component'

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
    standalone: false,
    selector: 'start-page',
    templateUrl: './startPage.component.pug',
    styleUrls: ['./startPage.component.scss'],
})
export class StartPageComponent extends BaseComponent {
    @ViewChild('contextMenu') private contextMenuElement?: ElementRef<HTMLElement>

    // Sidebar state
    activeGroupId: string | null = null
    favoritesOnly = false
    recentOnly = false
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    customProfiles: PartialProfile<Profile>[] = []
    recentProfileIds = new Set<string>()
    contextMenuVisible = false
    contextMenuX = 0
    contextMenuY = 0
    contextMenuItems: MenuItemOptions[] = []
    contextMenuSelectedIndex = -1
    private contextMenuReturnFocus: HTMLElement | null = null

    constructor (
        public homeBase: HomeBaseService,
        private profilesService: ProfilesService,
        private config: ConfigService,
        private app: AppService,
        private platform: PlatformService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
        @Optional() @Inject(ProfileEditorService) private profileEditor: ProfileEditorService | null,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        const savedGroupId = window.localStorage.startPageActiveGroupId
        if (savedGroupId) {
            this.activeGroupId = savedGroupId
        } else {
            const savedView = window.localStorage.startPageActiveView
            if (savedView === 'favorites') {
                this.favoritesOnly = true
            } else if (savedView === 'recent') {
                this.recentOnly = true
            }
        }
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
        delete window.localStorage.startPageActiveGroupId
        delete window.localStorage.startPageActiveView
    }

    showFavorites (): void {
        this.activeGroupId = null
        this.recentOnly = false
        this.favoritesOnly = true
        window.localStorage.startPageActiveView = 'favorites'
        delete window.localStorage.startPageActiveGroupId
    }

    showRecentHosts (): void {
        this.activeGroupId = null
        this.favoritesOnly = false
        this.recentOnly = true
        window.localStorage.startPageActiveView = 'recent'
        delete window.localStorage.startPageActiveGroupId
    }

    selectGroupView (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.activeGroupId = group.id
        this.favoritesOnly = false
        this.recentOnly = false
        window.localStorage.startPageActiveGroupId = group.id ?? ''
        delete window.localStorage.startPageActiveView
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
        if (group.editable) {
            return true
        }
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

    onGroupContextMenu (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.showGroupContextMenu(event, group)
    }

    private showGroupContextMenu (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        event.preventDefault()
        event.stopPropagation()
        this.showCustomContextMenu(this.buildGroupContextMenu(group), event)
    }

    private showCustomContextMenu (items: MenuItemOptions[], event: MouseEvent): void {
        const margin = 8
        this.contextMenuItems = items
        this.contextMenuSelectedIndex = this.findNextContextMenuItem(-1, 1)
        this.contextMenuReturnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
        this.contextMenuX = Math.max(margin, Math.min(event.clientX, window.innerWidth - margin))
        this.contextMenuY = Math.max(margin, Math.min(event.clientY, window.innerHeight - margin))
        this.contextMenuVisible = true
        setTimeout(() => this.focusAndConstrainContextMenu())
    }

    closeContextMenu (restoreFocus = true): void {
        if (!this.contextMenuVisible) {
            return
        }
        this.contextMenuVisible = false
        this.contextMenuSelectedIndex = -1
        const returnFocus = this.contextMenuReturnFocus
        this.contextMenuReturnFocus = null
        if (restoreFocus) {
            setTimeout(() => returnFocus?.focus())
        }
    }

    onContextMenuItemClick (item: MenuItemOptions): void {
        if (item.type === 'separator' || item.enabled === false) { return }
        this.closeContextMenu(false)
        item.click?.()
    }

    onContextMenuItemMouseEnter (index: number): void {
        if (this.isContextMenuItemActionable(this.contextMenuItems[index])) {
            this.contextMenuSelectedIndex = index
        }
    }

    onContextMenuKeyDown (event: KeyboardEvent): void {
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault()
                event.stopPropagation()
                this.contextMenuSelectedIndex = this.findNextContextMenuItem(this.contextMenuSelectedIndex, 1)
                break
            case 'ArrowUp':
                event.preventDefault()
                event.stopPropagation()
                this.contextMenuSelectedIndex = this.findNextContextMenuItem(this.contextMenuSelectedIndex, -1)
                break
            case 'Home':
                event.preventDefault()
                event.stopPropagation()
                this.contextMenuSelectedIndex = this.findNextContextMenuItem(-1, 1)
                break
            case 'End':
                event.preventDefault()
                event.stopPropagation()
                this.contextMenuSelectedIndex = this.findNextContextMenuItem(0, -1)
                break
            case 'Enter':
            case ' ':
                event.preventDefault()
                event.stopPropagation()
                if (this.contextMenuSelectedIndex >= 0) {
                    this.onContextMenuItemClick(this.contextMenuItems[this.contextMenuSelectedIndex])
                }
                break
            case 'Escape':
                event.preventDefault()
                event.stopPropagation()
                this.closeContextMenu()
                break
            case 'Tab':
                this.closeContextMenu(false)
                break
        }
    }

    private focusAndConstrainContextMenu (): void {
        if (!this.contextMenuVisible) {
            return
        }
        const menu = this.contextMenuElement?.nativeElement
        if (!menu) {
            return
        }
        const margin = 8
        const maxX = Math.max(margin, window.innerWidth - menu.offsetWidth - margin)
        const maxY = Math.max(margin, window.innerHeight - menu.offsetHeight - margin)
        this.contextMenuX = Math.max(margin, Math.min(this.contextMenuX, maxX))
        this.contextMenuY = Math.max(margin, Math.min(this.contextMenuY, maxY))
        menu.focus()
    }

    private findNextContextMenuItem (start: number, direction: 1 | -1): number {
        const count = this.contextMenuItems.length
        for (let step = 1; step <= count; step++) {
            const index = (start + direction * step + count) % count
            if (this.isContextMenuItemActionable(this.contextMenuItems[index])) {
                return index
            }
        }
        return -1
    }

    private isContextMenuItemActionable (item: MenuItemOptions | undefined): boolean {
        return !!item && item.type !== 'separator' && item.enabled !== false
    }

    private buildGroupContextMenu (group: PartialProfileGroup<CollapsableProfileGroup>): MenuItemOptions[] {
        const profiles = this.getGroupSSHProfiles(group)
        return [
            {
                label: `连接 (${profiles.length})`,
                enabled: profiles.length > 0,
                click: () => {
                    void this.connectGroupSSHProfiles(group)
                },
            },
            { type: 'separator' },
            {
                label: '新增主机',
                click: () => {
                    void this.addProfileToGroup(group)
                },
            },
            {
                label: '新增组',
                click: () => {
                    void this.addSubGroup(group)
                },
            },
            { type: 'separator' },
            {
                label: '重命名',
                click: () => {
                    void this.renameGroup(group)
                },
            },
            {
                label: '删除组',
                click: () => {
                    void this.deleteGroup(group)
                },
            },
        ]
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
            detail: this.buildGroupConnectDetail(profiles),
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

    private async addProfileToGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        if (!this.profileEditor) {
            this.openSettingsProfiles()
            return
        }

        let base = await this.selector.show<PartialProfile<Profile>>(
            '选择一个基础配置作为模板',
            (await this.profilesService.getProfiles())
                .filter(p => !(p.id && this.config.store.profileBlacklist?.includes(p.id)))
                .map(p => ({
                    icon: p.icon ?? undefined,
                    description: this.profilesService.getDescription(p) ?? undefined,
                    name: p.group ? `${this.profilesService.resolveProfileGroupName(p.group)} / ${p.name}` : p.name,
                    group: p.isTemplate ? '模板' : '复制已有配置',
                    result: p,
                    weight: p.isTemplate ? 0 : 1,
                })),
        ).catch(() => undefined)
        if (!base) {
            return
        }

        const result = await this.profileEditor.newProfile(base)
        if (!result) {
            return
        }

        result.group = group.id

        if (!result.name) {
            const provider = this.profilesService.providerForProfile(result)
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = provider?.getSuggestedName?.(cfgProxy) ?? `${base.name} copy`
        }

        await this.profilesService.newProfile(result)
        await this.config.save()
        await this.refreshAll()
    }

    private async addSubGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = `在 "${group.name || 'Ungrouped'}" 下新增分组名称`
        const result = (await modal.result.catch(() => null)) as { value: string } | null
        if (!result?.value?.trim()) {
            return
        }

        const newGroup: PartialProfileGroup<ProfileGroup> = {
            id: '',
            name: result.value.trim(),
            parentGroupId: group.id,
            icon: group.icon,
        }

        await this.profilesService.newProfileGroup(newGroup)
        await this.config.save()
        await this.refreshAll()
    }

    private async renameGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = '重命名分组'
        modal.componentInstance.value = group.name || ''
        const result = (await modal.result.catch(() => null)) as { value: string } | null
        if (!result?.value?.trim() || result.value.trim() === group.name) {
            return
        }

        group.name = result.value.trim()
        await this.profilesService.writeProfileGroup(group)
        await this.config.save()
        await this.refreshAll()
    }

    onSidebarContextMenu (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.showCustomContextMenu([
            {
                label: '新建分组',
                click: () => {
                    void this.createRootGroup()
                },
            },
        ], event)
    }

    private async createRootGroup (): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = '新建分组名称'
        const result = (await modal.result.catch(() => null)) as { value: string } | null
        if (!result?.value?.trim()) {
            return
        }

        const newGroup: PartialProfileGroup<ProfileGroup> = {
            id: '',
            name: result.value.trim(),
            parentGroupId: undefined,
            icon: 'folder',
        }

        await this.profilesService.newProfileGroup(newGroup)
        await this.config.save()
        await this.refreshAll()
    }

    private async deleteGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const profiles = this.getGroupSSHProfiles(group)
        const childCount = this.countGroupsRecursive(group)

        if (profiles.length > 0) {
            const choice = await this.platform.showMessageBox({
                type: 'warning',
                message: `分组 "${group.name}" 包含 ${profiles.length} 台主机。`,
                detail: `选择"移动到未分组"将保留主机并删除分组；选择"同时删除"将连同主机一起删除。`,
                buttons: ['移动到未分组并删除', '同时删除所有主机', '取消'],
                defaultId: 0,
                cancelId: 2,
            })

            if (choice.response === 2) {
                return
            }

            await this.profilesService.deleteProfileGroup(group, { deleteProfiles: choice.response === 1 })
        } else {
            const choice = await this.platform.showMessageBox({
                type: 'warning',
                message: `确认删除分组 "${group.name}"？`,
                detail: childCount > 1 ? `该分组下还有 ${childCount - 1} 个子分组，子分组中的主机将移动到未分组。` : undefined,
                buttons: ['删除', '取消'],
                defaultId: 0,
                cancelId: 1,
            })

            if (choice.response === 1) {
                return
            }

            await this.profilesService.deleteProfileGroup(group)
        }

        await this.config.save()
        await this.refreshAll()
    }

    private countGroupsRecursive (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        let count = 1
        for (const child of group.children ?? []) {
            count += this.countGroupsRecursive(child)
        }
        return count
    }

    onProfileContextMenu (event: MouseEvent, profile: PartialProfile<Profile>): void {
        this.showProfileContextMenu(event, profile)
    }

    private showProfileContextMenu (event: MouseEvent, profile: PartialProfile<Profile>): void {
        event.preventDefault()
        event.stopPropagation()
        this.showCustomContextMenu(this.buildProfileContextMenu(profile), event)
    }

    private buildProfileContextMenu (profile: PartialProfile<Profile>): MenuItemOptions[] {
        return [
            {
                label: '连接',
                click: () => {
                    void this.launchProfile(profile)
                },
            },
            {
                label: '编辑',
                enabled: !profile.isBuiltin,
                click: () => {
                    void this.editProfile(profile)
                },
            },
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

    private async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        if (!this.profileEditor) {
            this.openSettingsProfiles()
            return
        }

        const result = await this.profileEditor.editProfile(profile)
        if (!result) {
            return
        }

        await this.profilesService.writeProfile(result)
        await this.config.save()
        await this.refreshAll()
    }

    private async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if (profile.isBuiltin) {
            return
        }

        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: `删除主机 "${profile.name}"？`,
            detail: this.buildDeleteConfirmDetail(profile),
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

    isRiskEnvironment (environment?: string | null): boolean {
        return (environment ?? '').toLowerCase().includes('prod')
    }

    isRecentProfile (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.recentProfileIds.has(profile.id)
    }

    getHostStatusRailClass (profile: PartialProfile<Profile>): string {
        if (this.isRiskEnvironment(profile.environment)) {
            return 'host-status-rail--risk'
        }
        if (profile.favorite) {
            return 'host-status-rail--favorite'
        }
        if (this.isRecentProfile(profile)) {
            return 'host-status-rail--recent'
        }
        if (profile.type === 'ssh') {
            return 'host-status-rail--signal'
        }
        return ''
    }

    private getProfileGroupLabel (profile: PartialProfile<Profile>): string {
        if (!profile.group) {
            return '未分组'
        }
        return this.profilesService.resolveProfileGroupPath(profile.group).join(' / ') || profile.group
    }

    private buildDeleteConfirmDetail (profile: PartialProfile<Profile>): string {
        const lines: string[] = []
        const info = this.getProfileConnectionInfo(profile)
        if (info?.host) {
            lines.push(`地址：${info.user ? `${info.user}@` : ''}${info.host}${info.port ? `:${info.port}` : ''}`)
        }
        lines.push(`分组：${this.getProfileGroupLabel(profile)}`)
        if (profile.environment) {
            lines.push(`环境：${profile.environment}`)
        }
        lines.push('此操作不可恢复。')
        return lines.join('\n')
    }

    private buildGroupConnectDetail (profiles: PartialProfile<Profile>[]): string {
        const preview = profiles.slice(0, 5).map(p => p.name).join('\n')
        if (profiles.length <= 5) {
            return preview
        }
        return `${preview}\n… 等 ${profiles.length} 台`
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
