import { Component, EventEmitter, HostBinding, Input, Output } from '@angular/core'

/** @hidden */
@Component({
    selector: 'nl2-command-panel',
    templateUrl: './nl2CommandPanel.component.pug',
    styleUrls: ['./nl2CommandPanel.component.scss'],
})
export class NL2CommandPanelComponent {
    @Input() visible = false
    @Input() loading = false
    @Input() inputText = ''
    @Input() resultCommand = ''
    @Input() resultExplanation = ''
    @Input() dangerous = false
    @Input() dangerReason = ''

    @Output() inputTextChange = new EventEmitter<string>()
    @Output() convert = new EventEmitter<void>()
    @Output() confirm = new EventEmitter<void>()
    @Output() insertOnly = new EventEmitter<void>()
    @Output() dismiss = new EventEmitter<void>()

    @HostBinding('class.visible') get isVisible () {
        return this.visible
    }

    onInput (value: string): void {
        this.inputText = value
        this.inputTextChange.emit(value)
    }
}
