import { text } from '../../../../shared/utils/value.ts'
import type {
  AdoptedMethod,
  Blocker,
  KnowledgeRef,
  MethodAssessment,
  MethodRequest,
  PlanAssessment,
  ValuationPlan,
} from '../../../../shared/contracts/valuation-project.ts'
import { assessCoverage, type CoverageResult } from './coverage.ts'

/**
 * 方案的方法判定（设计稿 §7.2，计划 Task 6）。
 *
 * ## 三种状态必须分开
 *
 * 1. **业务不适用**（`applicable === false`）：知识选择方案说这个方法不适合这个方案；
 * 2. **未实现**（`applicable === true` 且 `implemented === false`）：业务上适用，但当前实现
 *    没有可执行的方法正文/模板/能力；
 * 3. **采用**（`selected === true`）。
 *
 * 把 2 说成 1 是这条链路上最贵的一句话：「成本法软件未支持，因此业务不适用」——
 * 报告读起来完全合理，而它是把**能力缺口**写成了**业务结论**。所以这里对二者分别产出
 * 不同的 blocker 文案，而且都不许"那就改用市场法"。
 *
 * ## 用户指定的方法是**约束**，不是建议
 *
 * `methodRequest` 是 market / income / cost 时，结论必须采纳它，或者如实记一条 `methodConflict`
 * 并请员工确认。悄悄换成别的方法，会让"用户要的是市场法"这件事在结果里彻底消失。
 *
 * ## 自动判断可以采用**单一或组合**方法（协议 39 改判）
 *
 * 旧实现在 `auto` 下恒取 `executable[0]` —— 于是知识里写"市场法与收益法互相校核"也只会跑一个。
 * 现在：**凡是知识判定适用、且当前部署能跑的方法都采用**；每个采用方法各有自己的
 * 依据、参数、案例、模板与结果，再由结果的协调段形成对象结论（**不相加、不默认平均**）。
 *
 * ## 缺一个方法**不误伤**别的方法
 *
 * 业务适用但当前跑不了的方法只记 `capabilityGaps` 与 `notes`，**不产生 blocker**；
 * 只有当**一个能跑的方法都没有**时，方案才整体阻断（否则会把一个能跑的方法拖死）。
 */

/** 一个方法的判定输入（来自知识 + 实现能力，**不含业务阈值**）。 */
export interface MethodFact {
  method: AdoptedMethod
  /** 知识选择方案判定它是否适用这个方案。 */
  applicable: boolean
  /** 引用知识快照的位置（判定依据）。 */
  ruleRefs?: KnowledgeRef[]
  /** 不适用的原因（知识正文里的话）。 */
  reason?: string
}

export interface MethodOutcome {
  ok: boolean
  assessment: PlanAssessment
  blockers: Blocker[]
  /** 用户指定方法与实际采纳不一致时的记录（必须在会话内确认）。 */
  methodConflict: { requested: MethodRequest; adopted: AdoptedMethod | null; reason: string } | null
  coverage: CoverageResult
  /**
   * 业务适用但当前部署跑不了的方法（能力缺口）。
   *
   * 它们**不是** blocker：只影响各自的方法，其余方法照常执行。
   */
  capabilityGaps: Array<{ method: AdoptedMethod; reason: string }>
}

function blockerOf(
  plan: ValuationPlan,
  kind: Blocker['kind'],
  method: AdoptedMethod,
  code: string,
  missing: string[],
  reason: string,
  remediation: string,
  ruleRefs: readonly KnowledgeRef[] = [],
): Blocker {
  return {
    kind,
    stage: 'method-selection',
    code,
    missing,
    checked: [
      'knowledge:01 估值与测算/01 房地产/02 估值方法/01 房地产评估方法选择方案',
      `coverage:${method}`,
      `plan:${plan.planId}`,
    ],
    reason,
    remediation,
    ...(ruleRefs.length === 0 ? {} : { knowledgeRef: ruleRefs[0] }),
  }
}

/**
 * 判定一个方案的方法。
 *
 * `facts` 是**知识选择方案给出的逐方法判定**（业务侧）；`implemented` 由实现能力决定，
 * 因此这里用 `assessCoverage` 回答"当前技术能不能跑" —— 两件事分开问、分开记。
 */
export function validateMethodAssessment(
  plan: ValuationPlan,
  facts: readonly MethodFact[],
  options: {
    /** 已经逐方法核对过实现能力时传进来；缺省按覆盖矩阵判。 */
    implementedOf?: (method: AdoptedMethod) => boolean
    /** 实测的"能跑完整链路"的方法清单（缺省用部署默认）。 */
    implementedMethods?: readonly AdoptedMethod[]
    decidedAt?: string
  } = {},
): MethodOutcome {
  const coverageOf = (method: AdoptedMethod): CoverageResult => assessCoverage({
    propertyType: plan.propertyType,
    method,
    valuationPath: plan.valuationPath,
    ...(options.implementedMethods === undefined ? {} : { implementedMethods: options.implementedMethods }),
  })
  const implementedOf = options.implementedOf
    ?? ((method: AdoptedMethod) => {
      const facts = coverageOf(method).methodCapabilities.find((item) => item.method === method)
      return facts?.executable === true
    })

  const assessments: MethodAssessment[] = facts.map((fact) => {
    const implemented = implementedOf(fact.method)
    return {
      method: fact.method,
      applicable: fact.applicable === true,
      implemented,
      selected: false,
      reason: text(fact.reason) || (fact.applicable === true
        ? (implemented ? '知识判定适用，且当前实现可完整执行' : '知识判定适用，但当前实现尚无完整正文/模板')
        : '知识选择方案判定不适用于本方案'),
      ruleRefs: (fact.ruleRefs ?? []).map((item) => ({ ...item })),
      conflicts: [],
    }
  })

  const requested = plan.methodRequest
  const executable = assessments.filter((item) => item.applicable && item.implemented)

  /**
   * 采用哪些方法。
   *
   * - 用户指定：**只**采纳它（不静默增补其它方法）；
   * - 自动判断：采纳**全部**"知识判定适用且当前能跑"的方法 —— 单一或组合，
   *   由知识与真实能力决定，不由"取数组第一项"决定。
   */
  const selectedList: MethodAssessment[] = requested === 'auto'
    ? executable
    : executable.filter((item) => item.method === requested)
  for (const item of selectedList) item.selected = true
  const selected: MethodAssessment | undefined = selectedList[0]

  const blockers: Blocker[] = []
  let methodConflict: MethodOutcome['methodConflict'] = null

  if (requested !== 'auto') {
    const requestedAssessment = assessments.find((item) => item.method === requested)
    if (selected === undefined) {
      const reason = requestedAssessment === undefined
        ? `方案 ${plan.planId} 的方法判定里没有出现用户指定的「${requested}」`
        : requestedAssessment.applicable
          ? `用户指定「${requested}」，但当前实现尚无该方法可执行的正文与计算表模板`
          : `用户指定「${requested}」，而知识选择方案判定它不适用于本方案：${requestedAssessment.reason}`
      methodConflict = { requested, adopted: null, reason }
      blockers.push(blockerOf(
        plan,
        'method-unsupported',
        requested,
        'valuation.method.requested-unavailable',
        [
          requestedAssessment?.applicable === true
            ? `方法「${requested}」的可执行正文与模板`
            : `方法「${requested}」对本方案的适用性依据`,
        ],
        reason,
        '请在会话内向员工说明冲突：要么补齐该方法的知识与模板后重跑本方案，要么由员工明确改为已实现的方法（会记入 methodConflict）。'
          + '**不得**因为未实现就直接改用市场法。',
        requestedAssessment?.ruleRefs ?? [],
      ))
    } else if (selected.method !== requested) {
      methodConflict = {
        requested,
        adopted: selected.method,
        reason: `用户指定「${requested}」，实际采纳「${selected.method}」`,
      }
      blockers.push(blockerOf(
        plan, 'method-unsupported', selected.method, 'valuation.method.requested-not-honored',
        [`按用户指定的「${requested}」出具结论的依据`],
        methodConflict.reason,
        '用户指定的方法是约束：请在会话内请员工确认是否可以改用其它方法，确认之前不要出具结论。',
      ))
    }
  }

  // 业务适用但当前跑不了：这是**能力缺口**，不是"业务不适用"，也不是整体阻断 ——
  // 只记缺口，让能跑的方法继续（"缺一方法不误伤其他方法"）。
  const capabilityGaps: Array<{ method: AdoptedMethod; reason: string }> = []
  for (const item of assessments) {
    if (!item.applicable || item.implemented) continue
    const reason = `知识选择方案判定「${item.method}」适用于本方案，但当前部署没有完整的可执行链路`
      + '（正文 / 参数 / 已验收模板 / 计算能力之一缺失）。「软件尚未支持」与「方法不适用」是两件事。'
    item.conflicts.push(reason)
    capabilityGaps.push({ method: item.method, reason })
  }
  // 一个能跑的方法都没有才阻断整方案（否则"缺一个方法"会把别的方法一起拖死）。
  if (selectedList.length === 0 && requested === 'auto') {
    blockers.push(blockerOf(
      plan, 'method-unsupported', 'market', 'valuation.method.none-executable',
      ['至少一个可执行的方法正文与计算表模板'],
      '知识选择方案给出的方法里，当前部署一个都跑不了：没有可执行的正文 / 参数 / 模板 / 计算能力。',
      '请业务负责人补齐至少一个方法的正文、参数与模板并验收计算能力后重跑本方案；'
        + '本期只交付说明原因的中断报告，不给出金额。',
    ))
  }

  const selectedMethods = assessments.filter((item) => item.selected).map((item) => item.method)
  const primary = selected?.method ?? null
  const coverage = coverageOf(requested === 'auto' ? (primary ?? 'auto') : requested)
  // 覆盖矩阵里的路径/物业类型阻断同样属于方法判定阶段的结果。
  for (const blocker of coverage.blockers) blockers.push(blocker)

  const assessment: PlanAssessment = {
    planId: plan.planId,
    methodRequest: requested,
    primaryMethod: primary,
    selectedMethods,
    assessments,
    requestedMethodHonored: requested === 'auto' || (selected !== undefined && selected.method === requested),
    notes: [
      ...(facts.length === 0 ? ['知识选择方案没有给出任何方法判定：无法确定方法'] : []),
      ...capabilityGaps.map((item) => item.reason),
    ],
    decidedAt: text(options.decidedAt) || new Date().toISOString(),
  }

  return {
    ok: blockers.length === 0 && selectedMethods.length > 0,
    assessment,
    blockers,
    methodConflict,
    coverage,
    capabilityGaps,
  }
}

/** 方案是否至少有一个可执行且被采纳的方法。 */
export function hasExecutableMethod(outcome: MethodOutcome): boolean {
  return outcome.assessment.primaryMethod !== null
}
