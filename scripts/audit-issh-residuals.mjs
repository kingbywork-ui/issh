import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const selfPath = 'scripts/audit-issh-residuals.mjs'
const ignoredDirectories = new Set([
    '.git',
    '.electron-builder-cache',
    '.electron-cache',
    '.issh-smoke',
    '.npm-cache',
    '.psacowork',
    '.tabby-smoke',
    '.workbuddy',
    'builtin-plugins',
    'dist',
    'node_modules',
    'test_screenshots',
])
const ignoredFiles = new Set([
    'HANDOFF.md',
    'ISSH_RENAME_SCHEDULE.md',
    'functional_regression_launch.log',
    'smoke_launch.log',
    'smoke_test_report.json',
])

function collectTextFiles (directory, relativeDirectory = '') {
    const result = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relativePath = path.posix.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name)) {
                result.push(...collectTextFiles(path.join(directory, entry.name), relativePath))
            }
            continue
        }
        if (!entry.isFile() || ignoredFiles.has(relativePath) || entry.name.endsWith('.lock') || entry.name === 'yarn.lock') {
            continue
        }
        const absolutePath = path.join(directory, entry.name)
        if (fs.statSync(absolutePath).size > 2 * 1024 * 1024) {
            continue
        }
        const content = fs.readFileSync(absolutePath)
        if (!content.includes(0)) {
            result.push({ relativePath, text: content.toString('utf8') })
        }
    }
    return result
}

function classifyResidual (relativePath, line) {
    if (relativePath === selfPath) {
        return 'audit-rule'
    }
    if (relativePath === 'SECURITY_REMEDIATION_2026-07-28.md') {
        return 'historical-record'
    }
    if (relativePath === 'LICENSE') {
        return 'legal-attribution'
    }
    if (/(?:^|\/)(?:test[^/]*|[^/]*\.test\.)/.test(relativePath) || ['smoke_helpers.py', 'smoke_test.py'].includes(relativePath)) {
        return 'compatibility-test'
    }
    if (/@tabby-gang\//i.test(line) || /tabby-(?:clickable-links|fig|plugin-fig-integration)/i.test(line)) {
        return 'third-party-name'
    }
    if (
        ['.all-contributorsrc', '.github/FUNDING.yml', 'locale/STOP.txt'].includes(relativePath)
        || ['README.md', 'README.zh-CN.md'].includes(relativePath)
        || /(?:github\.com\/Eugeny\/tabby|api\.github\.com\/repos\/eugeny\/tabby\/releases|eugeny\.github\.io\/tabby|tabby\.sh\/go\/|github\.com\/Eugeny\/tabby-clippy)/i.test(line)
    ) {
        return 'upstream-attribution'
    }
    if (
        /TABBY_(?:[A-Z_]+|\$\{[^}]+\}|\*)/.test(line)
        || /tabby_(?:[a-z_]+|['"])/.test(line)
        || /tabby-(?:agent|mcp-server|plugin|builtin-plugin)/i.test(line)
        || /(?:\.tabby|tabby:\/\/|api\.tabby\.sh)/i.test(line)
        || /(?:Open Tabby here|Paste path into Tabby|LOCALAPPDATA\\tabby\\Update\.exe)/.test(line)
        || (relativePath === 'issh-agent/src/client.mjs' && /tabby/i.test(line))
        || (relativePath === 'issh-core/src/services/appPanel.service.ts' && /tabby\./i.test(line))
        || (relativePath === 'issh-agent/README.md' && /legacy Tabby/i.test(line))
        || (relativePath === 'scripts/i18n-extract.mjs' && /replaceAll\(['"]Tabby['"]/.test(line))
        || relativePath === '.gitignore'
    ) {
        return 'one-release-compatibility'
    }
    return null
}

const files = collectTextFiles(repositoryRoot)
const residuals = []
for (const file of files) {
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
        if (/tabby/i.test(line)) {
            residuals.push({
                category: classifyResidual(file.relativePath, line),
                line: index + 1,
                relativePath: file.relativePath,
                text: line.trim(),
            })
        }
    }
}

const unknownResiduals = residuals.filter(item => !item.category)
assert.deepEqual(unknownResiduals, [], `Unapproved tabby residuals:\n${JSON.stringify(unknownResiduals, null, 2)}`)

const allowedLegacyPaths = [
    'issh-agent/bin/tabby-agent.mjs',
    'issh-agent/bin/tabby-mcp-server.mjs',
]
const legacyNamedPaths = files.map(file => file.relativePath).filter(relativePath => /tabby/i.test(relativePath)).sort()
assert.deepEqual(legacyNamedPaths, allowedLegacyPaths, 'Unexpected active path containing tabby')

const forbiddenPatterns = [
    /tabby-[0-9]+\.[0-9]+\.[0-9]+-(?:setup|portable)/i,
    /tabby-llm/i,
    /Tabby\.exe/,
    /Tabby 会话/,
    /updaterCacheDirName:\s*tabby/i,
    /latest Tabby version/i,
    /FIREBASE_SERVICE_ACCOUNT_TABBY_DOCS/,
    /projectId:\s*tabby-docs/i,
]
for (const pattern of forbiddenPatterns) {
    const matches = files.filter(file => file.relativePath !== selfPath && pattern.test(file.text)).map(file => file.relativePath)
    assert.deepEqual(matches, [], `Forbidden residual ${pattern} found in ${matches.join(', ')}`)
}

const devUpdaterConfig = fs.readFileSync(path.join(repositoryRoot, 'app', 'dev-app-update.yml'), 'utf8')
assert.ok(devUpdaterConfig.includes('updaterCacheDirName: issh-updater'), 'Dev updater cache still uses the old product name')

const plugins = [
    'issh-core',
    'issh-settings',
    'issh-terminal',
    'issh-community-color-schemes',
    'issh-ssh',
    'issh-local',
    'issh-linkifier',
    'issh-auto-sudo-password',
    'issh-llm',
    'issh-serial',
]
for (const plugin of plugins) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, plugin, 'package.json'), 'utf8'))
    assert.equal(manifest.name, plugin, `${plugin} package name is stale`)
    assert.ok(manifest.keywords.includes('issh-builtin-plugin'), `${plugin} does not publish the issh builtin marker`)
    assert.ok(!manifest.keywords.includes('tabby-builtin-plugin'), `${plugin} still publishes the old builtin marker`)
}

const appManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
assert.equal(appManifest.name, 'issh')
const englishReadme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8')
const chineseReadme = fs.readFileSync(path.join(repositoryRoot, 'README.zh-CN.md'), 'utf8')
for (const readme of [englishReadme, chineseReadme]) {
    assert.ok(readme.includes(`issh-${appManifest.version}-setup-x64.exe`), 'README installer version does not match package.json')
}
const agents = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8')
assert.ok(agents.includes(`当前版本 \`${appManifest.version}\``), 'AGENTS.md version does not match package.json')

const categoryCounts = Object.fromEntries([...new Set(residuals.map(item => item.category))].sort().map(category => [
    category,
    residuals.filter(item => item.category === category).length,
]))
console.log(JSON.stringify({
    allowedLegacyPaths,
    categoryCounts,
    residualFiles: new Set(residuals.map(item => item.relativePath)).size,
    residualLines: residuals.length,
    scannedTextFiles: files.length,
}, null, 2))
console.log('ISSH residual allowlist audit passed')
