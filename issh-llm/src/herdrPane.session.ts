import { Injector } from '@angular/core'
import { LogService } from 'issh-core'
import { BaseSession } from 'issh-terminal'
import { Subscription } from 'rxjs'
import { HerdrPaneOptions } from './herdrPane.api'
import { HerdrAdapterService } from './services/herdrAdapter.service'

interface HerdrPaneSessionStartOptions {
    columns: number
    rows: number
}

/** @hidden */
export class HerdrPaneSession extends BaseSession {
    private adapter: HerdrAdapterService
    private eventSubscription?: Subscription
    private commandChain: Promise<unknown> = Promise.resolve()
    private detached = false

    constructor (
        injector: Injector,
        private options: HerdrPaneOptions,
    ) {
        super(injector.get(LogService).create(`herdr-pane:${options.target}`))
        this.adapter = injector.get(HerdrAdapterService)
    }

    async start (options: HerdrPaneSessionStartOptions): Promise<void> {
        this.open = true
        this.eventSubscription = this.adapter.paneEventsFor(this.options.paneId).subscribe(event => {
            if (event.type === 'output' && event.data) {
                this.emitOutput(Buffer.from(event.data))
            } else if (event.state === 'error') {
                this.logger.error(`Herdr pane bridge failed: ${event.reason ?? 'unknown error'}`)
            } else if (event.state === 'reconnecting') {
                this.logger.warn(`Herdr pane bridge reconnecting: ${event.reason ?? 'stream closed'}`)
            }
        })
        const attach = this.adapter.attachPane(this.options, options.columns, options.rows)
        // Input and resize can arrive as soon as xterm becomes visible. Keep
        // those operations ordered behind the asynchronous pane attachment so
        // the first keystrokes are not rejected as "not attached".
        this.commandChain = attach
        try {
            await attach
        } catch (error) {
            this.eventSubscription.unsubscribe()
            this.eventSubscription = undefined
            const message = error instanceof Error ? error.message : String(error)
            this.logger.error(`Could not attach Herdr pane: ${message}`)
            this.emitOutput(Buffer.from(`\r\n\x1b[31mHerdr pane attach failed:\x1b[0m ${message}\r\n`))
        }
    }

    resize (columns: number, rows: number): void {
        if (!this.open || this.detached) {
            return
        }
        this.enqueue(() => this.adapter.resizePane(
            this.options.paneId,
            this.options.ownerId,
            columns,
            rows,
        ))
    }

    write (data: Buffer): void {
        if (!this.open || this.detached || !data.length) {
            return
        }
        this.enqueue(() => this.adapter.writePane(this.options.paneId, this.options.ownerId, data))
    }

    kill (): void {
        void this.detach()
    }

    async gracefullyKillProcess (): Promise<void> {
        await this.detach()
    }

    supportsWorkingDirectory (): boolean {
        return !!this.options.cwd
    }

    async getWorkingDirectory (): Promise<string|null> {
        return this.options.cwd
    }

    private enqueue (operation: () => Promise<unknown>): void {
        this.commandChain = this.commandChain
            .then(operation)
            .catch(error => {
                this.logger.error('Herdr pane command failed', error)
            })
    }

    private async detach (): Promise<void> {
        if (this.detached) {
            return
        }
        this.detached = true
        await this.commandChain.catch(() => undefined)
        await this.adapter.detachPane(this.options.paneId, this.options.ownerId).catch(error => {
            this.logger.warn('Could not detach Herdr pane controller', error)
        })
        this.eventSubscription?.unsubscribe()
        this.eventSubscription = undefined
    }
}
