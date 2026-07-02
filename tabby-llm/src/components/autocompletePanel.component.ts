import { AfterViewChecked, Component, ElementRef, EventEmitter, HostBinding, Input, Output } from '@angular/core'
import { AutocompleteSuggestion } from '../api'

/** @hidden */
@Component({
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
    @Input() selectedIndex = 0

    @Output() selectSuggestion = new EventEmitter<AutocompleteSuggestion>()
    @Output() dismiss = new EventEmitter<void>()
    @Output() selectedIndexChange = new EventEmitter<number>()

    private lastScrolledIndex = -1

    constructor (private element: ElementRef<HTMLElement>) {}

    @HostBinding('class.visible') get isVisible (): boolean {
        return this.visible
    }

    @HostBinding('style.left.px') get left (): number {
        return this.position.x
    }

    @HostBinding('style.top.px') get top (): number {
        return this.position.y
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
        if (!this.visible || this.selectedIndex === this.lastScrolledIndex) {
            return
        }
        const selected = this.element.nativeElement.querySelector('.suggestion-item.selected')
        selected?.scrollIntoView({ block: 'nearest' })
        this.lastScrolledIndex = this.selectedIndex
    }
}
