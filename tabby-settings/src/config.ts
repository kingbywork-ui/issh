import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class SettingsConfigProvider extends ConfigProvider {
    defaults = {
        configSync: {
            port: 8765,
            syncKey: null,
            bindAddress: '127.0.0.1',
            peerFingerprint: '',
            peerIP: '',
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                settings: ['⌘-,'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
    }
}
