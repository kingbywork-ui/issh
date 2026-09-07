import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const component = await readFile(new URL('../src/BridgeSettingsTab.svelte', import.meta.url), 'utf8')
const rpc = await readFile(new URL('../src/bridgeRpc.ts', import.meta.url), 'utf8')
const manifest = await readFile(new URL('../plugin.json', import.meta.url), 'utf8')

test('marketplace bridge is a read-only status card', () => {
    assert.match(component, /管理服务器/)
    assert.match(component, /打开 Web 管理界面/)
    assert.match(component, /managementStatus/)
    assert.doesNotMatch(component, /workspace\.create|workspace\.bind|agent\.register|probeRemoteAgents/)
})

test('plugin RPC wrapper only exposes management status and open', () => {
    assert.match(rpc, /management\.status/)
    assert.match(rpc, /management\.open/)
    assert.doesNotMatch(rpc, /ssh\.execReadonly|session\.probeAgents|workspace\.create|agent\.register/)
})

test('manifest declares only management read permission', () => {
    const value = JSON.parse(manifest)
    assert.equal(value.version, '0.3.0')
    assert.deepEqual(value.permissions, ['management:read', 'settings:tab'])
    assert.deepEqual(value.capabilities, ['ui.settings.register', 'management.read'])
})
