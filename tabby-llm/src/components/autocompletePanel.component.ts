import {
    AfterViewChecked,
    Component,
    ElementRef,
    EventEmitter,
    HostBinding,
    Input,
    Output,
} from '@angular/core'
import { AutocompleteSuggestion } from '../api'

/** @hidden */
@Component({
    standalone: false,
    selector: 'autocomplete-panel',
    templateUrl: './autocompletePanel.component.pug',
    styleUrls: ['./autocompletePanel.component.scss'],
})
export class AutocompletePanelComponent implements AfterViewChecked {
    @Input() suggestions: AutocompleteSuggestion[] = []
    @Input() visible = false
    @Input() loading = false
    @Input() aiLoading = false
    @Input() position: { x: number, y: number } = { x: 0, y: 0 }
    @Input() maxHeight = 320
    @Input() selectedIndex = 0
    @Input() lightweight = false
    @Input() hintText = ''
    @Input() statusText = ''
    @Input() panelOpacity = 20

    @Output() selectSuggestion = new EventEmitter<AutocompleteSuggestion>()
    @Output() dismiss = new EventEmitter<void>()
    @Output() selectedIndexChange = new EventEmitter<number>()

    private lastScrolledIndex = -1

    constructor (private element: ElementRef<HTMLElement>) {}

    @HostBinding('class.visible') get isVisible (): boolean {
        return this.visible
    }

    @HostBinding('class.lightweight') get isLightweight (): boolean {
        return this.lightweight
    }

    @HostBinding('style.left.px') get left (): number {
        return this.position.x
    }

    @HostBinding('style.top.px') get top (): number {
        return this.position.y
    }

    @HostBinding('style.max-height.px') get constrainedMaxHeight (): number {
        return Math.max(0, this.maxHeight)
    }

    @HostBinding('style.background-color') get panelBackgroundColor (): string {
        const clamped = Math.max(5, Math.min(100, Math.round(this.panelOpacity)))
        return this.lightweight ? 'transparent' : `rgba(18, 20, 24, ${clamped / 100})`
    }

    @HostBinding('class.opaque') get isOpaque (): boolean {
        return this.panelOpacity >= 100
    }

    @HostBinding('class.low-alpha') get isLowAlpha (): boolean {
        return this.panelOpacity < 30
    }

    select (suggestion: AutocompleteSuggestion): void {
        this.selectSuggestion.emit(suggestion)
    }

    moveSelection (delta: number): void {
        if (!this.suggestions.length) {
            return
        }
        const next = Math.max(0, Math.min(this.suggestions.length - 1, this.selectedIndex + delta))
        if (next === this.selectedIndex) {
            return
        }
        this.selectedIndex = next
        this.selectedIndexChange.emit(next)
    }

    ngAfterViewChecked (): void {
        if (!this.visible) {
            return
        }
        this.constrainToHost()
        if (this.selectedIndex === this.lastScrolledIndex) {
            return
        }
        const selected = this.element.nativeElement.querySelector('.suggestion-item.selected')
        selected?.scrollIntoView({ block: 'nearest' })
        this.lastScrolledIndex = this.selectedIndex
    }

    private constrainToHost (): void {
        const host = this.element.nativeElement
        const parent = host.offsetParent as HTMLElement | null
        if (!parent) {
            return
        }
        const margin = 8
        const maxX = Math.max(margin, parent.clientWidth - host.offsetWidth - margin)
        const maxY = Math.max(margin, parent.clientHeight - host.offsetHeight - margin)
        const x = Math.max(margin, Math.min(this.position.x, maxX))
        const y = Math.max(margin, Math.min(this.position.y, maxY))
        host.style.left = `${x}px`
        host.style.top = `${y}px`
    }
}
