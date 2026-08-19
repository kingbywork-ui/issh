import { Injectable, OnDestroy } from '@angular/core'
import { Context, Fiber } from 'cordis'

export type CordisRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface CordisRunSnapshot {
    id: string
    workspaceId: string
    taskIds: string[]
    status: CordisRunStatus
    startedAt: number
    completedAt: number | null
    error: string | null
}

interface CordisRunEntry extends CordisRunSnapshot {
    controller: AbortController
    fiber: Fiber
    finished: boolean
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class CordisOrchestratorService implements OnDestroy {
    private readonly context = new Context()
    private readonly runs = new Map<string, CordisRunEntry>()

    start (
        id: string,
        workspaceId: string,
        taskIds: string[],
        execute: (taskId: string, signal: AbortSignal) => Promise<void>,
        cancel: (taskId: string) => Promise<void>,
    ): CordisRunSnapshot {
        if (this.runs.has(id)) {
            throw new Error(`Cordis run already exists: ${id}`)
        }
        if (!taskIds.length) {
            throw new Error('Cordis run requires at least one task')
        }

        const controller = new AbortController()
        const entry = {
            id,
            workspaceId,
            taskIds: [...taskIds],
            status: 'running' as CordisRunStatus,
            startedAt: Date.now(),
            completedAt: null,
            error: null,
            controller,
            fiber: null as unknown as Fiber,
            finished: false,
        }
        const fiber = this.context.plugin(runContext => {
            runContext.effect(() => {
                void this.executeRun(entry, execute)
                return async () => {
                    controller.abort()
                    if (!entry.finished) {
                        await Promise.all(taskIds.map(taskId => cancel(taskId).catch(() => {})))
                    }
                }
            }, `issh-cordis-run:${id}`)
        })
        entry.fiber = fiber
        this.runs.set(id, entry)
        void fiber.await().catch(error => {
            this.failEntry(entry, error)
        })
        return this.snapshot(entry)
    }

    get (id: string): CordisRunSnapshot | null {
        const entry = this.runs.get(id)
        return entry ? this.snapshot(entry) : null
    }

    list (workspaceId?: string): CordisRunSnapshot[] {
        return [...this.runs.values()]
            .filter(entry => !workspaceId || entry.workspaceId === workspaceId)
            .map(entry => this.snapshot(entry))
            .sort((left, right) => right.startedAt - left.startedAt)
    }

    async cancel (id: string): Promise<CordisRunSnapshot> {
        const entry = this.runs.get(id)
        if (!entry) {
            throw new Error(`Cordis run not found: ${id}`)
        }
        if (entry.status === 'running') {
            entry.status = 'cancelled'
            entry.completedAt = Date.now()
            await entry.fiber.dispose()
        }
        return this.snapshot(entry)
    }

    health (): { active: boolean, activeRuns: number, retainedRuns: number, cordisFibers: number } {
        return {
            active: true,
            activeRuns: [...this.runs.values()].filter(entry => entry.status === 'running').length,
            retainedRuns: this.runs.size,
            cordisFibers: this.context.registry.size,
        }
    }

    ngOnDestroy (): void {
        for (const entry of this.runs.values()) {
            if (entry.status === 'running') {
                entry.status = 'cancelled'
                entry.completedAt = Date.now()
                void entry.fiber.dispose()
            }
        }
    }

    private async executeRun (
        entry: CordisRunEntry,
        execute: (taskId: string, signal: AbortSignal) => Promise<void>,
    ): Promise<void> {
        const errors = await Promise.all(entry.taskIds.map(async taskId => {
            try {
                await execute(taskId, entry.controller.signal)
                return null
            } catch (error) {
                return error instanceof Error ? error.message : String(error)
            }
        }))
        if (entry.status !== 'running') {
            return
        }
        const failures = errors.filter((error): error is string => !!error)
        entry.status = failures.length ? 'failed' : 'completed'
        entry.error = failures.length ? failures.join('; ') : null
        entry.completedAt = Date.now()
        entry.finished = true
        await entry.fiber.dispose()
    }

    private failEntry (entry: CordisRunEntry, error: unknown): void {
        if (entry.status !== 'running') {
            return
        }
        entry.status = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
        entry.completedAt = Date.now()
        entry.finished = true
    }

    private snapshot (entry: CordisRunEntry): CordisRunSnapshot {
        return {
            id: entry.id,
            workspaceId: entry.workspaceId,
            taskIds: [...entry.taskIds],
            status: entry.status,
            startedAt: entry.startedAt,
            completedAt: entry.completedAt,
            error: entry.error,
        }
    }
}
