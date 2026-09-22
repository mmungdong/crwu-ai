import { text } from '../../shared/utils/value.ts'
import { labelOf, pick } from '../h3yun/fields.ts'

/**
 * 审核结果 JSON 的摘要提取。
 *
 * 两段文本都是从动态形态实现**逐字搬过来的**（该形态已删除，见 `PORTING.md`），只把 `text()` 调用改成 `asText()`
 * （因为本模块也导入了 `text`）。改措辞前先想清楚：`auditInfoFromResult` 是列表抽屉
 * 唯一能看到的东西，`extractAuditSummary` 是案例卡片用的。
 *
 * **为什么只提取摘要**：审核结果 JSON 含完整问题清单与证据链，整包传到浏览器既慢又把
 * 内部细节铺到前端状态里。列表接口只回摘要，完整报告仍通过原 HTML 查看。
 *
 * 2026-09-23 追加两组**裁剪过的最小集**（用户口径：「AI 检出问题列表」与「已提出但仍未整改」
 * 必须直接长在抽屉里，不能让人跳到报告才知道 AI 发现了什么）：
 *   - `issues[]`：只留 issueId / title / severity / decision / problemDescription /
 *     gapAnalysis.difference / locationSummary / handlingRequirement，逐字段截断、整体封顶 100 条；
 *   - `reviewComparison.reviewItems[]`：只留 itemId / title / matchStatus / linkedIssueIds /
 *     inFileResolution / reviewerEvidence.quote（**关联字段**，抽屉据此判定"已提未改"）。
 * `ruleEvidence` / `materialEvidence` / `quote` 全文 / 知识库路径 / 证据链一律**不进**这个接口 ——
 * 那些仍然只在完整交付件里。客户端拿到新字段是加分项：旧宿主不给时抽屉照常降级渲染。
 */

function asText(value: unknown): string {
  return text(value)
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 外部 JSON 的唯一收窄入口：不是对象就当空对象，禁止后续直接索引 unknown。 */
function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function labels(value: unknown): string[] {
  return arr(value).map((item) => labelOf(item)).filter((item) => item !== '')
}

/**
 * 抽屉里一次能看完的问题条数上限。
 *
 * 100 条 ≈ 150KB 上限（每个问题已被截断到 ~1.5KB），对一次同源 RPC 是安全的；真机上
 * 单份报告的 issues 通常在十几条量级。超过上限时客户端会用 `counts.issuesTotal` 与
 * 实际条数对比，在列表尾部说明"仅显示前 N 条，完整清单见报告"——不新增字段。
 */
const DRAWER_ISSUE_LIMIT = 100

/** 复核项上限：它只服务于"已提未改"与计数，不需要全量。 */
const DRAWER_REVIEW_ITEM_LIMIT = 100

/** 逐字段截断：外部 JSON 里这些文本是给人读的正文，超长只可能是异常数据。 */
function clipped(value: unknown, max: number): string {
  return asText(value).slice(0, max)
}

export function auditInfoFromResult(doc: unknown): Record<string, unknown> {
  const root = rec(doc)
  const task = rec(root.auditTask)
  const profile = rec(task.profile)
  const summary = rec(root.summary)
  const counts = rec(summary.counts)
  const review = rec(root.reviewComparison)
  const metrics = rec(review.metrics)
  const bands = rec(review.bands)
  const trace = rec(root.fileTrace)
  const numberOrText = function (value: unknown): string | number {
    if (typeof value === 'number' && isFinite(value)) return value
    return asText(value)
  }
  const selectedCounts: Record<string, string | number> = {}
  ;['issuesTotal', 'fail', 'high', 'medium', 'low', 'pendingConfirmation', 'notChecked'].forEach(function (key) {
    if (counts[key] !== undefined && counts[key] !== null) selectedCounts[key] = numberOrText(counts[key])
  })
  const selectedMetrics: Record<string, string | number> = {}
  ;['total', 'evaluable', 'resolved', 'uncheckable', 'exactHits', 'partialHits', 'misses', 'hitRate',
    'coverageRate', 'strictHitRate', 'aiHitRate', 'aiHitRateExclResolved'].forEach(function (key) {
    if (metrics[key] !== undefined && metrics[key] !== null) selectedMetrics[key] = numberOrText(metrics[key])
  })
  const selectedBands: Record<string, string | number> = {}
  ;['overlap', 'aiOnly', 'reviewerOnly', 'divergent'].forEach(function (key) {
    if (bands[key] !== undefined && bands[key] !== null) selectedBands[key] = numberOrText(bands[key])
  })
  // 问题清单（裁剪）：抽屉的"AI 检出问题"直接用这些字段渲染，**不在前端生成第二套描述**。
  const issues = arr(root.issues).slice(0, DRAWER_ISSUE_LIMIT).map(function (item) {
    const one = rec(item)
    const gap = rec(one.gapAnalysis)
    return {
      issueId: asText(one.issueId),
      title: clipped(one.title, 200),
      severity: asText(one.severity),
      decision: asText(one.decision),
      // 首屏简述优先用 gapAnalysis.difference（比整段 problemDescription 短），原文兜底。
      difference: clipped(gap.difference, 300),
      problemDescription: clipped(one.problemDescription, 400),
      locationSummary: clipped(one.locationSummary, 240),
      handlingRequirement: clipped(one.handlingRequirement, 400),
    }
  })
  // 复核项（裁剪）：`linkedIssueIds` + `inFileResolution` 是"已提未改"的唯一判据来源。
  const reviewItems = arr(review.reviewItems).slice(0, DRAWER_REVIEW_ITEM_LIMIT).map(function (item) {
    const one = rec(item)
    const evidence = rec(one.reviewerEvidence)
    return {
      itemId: asText(one.itemId),
      title: clipped(one.title, 200),
      matchStatus: asText(one.matchStatus),
      linkedIssueIds: arr(one.linkedIssueIds)
        .map(function (id) { return asText(id) })
        .filter(function (id) { return id !== '' }),
      inFileResolution: asText(one.inFileResolution),
      reviewerQuote: clipped(evidence.quote, 300),
    }
  })
  return {
    schemaVersion: asText(root.schemaVersion),
    issues: issues,
    projectId: asText(task.projectId),
    auditTime: asText(task.auditTime),
    engineVersion: asText(task.engineVersion),
    reportVersion: asText(task.reportVersion).slice(0, 500),
    stage: asText(profile.stage),
    summary: {
      decision: asText(summary.overallDecision),
      counts: selectedCounts,
      narrative: asText(summary.narrative).slice(0, 4000),
    },
    reviewComparison: {
      status: asText(review.status),
      metrics: selectedMetrics,
      bands: selectedBands,
      reviewItems: reviewItems,
      reviewFiles: arr(review.reviewFiles).slice(0, 20).map(function (file) {
        const f = rec(file)
        return {
          level: asText(f.level),
          displayName: asText(f.displayName).slice(0, 300),
          version: asText(f.version).slice(0, 300),
          occurredAt: asText(f.occurredAt),
        }
      }),
    },
    fileTrace: {
      generatedAt: asText(trace.generatedAt),
      rendererVersion: asText(trace.rendererVersion),
      sourceDigest: asText(trace.sourceDigest),
    },
  }
}

export function extractAuditSummary(doc: unknown): Record<string, unknown> {
  const root = rec(doc)
  const at = rec(root.auditTask)
  const prof = rec(at.profile)
  const rp = rec(prof.routeProfile)
  const summary = rec(root.summary)
  const counts = rec(summary.counts)
  const rc = rec(root.reviewComparison)
  const m = (rc.metrics !== null && typeof rc.metrics === 'object' ? rec(rc.metrics) : null)
  const pc = rec(root.phaseControl)
  const ft = rec(root.fileTrace)
  const hitRate = m ? m.aiHitRate : undefined
  let derivedHitRate = ''
  if (m && (hitRate === undefined || hitRate === null || hitRate === '')) {
    const evaluable = num(m.evaluable)
    if (evaluable > 0) derivedHitRate = ((num(m.exactHits) + num(m.partialHits)) / evaluable * 100).toFixed(1) + '%'
  }
  return {
    projectId: asText(at.projectId),
    reportVersion: asText(at.reportVersion),
    auditTime: asText(at.auditTime),
    engineVersion: asText(at.engineVersion),
    // 与 legacy 的唯一差异：`rec()` 已保证是对象，所以省掉了 `: ''` 兜底（等价）。
    overallDecision: asText(summary.overallDecision),
    counts: {
      issuesTotal: num(counts.issuesTotal), fail: num(counts.fail),
      high: num(counts.high), medium: num(counts.medium), low: num(counts.low),
      pendingConfirmation: num(counts.pendingConfirmation), notChecked: num(counts.notChecked),
    },
    axes: {
      objectType: asText(prof.objectType),
      scenario: asText(prof.scenario),
      stage: asText(prof.stage),
      reportForm: asText(pick(rp, ['reportForm', 'report_form'])),
      riskClass: asText(pick(rp, ['reviewRiskClass', 'review_risk_class'])),
      methods: labels(pick(prof, ['methods'])),
      scope: labels(pick(rp, ['scopeTypes', 'scope_types'])),
      asset: labels(pick(rp, ['assetTypes', 'asset_types'])),
      business: labels(pick(rp, ['businessTypes', 'business_types'])),
      routeMethods: labels(pick(rp, ['methods'])),
      overlays: labels(pick(rp, ['overlays'])),
      skills: labels(pick(rp, ['skillsToLoad', 'skills_to_load'])),
    },
    review: {
      status: asText(rc.status) || 'not_performed',
      bands: typeof rc.bands === 'object' && rc.bands !== null ? {
        overlap: num(rec(rc.bands).overlap), aiOnly: num(rec(rc.bands).aiOnly),
        divergent: num(rec(rc.bands).divergent), reviewerOnly: num(rec(rc.bands).reviewerOnly),
      } : null,
      metrics: m ? {
        total: num(m.total), resolved: num(m.resolved), uncheckable: num(m.uncheckable),
        evaluable: num(m.evaluable), exactHits: num(m.exactHits), partialHits: num(m.partialHits),
        misses: num(m.misses), aiHitRate: asText(hitRate), derivedHitRate: derivedHitRate,
      } : null,
    },
    phase: {
      phase1FrozenAt: asText(pc.phase1FrozenAt),
      reviewAccessedAt: asText(pc.reviewAccessedAt),
      phase2CompletedAt: asText(pc.phase2CompletedAt),
    },
    generatedAt: asText(ft.generatedAt),
    rendererVersion: asText(ft.rendererVersion),
  }
}
