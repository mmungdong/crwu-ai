import { text } from '../../../../shared/utils/value.ts'

/**
 * **修订（revision）索引**（协议 39 · 设计稿 §7「新版与旧版并存」）。
 *
 * ## 为什么修订必须是磁盘上的记录，而不是"再算一遍"
 *
 * 用户在会话里说"加入 A、C 重算"之后，系统会产出**一套新的**结论、报告与底稿。
 * 如果新的一套直接覆盖旧的，那么：
 *
 * - 上一版依据的案例集合、知识版本与规则版本**永久消失**，复核者无法回答"上一版为什么是那个数"；
 * - "用户同意把 2 号纳入"这件事只存在于对话里，报告上看不出它改变了什么；
 * - 一次失败的重算会把当前版本指针指到一个半成品上。
 *
 * 所以每一版都落在**自己的目录**（`方案/<planId>/修订/<n>/`），索引记录
 * 父版本、变更原因、采用案例编号、知识与模板版本、检索轮次与规则版本；
 * **只有在核对通过之后**才更新当前指针（`promote`）。旧版本原样留着。
 *
 * ## 这一层是纯函数
 *
 * 落盘由工具做；这里只回答"这一版该不该建、编号是多少、是不是重复提交、能不能提升为当前版"。
 */

export const REVISION_INDEX_FILE = '修订记录.json'
/** 修订目录：`方案/<planId>/修订/<n>/`（第 1 版就是初版，对应没有修订目录时的情形）。 */
export const REVISION_DIR = '修订'

export type RevisionState = 'pending' | 'current' | 'superseded' | 'failed'

/** 一次修订的**变更种类**（决定"要不要重新检索 / 换规则"）。 */
export type RevisionChangeKind =
  /** 用户按编号把相近候选纳入重算（默认路径：复用原规则与已取得数据）。 */
  | 'user-case-selection'
  /** 用户要求补搜（新一轮检索，预算按新轮次记）。 */
  | 'research-round'
  /** 用户要求改规则 / 换模板（记录新的规则与模板版本）。 */
  | 'rule-change'
  /** 其他（人工说明）。 */
  | 'manual'

export interface RevisionRecord {
  revision: number
  /** 父版本（初版为 0）。 */
  parentRevision: number
  createdAt: string
  changeKind: RevisionChangeKind
  /** 变更原因（人话；用户明确说过什么）。 */
  reason: string
  /** 用户明确选中的候选编号（**只确认已说明的差异**）。 */
  adoptedNumbers: number[]
  /** 这一版采用的候选册指纹（哪一册候选）。 */
  candidatesDigest: string
  /** 本轮知识快照指纹（改了知识就是新依据）。 */
  knowledgeDigest: string
  /** 这一版用的计算表模板指纹。 */
  templateDigest: string
  /** 检索轮次（补搜才会 +1）。 */
  searchRound: number
  /** 规则版本（换规则才变；复用原规则时沿用父版本）。 */
  ruleVersion: string
  state: RevisionState
  /** 交付件目录（相对方案目录），例如 `修订/2`。 */
  directory: string
  /** 失败时的原因（`state = failed` 时非空）。 */
  failure: string
}

export interface RevisionIndex {
  schemaVersion: 'crwu.valuation.revisions.v1'
  planId: string
  /** 当前版本号；还没有任何核对通过的版本时是 0。 */
  currentRevision: number
  records: RevisionRecord[]
  updatedAt: string
}

export function emptyRevisionIndex(input: { planId: string; updatedAt: string }): RevisionIndex {
  return {
    schemaVersion: 'crwu.valuation.revisions.v1',
    planId: text(input.planId),
    currentRevision: 0,
    records: [],
    updatedAt: text(input.updatedAt),
  }
}

/** 修订目录（相对方案目录）。第 1 版就是初版，**没有**修订子目录。 */
export function revisionDirectoryOf(revision: number): string {
  const value = Math.max(1, Math.trunc(revision))
  return value <= 1 ? '' : `${REVISION_DIR}/${String(value)}`
}

/** 下一个版本号（只增；失败的版本也占号 —— 否则编号会被重用，旧记录就对不上了）。 */
export function nextRevisionNumber(index: RevisionIndex): number {
  const max = index.records.reduce((value, record) => Math.max(value, record.revision), 0)
  return Math.max(max, index.currentRevision) + 1
}

export interface RevisionRequest {
  changeKind: RevisionChangeKind
  reason: string
  adoptedNumbers: readonly number[]
  candidatesDigest: string
  knowledgeDigest: string
  templateDigest: string
  searchRound: number
  /** 缺省 = 沿用当前版本的规则版本。 */
  ruleVersion?: string
}

export type RevisionDecision =
  | { kind: 'ok'; revision: number; record: RevisionRecord }
  | { kind: 'duplicate'; revision: number; reason: string }
  | { kind: 'invalid'; reason: string }

/** 变更种类收窄（不许编一个词出来）。 */
export function isRevisionChangeKind(value: unknown): value is RevisionChangeKind {
  return (['user-case-selection', 'research-round', 'rule-change', 'manual'] as readonly string[])
    .includes(text(value))
}

/**
 * 决定这一版该不该建。
 *
 * 三条判据：
 *
 * 1. **重复提交**：同一（父版本、变更种类、原因、采用编号、候选册指纹）已经存在
 *    → 返回 `duplicate`（**不**新建一版）：双击、超时重试都不该留下两份一模一样的修订；
 * 2. **变更必须是具体的**：原因空串、或者"按编号纳入"却一个编号都没给 → `invalid`；
 * 3. 其余 → `ok`，并给出这一版的 `pending` 记录（**还没有**成为当前版）。
 */
export function decideRevision(
  index: RevisionIndex,
  request: RevisionRequest,
  options: { now: string },
): RevisionDecision {
  const reason = text(request.reason).trim()
  if (reason === '') {
    return { kind: 'invalid', reason: '修订必须有变更原因：用户说过什么、为什么这一版与上一版不同' }
  }
  if (!isRevisionChangeKind(request.changeKind)) {
    return { kind: 'invalid', reason: `不认识的变更种类：${text(request.changeKind)}` }
  }
  const numbers = [...new Set(request.adoptedNumbers
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.trunc(value)))]
    .sort((a, b) => a - b)
  if (request.changeKind === 'user-case-selection' && numbers.length === 0) {
    return { kind: 'invalid', reason: '「按编号纳入重算」必须给出用户明确选中的候选编号' }
  }

  const parent = Math.max(index.currentRevision, 0)
  const signature = signatureOf({ parent, request, numbers })
  const existing = index.records.find((record) => signatureOf({
    parent: record.parentRevision,
    request: {
      changeKind: record.changeKind,
      reason: record.reason,
      adoptedNumbers: record.adoptedNumbers,
      candidatesDigest: record.candidatesDigest,
      knowledgeDigest: record.knowledgeDigest,
      templateDigest: record.templateDigest,
      searchRound: record.searchRound,
    },
    numbers: record.adoptedNumbers,
  }) === signature)
  if (existing !== undefined) {
    return {
      kind: 'duplicate',
      revision: existing.revision,
      reason: `这一次修订与第 ${String(existing.revision)} 版完全相同（同样的原因、同样的编号、同一册候选）：`
        + '按幂等处理，不新建版本。',
    }
  }

  const revision = nextRevisionNumber(index)
  const ruleVersion = text(request.ruleVersion)
    || text(index.records.find((record) => record.revision === parent)?.ruleVersion)
    || 'v1'
  return {
    kind: 'ok',
    revision,
    record: {
      revision,
      parentRevision: parent,
      createdAt: text(options.now),
      changeKind: request.changeKind,
      reason,
      adoptedNumbers: numbers,
      candidatesDigest: text(request.candidatesDigest),
      knowledgeDigest: text(request.knowledgeDigest),
      templateDigest: text(request.templateDigest),
      searchRound: Number.isFinite(request.searchRound) ? Math.max(1, Math.trunc(request.searchRound)) : 1,
      ruleVersion,
      // **新版本一出生是 pending**：核对通过（或明确失败）之前不动当前指针。
      state: 'pending',
      directory: revisionDirectoryOf(revision),
      failure: '',
    },
  }
}

function signatureOf(input: {
  parent: number
  request: RevisionRequest
  numbers: readonly number[]
}): string {
  const { request } = input
  return [
    `p${String(input.parent)}`,
    text(request.changeKind),
    text(request.reason).trim(),
    input.numbers.join(','),
    text(request.candidatesDigest),
    text(request.knowledgeDigest),
    text(request.templateDigest),
    String(Number.isFinite(request.searchRound) ? Math.trunc(request.searchRound) : 1),
  ].join('|')
}

/** 追加一条记录（**不**改当前指针）。 */
export function appendRevision(index: RevisionIndex, record: RevisionRecord, updatedAt: string): RevisionIndex {
  return { ...index, records: [...index.records, record], updatedAt: text(updatedAt) }
}

/** 把某一版标成失败（保留记录与编号，便于复核"试过什么"）。 */
export function failRevision(index: RevisionIndex, revision: number, failure: string, updatedAt: string): RevisionIndex {
  return {
    ...index,
    records: index.records.map((record) => record.revision === revision
      ? { ...record, state: 'failed', failure: text(failure) }
      : record),
    updatedAt: text(updatedAt),
  }
}

export type PromoteVerdict =
  | { ok: true; index: RevisionIndex }
  | { ok: false; reason: string }

/**
 * 提升某一版为**当前版**。
 *
 * ## 为什么必须带核对回执
 *
 * "新版通过核对再更新当前指针"：没有核对回执就提升，等于把一个没验过的数挂成正式结论。
 * 而且提升会**先把上一版标成 `superseded`**（保留在 records 里），旧报告与旧底稿原样可读。
 */
export function promoteRevision(
  index: RevisionIndex,
  revision: number,
  input: { checked: boolean; checkedRevision: number; checkedAt: string },
): PromoteVerdict {
  const target = index.records.find((record) => record.revision === revision)
  if (target === undefined) {
    return { ok: false, reason: `不存在的修订版本：${String(revision)}` }
  }
  if (target.state === 'failed') {
    return { ok: false, reason: `第 ${String(revision)} 版已经被标记为失败：不能提升为当前版` }
  }
  if (input.checked !== true) {
    return { ok: false, reason: `第 ${String(revision)} 版没有核对回执：新版必须通过核对才能成为当前版` }
  }
  if (Math.trunc(input.checkedRevision) !== Math.trunc(revision)) {
    return {
      ok: false,
      reason: `核对回执对应的是第 ${String(input.checkedRevision)} 版，而这次要提升的是第 ${String(revision)} 版：`
        + '不接受别的版本的核对结论',
    }
  }
  return {
    ok: true,
    index: {
      ...index,
      currentRevision: target.revision,
      records: index.records.map((record) => {
        if (record.revision === target.revision) return { ...record, state: 'current' }
        if (record.state === 'current') return { ...record, state: 'superseded' }
        return record
      }),
      updatedAt: text(input.checkedAt),
    },
  }
}

/** 当前版的记录（没有核对通过的版本时为 `null`）。 */
export function currentRevisionOf(index: RevisionIndex): RevisionRecord | null {
  return index.records.find((record) => record.revision === index.currentRevision) ?? null
}

/** 从落盘 JSON 读回索引；形状不认识时返回 `null`。 */
export function revisionIndexFromJson(value: unknown): RevisionIndex | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 'crwu.valuation.revisions.v1') return null
  const records: RevisionRecord[] = []
  for (const item of Array.isArray(raw.records) ? raw.records : []) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const revision = typeof entry.revision === 'number' && Number.isFinite(entry.revision)
      ? Math.max(1, Math.trunc(entry.revision)) : 0
    if (revision === 0) continue
    const state = text(entry.state)
    records.push({
      revision,
      parentRevision: typeof entry.parentRevision === 'number' && Number.isFinite(entry.parentRevision)
        ? Math.max(0, Math.trunc(entry.parentRevision)) : 0,
      createdAt: text(entry.createdAt),
      changeKind: (isRevisionChangeKind(entry.changeKind) ? entry.changeKind : 'manual') as RevisionChangeKind,
      reason: text(entry.reason),
      adoptedNumbers: (Array.isArray(entry.adoptedNumbers) ? entry.adoptedNumbers : [])
        .map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN))
        .filter((value) => Number.isFinite(value)),
      candidatesDigest: text(entry.candidatesDigest),
      knowledgeDigest: text(entry.knowledgeDigest),
      templateDigest: text(entry.templateDigest),
      searchRound: typeof entry.searchRound === 'number' && Number.isFinite(entry.searchRound)
        ? Math.max(1, Math.trunc(entry.searchRound)) : 1,
      ruleVersion: text(entry.ruleVersion) || 'v1',
      state: (['pending', 'current', 'superseded', 'failed'] as readonly string[]).includes(state)
        ? state as RevisionState : 'pending',
      directory: text(entry.directory),
      failure: text(entry.failure),
    })
  }
  const current = typeof raw.currentRevision === 'number' && Number.isFinite(raw.currentRevision)
    ? Math.max(0, Math.trunc(raw.currentRevision)) : 0
  return {
    schemaVersion: 'crwu.valuation.revisions.v1',
    planId: text(raw.planId),
    // 当前指针必须指向一条真实存在的记录（记录被删掉时退回 0，而不是挂一个空指针）。
    currentRevision: records.some((record) => record.revision === current && record.state === 'current')
      ? current : 0,
    records,
    updatedAt: text(raw.updatedAt),
  }
}
