import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ProfileEditorService, PartialProfile, Profile, ProfilesService } from 'tabby-core'
import { EditProfileModalComponent } from './components/editProfileModal.component'

@Injectable()
export class ProfileEditorServiceImpl extends ProfileEditorService {
    constructor (
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
    ) {
        super()
    }

    async editProfile (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile> | null> {
        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            return null
        }
        const modal = this.ngbModal.open(EditProfileModalComponent, { size: 'lg' })
        modal.componentInstance.partialProfile = JSON.parse(JSON.stringify(profile))
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }
        result.type = provider.id
        return result
    }

    async newProfile (base?: PartialProfile<Profile>): Promise<PartialProfile<Profile> | null> {
        if (!base) {
            return null
        }
        const provider = this.profilesService.providerForProfile(base)
        if (!provider) {
            return null
        }
        const baseProfile: PartialProfile<Profile> = JSON.parse(JSON.stringify(base))
        delete (baseProfile as any).id
        if (base.isTemplate) {
            baseProfile.name = ''
        }
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false
        const modal = this.ngbModal.open(EditProfileModalComponent, { size: 'lg' })
        modal.componentInstance.partialProfile = baseProfile
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }
        result.type = provider.id
        return result
    }
}
