// 审计日志（Agent Bridge）排序 / 检索逻辑回归测试
// 运行：node scripts/test-audit-log.mjs
// 直接以内存转译方式加载真实的 src/lib/auditLog.ts，避免复制逻辑导致测试失真。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/lib/auditLog.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText, 'utf8').toString('base64')}`
const { parseAuditEntries, filterAuditEntries } = await import(moduleUrl)

let failures = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        console.log(`  ok  ${name}`)
    } else {
        failures += 1
        console.error(`FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`)
    }
}

const jsonl = [
    '{"timestamp":"2026-09-23T10:00:00.000Z","method":"ssh.exec","ok":true,"params":{"cmd":"ls"}}',
    '{"timestamp":"2026-09-23T10:02:00.000Z","method":"sftp.write","ok":false,"errorCode":"EACCES","errorMessage":"permission denied","params":{"path":"/etc/passwd"},"approved":false,"approvedBy":"bridge"}',
    '{"timestamp":"2026-09-23T10:01:00.000Z","method":"session.list","ok":true}',
].join('\n')

console.log('时间序列倒序')
const entries = parseAuditEntries(jsonl)
check('记录条数', entries.length, 3)
check('最新记录在最上（方法顺序）', entries.map((e) => e.method), ['sftp.write', 'session.list', 'ssh.exec'])
check('时间单调不增', entries.every((e, i) => i === 0 || entries[i - 1].time >= e.time), true)
check('保留原始文件行号（稳定 key）', entries[0].index, 1)

console.log('边界与容错')
check('空文本返回空数组', parseAuditEntries(''), [])
check('仅空白行返回空数组', parseAuditEntries('\n\n  \n').length, 0)
const crlf = parseAuditEntries(jsonl.replace(/\n/g, '\r\n'))
check('CRLF 行尾可解析', crlf.length, 3)
const withRaw = parseAuditEntries([
    '{"timestamp":"2026-09-23T10:05:00.000Z","method":"ok.call","ok":true}',
    'not-json-line',
].join('\n'))
check('无法解析的行沉底', withRaw.map((e) => e.parsed), [true, false])
check('无法解析的行保留原文', withRaw[1].raw, 'not-json-line')
const noTime = parseAuditEntries([
    '{"timestamp":"2026-09-23T10:05:00.000Z","method":"with.time"}',
    '{"method":"no.time"}',
].join('\n'))
check('无有效时间戳沉底', noTime.map((e) => e.method), ['with.time', 'no.time'])

console.log('日志检索')
check('命中方法名', filterAuditEntries(entries, 'sftp').map((e) => e.method), ['sftp.write'])
check('命中错误码（大小写无关）', filterAuditEntries(entries, 'eacces').length, 1)
check('命中参数内容', filterAuditEntries(entries, '/etc/passwd').length, 1)
check('命中错误信息', filterAuditEntries(entries, 'permission').length, 1)
check('命中审批人', filterAuditEntries(entries, 'bridge').length, 1)
check('命中时间前缀', filterAuditEntries(entries, '2026-09-23T10:00').map((e) => e.method), ['ssh.exec'])
check('空关键词返回全部', filterAuditEntries(entries, '   ').length, 3)
check('无命中返回空', filterAuditEntries(entries, 'zzz-not-found').length, 0)
check('检索结果保持倒序', filterAuditEntries(entries, '2026-09-23').map((e) => e.method), ['sftp.write', 'session.list', 'ssh.exec'])
check('检索命中无法解析的行', filterAuditEntries(withRaw, 'not-json').length, 1)

if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
}
console.log('\n审计日志排序 / 检索逻辑回归测试全部通过')
