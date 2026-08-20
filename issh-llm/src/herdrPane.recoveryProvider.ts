import { Injectable } from '@angular/core'
import { NewTabParameters, RecoveryToken, TabRecoveryProvider } from 'issh-core'
import { HerdrPaneTabComponent } from './components/herdrPaneTab.component'

/** @hidden */
@Injectable()
export class HerdrPaneRecoveryProvider extends TabRecoveryProvider<HerdrPaneTabComponent> {
    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'issh:herdr-pane-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<HerdrPaneTabComponent>> {
        return {
            type: HerdrPaneTabComponent,
            inputs: {
                profile: recoveryToken.profile,
                savedState: recoveryToken.savedState,
            },
        }
    }
}
