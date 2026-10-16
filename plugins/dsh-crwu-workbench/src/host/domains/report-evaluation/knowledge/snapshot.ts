import { createHash } from 'node:crypto'
import { text } from '../../../../shared/utils/value.ts'
import type { KnowledgeSourceKind, LookupAttempt } from '../../../../shared/contracts/valuation-project.ts'
import type { RouteState } from './route.ts'
import type { WikiLink } from './wiki-links.ts'

/**
 * 知识来源快照（设计稿 §6.1 / §6.2）。
 *
 * 它要回答一个能被核对的问题：**这一轮结果用的是哪一版知识、查过哪些位置**。
 *
 * 两条不许含糊的地方：
 *
 * 1. **`digest` 由正文/字节算出**，调用方给不了假值；`KnowledgeRef` 引用的是
 *    `snapshotDigest + sectionId/ruleId`，只有正文 hash 不足以证明"某条参数存在"。
 * 2. **落盘结构与 `schemas/knowledge-source.schema.json` 逐字一致**。那个 Schema 是
 *    **每路由一份**的记录（顶层 `routeId`，`entries[]` 里不再重复路由），所以内存里的
 *    聚合 manifest 用 `toKnowledgeSourceDocument()` 拆成逐路由文档再落盘。
 *
 * ⚠️ 这里**不记**签名 URL、库 id、组织标识、Cookie：那些是凭据面的事实，与"哪一版正文"无关。
 */

/** `sha256:<hex>`，与案例里其它指纹同形。 */
export function knowledgeDigest(content: string | Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content))
  return `sha256:${hash.digest('hex')}`
}

/** UTF-8 字节数（`body.length` 对中文是字符数，写进证据会误导）。 */
export function byteLength(body: string): number {
  return new TextEncoder().encode(body).length
}

/** 一条物化出来的知识来源（聚合 manifest 用；含 `routeId` 便于逐条核对）。 */
export interface KnowledgeManifestEntry {
  routeId: string
  /** 业务库里**实际**的节点名（不是 Skill 里的别名）。 */
  nodeName: string
  /** 库内完整路径（逐字）；镜像来源时是镜像内相对路径。 */
  resolvedPath: string
  source: KnowledgeSourceKind
  /** 正文 / 字节指纹。 */
  digest: string
  /** 落盘字节数（`body.length` 对中文是字符数，写进证据会误导）。 */
  sizeBytes: number
  /** 相对本方案 `知识快照/` 的落盘路径。 */
  snapshotFile: string
  mediaType: string
  updatedAt: string
  /**
   * 正文非空校验结果。
   *
   * 只有**校验通过**的正文才会成为一条 entry —— 空文档返回未支持，不会在这里留下一条
   * 看起来像规则的空记录。
   */
  bodyNonEmpty: boolean
  channel: LookupAttempt['channel']
  sectionIds: string[]
  ruleIds: string[]
  /**
   * 这份正文里出现的**库内链接**（设计稿 §4.2）。
   *
   * 它是 Agent"下一跳读哪一份"的依据：Wiki 用相对路径写导航，这里把每条 target 解析成
   * 库内完整路径，缺的、越界的、同名的分别如实标出来。它**不落进**知识来源文档 ——
   * 那是"这一轮用的是哪一版正文"的证据，链接从正文本身随时可再算一次。
   */
  links: WikiLink[]
  templateId: string | null
  templateContractVersion: string | null
  templateVerified: boolean | null
}

/** 一条路由的结论（缺哪一份、什么状态、落点在哪）。 */
export interface KnowledgeRouteOutcome {
  routeId: string
  state: RouteState
  nodeName: string
  source: string
  digest: string
  snapshotFile: string
  error: string
}

export type KnowledgeManifestErrorKind = 'input' | 'policy' | 'capability-gap' | 'infrastructure' | ''

/**
 * 一次 `materializeKnowledge` 的结果。
 *
 * 内存形状比落盘 Schema 宽（含 `routeIds` / `routes` / `expectedSpaceName` / `ok`），
 * 但**落盘用的逐路由文档**由 `toKnowledgeSourceDocument()` 收窄到 Schema，字段名逐字相同。
 */
export interface KnowledgeManifest {
  schemaVersion: 'crwu.valuation.knowledge-source.v1'
  projectId: string
  planId: string | null
  /** **实际**读到的空间名；读不到业务库时是现象（可能是审核库，也可能是空串）。 */
  spaceName: string
  /** 期望的业务库名（配置口径）。 */
  expectedSpaceName: string
  /** 实际空间身份是否经交叉验证通过。false 时不得据此继续。 */
  spaceVerified: boolean
  /**
   * 本轮据以取数的 manifest 正文指纹。
   *
   * 报告要能回答"这次用的是哪一版**取数口径**"，而不只是"哪一版正文" ——
   * manifest 是库侧可编辑文档、没有测试保护（设计稿 §8），指纹是它唯一的留痕。
   */
  manifestDigest: string
  /** manifest 在本次知识库读数里**声明了**的全部槽位（不只是本轮请求的）。 */
  availableRouteIds: string[]
  routeIds: string[]
  /**
   * 本轮按**Wiki 路径**请求的库内路径（协议 39 的主通道）。
   *
   * 与 `routeIds` 并存而不是替换：路由 id 里的 `wiki:` 前缀已经标明了来源，
   * 这一项让"这一轮到底按哪条通道取数"能被一眼核对（也进落盘索引）。
   */
  wikiPaths: string[]
  /** 取数过程中要如实说出来的事（通道迁移、manifest 不可读但继续按 Wiki 路径取…）。 */
  warnings: string[]
  entries: KnowledgeManifestEntry[]
  routes: KnowledgeRouteOutcome[]
  lookupAttempts: LookupAttempt[]
  /** 已成功落盘的索引文件（相对 `知识快照/`）。 */
  indexFiles: string[]
  materializedAt: string
  /** 只有来源是身份已验证镜像时才有值（绝对路径，**不进模型可见结果**）。 */
  mirrorRoot: string | null
  capabilityGaps: string[]
  ok: boolean
  error: string
  errorKind: KnowledgeManifestErrorKind
}

/**
 * 整份知识快照的指纹：按**路由 + 落点**排序后哈希。
 *
 * 于是同一批正文无论取数顺序如何都是同一个值；正文改了、或者同一路由换了节点，
 * 指纹都会变。`KnowledgeRef.snapshotDigest` 用的就是它。
 */
export function knowledgeSnapshotDigest(entries: readonly KnowledgeManifestEntry[]): string {
  const rows = [...entries]
    .sort((left, right) => {
      const leftKey = `${left.routeId}\u0000${left.snapshotFile}`
      const rightKey = `${right.routeId}\u0000${right.snapshotFile}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    .map((entry) => ({ routeId: entry.routeId, source: entry.source, digest: entry.digest }))
  return knowledgeDigest(JSON.stringify(rows))
}

/** 相对 `知识快照/` 的落盘路径：`<routeId>/<去掉路径分隔符的节点名>`。 */
export function knowledgeFileName(nodeName: string): string {
  return text(nodeName).replace(/[\\/:*?"<>|]+/g, '_').trim()
}

/**
 * 把聚合 manifest 收窄成**一条路由**的落盘文档。
 *
 * 字段名与 `schemas/knowledge-source.schema.json` 逐字相同，`additionalProperties: false`
 * 下不会多出 `channel` / `expectedSpaceName` / `routeIds` 这类内存字段。
 */
export function toKnowledgeSourceDocument(manifest: KnowledgeManifest, routeId: string): Record<string, unknown> {
  const entries = manifest.entries
    .filter((entry) => entry.routeId === routeId)
    .map((entry) => ({
      nodeName: entry.nodeName,
      resolvedPath: entry.resolvedPath,
      source: entry.source,
      digest: entry.digest,
      snapshotFile: entry.snapshotFile,
      bodyNonEmpty: entry.bodyNonEmpty,
      updatedAt: entry.updatedAt,
      // 可选字段只在**有内容**时落盘：空串 / 空数组 / null 不是证据，写进去只会让
      // "这条记录到底说了什么"变模糊。
      ...(entry.mediaType === '' ? {} : { mediaType: entry.mediaType }),
      ...(entry.sectionIds.length === 0 ? {} : { sectionIds: entry.sectionIds }),
      ...(entry.ruleIds.length === 0 ? {} : { ruleIds: entry.ruleIds }),
      ...(entry.templateId === null ? {} : { templateId: entry.templateId }),
      ...(entry.templateContractVersion === null ? {} : { templateContractVersion: entry.templateContractVersion }),
      ...(entry.templateVerified === null ? {} : { templateVerified: entry.templateVerified }),
    }))
  const lookupAttempts = manifest.lookupAttempts
    .filter((attempt) => attempt.routeId === routeId)
    .map((attempt) => ({
      channel: attempt.channel,
      target: attempt.target,
      outcome: attempt.outcome,
      detail: attempt.detail,
    }))
  return {
    schemaVersion: manifest.schemaVersion,
    projectId: manifest.projectId,
    planId: manifest.planId,
    spaceName: manifest.spaceName,
    spaceVerified: manifest.spaceVerified,
    routeId,
    ...(manifest.mirrorRoot === null ? {} : { mirrorRoot: manifest.mirrorRoot }),
    entries,
    lookupAttempts,
    materializedAt: manifest.materializedAt,
    ...(manifest.capabilityGaps.length === 0 ? {} : { capabilityGaps: manifest.capabilityGaps }),
  }
}

/** Aggregate schema tag written by the Host; parsed before any reuse. */
export const KNOWLEDGE_INDEX_SCHEMA = 'crwu.valuation.knowledge.v1'

/** A snapshot path is usable only when it stays inside the snapshot directory. */
export function safeSnapshotRelative(relativePath: string): boolean {
  const raw = text(relativePath).replace(/\\/g, '/')
  if (raw === '' || raw.startsWith('/') || raw.startsWith('~')) return false
  if (/^[a-zA-Z]:\//.test(raw)) return false
  return !raw.split('/').some((segment) => segment === '..' || segment === '.')
}

/** Cumulative aggregate persisted at `知识快照/.知识来源.json`. */
export interface KnowledgeIndexDocument {
  schema: typeof KNOWLEDGE_INDEX_SCHEMA
  projectId: string
  planId: string | null
  spaceName: string
  expectedSpaceName: string
  spaceVerified: boolean
  manifestDigest: string
  availableRouteIds: string[]
  routeIds: string[]
  digest: string
  materializedAt: string
  routes: KnowledgeRouteOutcome[]
  entries: KnowledgeManifestEntry[]
  capabilityGaps: string[]
  ok: boolean
}

export type KnowledgeIndexReadResult =
  | { ok: true; index: KnowledgeIndexDocument }
  | { ok: false; kind: 'invalid' | 'policy'; error: string }

function asString(value: unknown): string {
  return text(value)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter((item) => item !== '') : []
}

const SOURCE_KINDS: readonly KnowledgeSourceKind[] = ['dws', 'verified-mirror']

type IndexEntryRead = { ok: true; entry: KnowledgeManifestEntry } | { ok: false; error: string }

/** Parse one persisted entry; any structural defect rejects the whole index (no silent drop). */
function parseIndexEntry(raw: unknown): IndexEntryRead {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '条目不是对象' }
  const row = raw as Record<string, unknown>
  const routeId = asString(row.routeId)
  const nodeName = asString(row.nodeName)
  const resolvedPath = asString(row.resolvedPath)
  const source = asString(row.source)
  const digest = asString(row.digest)
  const snapshotFile = asString(row.snapshotFile)
  if (routeId === '') return { ok: false, error: '条目缺少 routeId' }
  if (nodeName === '') return { ok: false, error: `条目缺少 nodeName（${routeId}）` }
  if (resolvedPath === '') return { ok: false, error: `条目缺少 resolvedPath（${routeId}）` }
  if (!SOURCE_KINDS.includes(source as KnowledgeSourceKind)) {
    return { ok: false, error: `条目 source 不合法（${routeId}）` }
  }
  if (digest === '') return { ok: false, error: `条目缺少 digest（${routeId}）` }
  if (snapshotFile === '' || !safeSnapshotRelative(snapshotFile)) {
    return { ok: false, error: `条目 snapshotFile 不安全（${routeId}）` }
  }
  const size = row.sizeBytes
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < 0)) {
    return { ok: false, error: `条目 sizeBytes 不合法（${routeId}）` }
  }
  return {
    ok: true,
    entry: {
      routeId,
      nodeName,
      resolvedPath,
      source: source as KnowledgeSourceKind,
      digest,
      sizeBytes: typeof size === 'number' ? size : 0,
      snapshotFile,
      mediaType: asString(row.mediaType),
      updatedAt: asString(row.updatedAt),
      bodyNonEmpty: row.bodyNonEmpty !== false,
      channel: asString(row.channel) as KnowledgeManifestEntry['channel'],
      sectionIds: asStringArray(row.sectionIds),
      ruleIds: asStringArray(row.ruleIds),
      links: [],
      templateId: typeof row.templateId === 'string' ? row.templateId : null,
      templateContractVersion: typeof row.templateContractVersion === 'string' ? row.templateContractVersion : null,
      templateVerified: typeof row.templateVerified === 'boolean' ? row.templateVerified : null,
    },
  }
}

const ROUTE_STATES: readonly RouteState[] = ['found', 'missing', 'empty', 'ambiguous', 'unreadable']

type RouteOutcomeRead = { ok: true; route: KnowledgeRouteOutcome } | { ok: false; error: string }

function parseRouteOutcome(raw: unknown): RouteOutcomeRead {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '路由结论不是对象' }
  const row = raw as Record<string, unknown>
  const routeId = asString(row.routeId)
  const state = asString(row.state) as RouteState
  if (routeId === '') return { ok: false, error: '路由结论缺少 routeId' }
  if (!ROUTE_STATES.includes(state)) return { ok: false, error: `路由结论 state 不合法（${routeId}）` }
  return {
    ok: true,
    route: {
      routeId,
      state,
      nodeName: asString(row.nodeName),
      source: asString(row.source),
      digest: asString(row.digest),
      snapshotFile: asString(row.snapshotFile),
      error: asString(row.error),
    },
  }
}

/**
 * Parse an existing aggregate index with typed absent/invalid/policy distinctions.
 *
 * A malformed, conflicting or foreign index is never trusted: the caller must fail closed and keep
 * the file untouched, so a partial refresh cannot silently erase or swap known sources. Optional
 * legacy fields (size / template metadata) stay optional; required identity fields do not.
 */
export function parseKnowledgeIndex(
  raw: string,
  expected: { projectId: string; expectedSpaceName: string },
): KnowledgeIndexReadResult {
  const trimmed = text(raw).trim()
  if (trimmed === '') return { ok: false, kind: 'invalid', error: '既有知识索引为空' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, kind: 'invalid', error: '既有知识索引不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'invalid', error: '既有知识索引不是对象' }
  }
  const doc = parsed as Record<string, unknown>
  if (asString(doc.schema) !== KNOWLEDGE_INDEX_SCHEMA) {
    return { ok: false, kind: 'invalid', error: '既有知识索引 schema 不匹配' }
  }
  const projectId = asString(doc.projectId)
  if (projectId === '') return { ok: false, kind: 'invalid', error: '既有知识索引缺少 projectId' }
  if (projectId !== expected.projectId) {
    return { ok: false, kind: 'policy', error: `既有知识索引属于别的项目（${projectId}）` }
  }
  const expectedSpaceName = asString(doc.expectedSpaceName) || asString(doc.spaceName)
  if (expectedSpaceName !== expected.expectedSpaceName) {
    return { ok: false, kind: 'policy', error: `既有知识索引来自别的知识库（${expectedSpaceName || '未知'}）` }
  }
  if (!Array.isArray(doc.entries) || !Array.isArray(doc.routes)) {
    return { ok: false, kind: 'invalid', error: '既有知识索引缺少 entries/routes' }
  }
  const entries: KnowledgeManifestEntry[] = []
  const entryPairs = new Set<string>()
  const snapshotOwners = new Map<string, string>()
  for (const row of doc.entries) {
    const read = parseIndexEntry(row)
    if (!read.ok) return { ok: false, kind: 'invalid', error: `既有知识索引条目不可用：${read.error}` }
    const entry = read.entry
    const pair = `${entry.routeId}\u0000${entry.snapshotFile}`
    if (entryPairs.has(pair)) {
      return { ok: false, kind: 'invalid', error: `既有知识索引有重复条目（${entry.routeId}）` }
    }
    entryPairs.add(pair)
    const owner = snapshotOwners.get(entry.snapshotFile)
    if (owner !== undefined && owner !== entry.routeId) {
      return { ok: false, kind: 'invalid', error: `既有知识索引两个路由共用同一落点（${entry.snapshotFile}）` }
    }
    snapshotOwners.set(entry.snapshotFile, entry.routeId)
    entries.push(entry)
  }
  const routes: KnowledgeRouteOutcome[] = []
  for (const row of doc.routes) {
    const read = parseRouteOutcome(row)
    if (!read.ok) return { ok: false, kind: 'invalid', error: `既有知识索引路由不可用：${read.error}` }
    routes.push(read.route)
  }
  // A declared aggregate digest is verified against the recorded entries when present.
  const declaredDigest = asString(doc.digest)
  if (declaredDigest !== '' && declaredDigest !== knowledgeSnapshotDigest(entries)) {
    return { ok: false, kind: 'invalid', error: '既有知识索引摘要与条目不一致' }
  }
  return {
    ok: true,
    index: {
      schema: KNOWLEDGE_INDEX_SCHEMA,
      projectId,
      planId: typeof doc.planId === 'string' ? doc.planId : null,
      spaceName: asString(doc.spaceName),
      expectedSpaceName: asString(doc.expectedSpaceName),
      // A valid-schema index written by an unverified run is kept, but the caller must not reuse
      // its entries; only spaceVerified=true makes them trustworthy.
      spaceVerified: doc.spaceVerified === true,
      manifestDigest: asString(doc.manifestDigest),
      availableRouteIds: asStringArray(doc.availableRouteIds),
      routeIds: asStringArray(doc.routeIds),
      digest: asString(doc.digest),
      materializedAt: asString(doc.materializedAt),
      routes,
      entries,
      capabilityGaps: asStringArray(doc.capabilityGaps),
      ok: doc.ok !== false,
    },
  }
}
