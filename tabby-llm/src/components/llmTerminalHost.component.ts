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

    onNL2Input (text: string): void {
        this.controller!.nl2Input = text
    }

    onNL2Convert (): void {
        void this.controller?.convertNL2()
    }

    onNL2Confirm (): void {
        this.controller?.confirmNL2(true)
    }

    onNL2Insert (): void {
        this.controller?.confirmNL2(false)
    }

    onNL2Dismiss (): void {
        this.controller?.hideNL2()
    }

    onSidecarInput (text: string): void {
        this.controller!.sidecarInput = text
    }

    onSidecarSubmit (): void {
        void this.controller?.submitSidecarInput()
    }

    onSidecarDismiss (): void {
        this.controller?.hideSidecar()
    }

    onSidecarClear (): void {
        this.controller?.clearSidecar()
    }

    onSidecarSelectRagResult (suggestion: AutocompleteSuggestion): void {
        void this.controller?.selectSidecarRagResult(suggestion)
    }

    onSidecarInsertRagResult (suggestion: AutocompleteSuggestion): void {
        this.controller?.insertSidecarSuggestion(suggestion)
    }

    onSidecarInsertAIResult (): void {
        void this.controller?.insertSidecarAIResult(false)
    }

    onSidecarRunAIResult (): void {
        void this.controller?.insertSidecarAIResult(true)
    }

    onSidecarMoveNext (): void {
        this.controller?.moveSidecarSelection(1)
    }

    onSidecarMovePrev (): void {
        this.controller?.moveSidecarSelection(-1)
    }

    onSidecarInsertCurrent (): void {
        void this.controller?.insertCurrentSidecarResult(false)
    }
}
