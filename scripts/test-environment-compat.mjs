import assert from 'node:assert/strict'
import { getISSHEnvironmentVariable } from './environment.mjs'

const warnings = []
assert.equal(getISSHEnvironmentVariable('DEV', {
    ISSH_DEV: 'primary',
    TABBY_DEV: 'legacy',
}, message => warnings.push(message)), 'primary')
assert.deepEqual(warnings, [])

assert.equal(getISSHEnvironmentVariable('SKIP_PREPACKAGE', {
    TABBY_SKIP_PREPACKAGE: '1',
}, message => warnings.push(message)), '1')
assert.match(warnings[0], /TABBY_SKIP_PREPACKAGE.*ISSH_SKIP_PREPACKAGE/)

console.log('ISSH environment compatibility tests passed')
