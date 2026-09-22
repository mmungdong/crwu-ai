/**
 * 「AI 审核结果是否还对得上当前这份报告」的**判定规则**（纯函数，可单测）。
 *
 * 用户口径（2026-09-23）：
 * - 审核结果可能已经过期：报告在审核之后又改过，那 09-20 的审核结论**不能**被当成
 *   09-22 当前报告仍然存在的问题；
 * - 判定优先级：**digest/hash → version → etag → mtime → 最后才是时间关系**；
 * - 「不要仅仅因为 审核时间 < 报告更新时间 就直接断言一定过期，因为更新时间可能来自非内容性操作」
 *   —— 所以纯时间关系**只能**得出 `POSSIBLY_STALE`，永远得不出 `STALE`；
 * - 四个状态只给程序用，**不把英文枚举展示给员工**。
 *
 * 本仓当前实际能拿到的字段（`src/host/audit/summary.ts` 的裁剪摘要 + 氚云行 + OSS 清单）：
 *   - 审核侧：`fileTrace.sourceDigest`（真 digest）、`fileTrace.generatedAt`、`auditTask.auditTime`；
 *   - 报告侧：氚云记录的 `modifiedAt`（**记录**更新时间，不是内容 hash）、本地案例目录的 mtime；
 *   - `reportDigest` / `reportVersion` / `etag` 目前**没有**权威来源，所以这三个入参通常是空串，
 *     逻辑会自动退化到时间关系（并且如实报出"只能用时间判断"）。
 *   一旦以后报告侧能提供同源 digest，这一层不用改就能升级成强判定 —— 对应的分支已经有单测。
 */

import { stampValue } from './time.ts'

export type FreshnessStatus = 'current' | 'possibly_stale' | 'stale' | 'unknown'

/** 结论是**靠什么**得出的（技术详情 / Context Snapshot 要记录它，便于追溯）。 */
export type FreshnessBasis = 'digest' | 'version' | 'etag' | 'mtime' | 'time' | 'none'

/** 两侧的版本证据。同名字段必须**同源**再比较（不同来源的 digest 相比只会产生假 STALE）。 */
export interface VersionEvidence {
  /** 当前报告内容的 digest/hash；没有权威来源时留空。 */
  reportDigest: string
  /** 审核结果里记录的、它当时所依据的源 digest（`fileTrace.sourceDigest`）。 */
  auditSourceDigest: string
  reportVersion: string
  auditSourceVersion: string
  reportEtag: string
  auditSourceEtag: string
  /** 报告侧文件/内容的修改时间（有才用）。 */
  reportModifiedAt: string
  /** 审核侧产物的修改时间（有才用）。 */
  auditModifiedAt: string
  /** 记录级更新时间（氚云 `modifiedAt`）—— 只作**退化**判据。 */
  reportUpdatedAt: string
  /** 审核产物生成时间（`fileTrace.generatedAt`，退回 `auditTask.auditTime`）。 */
  auditGeneratedAt: string
}

export interface FreshnessVerdict {
  status: FreshnessStatus
  basis: FreshnessBasis
  /** 只给技术详情 / snapshot 用的一句话依据（中文，可直接展示）。 */
  note: string
}

const STRONG: ReadonlyArray<{ basis: FreshnessBasis; pick: (input: VersionEvidence) => [string, string] }> = [
  { basis: 'digest', pick: (input) => [input.reportDigest, input.auditSourceDigest] },
  { basis: 'version', pick: (input) => [input.reportVersion, input.auditSourceVersion] },
  { basis: 'etag', pick: (input) => [input.reportEtag, input.auditSourceEtag] },
  { basis: 'mtime', pick: (input) => [input.reportModifiedAt, input.auditModifiedAt] },
]

function clean(value: string): string {
  return (value ?? '').trim()
}

/**
 * 判定顺序（用户口径 §6）：
 * 1. digest 两侧都有 → 相等 CURRENT / 不等 STALE（**唯一的强结论来源**）；
 * 2. version 两侧都有 → 同上；
 * 3. etag 两侧都有 → 同上；
 * 4. mtime 两侧都有 → 同上；
 * 5. 都凑不齐 → 只用 `reportUpdatedAt` 与 `auditGeneratedAt` 的时间关系：
 *    报告不晚于审核 = CURRENT（没有任何"变过"的证据）；报告晚于审核 = POSSIBLY_STALE；
 *    有一侧时间都读不出来 = UNKNOWN（缺必要版本信息）。
 */
export function freshnessOf(input: VersionEvidence): FreshnessVerdict {
  for (const rule of STRONG) {
    const [report, audit] = rule.pick(input)
    if (clean(report) === '' || clean(audit) === '') continue
    return clean(report) === clean(audit)
      ? { status: 'current', basis: rule.basis, note: `${rule.basis} 一致` }
      : { status: 'stale', basis: rule.basis, note: `${rule.basis} 不一致` }
  }

  const report = stampValue(clean(input.reportUpdatedAt))
  const audit = stampValue(clean(input.auditGeneratedAt))
  if (report === null || audit === null) {
    return { status: 'unknown', basis: 'none', note: '缺少可比较的版本与时间信息' }
  }
  if (report <= audit) {
    return { status: 'current', basis: 'time', note: '报告更新时间不晚于审核时间（无版本证据，按时间退化判断）' }
  }
  return { status: 'possibly_stale', basis: 'time', note: '报告更新时间晚于审核时间，但无法证明内容变化' }
}

/** 两侧是否有**同源**的 digest 可比（没有就只能退化到时间，界面上不要说成"已确认过期"）。 */
export function digestComparable(input: VersionEvidence): boolean {
  return clean(input.reportDigest) !== '' && clean(input.auditSourceDigest) !== ''
}

/** Context Snapshot：新建分析会话那一刻的版本快照（判"历史会话是否过期"全靠它）。 */
export interface AuditContextSnapshot {
  reportSerialNumber: string
  reportUpdatedAt: string
  reportDigest: string
  /**
   * 报告资料的**远端标识**（氚云附件 fileId + 云端对象 key 聚合）。
   * 用户 §11：快照里不许用本地路径当报告版本身份 —— 这个字段全是远端标识。
   */
  reportRemoteId: string
  auditGeneratedAt: string
  auditSourceDigest: string
  /** 审核产物的远端标识（它的 OSS 对象 key 聚合）。 */
  auditRemoteId: string
  /** 本次从远端获取这批资料的时刻。 */
  fetchedAt: string
  /** 审核产物对象在 OSS 上的 ETag（`ossutil ls` 长格式自带）——审核结果是否重新生成过看它。 */
  auditEtag: string
  /** 审核产物对象的最后写入时间（同样来自长格式）。 */
  auditLastModified: string
  /** 审核产物的可追溯版本（schema + 渲染器），不是"重新生成过"的判据。 */
  auditArtifactVersion: string
  /** 人工复核意见里最晚的一个时间（`reviewFiles[].occurredAt` 的最大值）。 */
  reviewUpdatedAt: string
  /** 建会话的时刻（客户端时钟，仅用于"这个快照有多老"）。 */
  conversationCreatedAt: string
  contextStatus: FreshnessStatus
}

/** 历史会话与当前资料的差异（§13 的三个信号，各自独立）。 */
export interface SnapshotChange {
  report: boolean
  audit: boolean
  review: boolean
  digest: boolean
  any: boolean
}

function laterThan(current: string, stored: string): boolean {
  const now = stampValue(clean(current))
  const before = stampValue(clean(stored))
  if (now === null || before === null) return false
  return now > before
}

/**
 * 快照之后发生了什么。**每一项都用真实字段**：
 * - `report`：当前记录的更新时间晚于快照里的；
 * - `audit`：当前审核产物的生成时间晚于快照里的（= 审核结果重新生成过）；
 * - `review`：当前最晚复核意见时间晚于快照里的（= 新增了复核意见）；
 * - `digest`：两侧都有 digest 且不一致（内容级证据，最强）。
 */
export function changesSince(snapshot: AuditContextSnapshot, current: AuditContextSnapshot): SnapshotChange {
  // 报告侧：**远端标识**（远端换了附件就变，与本地下载无关）或记录更新时间，任一变了都算"报告已更新"。
  const report = (snapshot.reportRemoteId !== '' && current.reportRemoteId !== ''
      && snapshot.reportRemoteId !== current.reportRemoteId)
    || laterThan(current.reportUpdatedAt, snapshot.reportUpdatedAt)
  // 审核侧：OSS 对象的 ETag（同源，客观）或产物生成时间，任一变了都算"审核结果已更新"。
  const audit = (snapshot.auditRemoteId !== '' && current.auditRemoteId !== ''
      && snapshot.auditRemoteId !== current.auditRemoteId)
    || (snapshot.auditEtag !== '' && current.auditEtag !== '' && snapshot.auditEtag !== current.auditEtag)
    || laterThan(current.auditGeneratedAt, snapshot.auditGeneratedAt)
  const review = laterThan(current.reviewUpdatedAt, snapshot.reviewUpdatedAt)
  const digest = clean(current.reportDigest) !== '' && clean(snapshot.reportDigest) !== ''
    && clean(current.reportDigest) !== clean(snapshot.reportDigest)
  return { report, audit, review, digest, any: report || audit || review || digest }
}

/** 状态 → 给人看的一句话（**不出现英文枚举**）。 */
export function freshnessLabel(status: FreshnessStatus): string {
  if (status === 'current') return '与当前报告一致'
  if (status === 'stale') return '原始报告内容已经变化'
  if (status === 'possibly_stale') return '报告在 AI 审核后存在更新记录'
  return '缺少版本信息，无法判断'
}
