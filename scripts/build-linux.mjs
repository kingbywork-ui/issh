#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'
import { getISSHEnvironmentVariable } from './environment.mjs'
import { execFileSync } from 'child_process'
import { configureReleaseTarget } from './release-target.mjs'

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = (process.env.ARCH || process.arch) === 'arm' ? 'armv7l' : process.env.ARCH || process.arch
configureReleaseTarget(process.platform, process.env.ARCH)

if (getISSHEnvironmentVariable('SKIP_PREPACKAGE') !== '1') {
    console.log('Refreshing builtin plugins...')
    execFileSync(process.execPath, ['scripts/prepackage-plugins.mjs'], {
        cwd: new URL('..', import.meta.url),
        stdio: 'inherit',
    })
}

builder({
    dir: true,
    linux: ['tar.gz', 'appimage'],
    armv7l: process.env.ARCH === 'armv7l',
    arm64: process.env.ARCH === 'arm64',
    config: {
        npmRebuild: false,
        extraMetadata: {
            version: vars.version,
        },
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
    },
    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
