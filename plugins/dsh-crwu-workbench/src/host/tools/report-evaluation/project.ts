import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { text } from '../../../shared/utils/value.ts'
import { fileSystem } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { isSafeIdSegment } from '../../domains/report-evaluation/project/contracts.ts'
import {
  PROJECT_RECORD_FILE,
  buildProjectRecord,
  projectRecordOf,
  type ProjectRecord,
} from '../../domains/report-evaluation/lifecycle/index.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { writeCaseText } from '../common/case-files.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_PROJECT_INDEX_FILE, VALUATION_TOOL_NAMES } from './consts.ts'
import {
  VALUATION_PROJECT_SCHEMA_VERSION,
  type Blocker,
  type MethodRequest,
  type PlanAssessment,
  type PropertyType,
  type TaskNode,
  type ValuationObject,
  type ValuationPath,
  type ValuationPlan,
} from '../../../shared/contracts/valuation-project.ts'
import { validateGrouping, blockerFromGroupingConflict, type PlanProposal } from '../../domains/report-evaluation/project/grouping.ts'
import { validateMethodAssessment, type MethodFact } from '../../domains/report-evaluation/project/methods.ts'
import { buildTaskGraph } from '../../domains/report-evaluation/project/task-graph.ts'

/**
 * `crwu_valuation_project_prepare`：**项目 → 方案 → 对象**的落点（设计稿 §7，计划 Task 6）。
 *
 * ## 为什么分组与方法判定要在 Host 里做完
 *
 * 分组的后果是**结论的形状**：一个方案里的对象会被同一套方法、同一套参数口径处理。
 * 如果只让父会话"把分组结果写进 JSON"，那么"同小区就共用了计价面积"这类错误
 * 没有任何地方会拦。所以这一层把三件事固定下来：
 *
 * 1. `validateGrouping` —— 对象只能属一个方案、住宅与商业必须拆、权益/基准日不一致要报冲突；
 * 2. `validateMethodAssessment` —— **业务不适用**与**当前未实现**分成两种状态，用户指定方法是约束；
 * 3. `buildTaskGraph` —— 房地分别评估是有依赖的一张图，且 `land-and-only` 与
 *    `land-and-building` 不许相加（重复计价）；土地能力不存在时**阻断该方案**。
 *
 * ## 写盘
 *
 * 校验通过时把 `项目估值方案索引.json` 写进案例目录（原子写入走 `writeCaseText` 的
 * 统一路径）。`write: false` 只校验不落盘 —— 父会话想先看结论再落盘时用它。
 *
 * ## 它与"模型自己想清楚"的区别
 *
 * 这个 Tool 的返回值里**没有**任何业务判断的自由度：方法适不适用由知识正文决定的
 * `methodFacts` 传入，实现的有没有由覆盖矩阵/能力清单回答。这里只做**一致性校验与落盘**。
 */
interface ProjectPrepareArgs {
  caseDir?: unknown
  objects?: unknown
  proposals?: unknown
  methodFacts?: unknown
  implementedMethods?: unknown
  write?: unknown
}

// `type` 而非 `interface`：只有类型别名有**隐式索引签名**，能被工具 Schema 推导出的
// `Record<string, JsonValue>` 接受（`interface` 不行）。
type PlanView = {
  planId: string
  title: string
  propertyType: string
  objectIds: string[]
  valuationPath: string
  status: string
  conflicts: string[]
  primaryMethod: string
  selectedMethods: string[]
  requestedMethodHonored: boolean
}

type ProjectPrepareResult = {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  projectId: string
  objects: number
  plans: PlanView[]
  tasks: TaskNode[]
  blockers: Blocker[]
  conflicts: string[]
  written: string
}

function objectsOf(raw: unknown): { objects: ValuationObject[]; problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { objects: [], problem: 'objects 必须是非空数组' }
  const objects: ValuationObject[] = []
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { objects: [], problem: `第 ${String(index + 1)} 个对象不是对象` }
    }
    const record = item as Record<string, unknown>
    const objectId = text(record.objectId).trim()
    if (objectId === '') return { objects: [], problem: `第 ${String(index + 1)} 个对象缺少 objectId` }
    objects.push({
      objectId,
      displayName: text(record.displayName) || objectId,
      // **不默认 residential**（P15）：缺物业类型就没有业务分类，该对象会被分组层挂起，
      // 而不是被悄悄按住宅口径算下去。
      propertyType: text(record.propertyType) as PropertyType,
      // 原始权证/登记用途与业务分类依据分开存：前者是资料事实，后者是本轮知识规则下的判定依据。
      registeredUse: text(record.registeredUse),
      classificationBasis: text(record.classificationBasis),
      sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs.map((ref) => text(ref)).filter((ref) => ref !== '') : [],
      fields: record.fields !== null && typeof record.fields === 'object' && !Array.isArray(record.fields)
        ? Object.fromEntries(Object.entries(record.fields as Record<string, unknown>).map(([key, value]) => [key, text(value)]))
        : {},
      missingFields: Array.isArray(record.missingFields) ? record.missingFields.map((value) => text(value)) : [],
    })
  }
  return { objects, problem: '' }
}

function proposalsOf(raw: unknown): { proposals: PlanProposal[]; problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { proposals: [], problem: 'proposals 必须是非空数组' }
  const proposals: PlanProposal[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.objectIds)) return { proposals: [], problem: '每个 proposal 都要有 objectIds 数组' }
    proposals.push({
      planId: text(record.planId),
      title: text(record.title),
      objectIds: record.objectIds.map((id) => text(id)).filter((id) => id !== ''),
      propertyType: text(record.propertyType) as PropertyType,
      purpose: text(record.purpose),
      valueType: text(record.valueType),
      baseDate: text(record.baseDate) === '' ? null : text(record.baseDate),
      rightsBasis: text(record.rightsBasis),
      marketScope: text(record.marketScope),
      valuationPath: (text(record.valuationPath) || 'combined') as ValuationPath,
      methodRequest: (text(record.methodRequest) || 'auto') as MethodRequest,
      groupReason: text(record.groupReason),
      groupEvidenceRefs: Array.isArray(record.groupEvidenceRefs)
        ? record.groupEvidenceRefs.map((ref) => text(ref)).filter((ref) => ref !== '')
        : [],
    })
  }
  if (proposals.length === 0) return { proposals: [], problem: 'proposals 里没有一条可用的分组提议' }
  return { proposals, problem: '' }
}

/**
 * 逐方案的方法判定事实（由调用方从知识正文整理后传入）。
 *
 * 传 `applicable` 与 `reason` —— 这里**不判断**业务是否适用，只做一致性校验。
 */
function methodFactsOf(raw: unknown): Record<string, MethodFact[]> {
  const out: Record<string, MethodFact[]> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [planId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    out[planId] = list
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        method: (text(item.method) || 'market') as MethodFact['method'],
        applicable: item.applicable === true,
        ...(text(item.reason) === '' ? {} : { reason: text(item.reason) }),
      }))
  }
  return out
}

/**
 * Read and validate the protected project record **before any write**.
 *
 * `absent` is allowed (legacy fixtures); malformed / unreadable / non-file fails closed so a
 * broken record is never silently reset. The digest is checked inside `projectRecordOf`.
 */
async function readProjectRecord(
  ctx: Context,
  casePath: string,
): Promise<{ kind: 'absent' } | { kind: 'ok'; record: ProjectRecord } | { kind: 'invalid'; error: string }> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return { kind: 'invalid', error: '宿主文件服务不可用' }
  const path = joinLocalPath(casePath, PROJECT_RECORD_FILE)
  try {
    const resolved = await fs.resolve(path)
    const info = await fs.stat(resolved)
    if (info === undefined) return { kind: 'absent' }
    if (info.type !== 'file') return { kind: 'invalid', error: '项目记录不是普通文件' }
    const raw = await fs.readText(resolved)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { kind: 'invalid', error: '项目记录不是合法 JSON' }
    }
    const read = projectRecordOf(parsed)
    if (!read.ok) return { kind: 'invalid', error: read.error }
    return { kind: 'ok', record: read.record }
  } catch (error) {
    return { kind: 'invalid', error: `项目记录读不到：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function valuationProjectPrepareTools(deps: ToolDeps) {
  const prepare = defineTool({
    name: VALUATION_TOOL_NAMES.projectPrepare,
    description: [
      '校验并落盘「项目 → 方案 → 对象」的分组、方法判定与执行任务图：对象只能属一个方案、',
      '住宅与商业必须拆方案、权益或基准日不一致要报冲突；业务不适用与当前未实现分开记；',
      '房地分别评估生成有依赖的任务图并阻断不存在的土地能力。',
      '方法是否适用由调用方从知识正文传入的 methodFacts 决定，本工具不做业务判断。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      objects: {
        type: 'array', required: true,
        description: '识别出的估值对象：objectId / displayName / propertyType（业务分类）/ registeredUse（原始权证登记用途）/ classificationBasis（业务分类依据，缺失则该对象挂起）/ sourceRefs / fields / missingFields。',
      },
      proposals: {
        type: 'array', required: true,
        description: '分组提议：planId / title / objectIds / propertyType / 目的 / 价值类型 / 基准日 / 权益口径 / 市场范围 / valuationPath / methodRequest。',
      },
      methodFacts: {
        type: 'object',
        additionalProperties: true,
        properties: {},
        description: '按 planId 的逐方法判定（method / applicable / reason），来自知识选择方案正文。',
      },
      implementedMethods: {
        type: 'array', items: { type: 'string' },
        description: '当前实现已完整支持的方法（缺省按覆盖矩阵判定）。',
      },
      write: { type: 'boolean', description: '是否落盘项目索引（缺省 true）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          projectId: { type: 'string', required: true },
          objects: { type: 'number', required: true },
          plans: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          blockers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          conflicts: { type: 'array', required: true, items: { type: 'string' } },
          written: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: ProjectPrepareArgs, exec): Promise<ProjectPrepareResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base: ProjectPrepareResult = {
        ok: false, errorKind: '', error: '', caseDir: '', projectId: '',
        objects: 0, plans: [], tasks: [], blockers: [], conflicts: [], written: '',
      }
      const session = callerSession(exec)
      const scope = session === undefined ? undefined : deps.valuationScopes?.scopeOf(session.id)
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...failure('policy', access.error) }
      const casePath = access.casePath ?? ''
      const projectId = text(scope?.projectId) || text(scope?.valuationId)
      if (projectId === '') {
        return { ...base, caseDir: casePath, ...failure('policy', '拿不到本轮估值的项目 id（宿主记录不可用）：请重新发起本轮估值。') }
      }

      // Read the protected record before any write: malformed / foreign records fail closed.
      const recordRead = await readProjectRecord(ctx, casePath)
      if (recordRead.kind === 'invalid') {
        return {
          ...base, caseDir: casePath, projectId,
          ...failure('infrastructure', `项目记录不可用，拒绝准备（不会重置或覆盖它）：${recordRead.error}`),
        }
      }
      if (recordRead.kind === 'ok') {
        const record = recordRead.record
        const wrongScope = record.projectId !== projectId
          || record.casePath !== casePath
          || (session !== undefined && record.sessionId !== session.id)
        if (wrongScope) {
          return {
            ...base, caseDir: casePath, projectId,
            ...failure('policy', '项目记录与本轮会话/案例不一致：拒绝准备（不会改写别的项目或会话的记录）。'),
          }
        }
      }

      const parsedObjects = objectsOf(args.objects)
      if (parsedObjects.problem !== '') return { ...base, caseDir: casePath, projectId, ...failure('input', parsedObjects.problem) }
      const parsedProposals = proposalsOf(args.proposals)
      if (parsedProposals.problem !== '') return { ...base, caseDir: casePath, projectId, ...failure('input', parsedProposals.problem) }

      const grouping = validateGrouping(parsedObjects.objects, parsedProposals.proposals)
      const facts = methodFactsOf(args.methodFacts)
      const implemented = Array.isArray(args.implementedMethods)
        ? new Set(args.implementedMethods.map((item) => text(item)))
        : undefined

      const blockers: Blocker[] = []
      const plans: ValuationPlan[] = []
      const tasks: TaskNode[] = []
      const planViews: PlanView[] = []

      for (const plan of grouping.plans) {
        const planFacts = facts[plan.planId]
        let assessment: PlanAssessment | null = null
        let planBlockers: Blocker[] = []
        if (planFacts !== undefined && planFacts.length > 0) {
          const outcome = validateMethodAssessment(plan, planFacts, implemented === undefined
            ? {}
            : { implementedOf: (method) => implemented.has(method) })
          assessment = outcome.assessment
          planBlockers = outcome.blockers
        } else {
          planBlockers = [{
            kind: 'knowledge-missing',
            stage: 'method-selection',
            code: 'valuation.method.facts-missing',
            missing: [`方案 ${plan.planId} 的逐方法判定`],
            checked: ['knowledge:01 房地产评估方法选择方案', `plan:${plan.planId}`],
            reason: '没有传入该方案的方法判定事实：无法确定适用方法（本工具不替知识做业务判断）',
            remediation: '先按知识正文得出逐方法判定（method / applicable / reason），再调用本工具。',
          }]
        }
        const withAssessment: ValuationPlan = { ...plan, methodAssessment: assessment }
        const graph = buildTaskGraph(withAssessment, assessment)
        plans.push(withAssessment)
        tasks.push(...graph.nodes)
        blockers.push(...planBlockers, ...graph.blockers)
        planViews.push({
          planId: plan.planId,
          title: plan.title,
          propertyType: plan.propertyType,
          objectIds: plan.objectIds,
          valuationPath: plan.valuationPath,
          status: plan.status,
          conflicts: plan.conflicts,
          primaryMethod: assessment?.primaryMethod ?? '',
          selectedMethods: assessment?.selectedMethods ?? [],
          requestedMethodHonored: assessment?.requestedMethodHonored ?? false,
        })
      }

      for (const conflict of grouping.conflicts) blockers.push(blockerFromGroupingConflict(conflict))

      const conflicts = [
        ...grouping.conflicts.map((row) => row.reason),
        ...plans.flatMap((plan) => plan.conflicts.map((row) => `${plan.planId}：${row}`)),
      ]

      let written = ''
      if (args.write !== false) {
        const document = {
          schemaVersion: VALUATION_PROJECT_SCHEMA_VERSION,
          projectId,
          inputDigest: text(scope?.snapshot.digest),
          objects: parsedObjects.objects,
          plans,
          tasks,
          projectBlockers: grouping.ok ? [] : blockers.filter((row) => row.stage === 'grouping'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        const target = joinLocalPath(casePath, VALUATION_PROJECT_INDEX_FILE)
        const result = await writeCaseText(ctx, target, canonicalJson(document), {
          ...(session === undefined ? {} : { session }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        if (!result.ok) {
          return {
            ...base, caseDir: casePath, projectId, objects: parsedObjects.objects.length,
            plans: planViews, tasks, blockers, conflicts,
            ...failure('infrastructure', `项目索引写入失败：${result.error}`),
          }
        }
        written = VALUATION_PROJECT_INDEX_FILE

        // Ownership is granted only after the durable index write of a valid grouping, and the
        // same set is persisted into the protected record so resume does not reset to empty.
        const planIds = [...new Set(plans.map((plan) => plan.planId))]
        const grantable = conflicts.length === 0 && blockers.length === 0
          && planIds.length > 0 && planIds.every((planId) => isSafeIdSegment(planId))
        if (grantable) {
          if (recordRead.kind === 'ok') {
            const next = buildProjectRecord({ ...recordRead.record, planIds })
            const recordResult = await writeCaseText(
              ctx,
              joinLocalPath(casePath, PROJECT_RECORD_FILE),
              canonicalJson(next),
              { ...(session === undefined ? {} : { session }), ...(exec.signal === undefined ? {} : { signal: exec.signal }) },
            )
            if (!recordResult.ok) {
              return {
                ...base, caseDir: casePath, projectId, objects: parsedObjects.objects.length,
                plans: planViews, tasks, blockers, conflicts,
                ...failure('infrastructure', `项目记录写入失败，方案未登记：${recordResult.error}`),
              }
            }
          }
          deps.valuationScopes?.replacePlans(projectId, planIds)
        }
      }

      const ok = conflicts.length === 0 && blockers.length === 0
      return {
        ok,
        errorKind: ok ? '' : 'input',
        error: ok ? '' : conflicts[0] ?? blockers[0]?.reason ?? '分组或方法判定未通过',
        caseDir: casePath,
        projectId,
        objects: parsedObjects.objects.length,
        plans: planViews,
        tasks,
        blockers,
        conflicts,
        written,
      }
    },
  })
  return [prepare]
}
