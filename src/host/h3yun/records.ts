import { text } from '../../shared/utils/value.ts'
import { H3YUN_FIELDS, SEQ_NO_FULL } from './consts.ts'
import { asArray, labelOf, pick } from './fields.ts'

/**
 * 氚云应答的解析。
 *
 * 氚云不同接口把行放在不同层：`payload`、`payload.data`、`data.returnData` / `data.rows` /
 * `data.items`。这里集中收口，避免每个调用点各写一遍 `if` 链 —— 漏一种的表现是「列表为空」，
 * 而不是报错，最难排查。
 */

/** 从应答里取出记录数组。 */
export function rowsFromEnvelope(payload: unknown): unknown[] {
  if (payload === null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const data = record.data !== undefined ? record.data : payload
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    const inner = data as Record<string, unknown>
    if (Array.isArray(inner.returnData)) return inner.returnData
    if (Array.isArray(inner.rows)) return inner.rows
    if (Array.isArray(inner.items)) return inner.items
  }
  return []
}

/** 从应答里取总数；取不到返回 0（界面显示「共 0 条」而不是 NaN）。 */
export function totalFromEnvelope(payload: unknown): number {
  if (payload === null || typeof payload !== 'object') return 0
  const data = (payload as Record<string, unknown>).data
  if (data === null || typeof data !== 'object') return 0
  const value = pick(data, ['dataCount', 'total', 'count'])
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 把用户输入的检索词变成氚云过滤表达式。
 *
 * `invalid` 模式很关键：检索词里含 `'` 或 `\` 时**不能**拼进表达式（会破坏氚云那边的语法，
 * 轻则报错重则注入），必须回一个明确的模式让界面提示用户改写。
 */
export function buildQueryFilter(query: unknown): { expr: string; mode: '' | 'equal' | 'contains' | 'invalid' } {
  const value = text(query).trim()
  if (value === '') return { expr: '', mode: '' }
  if (/['\\]/.test(value)) return { expr: '', mode: 'invalid' }
  if (SEQ_NO_FULL.test(value)) return { expr: `SeqNo Equal '${value}'`, mode: 'equal' }
  return { expr: `SeqNo Contains '${value}'`, mode: 'contains' }
}

export interface H3yunTask {
  name: string
  project: string
  business: string
  risk: string
  reviewLevel: string
  reviewState: string
  currentNode: string
  seqNo: string
  status: string
  statusName: string
  modifiedAt: string
  id: string
  idTail: string
}

/** 一行氚云记录 → 面板要的字段。字段代码集中在 `consts.ts`。 */
export function rowToTask(row: unknown): H3yunTask {
  const record = row !== null && typeof row === 'object' ? row as Record<string, unknown> : {}
  const id = text(pick(record, ['ObjectId', 'objectId', 'Id', 'id']))
  return {
    name: text(pick(record, ['Name', 'name', 'Title'])) || '（无标题）',
    project: text(pick(record, [H3YUN_FIELDS.project])),
    business: text(pick(record, [H3YUN_FIELDS.business])),
    risk: text(pick(record, [H3YUN_FIELDS.risk])),
    reviewLevel: labelOf(pick(record, [H3YUN_FIELDS.reviewLevel])),
    reviewState: labelOf(pick(record, [H3YUN_FIELDS.reviewState])),
    currentNode: labelOf(pick(record, [H3YUN_FIELDS.currentNode])),
    seqNo: text(pick(record, ['SeqNo', 'seqNo'])),
    status: record.Status === undefined || record.Status === null ? '' : String(record.Status),
    statusName: text(pick(record, ['Status_Name', 'statusName'])),
    modifiedAt: text(pick(record, ['ModifiedTime', 'modifiedTime', 'CreatedTime', 'createdTime'])),
    id,
    idTail: id.length > 8 ? id.slice(-8) : id,
  }
}

/** 从对象存储 Key 里反推流水号（OSS 对象命名 `<prefix>/<流水号>/<文件名>`）。 */
export function seqNoFromKey(key: unknown, prefix: unknown): string {
  const normalizedPrefix = text(prefix).replace(/^\/+|\/+$/g, '')
  const raw = text(key)
  const parts = raw.split('/').filter(Boolean)
  if (normalizedPrefix !== '') {
    const relative = raw.startsWith(`${normalizedPrefix}/`) ? raw.slice(normalizedPrefix.length + 1) : ''
    const segments = relative.split('/').filter(Boolean)
    const candidate = segments[2]
    if (segments.length >= 3 && candidate !== undefined && /^\d{4}-\d+-/.test(candidate)) return candidate
  }
  for (const segment of parts) {
    if (/^\d{4}-\d+-/.test(segment)) return segment
  }
  return ''
}

/** 表单搜索结果里挑出目标表单。 */
export function pickForm(rows: unknown[], keyword: string): { code: string; name: string } | null {
  const isForm = (item: unknown): boolean => {
    if (item === null || typeof item !== 'object') return false
    const nodeType = text((item as Record<string, unknown>).nodeType)
    return nodeType === '200' || nodeType === '210'
  }
  const exact = rows.find((item) => text((item as Record<string, unknown>)?.displayName) === keyword && isForm(item))
  const form = exact ?? rows.find(isForm)
  if (form === undefined) return null
  const record = form as Record<string, unknown>
  return { code: text(record.code), name: text(record.displayName) }
}

export { asArray }
