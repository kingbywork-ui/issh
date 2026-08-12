import { Component, HostBinding } from '@angular/core'
import { X11Socket } from '../session/x11'
import {
    ConfigService,
    HostAppService,
    Platform,
    WIN_BUILD_CONPTY_SUPPORTED,
    WIN_BUILD_CONPTY_STABLE,
    isWindowsBuild,
} from 'issh-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './sshSettingsTab.component.pug',
})
export class SSHSettingsTabComponent {
    Platform = Platform
    defaultX11Display: string
    isConPTYAvailable = false
    isConPTYStable = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
    ) {
        const spec = X11Socket.resolveDisplaySpec()
        if ('path' in spec) {
            this.defaultX11Display = spec.path
        } else {
            this.defaultX11Display = `${spec.host}:${spec.port}`
        }

        if (hostApp.platform === Platform.Windows) {
            this.isConPTYAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
            this.isConPTYStable = isWindowsBuild(WIN_BUILD_CONPTY_STABLE)
        }
    }
}
