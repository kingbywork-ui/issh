import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifestPath = new URL('../plugin.json', import.meta.url)
const sourcePath = new URL('../src/BridgeSettingsTab.svelte', import.meta.url)

test('Agent Hub connector only requests read-only status and open access', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const source = await readFile(sourcePath, 'utf8')
    assert.equal(manifest.version, '0.4.0')
    assert.equal(manifest.minAppVersion, '0.0.4')
    assert.deepEqual(manifest.permissions, ['agentHub:read', 'settings:tab'])
    assert.deepEqual(manifest.capabilities, ['ui.settings.register', 'agentHub.read'])
    assert.match(source, /agentHubStatus/)
    assert.match(source, /openAgentHub/)
    assert.doesNotMatch(source, /workspace\.|agent\.register|management\./)
})
