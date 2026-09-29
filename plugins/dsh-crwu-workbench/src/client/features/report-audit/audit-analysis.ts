/**
 * 「AI 审核结果分析会话」（`audit_analysis`）的**纯逻辑**：命名、Context Snapshot、
 * 上下文包、以及 snapshot 的本地留存。
 *
 * 用户口径（2026-09-23）：
 * - 与报告列表的讨论**共用** `Report → Conversations` 这套体系，不建第二套聊天系统；
 *   区分来源靠**会话名**（本仓既有的"名字即映射"机制，`sessions.create` 不接受 metadata，
 *   所以不去改会话数据库）：`审核分析 · <流水号>` vs 报告列表那条 `报告讨论 · <流水号>`；
 * - 新建会话 = **Fresh Snapshot**：重新取最新原始资料 / AI 审核 HTML / JSON / 复核意见 / 报告元数据；
 * - 每个会话存一份 Context Snapshot，用来判断"这条历史会话是否已经过期"；
 * - **不修改历史审核产物**（AI Audit at T1 / Current Report at T2 / Analysis at T3 三者独立）。
 *
 * 为什么 snapshot 存在浏览器本地（localStorage）而不是会话数据库：DSH 的 `sessions.create`
 * 只接受 `{workspaceId, cwd}`，会话行（`SessionSummary`）只有 `updatedAt`、没有元数据字段；
 * 而用户明确说「不要为了这个字段重构整个会话数据库」。所以最小侵入的做法是：客户端按流水号存一份
 * 快照；**丢了也不致命** —— 退回用会话行的 `updatedAt` 与当前资料时间比较（同样真实，只是精度低）。
 */

import { asRecord, textOf } from './audit-summary.ts'
import { freshnessOf, type AuditContextSnapshot, type FreshnessStatus, type FreshnessVerdict, type VersionEvidence } from './audit-freshness.ts'
import { formatDateTime, stampValue } from './time.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { fetchRules, materialLines, type DiscussionFacts } from './assistant-context.ts'

/**
 * 一条资料的**远端来源**（用户 §10）。
 *
 * 只记远端标识：`provider` / `remoteId` / `remoteVersion` / `remoteUpdatedAt` / `digest` / `fetchedAt`。
 * **绝不记 localPath** —— 本地路径是内部实现细节，不能当业务来源，也不能当版本身份（用户 §11）。
 */
export interface SourceRef {
  /** 只有远端：本地文件系统不是业务来源。 */
  sourceType: 'remote'
  provider: 'h3yun' | 'oss'
  remoteId: string
  remoteVersion: string
  remoteUpdatedAt: string
  digest: string
  fetchedAt: string
}

/** 会话名前缀：**这是 `audit_analysis` 与 `report_discussion` 的唯一区分依据**。 */
export const AUDIT_ANALYSIS_PREFIX = '审核分析 · '

export function auditAnalysisTitle(seqNo: string, ordinal = 1): string {
  return ordinal <= 1 ? `${AUDIT_ANALYSIS_PREFIX}${seqNo}` : `${AUDIT_ANALYSIS_PREFIX}${seqNo} #${String(ordinal)}`
}

/** 这条报告的**全部分析会话**（前缀匹配 + `#N` 后缀，避免 `X-1` 命中 `X-10`）。 */
export function findAuditAnalyses<T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
): T[] {
  const base = auditAnalysisTitle(seqNo)
  return sessions.filter((item) => {
    const title = item.displayTitle ?? item.title ?? ''
    return title === base || title.startsWith(`${base} #`)
  })
}

export function nextAuditOrdinal<T extends { id: string; displayTitle?: string; title?: string }>(
  sessions: readonly T[],
  seqNo: string,
): number {
  return findAuditAnalyses(sessions, seqNo).length + 1
}

/** 审核产物版本的可追溯写法（schema + 渲染器；**不是**"重新生成过"的判据）。 */
function artifactVersionOf(info: Record<string, unknown>): string {
  const schema = textOf(info.schemaVersion)
  const renderer = textOf(asRecord(info.fileTrace).rendererVersion)
  return [schema, renderer].filter((part) => part !== '').join(' / ')
}

/** 人工复核意见里最晚的那个时间（`reviewFiles[].occurredAt` 的最大值；没有就空串）。 */
export function reviewUpdatedAtOf(info: Record<string, unknown>): string {
  const files = asRecord(info.reviewComparison).reviewFiles
  if (!Array.isArray(files)) return ''
  let best = ''
  let bestValue = Number.NEGATIVE_INFINITY
  for (const raw of files) {
    const at = textOf(asRecord(raw).occurredAt)
    const value = stampValue(at)
    if (value === null) continue
    if (value > bestValue) { bestValue = value; best = at }
  }
  return best
}

/**
 * 审核产物对象在 OSS 上的元数据（`ossutil ls` 长格式自带）。
 *
 * 取**审核结果 JSON**，没有就退回 HTML —— 它是"审核结果有没有重新生成过"的客观依据：
 * 同一个对象重新生成，ETag 一定变（`fileTrace.generatedAt` 是产物内部写的，理论上可能重复，
 * 而 ETag 是对象本身的指纹）。
 */
export function auditArtifactOf(cloud: { files?: Array<{ key?: unknown; etag?: unknown; lastModified?: unknown }>; jsonKey?: string; htmlKey?: string }): {
  etag: string
  lastModified: string
} {
  const files = Array.isArray(cloud.files) ? cloud.files : []
  const preferred = cloud.jsonKey !== undefined && cloud.jsonKey !== '' ? cloud.jsonKey : (cloud.htmlKey ?? '')
  const pick = files.find((file) => file.key === preferred)
    ?? files.find((file) => typeof file.etag === 'string' && file.etag !== '')
  return { etag: textOf(pick?.etag), lastModified: textOf(pick?.lastModified) }
}

/**
 * 报告侧资料的**远端标识**（用户 §11：快照里不要用本地路径当身份）。
 *
 * 由「氚云附件 fileId + 云端对象 key」排序聚合而成 —— 全部是远端标识：
 * 远端那边换了附件 / 换了交付件，这个标识就变；本地有没有下载过、下载到哪，与它无关。
 */
export function reportRemoteIdOf(pulled: {
  h3yun?: Array<{ fileId?: unknown; name?: unknown }>
  oss?: Array<{ key?: unknown }>
} | null): string {
  const h3yun = (Array.isArray(pulled?.h3yun) ? pulled.h3yun : [])
    .map((file) => `h3yun:${textOf(file.fileId)}`)
  const oss = (Array.isArray(pulled?.oss) ? pulled.oss : [])
    .map((file) => `oss:${textOf(file.key)}`)
  const ids = [...h3yun, ...oss].filter((id) => id !== 'h3yun:' && id !== 'oss:').sort()
  return ids.length === 0 ? '' : hashOf(ids.join('\n'))
}

/** 审核产物的远端标识：它的 OSS 对象 key（排序后取指纹，避免把完整 key 写得到处都是）。 */
export function auditRemoteIdOf(cloud: { htmlKey?: string; jsonKey?: string }): string {
  const keys = [textOf(cloud.htmlKey), textOf(cloud.jsonKey)].filter((key) => key !== '').sort()
  return keys.length === 0 ? '' : hashOf(keys.join('\n'))
}

/** 远端资料的来源清单（进上下文与快照；一处组装，避免两边各写一份）。 */
export function sourcesOf(input: {
  pulled: { h3yun?: Array<{ field?: unknown; fileId?: unknown; name?: unknown; size?: unknown }>; oss?: Array<{ key?: unknown; name?: unknown; size?: unknown; lastModified?: unknown; etag?: unknown }> } | null
  cloud: { htmlKey?: string; jsonKey?: string }
  info: Record<string, unknown>
  fetchedAt: string
}): SourceRef[] {
  const refs: SourceRef[] = []
  for (const file of input.pulled?.h3yun ?? []) {
    const id = textOf(file.fileId)
    if (id === '') continue
    refs.push({
      sourceType: 'remote', provider: 'h3yun', remoteId: id,
      remoteVersion: textOf(file.name), remoteUpdatedAt: '', digest: '',
      fetchedAt: input.fetchedAt,
    })
  }
  for (const file of input.pulled?.oss ?? []) {
    const key = textOf(file.key)
    if (key === '') continue
    refs.push({
      sourceType: 'remote', provider: 'oss', remoteId: key,
      remoteVersion: textOf(file.name), remoteUpdatedAt: textOf(file.lastModified),
      digest: textOf(file.etag), fetchedAt: input.fetchedAt,
    })
  }
  // 审核产物：远端标识 = OSS 对象 key；摘要里的 sourceDigest 是引擎给的源指纹。
  const trace = asRecord(input.info.fileTrace)
  for (const key of [textOf(input.cloud.htmlKey), textOf(input.cloud.jsonKey)]) {
    if (key === '') continue
    refs.push({
      sourceType: 'remote', provider: 'oss', remoteId: key, remoteVersion: '',
      remoteUpdatedAt: '', digest: textOf(trace.sourceDigest), fetchedAt: input.fetchedAt,
    })
  }
  return refs
}

/** djb2：只用来"比相等"，不是密码学摘要（指纹只在本机内部比较）。 */
export function hashOf(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

/** 审核产物的生成时间：优先 `fileTrace.generatedAt`，退回 `auditTask.auditTime`。 */
export function auditGeneratedAtOf(info: Record<string, unknown>): string {
  return textOf(asRecord(info.fileTrace).generatedAt) || textOf(info.auditTime)
}

/** 报告侧 / 审核侧的版本证据。**报告侧的 digest 目前没有权威来源**，通常是空串。 */
export function evidenceOf(input: {
  info: Record<string, unknown>
  reportUpdatedAt: string
  reportDigest?: string
  /** 审核产物对象的 ETag（`ossutil ls` 长格式）。 */
  auditEtag?: string
  /** 审核产物对象的最后写入时间。 */
  auditLastModified?: string
}): VersionEvidence {
  const info = input.info
  return {
    reportDigest: input.reportDigest ?? '',
    auditSourceDigest: textOf(asRecord(info.fileTrace).sourceDigest),
    reportVersion: '',
    auditSourceVersion: '',
    reportEtag: '',
    // 审核产物对象的 ETag：只有**同源**的两侧才能比 —— 报告侧目前没有 OSS 对象，所以这里
    // 只填审核侧；它的价值在"与上次快照比"（见 `changesSince`），不在这次的初次判定。
    auditSourceEtag: input.auditEtag ?? '',
    reportModifiedAt: '',
    auditModifiedAt: input.auditLastModified ?? '',
    reportUpdatedAt: input.reportUpdatedAt,
    auditGeneratedAt: auditGeneratedAtOf(info),
  }
}

/** 组装一份 Context Snapshot（新建会话时保存；判"历史会话是否过期"用它）。 */
export function snapshotOf(input: {
  seqNo: string
  info: Record<string, unknown>
  reportUpdatedAt: string
  reportDigest?: string
  /** 报告资料的远端标识（`reportRemoteIdOf(reportFiles)`）。 */
  reportRemoteId?: string
  /** 审核产物的远端标识（`auditRemoteIdOf(cloud)`）。 */
  auditRemoteId?: string
  /** 审核产物对象元数据（`auditArtifactOf(cloud)`）。 */
  auditEtag?: string
  auditLastModified?: string
  /** 本次远端获取时刻。 */
  fetchedAt?: string
  createdAt: string
}): AuditContextSnapshot {
  const verdict = freshnessOf(evidenceOf(input))
  return {
    reportSerialNumber: input.seqNo,
    reportUpdatedAt: input.reportUpdatedAt,
    reportDigest: input.reportDigest ?? '',
    reportRemoteId: input.reportRemoteId ?? '',
    auditGeneratedAt: auditGeneratedAtOf(input.info),
    auditSourceDigest: textOf(asRecord(input.info.fileTrace).sourceDigest),
    auditRemoteId: input.auditRemoteId ?? '',
    fetchedAt: input.fetchedAt ?? '',
    auditEtag: input.auditEtag ?? '',
    auditLastModified: input.auditLastModified ?? '',
    auditArtifactVersion: artifactVersionOf(input.info),
    reviewUpdatedAt: reviewUpdatedAtOf(input.info),
    conversationCreatedAt: input.createdAt,
    contextStatus: verdict.status,
  }
}

// ── snapshot 的本地留存（丢了大不了退化到会话 updatedAt）────────────────────────

const SNAPSHOT_PREFIX = 'crwu.audit-analysis.'

type StorageLike = {
  getItem?: (key: string) => string | null
  setItem?: (key: string, value: string) => void
}

function storage(): StorageLike | undefined {
  return (globalThis as { localStorage?: StorageLike }).localStorage
}

export function loadSnapshot(seqNo: string): AuditContextSnapshot | null {
  const store = storage()
  if (typeof store?.getItem !== 'function' || seqNo === '') return null
  try {
    const raw = store.getItem(SNAPSHOT_PREFIX + seqNo)
    if (typeof raw !== 'string' || raw === '') return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    // 逐字段收窄：本地存储是**不可信输入**（可能被手改 / 是旧版本写的）。
    return {
      reportSerialNumber: textOf(record.reportSerialNumber),
      reportUpdatedAt: textOf(record.reportUpdatedAt),
      reportDigest: textOf(record.reportDigest),
      reportRemoteId: textOf(record.reportRemoteId),
      auditGeneratedAt: textOf(record.auditGeneratedAt),
      auditSourceDigest: textOf(record.auditSourceDigest),
      auditRemoteId: textOf(record.auditRemoteId),
      fetchedAt: textOf(record.fetchedAt),
      auditEtag: textOf(record.auditEtag),
      auditLastModified: textOf(record.auditLastModified),
      auditArtifactVersion: textOf(record.auditArtifactVersion),
      reviewUpdatedAt: textOf(record.reviewUpdatedAt),
      conversationCreatedAt: textOf(record.conversationCreatedAt),
      contextStatus: contextStatusOf(record.contextStatus),
    }
  } catch (cause: unknown) {
    // 本地存储不可用（隐私模式 / 配额满 / 内容损坏）：当作"没有快照"，不打断会话创建。
    void cause
    return null
  }
}

function contextStatusOf(value: unknown): FreshnessStatus {
  const raw = textOf(value)
  if (raw === 'current' || raw === 'possibly_stale' || raw === 'stale') return raw
  return 'unknown'
}

export function saveSnapshot(snapshot: AuditContextSnapshot): void {
  const store = storage()
  if (typeof store?.setItem !== 'function' || snapshot.reportSerialNumber === '') return
  try {
    store.setItem(SNAPSHOT_PREFIX + snapshot.reportSerialNumber, JSON.stringify(snapshot))
  } catch (cause: unknown) {
    // 写不进去不是错误：下次打开退化成"没有快照"（时间关系判断仍然可用）。
    void cause
  }
}

// ── 上下文包（首轮注入；**不改历史审核产物**）──────────────────────────────────

export interface AuditAnalysisContext {
  /**
   * 本次会话的案例目录（`<工作空间>/<流水号>`）。
   *
   * 与报告讨论走**同一段**取数规则（`fetchRules`）：只允许在这一个目录里读本次下载的材料，
   * 不许扫描本机目录。空串时整段不写。
   */
  caseDir: string
  seqNo: string
  project: string
  reportUpdatedAt: string
  reportVersion: string
  auditGeneratedAt: string
  auditSourceDigest: string
  auditArtifactVersion: string
  reviewUpdatedAt: string
  /** 本次远端获取的时刻（Snapshot 与来源清单都记它）。 */
  fetchedAt: string
  /** 远端资料的来源清单（只有远端标识，**没有本地路径**）。 */
  sources: SourceRef[]
  /** 远端原始资料行（**只有氚云附件与云端交付件**，不含任何本地目录内容）。 */
  reportLines: string[]
  /** 可用审核产物的行（HTML / JSON），缺失的如实写进 `missing`。 */
  auditLines: string[]
  /** 人工复核意见行。 */
  reviewLines: string[]
  /** 本会话拿不到的项（如实说明，不伪装成完整分析）。 */
  missing: string[]
  verdict: FreshnessVerdict
}

function kv(label: string, value: string): string {
  return value.trim() === '' ? '' : `- ${label}：${formatDateTime(value)}`
}

function rawKv(label: string, value: string): string {
  return value.trim() === '' ? '' : `- ${label}：${value.trim()}`
}

/**
 * 首轮注入的上下文包。
 *
 * 结构照用户 §19/§21：System Instruction → Context Metadata（含版本状态）→ 原始资料 →
 * AI 审核报告 / 结构化结果 → 人工复核意见 → 缺失项。**不把文件正文拼进来**
 * （用户 §19：用 Harness 的附件 / 文件 / 工作空间上下文，不要把完整文件塞进 System Prompt；
 * 会话就建在案例根目录下，模型可以自己按路径回看原文）。
 */
export function buildAuditContextBlock(
  context: AuditAnalysisContext,
  /**
   * Host 登记的材料白名单（协议 23，来自 `discussion-material-open`）。
   *
   * 与报告讨论共用同一段 `fetchRules`（它要求按落盘名下载），所以这一段也必须给 ——
   * 否则分析会话读到"用下面给出的落盘名"却找不到"下面"。缺省（旧宿主 / 没登记）时整段不写。
   */
  materials?: DiscussionFacts['materials'],
): string {
  const meta = [
    rawKv(zhCN.auditCtxSeqNo, context.seqNo),
    rawKv(zhCN.auditCtxProject, context.project),
    kv(zhCN.auditCtxReportUpdatedAt, context.reportUpdatedAt),
    rawKv(zhCN.auditCtxReportVersion, context.reportVersion),
    kv(zhCN.auditCtxAuditGeneratedAt, context.auditGeneratedAt),
    kv(zhCN.auditCtxReviewUpdatedAt, context.reviewUpdatedAt),
    rawKv(zhCN.auditCtxAuditDigest, context.auditSourceDigest),
    rawKv(zhCN.auditCtxArtifactVersion, context.auditArtifactVersion),
    kv(zhCN.auditCtxFetchedAt, context.fetchedAt),
    rawKv(zhCN.auditCtxFreshness, freshnessSentence(context.verdict)),
  ].filter((row) => row !== '')

  const report = context.reportLines.length === 0 ? [zhCN.auditCtxNone] : context.reportLines.map((line) => `- ${line}`)
  const audit = context.auditLines.length === 0 ? [zhCN.auditCtxNone] : context.auditLines.map((line) => `- ${line}`)
  const review = context.reviewLines.length === 0 ? [zhCN.auditCtxReviewNone] : context.reviewLines.map((line) => `- ${line}`)
  const missing = context.missing.length === 0 ? [] : ['', `${zhCN.auditCtxMissingHead}：`, ...context.missing.map((line) => `- ${line}`)]
  // 来源清单：每条都写明"这是远端什么、远端标识是什么、什么时候取的、指纹是什么"。
  const sources = context.sources.length === 0 ? [zhCN.auditCtxNone] : context.sources.map((ref) => `- ${[
    ref.provider,
    rawKv(zhCN.auditCtxRemoteId, ref.remoteId).replace(/^- /, ''),
    ref.remoteVersion,
    ref.remoteUpdatedAt === '' ? '' : formatDateTime(ref.remoteUpdatedAt),
    ref.digest === '' ? '' : `digest ${ref.digest.slice(0, 16)}`,
  ].filter((part) => part !== '').join(' · ')}`)

  return [
    zhCN.aiAuditSystemPrompt.replace('【REPORT_SERIAL_NUMBER】', context.seqNo),
    '',
    `${zhCN.auditCtxHead}：`,
    ...meta,
    '',
    `${zhCN.auditCtxReportHead}（${String(context.reportLines.length)}）：`,
    ...report,
    '',
    `${zhCN.auditCtxAuditHead}（${String(context.auditLines.length)}）：`,
    ...audit,
    '',
    `${zhCN.auditCtxReviewHead}（${String(context.reviewLines.length)}）：`,
    ...review,
    '',
    `${zhCN.auditCtxSourceHead}（${String(context.sources.length)}）：`,
    ...sources,
    ...missing,
    ...materialLines(materials),
    ...fetchRules(context.caseDir),
  ].join('\n')
}

/** 版本关系的中文表述（给模型 / 给 Context Notice 用；**不出现英文枚举**）。 */
export function freshnessSentence(verdict: FreshnessVerdict): string {
  if (verdict.status === 'stale') {
    return zhCN.auditFreshStale.replace('{basis}', verdict.note)
  }
  if (verdict.status === 'possibly_stale') {
    return zhCN.auditFreshPossibly
  }
  if (verdict.status === 'current') {
    return zhCN.auditFreshCurrent
  }
  return zhCN.auditFreshUnknown
}

/** §21 的 Context Notice：从第一轮就让模型知道版本关系。 */
export function buildContextNotice(context: AuditAnalysisContext): string {
  const rows = [
    kv(zhCN.auditCtxReportUpdatedAt, context.reportUpdatedAt),
    kv(zhCN.auditCtxAuditGeneratedAt, context.auditGeneratedAt),
    kv(zhCN.auditCtxReviewUpdatedAt, context.reviewUpdatedAt),
    rawKv(zhCN.auditCtxFreshness, freshnessSentence(context.verdict)),
    ...context.missing.map((line) => `- ${line}`),
  ].filter((row) => row !== '')
  return [`${zhCN.auditCtxHead}：`, ...rows].join('\n')
}
