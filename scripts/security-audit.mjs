#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function auditWorkspace (label, cwd) {
    const executable = process.platform === 'win32' ? process.env.ComSpec : 'corepack'
    const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'corepack.cmd yarn audit --json']
        : ['yarn', 'audit', '--json']
    const result = spawnSync(executable, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
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
                uniqueAdvisories.set(advisory.id, {
                    severity: advisory.severity,
                    module: advisory.module_name,
                    patchedVersions: advisory.patched_versions,
                })
            }
        } else if (entry.type === 'auditSummary') {
            rawCounts = entry.data?.vulnerabilities ?? null
        }
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
        remainingHighModules: [...highModules.values()]
            .map(item => ({
                module: item.module,
                advisories: item.advisories,
                patchedVersions: [...item.patchedVersions],
            }))
            .sort((a, b) => b.advisories - a.advisories || a.module.localeCompare(b.module)),
    }
}

const results = [
    auditWorkspace('root', repositoryRoot),
    auditWorkspace('app', path.join(repositoryRoot, 'app')),
]
console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Only dependency names, versions and lockfile metadata are sent to the configured npm audit registry.',
    results,
}, null, 2))
