export const PRIMARY_PLUGIN_PREFIX = 'issh-'
export const LEGACY_PLUGIN_PREFIXES = ['tabby-', 'terminus-']
export const PLUGIN_PREFIXES = [PRIMARY_PLUGIN_PREFIX, ...LEGACY_PLUGIN_PREFIXES]

export const PRIMARY_PLUGIN_KEYWORDS = ['issh-plugin', 'issh-builtin-plugin']
export const LEGACY_PLUGIN_KEYWORDS = [
    'tabby-plugin',
    'tabby-builtin-plugin',
    'terminus-plugin',
    'terminus-builtin-plugin',
]
export const PLUGIN_KEYWORDS = [...PRIMARY_PLUGIN_KEYWORDS, ...LEGACY_PLUGIN_KEYWORDS]

export interface PluginCompatibility {
    supported: boolean
    legacy: boolean
}

export function isPluginPackageName (packageName: string): boolean {
    return PLUGIN_PREFIXES.some(prefix => packageName.startsWith(prefix))
}

export function getPluginName (packageName: string): string {
    const prefix = PLUGIN_PREFIXES.find(candidate => packageName.startsWith(candidate))
    return prefix ? packageName.substring(prefix.length) : packageName
}

export function classifyPluginPackage (packageName: string, keywords: unknown): PluginCompatibility {
    const packageKeywords = Array.isArray(keywords)
        ? keywords.filter((keyword): keyword is string => typeof keyword === 'string')
        : []
    const supported = isPluginPackageName(packageName)
        && PLUGIN_KEYWORDS.some(keyword => packageKeywords.includes(keyword))
    const legacy = LEGACY_PLUGIN_PREFIXES.some(prefix => packageName.startsWith(prefix))
        || LEGACY_PLUGIN_KEYWORDS.some(keyword => packageKeywords.includes(keyword))
    return { supported, legacy }
}
