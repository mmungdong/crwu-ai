import { createHash } from 'node:crypto'
import { text } from '../../../../shared/utils/value.ts'

/**
 * 候选案例的**稳定编号册**（协议 39 · 设计稿 §7「用户按编号选例」）。
 *
 * ## 为什么编号必须由 Host 发、而且必须稳定
 *
 * 员工在会话里看到的是"相近但未达标"的候选清单（差异、可用信息、纳入影响），然后用
 * **编号**回答"加入 A、C 重算"。于是编号是**跨轮次的引用**：再搜一次、换一个关键字、
 * 或者多跑一轮，如果编号重新排过，用户说的"3 号"就会指向另一条房源 ——
 * 而系统会照着他没看过的那条重算，两边都不报错。
 *
 * 所以：
 *
 * 1. 编号按**身份**（`identity`）分配一次，之后永远不变；已见过的身份在新结果里出现时**沿用**旧编号；
 * 2. 新身份按"当前最大值 + 1"接着发号，**不重用**已退休的编号（退休的编号会被记成 `retired`）；
 * 3. 编号只在**同一个方案**内有效（`planId` 不同就是另一册）。
 *
 * ## 它不判断"达标"
 *
 * 达标由本轮知识正文定义（相似性、价格性质、面积区间…）。这一层只维护
 * **身份 → 编号 → 状态与差异**的登记关系，以及"用户给的这个编号还在不在"。
 */

/** Known tracking query names that never identify a listing. */
const TRACKING_PARAM_PATTERNS: readonly RegExp[] = [/^utm_/i, /^gclid$/i, /^fbclid$/i]

/**
 * Canonical listing URL: scheme + lowercase host + path + identity query + fragment, dropping
 * only known tracking parameters. Returns '' when there is no usable HTTP(S) URL.
 */
export function canonicalListingUrl(value: unknown): string {
  const raw = text(value).trim()
  if (raw === '') return ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const scheme = parsed.protocol.replace(/:$/, '')
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  const path = parsed.pathname.replace(/\/+$/, '') || '/'
  const query = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(key)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
    .join('&')
  return `${scheme}://${host}${port}${path}${query === '' ? '' : `?${query}`}${parsed.hash}`
}

/**
 * Candidate identity: canonical URL first.
 *
 * Same community/area/price is only a suspicion and never establishes identity for two
 * different URLs. Weak facts remain a fallback only when no URL is available at all.
 */
export function candidateIdentityOf(input: {
  community?: unknown
  buildingArea?: unknown
  price?: unknown
  url?: unknown
}): string {
  const canonical = canonicalListingUrl(input.url)
  if (canonical !== '') return `u:${canonical}`
  const community = text(input.community).replace(/\s+/g, '').toLowerCase()
  const area = typeof input.buildingArea === 'number' && Number.isFinite(input.buildingArea)
    ? String(Math.round(input.buildingArea * 10) / 10)
    : ''
  const price = typeof input.price === 'number' && Number.isFinite(input.price) ? String(input.price) : ''
  if (community === '' && area === '' && price === '') return ''
  return `c:${community}|${area}|${price}`
}

export type CandidateStatus = 'adopted' | 'near-miss' | 'rejected' | 'unreviewed'

/** 一条登记在册的候选。 */
export interface CandidateEntry {
  /** **稳定编号**（1 起，只增不重用）。 */
  number: number
  identity: string
  source: string
  url: string
  community: string
  unitPrice: number | null
  buildingArea: number | null
  transactionType: string
  evidence: string
  status: CandidateStatus
  /** 与达标条件的差异 / 处置理由（业务文本，来自方法与案例正文）。 */
  reason: string
  /** 首次登记的轮次（用户补搜换规则时会开新一轮）。 */
  firstSeenRound: number
  /** 是否已退休（不再出现在最新结果里）：编号保留、不重新分配。 */
  retired: boolean
}

export interface CandidateRegister {
  schemaVersion: 'crwu.valuation.candidates.v1'
  planId: string
  entries: CandidateEntry[]
  /** 下一个可用的编号（只增）。 */
  nextNumber: number
  updatedAt: string
}

export function emptyRegister(input: { planId: string; updatedAt: string }): CandidateRegister {
  return {
    schemaVersion: 'crwu.valuation.candidates.v1',
    planId: text(input.planId),
    entries: [],
    nextNumber: 1,
    updatedAt: text(input.updatedAt),
  }
}

/** 一条待登记/更新的候选（来自取数结果或模型整理后的清单）。 */
export interface CandidateInput {
  source?: unknown
  url?: unknown
  community?: unknown
  buildingArea?: unknown
  price?: unknown
  unitPrice?: unknown
  transactionType?: unknown
  evidence?: unknown
  status?: unknown
  reason?: unknown
}

const STATUSES: readonly CandidateStatus[] = ['adopted', 'near-miss', 'rejected', 'unreviewed']

function statusOf(value: unknown): CandidateStatus {
  const raw = text(value)
  return (STATUSES as readonly string[]).includes(raw) ? raw as CandidateStatus : 'unreviewed'
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把一批候选并在册子上。
 *
 * - 已有身份的条目**沿用编号**（只更新状态 / 理由 / 证据）；
 * - 新身份发新号；
 * - 本批没出现的旧身份**不删除**，标 `retired`（编号不重用）。
 */
export function mergeCandidates(
  register: CandidateRegister,
  incoming: readonly CandidateInput[],
  options: { round?: number; updatedAt: string },
): { register: CandidateRegister; added: number[]; updated: number[] } {
  const round = Number.isFinite(options.round) ? Math.max(1, Math.trunc(options.round as number)) : 1
  const byIdentity = new Map(register.entries.map((entry) => [entry.identity, entry]))
  const entries = register.entries.map((entry) => ({ ...entry }))
  const indexOf = new Map(entries.map((entry, index) => [entry.identity, index]))
  let nextNumber = register.nextNumber
  const added: number[] = []
  const updated: number[] = []
  const seen = new Set<string>()

  for (const raw of incoming) {
    const identity = candidateIdentityOf(raw)
    if (identity === '') continue
    seen.add(identity)
    const patch = {
      source: text(raw.source),
      url: text(raw.url),
      community: text(raw.community),
      unitPrice: numberOrNull(raw.unitPrice),
      buildingArea: numberOrNull(raw.buildingArea),
      transactionType: text(raw.transactionType),
      evidence: text(raw.evidence),
      status: statusOf(raw.status),
      reason: text(raw.reason),
      retired: false,
    }
    let existingIndex = indexOf.get(identity)
    if (existingIndex === undefined) {
      // Legacy migration: a unique same-URL match keeps its assigned number.
      const url = text(raw.url).trim()
      if (url !== '') {
        const matches = entries
          .map((entry, index) => ({ entry, index }))
          .filter((item) => item.entry.url === url && item.entry.identity !== identity)
        if (matches.length === 1) {
          existingIndex = matches[0].index
          indexOf.delete(matches[0].entry.identity)
          indexOf.set(identity, existingIndex)
        }
        // Ambiguous same-URL legacy records are never resolved by picking the first one.
      }
    }
    if (existingIndex !== undefined) {
      entries[existingIndex] = { ...entries[existingIndex], ...patch, identity }
      updated.push(entries[existingIndex].number)
      continue
    }
    const entry: CandidateEntry = {
      number: nextNumber,
      identity,
      firstSeenRound: round,
      ...patch,
    }
    nextNumber += 1
    indexOf.set(identity, entries.length)
    byIdentity.set(identity, entry)
    entries.push(entry)
    added.push(entry.number)
  }

  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.identity)) continue
    // 这一批没出现：**保留编号**、标记退休（不删、不重排）。
    entries[index] = { ...entry, retired: true }
  }

  return {
    register: { ...register, entries, nextNumber, updatedAt: text(options.updatedAt) },
    added,
    updated,
  }
}

/** 用户给出的编号 → 登记条目；未知 / 已退休的编号单独列出（**不**静默忽略）。 */
export function resolveSelection(
  register: CandidateRegister,
  numbers: readonly unknown[],
): {
  ok: boolean
  selected: CandidateEntry[]
  unknown: number[]
  retired: number[]
  duplicated: number[]
} {
  const selected: CandidateEntry[] = []
  const unknownNumbers: number[] = []
  const retired: number[] = []
  const duplicated: number[] = []
  const seen = new Set<number>()
  for (const raw of numbers) {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN
    if (!Number.isFinite(value)) {
      unknownNumbers.push(Number.NaN)
      continue
    }
    if (seen.has(value)) {
      duplicated.push(value)
      continue
    }
    seen.add(value)
    const entry = register.entries.find((item) => item.number === value)
    if (entry === undefined) {
      unknownNumbers.push(value)
      continue
    }
    if (entry.retired) {
      retired.push(value)
      continue
    }
    selected.push(entry)
  }
  return {
    ok: unknownNumbers.length === 0 && retired.length === 0 && selected.length > 0,
    selected,
    unknown: unknownNumbers,
    retired,
    duplicated,
  }
}

/**
 * 候选册的指纹（进修订记录：这一版用的是**哪一册**候选）。
 *
 * 只覆盖编号与身份，不覆盖会随后续轮次变化的字段 —— 否则"同一册候选"永远对不上。
 */
export function registerDigest(register: CandidateRegister): string {
  const canonical = register.entries
    .map((entry) => `${String(entry.number)}:${entry.identity}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n')
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/** 从落盘 JSON 读回候选册；形状不认识时返回 `null`（调用方重建并如实说明）。 */
export function registerFromJson(value: unknown): CandidateRegister | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 'crwu.valuation.candidates.v1') return null
  const entries: CandidateEntry[] = []
  for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const number = numberOrNull(entry.number)
    const identity = text(entry.identity)
    if (number === null || number <= 0 || identity === '') continue
    entries.push({
      number: Math.trunc(number),
      identity,
      source: text(entry.source),
      url: text(entry.url),
      community: text(entry.community),
      unitPrice: numberOrNull(entry.unitPrice),
      buildingArea: numberOrNull(entry.buildingArea),
      transactionType: text(entry.transactionType),
      evidence: text(entry.evidence),
      status: statusOf(entry.status),
      reason: text(entry.reason),
      firstSeenRound: numberOrNull(entry.firstSeenRound) ?? 1,
      retired: entry.retired === true,
    })
  }
  const maxNumber = entries.reduce((max, entry) => Math.max(max, entry.number), 0)
  const next = numberOrNull(raw.nextNumber)
  return {
    schemaVersion: 'crwu.valuation.candidates.v1',
    planId: text(raw.planId),
    entries,
    // `nextNumber` 只增：读回来时不许比已发出的最大编号还小（否则会重发号）。
    nextNumber: Math.max(next === null ? 1 : Math.trunc(next), maxNumber + 1),
    updatedAt: text(raw.updatedAt),
  }
}
