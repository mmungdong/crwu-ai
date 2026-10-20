import { text } from '../../../../shared/utils/value.ts'
import type {
  Blocker,
  MethodRequest,
  PropertyType,
  ValuationObject,
  ValuationPath,
  ValuationPlan,
} from '../../../../shared/contracts/valuation-project.ts'
import { safeIdSegment } from './contracts.ts'
import { isMethodRequest } from './coverage.ts'

/**
 * 项目 → 方案的**分组校验**（设计稿 §7.1，计划 Task 6）。
 *
 * ## 为什么分组必须由 Host 校验，而不是听父会话说什么就是什么
 *
 * 分组的后果是**结论的形状**：一个方案里的对象会被同一套方法、同一套参数口径处理。
 * 把"同小区"当成"可以共用计价面积/权益/案例权重"是这条链路上最贵的错误 ——
 * 三套面积不同的住宅被合在一张表里，算出来的单价看着正常，而它是错的。
 *
 * 所以这里只做**结构校验**，业务判定仍然引用知识快照：
 *
 * - 「同小区 / 同地域」只作为**候选分组信号**（进 `groupReason` 与证据引用），不是合并依据；
 * - 合并必须满足规则兼容：物业类型、评估目的、价值类型、基准日、权益/价税口径、市场范围；
 * - 有冲突就**如实报冲突**（`conflicts[]`），由父会话在原生会话里问员工，不自动合并；
 * - 没有归属的对象、被两个方案同时认领的对象都是冲突，不是"忽略即可"。
 *
 * 这里**不含任何业务阈值**：兼容字段清单是技术结构，字段的取值来自资料与知识快照。
 */

/**
 * 同一方案内必须一致的兼容字段。
 *
 * 是**技术结构**而不是业务规则：它回答"哪些字段不同就不该合在一个方案里"。
 * 具体该填什么（用途口径、价值类型、价税内涵）来自业务知识库。
 */
export const GROUPING_KEYS = [
  { key: 'propertyType', label: '物业类型' },
  { key: 'purpose', label: '评估目的' },
  { key: 'valueType', label: '价值类型' },
  { key: 'baseDate', label: '基准日' },
  { key: 'rightsBasis', label: '权益与价税口径' },
  { key: 'marketScope', label: '市场范围' },
] as const

export type GroupingKey = (typeof GROUPING_KEYS)[number]['key']

/** 父会话给出的一个分组提议。字段缺省表示"尚未识别"，不是"空就是一致"。 */
export interface PlanProposal {
  planId?: string
  title?: string
  objectIds: string[]
  propertyType?: PropertyType | string
  purpose?: string
  valueType?: string
  baseDate?: string | null
  rightsBasis?: string
  marketScope?: string
  valuationPath?: ValuationPath
  methodRequest?: MethodRequest
  groupReason?: string
  groupEvidenceRefs?: string[]
}

export type GroupingConflictKind =
  | 'unassigned-object'
  | 'unknown-object'
  | 'duplicate-membership'
  | 'empty-plan'
  | 'missing-method'
  | 'unclassified-object'
  | 'incompatible-field'

export interface GroupingConflict {
  kind: GroupingConflictKind
  /** 冲突涉及的字段（`unassigned-object` 等结构冲突为空串）。 */
  field: string
  label: string
  objectIds: string[]
  values: Array<{ objectId: string; value: string }>
  reason: string
  /** 处置建议：**不是**自动动作，是给父会话向员工提问时用的措辞。 */
  resolution: string
}

export interface GroupingOutcome {
  ok: boolean
  plans: ValuationPlan[]
  conflicts: GroupingConflict[]
  unassignedObjectIds: string[]
  unknownObjectIds: string[]
  duplicateObjectIds: string[]
  /** 因为**业务分类依据缺失**而挂起的对象（不进任何方案，但如实列出来）。 */
  suspendedObjectIds: string[]
  notes: string[]
}

/**
 * 业务分类依据是否到位（P15）。
 *
 * 依据缺失时该对象**挂起**：既不按名字猜一个物业类型，也不让整轮停摆 —— 其余对象照常继续。
 * 判据只看"有没有依据"，不看名称里出现什么字（"公寓"不是依据）。
 */
function classificationBasisMissing(object: ValuationObject): boolean {
  return text(object.propertyType) === '' || text(object.classificationBasis) === ''
}

function valueOf(proposal: PlanProposal, key: GroupingKey, object: ValuationObject): string {
  switch (key) {
    case 'propertyType':
      // 物业类型**优先看对象自己的识别结果**：提议里写一个统一值，不该让"住宅 + 商业"
      // 两个对象看起来一致 —— 那正是"合在一个方案里"最容易发生的方式。
      return text(object.propertyType) || text(proposal.propertyType)
    case 'baseDate':
      return text(proposal.baseDate)
    case 'purpose': return text(proposal.purpose)
    case 'valueType': return text(proposal.valueType)
    case 'rightsBasis': return text(proposal.rightsBasis)
    case 'marketScope': return text(proposal.marketScope)
  }
}

/**
 * 校验一次分组提议。
 *
 * 返回**归一化后的方案**（`objectIds` 去重且按输入顺序稳定、`conflicts` 已填好），
 * 让后续方法判定与任务图有一份确定的对象集合。
 */
export function validateGrouping(
  objects: readonly ValuationObject[],
  proposals: readonly PlanProposal[],
  options: { planIdPrefix?: string } = {},
): GroupingOutcome {
  const prefix = text(options.planIdPrefix) || 'plan'
  const byId = new Map(objects.map((object) => [object.objectId, object]))
  const conflicts: GroupingConflict[] = []
  const unassignedObjectIds: string[] = []
  const unknownObjectIds: string[] = []
  const duplicateObjectIds: string[] = []
  const suspendedObjectIds: string[] = []
  const notes: string[] = []
  const membership = new Map<string, string[]>()

  // P15：**业务分类必须有依据**。没有依据的对象挂起（不进任何方案），其余对象继续。
  // 为什么先做这一步：`propertyType` 缺失时如果落到"默认住宅"，整个方案会按住宅模板算下去，
  // 而报告上看起来一切正常 —— 那正是"名称里有公寓就套住宅"最贵的形态。
  for (const object of objects) {
    if (!classificationBasisMissing(object)) continue
    suspendedObjectIds.push(object.objectId)
    conflicts.push({
      kind: 'unclassified-object',
      field: 'classificationBasis',
      label: '业务分类依据',
      objectIds: [object.objectId],
      values: [{
        objectId: object.objectId,
        value: text(object.propertyType) || `登记用途：${text(object.registeredUse) || '（未读到）'}`,
      }],
      reason: `对象 ${object.objectId} 缺少业务分类依据：`
        + `原始权证登记用途「${text(object.registeredUse) || '未读到'}」、`
        + `业务分类「${text(object.propertyType) || '未判定'}」。`
        + '名称里的字样（例如「公寓」）不构成分类依据。',
      resolution: '请补齐登记用途 / 规划用途与实际使用，并写明业务分类的依据（含资料坐标）；'
        + '该对象在依据补齐前挂起，其余对象照常测算。',
    })
  }

  for (const proposal of proposals) {
    // 方法必须由用户明确选择：提案不带方法（或带已移除的 auto）时**不建方案**，
    // 让它的对象落回"没有归属"并由冲突如实登记，而不是替用户默认一个方法。
    if (!isMethodRequest(proposal.methodRequest)) {
      conflicts.push({
        kind: 'missing-method',
        field: 'methodRequest',
        label: '评估方法',
        objectIds: (proposal.objectIds ?? []).map((item) => text(item)).filter((id) => id !== ''),
        values: [],
        reason: `方案 ${text(proposal.planId) || '(未铸号)'} 没有指定评估方法：`
          + `收到「${text(proposal.methodRequest) || '空'}」，而方法必须由用户在选择页明确指定。`,
        resolution: '请在会话内请员工明确选择市场法 / 收益法 / 成本法之一，再重新提交分组。',
      })
      continue
    }
    const seen = new Set<string>()
    for (const raw of proposal.objectIds ?? []) {
      const objectId = text(raw)
      if (objectId === '') continue
      if (!byId.has(objectId)) {
        if (!unknownObjectIds.includes(objectId)) unknownObjectIds.push(objectId)
        continue
      }
      // 挂起的对象不进任何方案：它还没有业务分类依据，按哪套口径算都是猜的。
      if (suspendedObjectIds.includes(objectId)) continue
      if (seen.has(objectId)) {
        notes.push(`方案内对象重复出现，已去重：${objectId}`)
        continue
      }
      seen.add(objectId)
      const owners = membership.get(objectId) ?? []
      owners.push(text(proposal.planId) || '(未铸号)')
      membership.set(objectId, owners)
    }
  }

  for (const [objectId, owners] of membership) {
    if (owners.length > 1) {
      duplicateObjectIds.push(objectId)
      conflicts.push({
        kind: 'duplicate-membership',
        field: '',
        label: '对象归属',
        objectIds: [objectId],
        values: owners.map((owner, index) => ({ objectId: `方案${String(index + 1)}`, value: owner })),
        reason: `同一个对象被 ${String(owners.length)} 个方案同时认领：${objectId}`,
        resolution: '请员工确认这个对象属于哪一个方案；在确认之前不合并、也不重复计算它。',
      })
    }
  }

  for (const object of objects) {
    // 挂起与"没有归属"是两件事：前者有明确处置（等依据），后者是分组漏了。
    if (suspendedObjectIds.includes(object.objectId)) continue
    if (!membership.has(object.objectId)) unassignedObjectIds.push(object.objectId)
  }
  for (const objectId of unassignedObjectIds) {
    conflicts.push({
      kind: 'unassigned-object',
      field: '',
      label: '对象归属',
      objectIds: [objectId],
      values: [],
      reason: `对象 ${objectId} 没有被任何方案认领`,
      resolution: '请在会话内把该对象归入某个方案，或明确说明它与本轮估值无关（例如不是本项目的估价对象）。',
    })
  }
  for (const objectId of unknownObjectIds) {
    conflicts.push({
      kind: 'unknown-object',
      field: '',
      label: '对象归属',
      objectIds: [objectId],
      values: [],
      reason: `方案里出现了未识别过的对象：${objectId}`,
      resolution: '对象清单由资料识别结果决定；未识别的 id 不能凭空进入方案，请先修正识别结果。',
    })
  }

  const plans: ValuationPlan[] = []
  proposals.forEach((proposal, index) => {
    // 方法缺失的提案已在上面登记冲突，这里不再为它建方案。
    if (!isMethodRequest(proposal.methodRequest)) return
    const objectIds = [...new Set((proposal.objectIds ?? []).map((item) => text(item))
      .filter((id) => byId.has(id) && !suspendedObjectIds.includes(id)))]
    const planId = text(proposal.planId) || `${prefix}-${String(index + 1).padStart(3, '0')}`
    const planConflicts: string[] = []
    if (objectIds.length === 0) {
      conflicts.push({
        kind: 'empty-plan',
        field: '',
        label: '方案对象',
        objectIds: [],
        values: [],
        reason: `方案 ${planId} 里没有任何已识别的对象`,
        resolution: '空方案不参与估值；请删除它，或补上它实际要估的对象。',
      })
      planConflicts.push('方案里没有任何已识别的对象')
    }

    const planObjects = objectIds.map((id) => byId.get(id)).filter((item): item is ValuationObject => item !== undefined)
    for (const { key, label } of GROUPING_KEYS) {
      const values = planObjects.map((object) => ({ objectId: object.objectId, value: valueOf(proposal, key, object) }))
      const distinct = [...new Set(values.map((item) => item.value))]
      if (distinct.length <= 1) continue
      const identifiers = values.filter((item) => item.value !== '')
      conflicts.push({
        kind: 'incompatible-field',
        field: key,
        label,
        objectIds: objectIds,
        values,
        reason: `方案 ${planId} 内「${label}」不一致：${values.map((item) => `${item.objectId}=${item.value || '（未识别）'}`).join('；')}`,
        resolution: identifiers.length > 1
          ? `请按「${label}」拆成多个方案，或在会话内确认统一口径后再合并。`
          : `「${label}」对部分对象缺失：先补齐资料，不要按已有对象的口径替它们填。`,
      })
      planConflicts.push(`${label}不一致`)
    }

    plans.push({
      planId,
      title: text(proposal.title) || `方案 ${String(index + 1)}`,
      propertyType: (text(proposal.propertyType) || text(planObjects[0]?.propertyType) || 'other') as PropertyType,
      objectIds,
      methodRequest: proposal.methodRequest as MethodRequest,
      methodAssessment: null,
      baseDate: text(proposal.baseDate) === '' ? null : text(proposal.baseDate),
      valuationPath: (text(proposal.valuationPath) || 'combined') as ValuationPath,
      groupReason: text(proposal.groupReason),
      groupEvidenceRefs: (proposal.groupEvidenceRefs ?? []).map((item) => text(item)).filter((item) => item !== ''),
      conflicts: planConflicts,
      status: planConflicts.length === 0 ? 'ready-for-method-selection' : 'draft',
    })
  })

  if (plans.some((plan) => text(plan.groupReason).includes('小区'))) {
    notes.push('分组理由里提到"同小区/同地域"：它只是候选信号，不代表可以共用计价面积、权益、案例权重或价值结论。')
  }

  return {
    ok: conflicts.length === 0,
    plans,
    conflicts,
    unassignedObjectIds,
    unknownObjectIds,
    duplicateObjectIds,
    suspendedObjectIds,
    notes,
  }
}

/** 方案安全目录名（`plan-001-住宅`）：id 是身份，中文标题只是标签。 */
export function planDirectoryName(plan: Pick<ValuationPlan, 'planId' | 'title'>): string {
  const label = safeIdSegment(plan.title, '')
  const base = safeIdSegment(plan.planId, 'plan')
  return label === '' ? base : `${base}-${label}`
}

/** 分组冲突 → 结构化 blocker（整项目级别就用它）。 */
export function blockerFromGroupingConflict(conflict: GroupingConflict): Blocker {
  const structural = conflict.kind === 'unknown-object'
    || conflict.kind === 'unassigned-object'
    || conflict.kind === 'unclassified-object'
    || conflict.kind === 'missing-method'
  return {
    kind: structural ? 'input-invalid' : 'valuation-path-unresolved',
    stage: 'grouping',
    code: `valuation.grouping.${conflict.kind}`,
    missing: [conflict.reason],
    checked: ['项目对象清单', `分组字段:${conflict.label}`],
    reason: conflict.reason,
    remediation: conflict.resolution,
  }
}
