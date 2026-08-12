import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'

export type AppPanelSlot = 'left' | 'right' | 'bottom'

const BOTTOM_HEIGHT_STORAGE_KEY = 'issh.appPanel.bottomHeightPx'
const LEGACY_BOTTOM_HEIGHT_STORAGE_KEY = 'tabby.appPanel.bottomHeightPx'
const BOTTOM_HEIGHT_DEFAULT = 180
const BOTTOM_HEIGHT_MIN = 96
const BOTTOM_HEIGHT_MAX_HARD = 480

/** @hidden */
@Injectable({ providedIn: 'root' })
export class AppPanelService {
    leftVisible = false
    rightVisible = false
    bottomVisible = false
    bottomHeightPx = BOTTOM_HEIGHT_DEFAULT

    readonly changed$ = new Subject<void>()
    readonly slotRegistered$ = new Subject<AppPanelSlot>()

    private slots: Record<AppPanelSlot, HTMLElement | null> = {
        left: null,
        right: null,
        bottom: null,
    }

    constructor () {
        this.bottomHeightPx = this.loadBottomHeight()
    }

    registerSlot (slot: AppPanelSlot, element: HTMLElement): void {
        this.slots[slot] = element
        this.slotRegistered$.next(slot)
    }

    getSlotElement (slot: AppPanelSlot): HTMLElement | null {
        if (this.slots[slot]) {
            return this.slots[slot]
        }
        const selector = slot === 'left'
            ? 'app-root .app-panel-left'
            : slot === 'right'
                ? 'app-root .app-panel-right'
                : 'app-root .app-panel-bottom'
        const element = document.querySelector(selector)
        if (element instanceof HTMLElement) {
            this.slots[slot] = element
            this.slotRegistered$.next(slot)
            return element
        }
        return null
    }

    setPanelVisible (slot: AppPanelSlot, visible: boolean): void {
        const key = slot === 'left' ? 'leftVisible' : slot === 'right' ? 'rightVisible' : 'bottomVisible'
        if (this[key] === visible) {
            return
        }
        this[key] = visible
        this.changed$.next()
        this.notifyResize()
    }

    /**
     * Set bottom Send panel height. Pass workspaceHeight to clamp against 70% of workspace.
     * When persist is false, only updates in-memory height for live drag feedback.
     */
    setBottomHeight (px: number, options: { workspaceHeight?: number, persist?: boolean, notify?: boolean } = {}): void {
        const persist = options.persist ?? true
        const notify = options.notify ?? true
        const next = this.clampBottomHeight(px, options.workspaceHeight)
        if (this.bottomHeightPx === next) {
            if (persist) {
                this.persistBottomHeight(next)
            }
            return
        }
        this.bottomHeightPx = next
        if (persist) {
            this.persistBottomHeight(next)
        }
        this.changed$.next()
        if (notify) {
            this.notifyResize()
        }
    }

    clampBottomHeight (px: number, workspaceHeight?: number): number {
        let max = BOTTOM_HEIGHT_MAX_HARD
        if (typeof workspaceHeight === 'number' && workspaceHeight > 0) {
            max = Math.min(BOTTOM_HEIGHT_MAX_HARD, Math.floor(workspaceHeight * 0.7))
        }
        max = Math.max(max, BOTTOM_HEIGHT_MIN)
        return Math.max(BOTTOM_HEIGHT_MIN, Math.min(max, Math.round(px)))
    }

    notifyResize (): void {
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 50)
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 200)
    }

    private loadBottomHeight (): number {
        try {
            let raw = localStorage.getItem(BOTTOM_HEIGHT_STORAGE_KEY)
            const isLegacy = !raw
            if (isLegacy) {
                raw = localStorage.getItem(LEGACY_BOTTOM_HEIGHT_STORAGE_KEY)
            }
            if (!raw) {
                return BOTTOM_HEIGHT_DEFAULT
            }
            const parsed = Number(raw)
            if (!Number.isFinite(parsed)) {
                return BOTTOM_HEIGHT_DEFAULT
            }
            const migrated = this.clampBottomHeight(parsed)
            if (isLegacy) {
                localStorage.setItem(BOTTOM_HEIGHT_STORAGE_KEY, String(migrated))
                localStorage.removeItem(LEGACY_BOTTOM_HEIGHT_STORAGE_KEY)
            }
            return migrated
        } catch {
            return BOTTOM_HEIGHT_DEFAULT
        }
    }

    private persistBottomHeight (px: number): void {
        try {
            localStorage.setItem(BOTTOM_HEIGHT_STORAGE_KEY, String(px))
        } catch {
            // ignore quota / private mode
        }
    }
}
