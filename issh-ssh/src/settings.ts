import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'issh-settings'

import { SSHSettingsTabComponent } from './components/sshSettingsTab.component'

/** @hidden */
@Injectable()
export class SSHSettingsTabProvider extends SettingsTabProvider {
    id = 'ssh'
    icon = 'globe'
    /** Merged Shell (ConPTY) + SSH connection options. */
    title = '终端与 SSH'
    group = 'terminal' as const

    getComponentType (): any {
        return SSHSettingsTabComponent
    }
}
