import { PartialProfile, Profile } from './profileProvider'

export abstract class ProfileEditorService {
    abstract editProfile (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile> | null>
    abstract newProfile (base?: PartialProfile<Profile>): Promise<PartialProfile<Profile> | null>
}
