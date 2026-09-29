export const GITHUB_REGISTRY = 'https://raw.githubusercontent.com/kingbywork-ui/issh-plugin-registry/main/index.json'
export const GITEE_REGISTRY = 'https://gitee.com/YangAlvin/issh-plugin-registry/raw/main/index.json'

const mainlandTimeZones = new Set([
    'Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Kashgar',
])

export function officialRegistryOrder (timeZone: string, locale: string): string[] {
    const inMainlandChina = timeZone
        ? mainlandTimeZones.has(timeZone)
        : /(?:^|[-_])CN(?:$|[-_])/i.test(locale)
    return inMainlandChina
        ? [GITEE_REGISTRY, GITHUB_REGISTRY]
        : [GITHUB_REGISTRY, GITEE_REGISTRY]
}

export function isOfficialRegistry (url: string): boolean {
    return url === GITHUB_REGISTRY || url === GITEE_REGISTRY
}

export function registryCandidates (url: string, timeZone: string, locale: string): string[] {
    return isOfficialRegistry(url) ? officialRegistryOrder(timeZone, locale) : [url]
}

export async function firstAvailableRegistry<T> (
    urls: string[], fetchRegistry: (url: string) => Promise<T>,
): Promise<{ url: string, registry: T }> {
    const failures: string[] = []
    for (const url of urls) {
        try {
            return { url, registry: await fetchRegistry(url) }
        } catch (cause) {
            failures.push(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
    }
    throw new Error(failures.join('；'))
}
