import { text } from '../../../../shared/utils/value.ts'
import type {
  AdoptedMethod,
  Blocker,
  PropertyType,
  ValuationPath,
} from '../../../../shared/contracts/valuation-project.ts'

/**
 * 方案的**结构性阻断**与**逐方法技术能力事实**（协议 39 起改判）。
 *
 * ## 这一代删掉了什么
 *
 * 旧实现把"只支持住宅 + 市场法"写成一道**覆盖门禁**：非住宅的物业类型直接
 * `property-unsupported`，收益法 / 成本法直接 `method-unsupported`。两处都越权了：
 *
 * - **物业类型是不是住宅**是**业务分类**（原始登记用途 + 业务规则 + 资料依据），
 *   由本轮知识正文判定，不由代码里的一个白名单判定；
 * - **某个方法能不能跑**是**能力事实**（正文、参数、模板、计算引擎是否到位），
 *   它随着知识库与适配器的进展变化 —— 写死在代码里会让"知识补了一章"必须发一次版。
 *
 * 取而代之：这里只回答四件**结构**问题 ——
 *
 * 1. 房地权益边界未解 → 请在会话内确认（不是自行选路径）；
 * 2. 房地分别评估 → 土地 / 建筑物专门能力当前不存在 → 阻断该方案（防重复计价）；
 * 3. 逐方法的技术能力事实（`methodCapabilities`）：能不能跑完整链路、缺什么、要哪些能力 ID；
 * 4. 降级而非阻断的能力（本地重算引擎缺席）。
 *
 * ## 缺一个方法**不误伤**别的方法
 *
 * 方法级的缺口只影响该方法：`validateMethodAssessment` 采用"能跑的照跑、不能跑的记缺口"。
 * 只有当**一个能跑的方法都没有**时，方案才整体阻断。物业类型与业务适用性都不再产生 blocker。
 *
 * 这里仍然**不含任何业务阈值**（面积区间、税费率、案例最少数量）：那些来自本轮知识快照。
 */

/**
 * 当前部署里**能跑完整链路**的方法（能力事实，不是业务规则）。
 *
 * 「完整链路」= 方法正文可执行 + 参数有出处 + 有已验证的计算表模板 + 有受控计算能力。
 * 它是**部署能力清单**，因此：
 *
 * - 知识库补齐收益法 / 成本法的正文、参数、模板并验收计算之后，这里加一项即可（无需改业务口径）；
 * - 调用方（工具装配层）可以传入**实测**的清单覆盖它，而不是靠本文件猜。
 *
 * ⚠️ 它**不是**"业务上只该用市场法"：业务适用性由本轮知识的选择方案回答。
 */
export const DEFAULT_IMPLEMENTED_METHODS: readonly AdoptedMethod[] = ['market']

/** 每个方法跑完整链路需要的技术能力 ID（Host 侧技术合同键）。 */
export const METHOD_CAPABILITIES: Record<AdoptedMethod, readonly string[]> = {
  market: [
    'knowledge.realestate.catalog',
    'knowledge.realestate.method-selection',
    'browser.auth.status',
    'market.residential.search',
    'market.residential.detail',
    'browser.page.screenshot',
    'parameters.market-index.read',
    'template.xlsx.materialize',
    'valuation.market.calculate',
  ],
  income: [
    'knowledge.realestate.catalog',
    'knowledge.realestate.method-selection',
    'parameters.income.read',
    'template.xlsx.materialize',
    'valuation.income.calculate',
  ],
  cost: [
    'knowledge.realestate.catalog',
    'knowledge.realestate.method-selection',
    'parameters.cost.read',
    'template.xlsx.materialize',
    'valuation.cost.calculate',
  ],
}

/**
 * 能力缺失**不阻断**、只降级的能力。
 *
 * `workbook.recalculate` 是唯一的例子：没有本地重算 provider 时仍要产出公式正确的底稿，
 * 但状态只能是 `partial`。把它混进必需清单会让"缺 Excel"直接变成业务失败。
 */
export const DEGRADABLE_CAPABILITIES: readonly string[] = ['workbook.recalculate']

/** 未来土地估值的候选 Skill 名。本期只作为**不满足条件的证据**出现，不创建空壳 Skill。 */
export const LAND_SKILL_CANDIDATE = 'crwu-biz-valuation-land'

/** 未来建筑物专门方法的候选能力 ID（同样只是预留映射）。 */
export const BUILDING_ONLY_CAPABILITY_CANDIDATE = 'valuation.building-only.calculate'

export interface CoverageInput {
  propertyType: string
  /** 用户请求或知识选定的方法。 */
  method: string
  valuationPath: ValuationPath
  /** 实测的"能跑完整链路的方法"清单；缺省用部署默认。 */
  implementedMethods?: readonly AdoptedMethod[]
}

/** 一个方法的技术能力事实（**不是**业务适用性）。 */
export interface MethodCapability {
  method: AdoptedMethod
  /** 当前部署能不能跑完整链路。 */
  executable: boolean
  /** 需要的技术能力 ID（可执行与不可执行都列，好让"补齐清单"是具体 ID）。 */
  capabilities: string[]
  /** 不能执行时的原因（**能力缺口**，不是"业务不适用"）。 */
  gap: string
}

export interface CoverageResult {
  /** 只有**结构性**问题会让它为假（路径未解 / 分别评估缺组件能力）。 */
  supported: boolean
  requiredCapabilities: string[]
  degradableCapabilities: string[]
  blockers: Blocker[]
  /** 逐方法的能力事实：方法判定层据此决定"采用 / 记缺口"，而不是靠硬编码白名单。 */
  methodCapabilities: MethodCapability[]
}

/** 取值是否是一个合法物业类型（模型/资料提交的值一律走这里收窄）。 */
export function isPropertyType(value: unknown): value is PropertyType {
  const raw = text(value)
  return (['residential', 'commercial', 'office', 'industrial', 'apartment', 'other'] as readonly string[]).includes(raw)
}

/** 取值是否是一个合法方法请求（必须是一个指定方法）。 */
export function isMethodRequest(value: unknown): value is 'market' | 'income' | 'cost' {
  return (['market', 'income', 'cost'] as readonly string[]).includes(text(value))
}

function separatePathBlocker(): Blocker {
  return {
    kind: 'valuation-path-unsupported',
    stage: 'method-selection',
    code: 'valuation.coverage.separate-path-unsupported',
    missing: [
      `土地专门能力（候选 Skill ${LAND_SKILL_CANDIDATE} 尚未实现）`,
      `仅建筑物能力（候选能力 ${BUILDING_ONLY_CAPABILITY_CANDIDATE} 尚未实现）`,
    ],
    checked: [
      `capability:${LAND_SKILL_CANDIDATE}`,
      `capability:${BUILDING_ONLY_CAPABILITY_CANDIDATE}`,
      'knowledge:01 估值与测算/01 房地产/02 估值方法/01 房地产评估方法选择方案（房地合一与房地分别评估）',
    ],
    reason: '知识判定本方案需要房地分别评估，而土地与建筑物各自独立的取值能力当前都未实现。'
      + '继续走下去只可能把土地价值重复计入含地价的住宅市场法结论，因此必须阻断。',
    remediation: `先实现并验证 ${LAND_SKILL_CANDIDATE}（或仅建筑物方法）的 Skill、结构化 Tool、知识入口与模板，`
      + '再按 land-only / building-only / land-and-building 三个互斥价值范围重跑本方案；'
      + '本期只交付说明原因的中断报告，不给出金额。',
  }
}

function unresolvedPathBlocker(): Blocker {
  return {
    kind: 'valuation-path-unresolved',
    stage: 'grouping',
    code: 'valuation.coverage.valuation-path-unresolved',
    missing: ['房地产权益边界（土地与建筑物是否分别评估）的确认结论'],
    checked: [
      'knowledge:01 估值与测算/01 房地产/02 估值方法/01 房地产评估方法选择方案',
      'materials:权属/权利类型/土地信息字段',
    ],
    reason: '资料里的权利类型或土地信息互相冲突，或不足以判断房地合一还是分别评估；'
      + '自行选路径会直接影响价值范围。',
    remediation: '在本估值会话内直接向员工确认房地权益边界后继续（同一会话、同一冻结输入，不重传资料、不重建会话）。',
  }
}

/** 逐方法的能力事实（缺省用一个明确的部署默认清单）。 */
export function methodCapabilitiesOf(
  implementedMethods: readonly AdoptedMethod[] = DEFAULT_IMPLEMENTED_METHODS,
): MethodCapability[] {
  return (['market', 'income', 'cost'] as const).map((method) => {
    const executable = implementedMethods.includes(method)
    return {
      method,
      executable,
      capabilities: [...METHOD_CAPABILITIES[method]],
      gap: executable
        ? ''
        : `方法「${method}」当前部署里没有完整的可执行链路（正文 / 参数 / 已验收模板 / 计算能力之一缺失）：`
          + '这是**能力缺口**，不是"业务上不适用"。补齐知识并验收计算能力之后即可执行。',
    }
  })
}

/**
 * 判定这套组合有没有**结构性**阻断，并给出逐方法的能力事实。
 *
 * 物业类型**不再**产生 blocker：它是不是住宅由本轮知识按资料依据判定（P15 已把
 * "原始登记用途"与"业务分类"分成两个字段）。一个不认识的分类在方法判定阶段表现为
 * "没有可用的方法路径"，而不是在这里被一个白名单拒掉。
 */
export function assessCoverage(input: CoverageInput): CoverageResult {
  const valuationPath: ValuationPath = input.valuationPath

  const blockers: Blocker[] = []
  const required = new Set<string>()
  const degradable = new Set<string>()

  if (valuationPath === 'separate') {
    blockers.push(separatePathBlocker())
  } else if (valuationPath === 'unresolved') {
    blockers.push(unresolvedPathBlocker())
  }

  const methodCapabilities = methodCapabilitiesOf(input.implementedMethods)

  // 能力清单：路径可执行时按方法登记；被阻断的组合也照列，好让"补齐清单"是具体的能力 ID。
  if (valuationPath === 'combined') {
    for (const item of methodCapabilities) required.add(item.capabilities[0] ?? '')
    for (const id of METHOD_CAPABILITIES.market) required.add(id)
    if (methodCapabilities.some((item) => item.method === 'income' && item.executable)) {
      for (const id of METHOD_CAPABILITIES.income) required.add(id)
    }
    if (methodCapabilities.some((item) => item.method === 'cost' && item.executable)) {
      for (const id of METHOD_CAPABILITIES.cost) required.add(id)
    }
    required.delete('')
  }

  // 房地分别的组件能力在被阻断时也要登记，好让"补齐清单"是具体的能力 ID。
  if (valuationPath === 'separate') {
    required.add(LAND_SKILL_CANDIDATE)
    required.add(BUILDING_ONLY_CAPABILITY_CANDIDATE)
  }

  for (const id of DEGRADABLE_CAPABILITIES) degradable.add(id)

  return {
    supported: blockers.length === 0,
    requiredCapabilities: [...required],
    degradableCapabilities: [...degradable],
    blockers,
    methodCapabilities,
  }
}
