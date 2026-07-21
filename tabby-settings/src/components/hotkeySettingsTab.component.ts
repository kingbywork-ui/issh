/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, NgZone } from '@angular/core'
import {
    ConfigService,
    Hotkey,
    HotkeyDescription,
    HotkeysService,
    HostAppService,
} from 'tabby-core'

_('Search hotkeys')

/** @hidden */
@Component({
    selector: 'hotkey-settings-tab',
    templateUrl: './hotkeySettingsTab.component.pug',
})
export class HotkeySettingsTabComponent {
    hotkeyFilter = ''
    hotkeyDescriptions: HotkeyDescription[]
    allDuplicateHotkeys = this.getAllDuplicateHotkeys()

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        public zone: NgZone,
        hotkeys: HotkeysService,
    ) {
        hotkeys.getHotkeyDescriptions().then(descriptions => {
            this.hotkeyDescriptions = descriptions
        })
    }

    getHotkeys (id: string): Hotkey[] {
        let ptr: any = this.config.store.hotkeys
        for (const token of id.split(/\./g)) {
            // Nested ids like "settings-tab.ssh" must not throw when intermediate
            // keys are missing — a CD-time throw freezes ngbNav content switching.
            if (ptr == null || typeof ptr !== 'object') {
                return []
            }
            ptr = ptr[token]
        }
        if (!Array.isArray(ptr)) {
            return []
        }
        return ptr.map(hotkey => this.detectDuplicates(hotkey))
    }

    setHotkeys (id: string, hotkeys: Hotkey[]) {
        const tokens = id.split(/\./g)
        if (!this.config.store.hotkeys || typeof this.config.store.hotkeys !== 'object') {
            this.config.store.hotkeys = {}
        }
        let parent: any = this.config.store.hotkeys
        for (let i = 0; i < tokens.length - 1; i++) {
            const token = tokens[i]
            if (parent[token] == null || typeof parent[token] !== 'object' || Array.isArray(parent[token])) {
                parent[token] = {}
            }
            parent = parent[token]
        }
        parent[tokens[tokens.length - 1]] = hotkeys.map(hotkey =>
            hotkey.strokes.length === 1 && Array.isArray(hotkey.strokes)
                ? hotkey.strokes[0]
                : hotkey.strokes,
        )
        this.config.save()
        this.allDuplicateHotkeys = this.getAllDuplicateHotkeys()
    }

    hotkeyFilterFn (hotkey: HotkeyDescription, query: string): boolean {
        const s = hotkey.name + hotkey.id + this.getHotkeys(hotkey.id).map(h => h.strokes).toString()
        return s.toLowerCase().includes(query.toLowerCase())
    }

    private getAllDuplicateHotkeys (): string[] {
        const allHotkeys = Object
            .values(this.config.store.hotkeys)
            .filter((value: unknown) => Array.isArray(value))
            .flat()
            .map((hotkey: string | string[]) => this.toHotkeyIdentifier(hotkey))

        return allHotkeys.filter(hotkey => allHotkeys.indexOf(hotkey) !== allHotkeys.lastIndexOf(hotkey))
    }

    private detectDuplicates (strokes: string[] | string): Hotkey {
        const hotkeyIdentifier = this.toHotkeyIdentifier(strokes)
        const isDuplicate = this.allDuplicateHotkeys.includes(hotkeyIdentifier)
        return { strokes, isDuplicate }
    }

    private toHotkeyIdentifier (hotkey: string[] | string): string {
        return Array.isArray(hotkey) ? hotkey.join('$#!') : hotkey
    }
}
