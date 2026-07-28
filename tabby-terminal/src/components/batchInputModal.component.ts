import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input, ViewChild, ElementRef, Injector } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { NotificationsService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { BatchInputTarget } from '../services/batchInput.service'

type BatchInputScope = 'current' | 'all' | 'selected'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './batchInputModal.component.pug',
    styleUrls: ['./batchInputModal.component.scss'],
})
export class BatchInputModalComponent {
    @Input() currentTab: BaseTerminalTabComponent<any>
    @Input() targets: BatchInputTarget[] = []
    @ViewChild('commandInput') commandInput?: ElementRef<HTMLTextAreaElement>

    command = ''
    appendNewline = true
    scope: BatchInputScope = 'current'
    selectedTargetIds = new Set<string>()

    constructor (
        public modalInstance: NgbActiveModal,
        private injector: Injector,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    ngOnInit (): void {
        const currentTarget = this.targets.find(x => x.tab === this.currentTab)
        if (currentTarget) {
            this.selectedTargetIds.add(currentTarget.id)
        }
    }

    ngAfterViewInit (): void {
        setTimeout(() => this.commandInput?.nativeElement.focus())
    }

    get selectedTargets (): BatchInputTarget[] {
        if (this.scope === 'current') {
            const current = this.targets.find(x => x.tab === this.currentTab)
            return current ? [current] : []
        }
        if (this.scope === 'all') {
            return this.targets
        }
        return this.targets.filter(x => this.selectedTargetIds.has(x.id))
    }

    get canSend (): boolean {
        return !!this.command.trim() && this.selectedTargets.length > 0
    }

    setScope (scope: BatchInputScope): void {
        this.scope = scope
        if (scope === 'current') {
            this.selectedTargetIds.clear()
            const current = this.targets.find(x => x.tab === this.currentTab)
            if (current) {
                this.selectedTargetIds.add(current.id)
            }
        } else if (scope === 'all') {
            this.selectedTargetIds = new Set(this.targets.map(x => x.id))
        }
    }

    toggleTarget (target: BatchInputTarget): void {
        if (this.selectedTargetIds.has(target.id)) {
            this.selectedTargetIds.delete(target.id)
        } else {
            this.selectedTargetIds.add(target.id)
        }
    }

    isSelected (target: BatchInputTarget): boolean {
        return this.selectedTargetIds.has(target.id)
    }

    private get batchInput (): any {
        // Lazy resolve via Injector to avoid circular dependency with BatchInputService
        const { BatchInputService } = require('../services/batchInput.service')
        return this.injector.get(BatchInputService)
    }

    send (): void {
        if (!this.command.trim()) {
            this.notifications.error(this.translate.instant('Command cannot be empty'))
            return
        }

        const targets = this.selectedTargets
        if (!targets.length) {
            this.notifications.error(this.translate.instant('Select at least one terminal tab'))
            return
        }

        const count = this.batchInput.send(targets.map(x => x.tab), this.command, this.appendNewline)
        this.notifications.notice(this.translate.instant('Sent to {count} tabs', { count }))
    }

    close (): void {
        this.modalInstance.close()
    }

    scopeLabel (scope: BatchInputScope): string {
        return {
            current: this.translate.instant(_('Current tab')),
            all: this.translate.instant(_('All tabs')),
            selected: this.translate.instant(_('Selected tabs')),
        }[scope]
    }
}
