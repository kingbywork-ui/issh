import { Component, EventEmitter, HostBinding, Input, Output } from '@angular/core'
import { AutocompleteSuggestion } from '../api'

/** @hidden */
@Component({
    selector: 'autocomplete-panel',
    templateUrl: './autocompletePanel.component.pug',
    styleUrls: ['./autocompletePanel.component.scss'],
})
export class AutocompletePanelComponent {
    @Input() suggestions: AutocompleteSuggestion[] = []
    @Input() visible = false
    @Input() loading = false
    @Input() position: { x: number, y: number } = { x: 0, y: 0 }
    @Input() selectedIndex = 0

    @Output() selectSuggestion = new EventEmitter<AutocompleteSuggestion>()
    @Output() dismiss = new EventEmitter<void>()
    @Output() selectedIndexChange = new EventEmitter<number>()

    @HostBinding('class.visible') get isVisible () {
        return this.visible
    }

    @HostBinding('style.left.px') get left () {
        return this.position.x
    }

    @HostBinding('style.top.px') get top () {
        return this.position.y
    }

    select (suggestion: AutocompleteSuggestion): void {
        this.selectSuggestion.emit(suggestion)
    }

    moveSelection (delta: number): void {
        if (!this.suggestions.length) {
            return
        }
        const next = (this.selectedIndex + delta + this.suggestions.length) % this.suggestions.length
        this.selectedIndex = next
        this.selectedIndexChange.emit(next)
    }
}
