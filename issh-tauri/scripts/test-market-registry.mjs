import assert from 'node:assert/strict'
import {
    firstAvailableRegistry,
    GITEE_REGISTRY,
    GITHUB_REGISTRY,
    isOfficialRegistry,
    officialRegistryOrder,
    registryCandidates,
} from '../src/lib/marketRegistry.ts'

assert.deepEqual(officialRegistryOrder('Asia/Shanghai', 'en-US'), [GITEE_REGISTRY, GITHUB_REGISTRY])
assert.deepEqual(officialRegistryOrder('America/New_York', 'zh-CN'), [GITHUB_REGISTRY, GITEE_REGISTRY])
assert.deepEqual(officialRegistryOrder('', 'zh-CN'), [GITEE_REGISTRY, GITHUB_REGISTRY])
assert.equal(isOfficialRegistry(GITHUB_REGISTRY), true)
assert.equal(isOfficialRegistry('https://example.com/index.json'), false)
assert.deepEqual(registryCandidates(GITHUB_REGISTRY, 'Asia/Shanghai', 'en-US'), [GITEE_REGISTRY, GITHUB_REGISTRY])
assert.deepEqual(registryCandidates('https://example.com/index.json', 'Asia/Shanghai', 'zh-CN'), ['https://example.com/index.json'])

const requests = []
const primary = await firstAvailableRegistry([GITEE_REGISTRY, GITHUB_REGISTRY], async (url) => {
    requests.push(url)
    return { plugins: [1] }
})
assert.equal(primary.url, GITEE_REGISTRY)
assert.deepEqual(requests, [GITEE_REGISTRY])

requests.length = 0
const fallback = await firstAvailableRegistry([GITEE_REGISTRY, GITHUB_REGISTRY], async (url) => {
    requests.push(url)
    if (url === GITEE_REGISTRY) throw new Error('unavailable')
    return { plugins: [2] }
})
assert.equal(fallback.url, GITHUB_REGISTRY)
assert.deepEqual(requests, [GITEE_REGISTRY, GITHUB_REGISTRY])
await assert.rejects(
    firstAvailableRegistry([GITEE_REGISTRY, GITHUB_REGISTRY], async () => { throw new Error('offline') }),
    /gitee\.com.*offline.*githubusercontent\.com.*offline/,
)

console.log('Marketplace registry priority and fallback passed')
