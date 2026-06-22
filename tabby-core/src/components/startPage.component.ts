import { Component } from '@angular/core'
import { HomeBaseService } from '../services/homeBase.service'
import { CommandService } from '../services/commands.service'
import { ProfilesService } from '../services/profiles.service'
import { Command, CommandLocation, PartialProfile, Profile } from '../api'

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
export class StartPageComponent {
    version: string
    commands: Command[] = []
    favoriteProfiles: PartialProfile<Profile>[] = []
    recentProfiles: PartialProfile<Profile>[] = []

    constructor (
        public homeBase: HomeBaseService,
        private profilesService: ProfilesService,
        commands: CommandService,
    ) {
        commands.getCommands({}).then(c => {
            this.commands = c.filter(x => x.locations?.includes(CommandLocation.StartPage))
        })

        this.refreshHostCards().catch(err => console.error('Could not load host cards', err))
    }

    getCommandIconClass (command: Command): string {
        if (command.id === 'core:profile-selector') {
            return 'fas fa-window-restore'
        }
        if (command.id?.startsWith('core:recent-profile-')) {
            return 'fas fa-history'
        }
        if (command.touchBarNSImage === 'NSTouchBarAddDetailTemplate') {
            return 'fas fa-plus'
        }
        if (command.touchBarNSImage === 'NSTouchBarComposeTemplate') {
            return 'fas fa-cog'
        }
        return this.getSafeIconClass(command.icon) ?? 'fas fa-circle'
    }

    private getSafeIconClass (icon?: string): string|null {
        if (!icon || !/^(fa[rsb]?|fas|far|fab)(\s+fa[-\w]+)*$/.test(icon)) {
            return null
        }
        return icon
    }

    async launchProfile (profile: PartialProfile<Profile>): Promise<void> {
        await this.profilesService.launchProfile(profile)
        await this.refreshHostCards()
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
    buttonsTrackBy (_, btn: Command): any {
        return btn.label + btn.icon
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    profilesTrackBy (_, profile: PartialProfile<Profile>): any {
        return profile.id ?? `${profile.type}:${profile.name}`
    }

    private async refreshHostCards (): Promise<void> {
        const profiles = await this.profilesService.getProfiles()
        const customProfiles = profiles.filter(profile => !profile.isBuiltin && !profile.isTemplate)
        const recentProfiles = this.profilesService.getRecentProfiles()
        const recentIds = new Set(recentProfiles.map(profile => profile.id).filter((id): id is string => !!id))

        this.favoriteProfiles = customProfiles
            .filter(profile => !!profile.favorite)
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .slice(0, 8)

        this.recentProfiles = customProfiles
            .filter(profile => !!profile.id && recentIds.has(profile.id))
            .sort((a, b) => {
                const aIndex = recentProfiles.findIndex(profile => profile.id === a.id)
                const bIndex = recentProfiles.findIndex(profile => profile.id === b.id)
                return aIndex - bIndex
            })
            .slice(0, 8)
    }
}
