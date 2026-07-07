import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core'
import { AutocompleteSuggestion } from '../api'
import { TabLLMController } from '../tabLLMController'

/** @hidden */
@Component({
    selector: 'llm-app-sidecar-host',
    templateUrl: './llmAppSidecarHost.component.pug',
    styleUrls: ['./llmAppSidecarHost.component.scss'],
})
export class LLMAppSidecarHostComponent implements OnDestroy {
    controller?: TabLLMController

    constructor (private cdr: ChangeDetectorRef) {}

    ngOnDestroy (): void {
        this.controller?.detachSidecarView(this)
    }

    bindController (controller: TabLLMController | undefined): void {
        this.controller?.detachSidecarView(this)
        this.controller = controller
        controller?.attachSidecarView(this, () => this.cdr.detectChanges())
        this.cdr.detectChanges()
    }

    onSidecarInput (text: string): void {
        if (this.controller) {
            this.controller.sidecarInput = text
        }
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
