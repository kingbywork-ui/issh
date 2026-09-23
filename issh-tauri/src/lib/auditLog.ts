// Agent Bridge 审计日志（agent-bridge-audit.jsonl）解析与检索的纯逻辑，
// 抽出为独立模块便于回归测试；UI 组件只负责渲染。

export interface AuditEntry {
    index: number
    parsed: true
    timestamp: string
    time: number
    method: string
    ok: boolean
    errorCode: string | null
    errorMessage: string | null
    params: unknown
    executed: boolean | null
    approved: boolean | null
    approvedBy: string | null
    reason: string | null
    searchText: string
}

export interface AuditRawEntry {
    index: number
    parsed: false
    raw: string
    time: number
    searchText: string
}

export type AuditLogEntry = AuditEntry | AuditRawEntry

function parseTime (value: unknown): number {
    if (typeof value !== 'string' || value.length === 0) return Number.NEGATIVE_INFINITY
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function toSearchText (value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : ''
}

/**
 * 解析 JSONL 审计文本，并按时间序列倒序返回：最新记录在最前。
 * 无有效时间戳或无法解析的行沉底；`Array.prototype.sort` 稳定，
 * 因此同时间戳的记录保持原始文件顺序。
 */
export function parseAuditEntries (auditText: string): AuditLogEntry[] {
    if (!auditText) return []
    const lines = auditText.split('\n').filter((line) => line.trim().length > 0)
    const entries = lines.map((line, index): AuditLogEntry => {
        try {
            const parsed = JSON.parse(line)
            const params = parsed.params ?? null
            const searchText = [
                toSearchText(parsed.timestamp),
                toSearchText(parsed.method),
                toSearchText(parsed.errorCode),
                toSearchText(parsed.errorMessage),
                toSearchText(parsed.approvedBy),
                toSearchText(parsed.reason),
                params ? JSON.stringify(params) : '',
            ]
                .filter((part) => part.length > 0)
                .join(' ')
                .toLowerCase()
            return {
                index,
                parsed: true,
                timestamp: toSearchText(parsed.timestamp),
                time: parseTime(parsed.timestamp),
                method: toSearchText(parsed.method),
                ok: parsed.ok === true,
                errorCode: parsed.errorCode ?? null,
                errorMessage: parsed.errorMessage ?? null,
                params,
                executed: parsed.executed ?? null,
                approved: parsed.approved ?? null,
                approvedBy: parsed.approvedBy ?? null,
                reason: parsed.reason ?? null,
                searchText,
            }
        } catch {
            return {
                index,
                parsed: false,
                raw: line,
                time: Number.NEGATIVE_INFINITY,
                searchText: line.toLowerCase(),
            }
        }
    })
    return entries.sort((a, b) => b.time - a.time)
}

/** 关键词检索（大小写无关），命中时间 / 方法 / 错误码 / 错误信息 / 审批人 / 原因 / 参数。 */
export function filterAuditEntries (entries: AuditLogEntry[], query: string): AuditLogEntry[] {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return entries
    return entries.filter((entry) => entry.searchText.includes(keyword))
}
