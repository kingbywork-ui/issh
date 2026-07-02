import { AfterViewChecked, Component, ElementRef, EventEmitter, HostBinding, Input, Output, ViewChild } from '@angular/core'
import { AutocompleteSuggestion, CommandDetail } from '../api'

export type CommandSidecarMode = 'rag' | 'ai'

/** @hidden */
@Component({
    selector: 'command-sidecar',
    templateUrl: './commandSidecar.component.pug',
    styleUrls: ['./commandSidecar.component.scss'],
})
export class CommandSidecarComponent implements AfterViewChecked {
    @Input() visible = false
    @Input() mode: CommandSidecarMode = 'rag'
    @Input() inputText = ''
    @Input() loading = false
    @Input() ragResults: AutocompleteSuggestion[] = []
    @Input() selectedIndex = 0
    @Input() commandDetail: CommandDetail | null = null
    @Input() errorText = ''
    @Input() aiCommand = ''
    @Input() aiExplanation = ''
    @Input() aiDangerous = false
    @Input() aiDangerReason = ''

    @Output() inputTextChange = new EventEmitter<string>()
    @Output() submitInput = new EventEmitter<void>()
    @Output() dismiss = new EventEmitter<void>()
    @Output() clear = new EventEmitter<void>()
    @Output() selectRagResult = new EventEmitter<AutocompleteSuggestion>()
    @Output() insertRagResult = new EventEmitter<AutocompleteSuggestion>()
    @Output() insertAIResult = new EventEmitter<void>()
    @Output() runAIResult = new EventEmitter<void>()
    @Output() moveNext = new EventEmitter<void>()
    @Output() movePrev = new EventEmitter<void>()
    @Output() insertCurrent = new EventEmitter<void>()

    @ViewChild('inputField') inputField?: ElementRef<HTMLInputElement>

    private wasVisible = false
    private lastScrolledIndex = -1

    constructor (private element: ElementRef<HTMLElement>) {}

    @HostBinding('class.visible') get isVisible (): boolean {
        return this.visible
    }

    ngAfterViewChecked (): void {
        if (this.visible && !this.wasVisible) {
            this.wasVisible = true
            setTimeout(() => this.inputField?.nativeElement.focus())
        }
        if (!this.visible) {
            this.wasVisible = false
            this.lastScrolledIndex = -1
        }
        if (this.visible && this.selectedIndex !== this.lastScrolledIndex) {
            const selected = this.element.nativeElement.querySelector('.result-item.selected')
            selected?.scrollIntoView({ block: 'nearest' })
            this.lastScrolledIndex = this.selectedIndex
        }
    }

    onInput (value: string): void {
        this.inputText = value
        this.inputTextChange.emit(value)
    }

    onKeydown (event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            this.dismiss.emit()
            return
        }

        if (event.ctrlKey && !event.altKey && !event.metaKey) {
            const key = event.key.toLowerCase()
            if (key === 'n') {
                event.preventDefault()
                event.stopPropagation()
                this.moveNext.emit()
                return
            }
            if (key === 'u') {
                event.preventDefault()
                event.stopPropagation()
                this.movePrev.emit()
                return
            }
            if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                this.insertCurrent.emit()
            }
        }
    }
}
