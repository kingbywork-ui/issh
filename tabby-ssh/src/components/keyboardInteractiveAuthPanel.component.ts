import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, ChangeDetectionStrategy, OnInit, ChangeDetectorRef } from '@angular/core'
import { NotificationsService, TranslateService } from 'tabby-core'
import { KeyboardInteractivePrompt } from '../session/ssh'
import { SSHProfile } from '../api'
import { PasswordStorageService } from '../services/passwordStorage.service'

@Component({
    selector: 'keyboard-interactive-auth-panel',
    templateUrl: './keyboardInteractiveAuthPanel.component.pug',
    styleUrls: ['./keyboardInteractiveAuthPanel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyboardInteractiveAuthComponent implements OnInit {
    @Input() profile: SSHProfile
    @Input() prompt: KeyboardInteractivePrompt
    @Input() step = 0
    @Output() done = new EventEmitter()
    @ViewChild('input') input: ElementRef
    remember = false

    constructor (
        private passwordStorage: PasswordStorageService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private cdr: ChangeDetectorRef,
    ) {}

    async ngOnInit (): Promise<void> {
        const savedPassword = await this.passwordStorage.loadPassword(this.profile)
        if (savedPassword) {
            for (let i = 0; i < this.prompt.prompts.length; i++) {
                if (this.prompt.isAPasswordPrompt(i) && !this.prompt.responses[i]) {
                    this.prompt.responses[i] = savedPassword
                }
            }
            this.cdr.markForCheck()
        }
    }

    isPassword (): boolean {
        return this.prompt.isAPasswordPrompt(this.step)
    }

    shouldEcho (): boolean {
        return this.prompt.prompts[this.step].echo ?? false
    }

    previous (): void {
        if (this.step > 0) {
            this.step--
        }
        this.input.nativeElement.focus()
    }

    async next (): Promise<void> {
        if (this.isPassword() && this.remember) {
            try {
                await this.passwordStorage.savePassword(this.profile, this.prompt.responses[this.step])
            } catch (error) {
                this.notifications.error(this.translate.instant('Could not save password'), error instanceof Error ? error.message : String(error))
                return
            }
        }

        if (this.step === this.prompt.prompts.length - 1) {
            this.prompt.respond()
            this.done.emit()
            return
        }
        this.step++
        this.input.nativeElement.focus()
    }
}
