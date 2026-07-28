import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

/** @hidden Shell settings merged into SSH tab; hidden from nav. */
@Injectable()
export class ShellSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-shell'
    icon = 'list-ul'
    title = '终端 Shell'

    getComponentType (): any {
        return null
    }
}
