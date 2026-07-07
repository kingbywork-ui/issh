import { ChangeDetectorRef, Component, Input, OnDestroy } from '@angular/core'
import { AutocompleteSuggestion } from '../api'
import { TabLLMController } from '../tabLLMController'

/** @hidden */
@Component({
    selector: 'llm-terminal-host',
    templateUrl: './llmTerminalHost.component.pug',
    styleUrls: ['./llmTerminalHost.component.scss'],
})
export class LLMTerminalHostComponent implements OnDestroy {
    @Input() controller?: TabLLMController

    constructor (private cdr: ChangeDetectorRef) {}

    ngOnDestroy (): void {
        this.controller?.detachView(this)
    }

    bindController (controller: TabLLMController): void {
        this.controller = controller
        controller.attachView(this, () => this.cdr.markForCheck())
    }

    onSelectSuggestion (suggestion: AutocompleteSuggestion): void {
        this.controller?.acceptSuggestion(suggestion)
    }

    onAutocompleteDismiss (): void {
        this.controller?.hideAutocomplete()
    }

    onSelectedIndexChange (index: number): void {
        this.controller!.selectedIndex = index
    }
}
