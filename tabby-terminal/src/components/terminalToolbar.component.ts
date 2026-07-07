/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, HostListener, Input } from '@angular/core'
import { AppService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { BatchInputService } from '../services/batchInput.service'

/** @hidden */
@Component({
    selector: 'terminal-toolbar',
    templateUrl: './terminalToolbar.component.pug',
    styleUrls: ['./terminalToolbar.component.scss'],
})
export class TerminalToolbarComponent {
    @Input() tab: BaseTerminalTabComponent<any>

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        private app: AppService,
        private batchInput: BatchInputService,
    ) { }

    onTabDragStart (): void {
        this.app.emitTabDragStarted(this.tab)
    }

    onTabDragEnd (): void {
        setTimeout(() => {
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    get shouldShowDragHandle (): boolean {
        return this.tab.topmostParent instanceof SplitTabComponent && this.tab.topmostParent.getAllTabs().length > 1
    }

    openBatchInput (): void {
        const hasToggle = 'toggleSendPanel' in this.tab && typeof (this.tab as { toggleSendPanel?: () => void }).toggleSendPanel === 'function'
        if (hasToggle) {
            (this.tab as unknown as { toggleSendPanel: () => void }).toggleSendPanel()
            return
        }
        this.batchInput.open(this.tab)
    }

    @HostListener('mouseenter') onMouseEnter () {
        this.tab.showToolbar()
    }

    @HostListener('mouseleave') onMouseLeave () {
        this.tab.hideToolbar()
    }
}
