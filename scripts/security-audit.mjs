#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function wait (milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function auditWorkspace (label, cwd) {
    const executable = process.platform === 'win32' ? process.env.ComSpec : 'corepack'
    const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'corepack.cmd yarn audit --json']
        : ['yarn', 'audit', '--json']
    let result
    for (let attempt = 1; attempt <= 4; attempt++) {
        result = spawnSync(executable, args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        })
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        if (!output.includes('returned a 429') || attempt === 4) {
            break
        }
        wait(attempt * 2000)
    }
    if (result.error) {
        throw result.error
    }

    const uniqueAdvisories = new Map()
    let rawCounts = null
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim()) {
            continue
        }
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (entry.type === 'auditAdvisory') {
            const advisory = entry.data?.advisory
            if (advisory?.id && advisory?.severity) {
                const findings = (advisory.findings ?? [])
                    .flatMap(finding => finding.paths ?? [])
                const previous = uniqueAdvisories.get(advisory.id)
                uniqueAdvisories.set(advisory.id, {
                    id: advisory.id,
                    severity: advisory.severity,
                    module: advisory.module_name,
                    title: advisory.title,
                    url: advisory.url,
                    vulnerableVersions: advisory.vulnerable_versions,
                    patchedVersions: advisory.patched_versions,
                    paths: [...new Set([...(previous?.paths ?? []), ...findings])].sort(),
                })
            }
        } else if (entry.type === 'auditSummary') {
            rawCounts = entry.data?.vulnerabilities ?? null
        }
    }
    if (!rawCounts && result.status === 0) {
        rawCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
    }
    if (!rawCounts) {
        throw new Error(`${label}: npm audit did not return a summary (${result.stderr.trim()})`)
    }

    const uniqueCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
    const highModules = new Map()
    for (const advisory of uniqueAdvisories.values()) {
        const { severity } = advisory
        if (Object.prototype.hasOwnProperty.call(uniqueCounts, severity)) {
            uniqueCounts[severity]++
        }
        if (severity === 'high' || severity === 'critical') {
            const current = highModules.get(advisory.module) ?? { module: advisory.module, advisories: 0, patchedVersions: new Set() }
            current.advisories++
            current.patchedVersions.add(advisory.patchedVersions)
            highModules.set(advisory.module, current)
        }
    }

    return {
        workspace: label,
        lockfile: path.relative(repositoryRoot, path.join(cwd, 'yarn.lock')) || 'yarn.lock',
        auditExitCode: result.status,
        rawCounts,
        uniqueCounts: {
            ...uniqueCounts,
            total: uniqueAdvisories.size,
        },
        remainingAdvisories: [...uniqueAdvisories.values()]
            .sort((a, b) =>
                ['critical', 'high', 'moderate', 'low', 'info'].indexOf(a.severity) -
                ['critical', 'high', 'moderate', 'low', 'info'].indexOf(b.severity) ||
                a.module.localeCompare(b.module) ||
                a.id - b.id),
        remainingHighModules: [...highModules.values()]
            .map(item => ({
                module: item.module,
                advisories: item.advisories,
                patchedVersions: [...item.patchedVersions],
            }))
            .sort((a, b) => b.advisories - a.advisories || a.module.localeCompare(b.module)),
    }
}

const workspaceNames = [
    'app',
    'tabby-core',
    'tabby-settings',
    'tabby-terminal',
    'tabby-community-color-schemes',
    'tabby-ssh',
    'tabby-local',
    'tabby-electron',
    'tabby-linkifier',
    'tabby-auto-sudo-password',
    'tabby-llm',
]
const results = [auditWorkspace('root', repositoryRoot)]
for (const name of workspaceNames) {
    wait(1000)
    results.push(auditWorkspace(name, path.join(repositoryRoot, name)))
}
console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Only dependency names, versions and lockfile metadata are sent to the configured npm audit registry.',
    results,
}, null, 2))
