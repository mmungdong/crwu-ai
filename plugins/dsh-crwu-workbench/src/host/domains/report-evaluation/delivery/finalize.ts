import { text } from '../../../../shared/utils/value.ts'
import type {
  Blocker,
  KnowledgeSourceRecord,
  ReportConclusion,
  ReportStatus,
  ReportWorkbookRecord,
  ScreenshotEvidenceRecord,
  ValuationPath,
  ValueScope,
} from '../../../../shared/contracts/valuation-project.ts'
import type { RecalculationOutcome } from './recalculation.ts'
import { statusCeilingFromRecalculation } from './recalculation.ts'

/**
 * **finalize：显式的完成校验**（设计稿 §11.4，计划 Task 11）。
 *
 * ## 为什么完成判定必须是一个显式调用，而不是"页面还在轮询就算完成"
 *
 * 删除面板进度轮询之后，没有任何东西会顺手看一眼文件齐不齐。如果这时还允许"子会话写完文件
 * 就结束"，那么"完成"就退化成了**模型的自我声明** —— 而模型说"我完成了"从来不是事实。
 *
 * 所以这里把完成判据集中到一处，由 Host 用**真实文件与真实校验结果**回答：
 *
 * - `requestedStatus`（模型/调用方的请求）**只是提示**，最终状态由实际校验决定；
 * - 校验不通过就**降级**（`completed` → `partial` / `blocked`），而不是"再劝一次"；
 * - 降级必须留下**具体问题清单**，否则员工不知道还差什么。
 *
 * ## 这一层是纯的
 *
 * 它不读文件、不跑脚本：所有事实由调用方（Host）先验好再传进来。这样"什么算完成"这条
 * 口径可以被穷举测试，而 I/O 拼装留在一个薄薄的适配层里。
 */

/** 每个方案 finalize 需要的**已核实事实**。 */
export interface PlanFinalizeFacts {
  projectId: string
  planId: string
  taskId: string
  /** 调用方请求的状态（只是提示）。 */
  requestedStatus: ReportStatus
  /** 冻结输入摘要 vs 本轮重新算出来的摘要。 */
  inputDigest: { frozen: string; recomputed: string }
  knowledge: {
    sources: readonly KnowledgeSourceRecord[]
    /** 知识正文与节/规则字段都核对过。 */
    verified: boolean
    /** 必需知识的缺口（非空即阻断）。 */
    missing: readonly string[]
  }
  template: {
    templateId: string
    digest: string
    expectedDigest: string
    /** ZIP / 工作簿结构 / 公式区 / 输入映射都通过。 */
    structureOk: boolean
  } | null
  objects: {
    objectIds: readonly string[]
    conclusions: readonly ReportConclusion[]
  }
  calculation: {
    /** 计算轨迹步数（0 表示没算过）。 */
    steps: number
    verified: boolean
  }
  evidence: {
    /** 知识是否要求页面截图。 */
    required: boolean
    entries: readonly ScreenshotEvidenceRecord[]
  }
  workbooks: readonly ReportWorkbookRecord[]
  recalculation: RecalculationOutcome
  report: {
    rendered: boolean
    /** report-data 的 Schema 问题清单（空 = 通过）。 */
    schemaProblems: readonly string[]
  }
  artifacts: {
    /** 产物 manifest 核对通过。 */
    manifestOk: boolean
    missing: readonly string[]
  }
  /** 该方案已知的阻断（知识缺失 / 能力缺失 / 模板缺失…）。 */
  blockers: readonly Blocker[]
  valuationPath: ValuationPath
  /** 该方案内各组件声明的价值范围（重复计价检查）。 */
  valueScopes: readonly ValueScope[]
  /**
   * Delivery mode (optional). Absent / unset = formal conclusion.
   *
   * `listing-reference` is a **reference-only** mode: at most `partial`, and the formal template /
   * workbook / recalculation gates do not apply. The flag only lowers the ceiling; it never relaxes
   * input, knowledge, or blocker checks.
   */
  valuationMode?: string
  /**
   * Verified listing-reference facts (only used when `valuationMode=listing-reference`).
   *
   * Must come from Host review of the report data / receipt, not a model-claimed `verified` boolean.
   * `verified=false`, non-empty `problems`, or `objectIds` not matching the plan objects → `blocked`.
   */
  reference?: {
    verified: boolean
    objectIds: readonly string[]
    problems: readonly string[]
  } | null
  verifiedAt: string
}

/** finalize 回执。`status` 是 Host 依据实际事实判定的结果。 */
export interface FinalizeReceipt {
  ok: boolean
  projectId: string
  planId: string
  taskId: string
  requestedStatus: ReportStatus
  status: ReportStatus
  /** 请求的状态被下调了（界面/报告要如实说明）。 */
  downgraded: boolean
  /** 逐条问题（人话，可直接进报告的限制说明）。 */
  problems: string[]
  /** 校验回执（只有 `completed` 才有）。 */
  validation: {
    projectId: string
    planId: string
    inputDigest: string
    knowledgeVerified: boolean
    templateVerified: boolean
    evidenceVerified: boolean
    calculationVerified: boolean
    workbookRecalculated: boolean
    reportRendered: boolean
    verifiedAt: string
    notes: string[]
  } | null
  /** 这一份结论是否包含了被阻断方案的中间金额（必须恒为 false）。 */
  conclusionIncludesBlockedAmount: boolean
}

/** 判断一组价值范围是否重复计价（`land-and-building` 不能再加 `land-only`/`building-only`）。 */
export function valueScopesOverlap(scopes: readonly ValueScope[]): { overlap: boolean; reason: string } {
  const combined = scopes.includes('land-and-building')
  const land = scopes.includes('land-only')
  const building = scopes.includes('building-only')
  if (combined && (land || building)) {
    return {
      overlap: true,
      reason: '同一方案内 `land-and-building` 与 `land-only`/`building-only` 并存：会把土地权益重复计价',
    }
  }
  if (new Set(scopes).size !== scopes.length) {
    return { overlap: true, reason: '同一方案内出现重复的价值范围声明' }
  }
  return { overlap: false, reason: '' }
}

const statusRank: Record<ReportStatus, number> = {
  completed: 4, partial: 3, blocked: 2, failed: 1, cancelled: 0,
}

/**
 * 判定一个方案的最终状态。
 *
 * 判定顺序（先硬后软）：
 * 1. **输入被改过** → `failed`：连输入都不是确认时那一份，任何结论都无意义；
 * 2. **有阻断** → `blocked`：缺知识/模板/能力时不给金额；
 * 3. **请求 completed 但校验不全** → 按缺什么降到 `partial`（可继续补齐）或 `blocked`（缺规则）；
 * 4. 全部通过 → `completed`，并附校验回执。
 */
export function finalizePlan(facts: PlanFinalizeFacts): FinalizeReceipt {
  const problems: string[] = []
  const base = {
    projectId: facts.projectId,
    planId: facts.planId,
    taskId: facts.taskId,
    requestedStatus: facts.requestedStatus,
    conclusionIncludesBlockedAmount: false,
  }

  // ── 1. 冻结输入 ────────────────────────────────────────────────────────
  if (text(facts.inputDigest.frozen) === '' || text(facts.inputDigest.recomputed) === '') {
    problems.push('拿不到冻结输入摘要：无法证明本轮算的是确认时那一份资料')
  } else if (facts.inputDigest.frozen !== facts.inputDigest.recomputed) {
    // 借改 `估值输入.json` 来"让校验通过"是最危险的一种：它让结论与员工确认的输入脱钩。
    return {
      ...base,
      ok: false,
      status: 'failed',
      downgraded: facts.requestedStatus !== 'failed',
      problems: [
        `输入快照与冻结记录不一致（冻结 ${facts.inputDigest.frozen}，现在 ${facts.inputDigest.recomputed}）：`
        + '资料在确认之后被改过，本轮结论无效，必须重新确认。',
      ],
      validation: null,
    }
  }

  // ── 2. 重复计价 ────────────────────────────────────────────────────────
  const scopeCheck = valueScopesOverlap(facts.valueScopes)
  if (scopeCheck.overlap) problems.push(scopeCheck.reason)
  const pathUnresolved = facts.valuationPath === 'unresolved'
  if (pathUnresolved) problems.push('房地权益路径未确认：无法完成方案估值')

  // ── 3. 阻断 ────────────────────────────────────────────────────────────
  if (facts.blockers.length > 0 || scopeCheck.overlap || pathUnresolved) {
    for (const blocker of facts.blockers) {
      problems.push(`[${blocker.stage}/${blocker.kind}] ${blocker.reason}`)
    }
    return {
      ...base,
      ok: true,
      status: 'blocked',
      downgraded: facts.requestedStatus !== 'blocked',
      problems,
      validation: null,
    }
  }

  if (facts.requestedStatus === 'cancelled' || facts.requestedStatus === 'failed') {
    return {
      ...base,
      ok: true,
      status: facts.requestedStatus,
      downgraded: false,
      problems,
      validation: null,
    }
  }

  // ── 4. completed 的逐项判据 ────────────────────────────────────────────
  const knowledgeVerified = facts.knowledge.verified && facts.knowledge.sources.length > 0 && facts.knowledge.missing.length === 0
  if (facts.knowledge.missing.length > 0) {
    // 必需知识缺失属于**规则**缺失：给金额是不负责任的。
    for (const item of facts.knowledge.missing) problems.push(`缺少必需知识：${item}`)
    return { ...base, ok: true, status: 'blocked', downgraded: facts.requestedStatus !== 'blocked', problems, validation: null }
  }
  if (!knowledgeVerified) problems.push('知识正文或节/规则字段没有核对通过：无法证明结论引用的是哪一版规则')

  // ── 4b. Listing reference (`listing-reference`): at most partial, never completed ─────────────
  //
  // Listing references skip the formal template / workbook / Excel recalculation gates (they only
  // average listed asking prices), but the input digest, knowledge, blockers, value scopes,
  // evidence, calculation, report data and artifact manifest checks still apply.
  if (facts.valuationMode === 'listing-reference') {
    if (!knowledgeVerified) {
      return {
        ...base, ok: true, status: 'blocked',
        downgraded: statusRank[facts.requestedStatus] > statusRank['blocked'],
        problems, validation: null,
      }
    }
    const reference = facts.reference ?? null
    const referenceProblems: string[] = reference === null
      ? ['挂牌参考交付缺少已验证的参考事实：不能按参考口径交付']
      : [...reference.problems]
    const referenceIds = new Set(reference?.objectIds ?? [])
    const expectedIds = facts.objects.objectIds
    const missingReferenceIds = expectedIds.filter((id) => !referenceIds.has(id))
    const extraReferenceIds = [...referenceIds].filter((id) => !expectedIds.includes(id))
    if (reference !== null && reference.verified !== true && referenceProblems.length === 0) {
      referenceProblems.push('挂牌参考未经 Host 验证：不能按参考口径交付')
    }
    if (missingReferenceIds.length > 0 || extraReferenceIds.length > 0) {
      referenceProblems.push(
        '挂牌参考覆盖的对象与本方案对象不一致：'
        + `缺 ${missingReferenceIds.join('、') || '无'}；多 ${extraReferenceIds.join('、') || '无'}`)
    }
    if (referenceProblems.length > 0) {
      return {
        ...base, ok: true, status: 'blocked',
        downgraded: statusRank[facts.requestedStatus] > statusRank['blocked'],
        problems: [...problems, ...referenceProblems], validation: null,
      }
    }

    const referenceInvalidEvidence = facts.evidence.entries.filter(
      (item) => item.validity === 'invalid' || item.validity === 'missing')
    if (facts.evidence.required && facts.evidence.entries.length === 0) {
      problems.push('知识要求页面截图，但没有任何有效截图证据')
    }
    if (facts.evidence.required && referenceInvalidEvidence.length > 0) {
      problems.push(`有 ${String(referenceInvalidEvidence.length)} 条截图证据失效：${referenceInvalidEvidence.map((item) => item.caseId).join('、')}`)
    }
    if (!(facts.calculation.verified && facts.calculation.steps > 0)) {
      problems.push('计算轨迹缺失或未通过校验：数字必须由脚本算出并可复算')
    }
    if (!facts.report.rendered) problems.push('报告还没有渲染')
    for (const problem of facts.report.schemaProblems) problems.push(`报告数据不合法：${problem}`)
    if (!facts.artifacts.manifestOk) problems.push('产物 manifest 核对未通过')
    if (facts.artifacts.missing.length > 0) problems.push(`产物缺失：${facts.artifacts.missing.join('、')}`)

    return {
      ...base, ok: true, status: 'partial',
      downgraded: statusRank[facts.requestedStatus] > statusRank['partial'],
      problems, validation: null,
    }
  }

  const templateVerified = facts.template !== null
    && facts.template.structureOk
    && facts.template.digest === facts.template.expectedDigest
  if (facts.template === null) problems.push('没有可用的计算表模板：空目录 / TODO 标题 / 预留正文都不算已发布模板')
  else if (facts.template.digest !== facts.template.expectedDigest) {
    problems.push(`模板指纹与索引不一致（模板 ${facts.template.digest}，索引 ${facts.template.expectedDigest}）`)
  } else if (!facts.template.structureOk) {
    problems.push('模板结构未通过（ZIP/工作簿结构、公式区或输入映射不符）')
  }

  const conclusionObjectIds = new Set(facts.objects.conclusions.map((item) => text(item.objectId)))
  const missingConclusions = facts.objects.objectIds.filter((id) => !conclusionObjectIds.has(id))
  if (facts.objects.conclusions.length === 0) problems.push('没有任何对象结论')
  // 多对象必须逐对象有结论：用一条汇总金额代表多个对象是"看起来完成了"。
  if (missingConclusions.length > 0) problems.push(`缺少对象结论：${missingConclusions.join('、')}`)

  const evidenceRequired = facts.evidence.required
  const invalidEvidence = facts.evidence.entries.filter((item) => item.validity === 'invalid' || item.validity === 'missing')
  const evidenceVerified = !evidenceRequired || (facts.evidence.entries.length > 0 && invalidEvidence.length === 0)
  if (evidenceRequired && facts.evidence.entries.length === 0) problems.push('知识要求页面截图，但没有任何有效截图证据')
  if (evidenceRequired && invalidEvidence.length > 0) {
    problems.push(`有 ${String(invalidEvidence.length)} 条截图证据失效：${invalidEvidence.map((item) => item.caseId).join('、')}`)
  }

  const calculationVerified = facts.calculation.verified && facts.calculation.steps > 0
  if (!calculationVerified) problems.push('计算轨迹缺失或未通过校验：数字必须由脚本算出并可复算')

  const workbooksOk = facts.workbooks.length > 0
  if (!workbooksOk) problems.push('没有任何计算表交付件')

  // 重算能力是**硬门禁**：`completed` 表示"数字与底稿都核对过"。
  const ceiling = statusCeilingFromRecalculation(facts.recalculation)
  const recalculationOk = ceiling === 'completed'
  if (!recalculationOk) {
    problems.push(`计算表未完成重算核对（${facts.recalculation.state}）：${facts.recalculation.reason}`)
  }

  const reportOk = facts.report.rendered && facts.report.schemaProblems.length === 0
  if (!facts.report.rendered) problems.push('报告还没有渲染')
  for (const problem of facts.report.schemaProblems) problems.push(`报告数据不合法：${problem}`)

  const artifactsOk = facts.artifacts.manifestOk && facts.artifacts.missing.length === 0
  if (!facts.artifacts.manifestOk) problems.push('产物 manifest 核对未通过')
  if (facts.artifacts.missing.length > 0) problems.push(`产物缺失：${facts.artifacts.missing.join('、')}`)

  const allVerified = knowledgeVerified && templateVerified && missingConclusions.length === 0
    && facts.objects.conclusions.length > 0 && evidenceVerified && calculationVerified
    && workbooksOk && recalculationOk && reportOk && artifactsOk

  if (!allVerified) {
    // 缺知识/模板 → blocked（补齐规则才能继续）；其余缺口 → partial（工作没做完）。
    const blockingRules = !knowledgeVerified || !templateVerified
    const status: ReportStatus = blockingRules ? 'blocked' : 'partial'
    return {
      ...base,
      ok: true,
      status,
      downgraded: statusRank[facts.requestedStatus] > statusRank[status],
      problems,
      validation: null,
    }
  }

  return {
    ...base,
    ok: true,
    status: 'completed',
    downgraded: false,
    problems: [],
    validation: {
      projectId: facts.projectId,
      planId: facts.planId,
      inputDigest: facts.inputDigest.recomputed,
      knowledgeVerified,
      templateVerified,
      evidenceVerified,
      calculationVerified,
      workbookRecalculated: recalculationOk,
      reportRendered: facts.report.rendered,
      verifiedAt: facts.verifiedAt,
      notes: facts.evidence.required ? [] : ['知识未要求页面截图：截图证据按「不适用」处理'],
    },
  }
}

export interface ProjectFinalizeInput {
  projectId: string
  /** 逐方案的 finalize 回执。 */
  plans: readonly FinalizeReceipt[]
  /** 项目级门槛（通用规则缺失等）。 */
  projectBlockers: readonly Blocker[]
  verifiedAt: string
}

export interface ProjectFinalizeReceipt {
  ok: boolean
  projectId: string
  status: ReportStatus
  perPlan: Array<{ planId: string; status: ReportStatus }>
  problems: string[]
  /**
   * 项目是否把**被阻断/部分完成方案**的中间金额计入了总价。
   *
   * 恒为 `false`：一个方案中断不停止可独立的其他方案，但中断方案的中间金额
   * 绝不能被汇总成项目结论。
   */
  conclusionIncludesBlockedAmount: boolean
  /** 可以合计的对象结论（只含 `completed` 方案的结论）。 */
  aggregatablePlanIds: string[]
  verifiedAt: string
}

/**
 * 项目级汇总。
 *
 * 两条口径：
 * 1. **一个方案中断不停止可独立的其他方案**：`project.status = partial`，其余方案照常有结论；
 * 2. **项目金额只在允许时合计**：只有 `completed` 的方案的结论才进入可合计集合；
 *    被阻断方案的中间金额**不进总价**（否则"中断"会变成一个更好看的总价）。
 */
export function finalizeProject(input: ProjectFinalizeInput): ProjectFinalizeReceipt {
  const problems: string[] = []
  for (const blocker of input.projectBlockers) problems.push(`[项目级/${blocker.kind}] ${blocker.reason}`)

  const perPlan = input.plans.map((receipt) => ({ planId: receipt.planId, status: receipt.status }))
  const completed = input.plans.filter((receipt) => receipt.status === 'completed')
  const blocked = input.plans.filter((receipt) => receipt.status === 'blocked')
  const partial = input.plans.filter((receipt) => receipt.status === 'partial')
  const hardFail = input.plans.filter((receipt) => receipt.status === 'failed' || receipt.status === 'cancelled')

  for (const receipt of input.plans) {
    for (const problem of receipt.problems) problems.push(`${receipt.planId}：${problem}`)
  }

  let status: ReportStatus
  if (input.projectBlockers.length > 0 || input.plans.length === 0) status = 'blocked'
  else if (hardFail.length > 0) status = 'failed'
  else if (blocked.length > 0 || partial.length > 0) status = 'partial'
  else status = 'completed'

  return {
    ok: true,
    projectId: input.projectId,
    status,
    perPlan,
    problems,
    // 断言式的恒 false：被阻断方案的中间金额不进项目结论。
    conclusionIncludesBlockedAmount: false,
    // 项目级通用规则缺失时**一个方案的金额都不许合计** —— 那类规则缺失影响的是整个项目，
    // 不是某一个方案；这时把已完成方案的金额汇总出来，等于用一份不可核对的规则出总价。
    aggregatablePlanIds: input.projectBlockers.length > 0 ? [] : completed.map((receipt) => receipt.planId),
    verifiedAt: input.verifiedAt,
  }
}
