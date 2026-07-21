import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { SSHSettingsTabComponent } from './components/sshSettingsTab.component'

/** @hidden */
@Injectable()
export class SSHSettingsTabProvider extends SettingsTabProvider {
    id = 'ssh'
    icon = 'globe'
    /** Merged Shell (ConPTY) + SSH connection options. */
    title = 'Shell & SSH'

    getComponentType (): any {
        return SSHSettingsTabComponent
    }
}
