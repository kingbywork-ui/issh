import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'

export type AppPanelSlot = 'left' | 'right' | 'bottom'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class AppPanelService {
    leftVisible = false
    rightVisible = false
    bottomVisible = false

    readonly changed$ = new Subject<void>()
    readonly slotRegistered$ = new Subject<AppPanelSlot>()

    private slots: Record<AppPanelSlot, HTMLElement | null> = {
        left: null,
        right: null,
        bottom: null,
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

    notifyResize (): void {
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 50)
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 200)
    }
}
