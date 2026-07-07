import { AfterViewChecked, Component, ElementRef, EventEmitter, HostBinding, Input, Output, ViewChild } from '@angular/core'
import { AutocompleteSuggestion, CommandDetail } from '../api'

/** @hidden */
@Component({
    selector: 'command-sidecar',
    templateUrl: './commandSidecar.component.pug',
    styleUrls: ['./commandSidecar.component.scss'],
})
export class CommandSidecarComponent implements AfterViewChecked {
    @Input() visible = false
    @Input() inputText = ''
    @Input() loading = false
    @Input() ragResults: AutocompleteSuggestion[] = []
    @Input() selectedIndex = 0
    @Input() commandDetail: CommandDetail | null = null
    @Input() errorText = ''

    @Output() inputTextChange = new EventEmitter<string>()
    @Output() submitInput = new EventEmitter<void>()
    @Output() dismiss = new EventEmitter<void>()
    @Output() clear = new EventEmitter<void>()
    @Output() selectRagResult = new EventEmitter<AutocompleteSuggestion>()
    @Output() insertRagResult = new EventEmitter<AutocompleteSuggestion>()
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
            requestAnimationFrame(() => {
                setTimeout(() => {
                    this.inputField?.nativeElement.focus()
                    this.inputField?.nativeElement.click()
                }, 150)
            })
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
        event.stopPropagation()
        if (event.key === 'Escape') {
            event.preventDefault()
            this.dismiss.emit()
            return
        }

        if (event.ctrlKey && !event.altKey && !event.metaKey) {
            const key = event.key.toLowerCase()
            if (key === 'n') {
                event.preventDefault()
                this.moveNext.emit()
                return
            }
            if (key === 'u') {
                event.preventDefault()
                this.movePrev.emit()
                return
            }
            if (event.key === 'Enter') {
                event.preventDefault()
                this.insertCurrent.emit()
            }
        }
    }

    onMouseEvent (event: MouseEvent): void {
        event.stopPropagation()
    }

    onInputClick (event: MouseEvent): void {
        event.stopPropagation()
        const el = this.inputField?.nativeElement
        if (el) {
            el.focus()
            el.click()
        }
    }
}
