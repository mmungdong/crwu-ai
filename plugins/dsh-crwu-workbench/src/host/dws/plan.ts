/**
 * 钉钉结果回传的**纯计划逻辑**（无 IO、无 shell）。
 *
 * 它是技能里 `scripts/upload_audit_result.py` 业务契约的 TypeScript 移植：
 * 归档年月、安全化项目 ID、唯一远端文件名，以及从目录条目里读文件大小。
 * 移植它的理由只有一个 —— DSH 自动审核链路**不得**再让 Python 脚本用
 * `subprocess.run(["dws", ...])` 执行 `dws`；校验/计划这类纯函数留在同一处，
 * 由 `dingtalk.ts` 用 `ctx.shell` 完成外部编排。
 *
 * 契约（逐条对应 `references/13-dingtalk-result-publish.md`）：
 * - 归档年月取 `auditTask.auditTime`（带时区 ISO 8601，必须是**业务时间**而不是上传时钟）；
 * - 远端文件名的时间戳取 `fileTrace.generatedAt`，格式化成 `YYYYMMDD-HHmmssffffff`，
 *   使同一份最终结果的名字可复现；
 * - 项目 ID 里不适用于文件名的字符替换为 `_`，**不改写 JSON 内容**。
 */

export interface PublishPlan {
  /** `auditTask.auditTime` 的年份（4 位）。 */
  year: string
  /** `auditTask.auditTime` 的零补齐月份。 */
  month: string
  /** 唯一远端文件名：`审核结果.<安全化项目ID>.<时间戳>.json`。 */
  remoteName: string
}

export interface PlanError {
  ok: false
  error: string
}

export type PlanResult = { ok: true; plan: PublishPlan } | PlanError

interface ParsedStamp {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
  /** 微秒，零补齐到 6 位（Python `%f` 的等价物）。 */
  micros: string
}

/**
 * ISO 8601 解析器，语义对齐 Python 的 `datetime.fromisoformat` + 时区强制。
 *
 * 为什么不用 `Date.parse`：它会**悄悄**补上本地时区并把亚毫秒精度丢掉，
 * 而这里两件事都必须在契约上严格 —— 缺时区要报错（实测报错文案是
 * 「auditTask.auditTime 必须包含时区」），微秒要保留（否则文件名不可复现）。
 */
const ISO_STAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|z|[+-]\d{2}:?\d{2})$/
/** 形状对、但**没有时区**的那一刻：单独判出来才能给出可自查的报错。 */
const ISO_STAMP_NO_ZONE = /^(\d{4})-(\d{2})-(\d{2})([Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/

export function parseIsoStamp(value: unknown, field: string): ParsedStamp | PlanError {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return { ok: false, error: `${field} 不得为空` }
  const match = ISO_STAMP.exec(raw)
  if (match === null) {
    // 区分「格式坏」与「缺时区」两种原因 —— 后者是实测踩到的那一个，报错必须能直接自查。
    if (ISO_STAMP_NO_ZONE.test(raw)) return { ok: false, error: `${field} 必须包含时区：${raw}` }
    return { ok: false, error: `${field} 不是带时区的 ISO 8601 时间：${raw}` }
  }
  const [, year, month, day, hour, minute, second, fraction] = match
  return {
    year: year ?? '',
    month: month ?? '',
    day: day ?? '',
    hour: hour ?? '',
    minute: minute ?? '',
    second: second ?? '00',
    micros: (fraction ?? '').padEnd(6, '0').slice(0, 6),
  }
}

/** 项目 ID → 安全文件名片段；替换 `\ / : * ? " < > |` 与控制字符，去掉首尾点与空格。 */
export function safeProjectId(value: unknown): string | PlanError {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return { ok: false, error: 'auditTask.projectId 不得为空' }
  const normalized = raw.normalize('NFKC')
  // eslint-disable-next-line no-control-regex
  const safe = normalized.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '')
  if (safe === '') return { ok: false, error: 'auditTask.projectId 无法生成安全文件名' }
  return safe
}

function isError(value: unknown): value is PlanError {
  return value !== null && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}

const AUDIT_RESULT_FILENAME = (projectId: string, stamp: ParsedStamp): string =>
  `审核结果.${projectId}.${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}${stamp.second}${stamp.micros}.json`

/**
 * 从 AuditResult JSON 生成回传计划。
 *
 * 只读 `auditTask.auditTime` / `auditTask.projectId` / `fileTrace.generatedAt` 三个字段，
 * 其余内容一律不改写。
 */
export function buildPublishPlan(result: unknown): PlanResult {
  if (result === null || typeof result !== 'object') {
    return { ok: false, error: 'AuditResult 不是 JSON 对象' }
  }
  const doc = result as Record<string, unknown>
  const auditTask = doc.auditTask
  const fileTrace = doc.fileTrace
  if (auditTask === null || typeof auditTask !== 'object' || fileTrace === null || typeof fileTrace !== 'object') {
    return { ok: false, error: 'AuditResult 缺少 auditTask 或 fileTrace' }
  }
  const task = auditTask as Record<string, unknown>
  const trace = fileTrace as Record<string, unknown>

  const auditTime = parseIsoStamp(task.auditTime, 'auditTask.auditTime')
  if (isError(auditTime)) return auditTime
  const generatedAt = parseIsoStamp(trace.generatedAt, 'fileTrace.generatedAt')
  if (isError(generatedAt)) return generatedAt
  const projectId = safeProjectId(task.projectId)
  if (isError(projectId)) return projectId

  return {
    ok: true,
    plan: {
      year: auditTime.year,
      month: auditTime.month,
      remoteName: AUDIT_RESULT_FILENAME(projectId, generatedAt),
    },
  }
}

/**
 * 缺时区时的**精确**报错文案。
 *
 * 单独暴露一条判定，是因为技能与提示词里引用过实测报错原文
 * 「auditTask.auditTime 必须包含时区」；让文案只有一处来源，才不会两处漂移。
 */
export function stampHasTimezone(value: unknown): boolean {
  const raw = typeof value === 'string' ? value.trim() : ''
  return /(Z|z|[+-]\d{2}:?\d{2})$/.test(raw)
}

/** 从钉钉目录条目里读文件大小；读不到返回 null（调用方再走 `+inspect`）。 */
export function nodeSize(item: unknown): number | null {
  if (item === null || typeof item !== 'object') return null
  const doc = item as Record<string, unknown>
  for (const key of ['sizeBytes', 'size']) {
    const value = doc[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}
