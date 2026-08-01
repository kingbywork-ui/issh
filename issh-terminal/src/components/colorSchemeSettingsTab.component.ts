import { Component } from '@angular/core'
import { ConfigService, PlatformService } from 'issh-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './colorSchemeSettingsTab.component.pug',
})
export class ColorSchemeSettingsTabComponent {
    defaultTab = 'dark'

    constructor (
        platform: PlatformService,
        public config: ConfigService,
    ) {
        this.defaultTab = platform.getTheme()
    }
}
