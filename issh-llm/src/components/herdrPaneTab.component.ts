import { Component, Injector } from '@angular/core'
import { BaseTabProcess, GetRecoveryTokenOptions } from 'issh-core'
import { BaseTerminalTabComponent } from 'issh-terminal'
import { HerdrPaneProfile } from '../herdrPane.api'
import { HerdrPaneSession } from '../herdrPane.session'

/** @hidden */
@Component({
    standalone: false,
    selector: 'herdr-pane-tab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class HerdrPaneTabComponent extends BaseTerminalTabComponent<HerdrPaneProfile> {
    session: HerdrPaneSession|null = null

    constructor (injector: Injector) {
        super(injector)
    }

    ngOnInit (): void {
        this.logger = this.log.create(`herdrPaneTab:${this.profile.options.target}`)
        super.ngOnInit()
    }

    protected onFrontendReady (): void {
        const session = new HerdrPaneSession(this.injector, this.profile.options)
        this.setSession(session)
        this.savedStateIsLive = true
        void session.start({
            columns: this.size.columns,
            rows: this.size.rows,
        })
        super.onFrontendReady()
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        return {
            type: 'issh:herdr-pane-tab',
            profile: this.profile,
            savedState: options?.includeState && this.frontend?.saveState(),
        }
    }

    async getCurrentProcess (): Promise<BaseTabProcess|null> {
        return this.session?.open ? { name: `Herdr: ${this.profile.options.title}` } : null
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        void this.session?.destroy()
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return false
    }
}
