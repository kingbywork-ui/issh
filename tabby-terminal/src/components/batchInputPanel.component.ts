import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, ElementRef, EventEmitter, Input, OnInit, AfterViewInit, Output, ViewChild } from '@angular/core'
import { NotificationsService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { BatchInputService, BatchInputTarget } from '../services/batchInput.service'

type BatchInputScope = 'current' | 'all' | 'selected'

/** @hidden */
@Component({
    selector: 'batch-input-panel',
    templateUrl: './batchInputPanel.component.pug',
    styleUrls: ['./batchInputPanel.component.scss'],
})
export class BatchInputPanelComponent implements OnInit, AfterViewInit {
    @Input() tab?: BaseTerminalTabComponent<any>
    @Output() closed = new EventEmitter<void>()
    @ViewChild('commandInput') commandInput?: ElementRef<HTMLTextAreaElement>

    command = ''
    appendNewline = true
    scope: BatchInputScope = 'current'
    selectedTargetIds = new Set<string>()
    targets: BatchInputTarget[] = []

    constructor (
        private batchInput: BatchInputService,
        private notifications: NotificationsService,
        public translate: TranslateService,
    ) { }

    ngOnInit (): void {
        this.refreshTargets()
    }

    ngAfterViewInit (): void {
        setTimeout(() => this.commandInput?.nativeElement.focus())
    }

    setCurrentTab (tab: BaseTerminalTabComponent<any>): void {
        this.tab = tab
        this.refreshTargets()
        if (this.scope === 'current') {
            this.selectCurrentTarget()
        }
    }

    refreshTargets (): void {
        this.targets = this.batchInput.getTargets()
        this.selectedTargetIds = new Set([...this.selectedTargetIds].filter(id => this.targets.some(target => target.id === id)))
        if (this.scope === 'current') {
            this.selectCurrentTarget()
        }
    }

    private selectCurrentTarget (): void {
        if (!this.tab) {
            return
        }
        const currentTarget = this.targets.find(x => x.tab === this.tab)
        if (currentTarget) {
            this.selectedTargetIds.add(currentTarget.id)
        }
    }

    get selectedTargets (): BatchInputTarget[] {
        if (this.scope === 'current') {
            const current = this.tab ? this.targets.find(x => x.tab === this.tab) : null
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
            const current = this.tab ? this.targets.find(x => x.tab === this.tab) : null
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
        this.command = ''
        setTimeout(() => this.commandInput?.nativeElement.focus())
    }

    collapse (): void {
        this.closed.emit()
    }

    scopeLabel (scope: BatchInputScope): string {
        return {
            current: this.translate.instant(_('Current tab')),
            all: this.translate.instant(_('All tabs')),
            selected: this.translate.instant(_('Selected tabs')),
        }[scope]
    }
}
