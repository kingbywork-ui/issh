import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'
import { HostAppService, Platform, TranslateService } from 'tabby-core'

import { ShellProvider, Shell } from 'tabby-local'

/** @hidden */
@Injectable()
export class MacOSDefaultShellProvider extends ShellProvider {
    private cachedShell?: string

    constructor (
        private hostApp: HostAppService,
        private translate: TranslateService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.macOS) {
            return []
        }
        return [{
            id: 'default',
            name: this.translate.instant('OS default'),
            command: await this.getDefaultShellCached(),
            args: ['--login'],
            hidden: true,
            env: {},
            shellType: 'unix',
        }]
    }

    private async getDefaultShellCached () {
        if (!this.cachedShell) {
            this.cachedShell = await this.getDefaultShell()
        }
        return this.cachedShell
    }

    private async getDefaultShell (): Promise<string> {
        return ipcRenderer.invoke('get-default-mac-shell') as Promise<string>
    }
}
