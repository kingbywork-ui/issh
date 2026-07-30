/**
 * Nav group keys for the settings sidebar.
 * Providers without an explicit group fall back to 'other'.
 */
export type SettingsNavGroup = 'common' | 'appearance' | 'terminal' | 'ai' | 'system' | 'other'

/**
 * Extend to add your own settings tabs
 */
export abstract class SettingsTabProvider {
    id: string
    icon: string
    title: string
    weight = 0
    prioritized = false
    /** When true, the tab body fills the settings content area (e.g. host manager). */
    fullWidth = false
    /** Optional sidebar nav group. Defaults to 'other' when not set. */
    group?: SettingsNavGroup

    getComponentType (): any {
        return null
    }
}
