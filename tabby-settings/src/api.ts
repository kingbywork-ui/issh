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

    getComponentType (): any {
        return null
    }
}
