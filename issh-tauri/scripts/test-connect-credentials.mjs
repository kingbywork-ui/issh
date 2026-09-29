import assert from 'node:assert/strict'
import { connectionCredentials, retryConnectionCredentials } from '../src/lib/connectCredentials.ts'

const base = { user: 'root', originalUser: 'root', storedPassword: 'old', storedKeyPassphrase: 'old-key', password: '', keyPassphrase: '', keyPath: '/id_ed25519', originalKeyPath: '/id_ed25519' }
assert.equal(connectionCredentials({ ...base, auth: 'password', password: 'new' }).password, 'new')
assert.equal(connectionCredentials({ ...base, auth: 'password', user: 'admin' }).password, '')
assert.deepEqual(connectionCredentials({ ...base, auth: 'publicKey', keyPassphrase: 'new-key' }), {
    useKey: true, password: '', keyPassphrase: 'new-key',
})
assert.equal(connectionCredentials({ ...base, auth: 'publicKey', keyPath: '/another-key' }).keyPassphrase, '')
assert.deepEqual(connectionCredentials({ ...base, auth: 'agent' }), {
    useKey: true, password: 'old', keyPassphrase: 'old-key',
})
const retry = { previous: { host: '10.0.0.17', port: 22, user: 'root', password: 'saved', keyPath: '/key', keyPassphrase: 'saved-key' }, host: '10.0.0.17', port: 22, user: 'root', keyPath: '/key', password: '', keyPassphrase: '' }
assert.deepEqual(retryConnectionCredentials(retry), {
    sameIdentity: true, sameKeyPath: true, password: 'saved', keyPassphrase: 'saved-key',
})
assert.equal(retryConnectionCredentials({ ...retry, host: '10.0.0.18' }).password, '')
assert.equal(retryConnectionCredentials({ ...retry, user: 'admin' }).password, '')
assert.equal(retryConnectionCredentials({ ...retry, keyPath: '/another-key' }).keyPassphrase, '')
assert.equal(retryConnectionCredentials({ ...retry, password: 'typed' }).password, 'typed')
console.log('connection credentials: manual override, identity and key scoped retry passed')
