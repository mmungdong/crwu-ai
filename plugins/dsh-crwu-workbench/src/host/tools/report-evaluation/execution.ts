import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { agentRegistry, startChild, stopChild } from '../../domains/report-audit/spawn.ts'
import { makeAgentStatusOf } from '../../domains/report-audit/state.ts'
import { VALUATION_CHILD_TOOLS, VALUATION_PROJECT_INDEX_FILE, VALUATION_TOOL_NAMES } from './consts.ts'
import { dispatchReadyTasks, joinTasks, type DispatchTask } from '../../domains/report-evaluation/execution/dispatch.ts'
import { readHarnessFacts } from '../../domains/report-evaluation/execution/harness-facts.ts'
import { planDirRelative } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import type { TaskLeaseStore } from '../../domains/report-evaluation/execution/leases.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { missingAuditTools } from '../register.ts'

/**
 * `crwu_valuation_execution_dispatch` / `crwu_valuation_execution_join`（设计稿 §9，计划 Task 7）。
 *
 * ## 为什么"顺序执行"也必须走这两个 Tool
 *
 * 顺序是**主路径**，不是兜底：状态未知、资源繁忙、provider 缺失时都由父会话自己按依赖顺序
 * 算完。但顺序执行同样需要租约，否则"模型重试一次调度"就会把同一个方案排两遍 ——
 * 两份结论写进同一个方案目录，谁后写谁生效，而两边看起来都正常。
 *
 * 所以：
 *
 * - `dispatch` 只回答"这一轮该谁做哪几个任务"，并**真的**把执行者写进租约；
 * - `join` 只回答"这些任务静止了没有"，只有**确认静止**（子会话不在跑 / 父会话给出结论）
 *   才结算，之后才允许换执行者。
 *
 * ## 三条不许含糊的边界
 *
 * 1. **启动结果未知 ≠ 没有执行者**：子会话创建失败或可见性回读不过时，租约留在
 *    `start-unknown`，父会话**不许**接手重算 —— 错误信息里明说这一点。
 * 2. **并行只在可验证时发生**：provider 不支持 toolFilter、或子会话回读不出必需工具，
 *    一律停在顺序路径（子会话跑出来的结论不可复核比慢一点严重得多）。
 * 3. **归属靠租约与索引，不靠模型提交的目录**：任务必须在本项目索引里；方案级调用者
 *    只能调度自己那些方案的任务（由 `deps.valuationScopes` 的 `planIds` 判定）。
 */

interface TaskRecord extends DispatchTask {
  requestedCapability: string
}

/** 项目索引里的任务（v2：`tasks[]`，字段与 `TaskNode` 逐字对应）。 */
function tasksOf(document: Record<string, unknown> | null): TaskRecord[] {
  if (document === null || !Array.isArray(document.tasks)) return []
  const out: TaskRecord[] = []
  for (const raw of document.tasks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const taskId = text(record.taskId).trim()
    const planId = text(record.parentPlanId).trim()
    if (taskId === '' || planId === '') continue
    out.push({
      taskId,
      planId,
      objectIds: Array.isArray(record.objectIds) ? record.objectIds.map((id) => text(id)).filter((id) => id !== '') : [],
      dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.map((id) => text(id)).filter((id) => id !== '') : [],
      assetClass: text(record.assetClass) || 'realestate',
      valuationPath: text(record.valuationPath) || 'combined',
      valueScope: text(record.valueScope) || 'land-and-building',
      requestedCapability: text(record.requestedCapability),
      status: text(record.status) || 'pending',
    })
  }
  return out
}

/** 已完成的方案（落盘证据）：方案目录里已经有报告数据或估值状态，说明这一轮之前已经做过。 */
async function completedFromDisk(
  ctx: Parameters<typeof readTextIfExists>[0],
  casePath: string,
  tasks: readonly TaskRecord[],
): Promise<string[]> {
  const done: string[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.planId)) continue
    seen.add(task.planId)
    const dir = planDirRelative(task.planId)
    if (dir === '') continue
    const status = await readTextIfExists(ctx, joinLocalPath(casePath, dir, '估值状态.json'))
    const data = await readTextIfExists(ctx, joinLocalPath(casePath, dir, '估值报告数据.json'))
    if (status.trim() !== '' || data.trim() !== '') done.push(task.taskId)
  }
  return done
}

/** 方案级子会话的固定指令（设计稿 §15：只带授权 planId、对象、知识指纹与结论要求）。 */
export function valuationPlanPrompt(input: {
  projectId: string
  planId: string
  taskId: string
  objectIds: readonly string[]
  casePath: string
  knowledgeDigest: string
}): string {
  const planDir = planDirRelative(input.planId)
  return [
    '你是中瑞世联的**房地产估值**业务助手，负责本项目里的**一个方案**（已由父会话授权）。',
    '用 skill 工具加载 `crwu-biz-valuation-realestate`；业务规范以本轮知识快照为准（技能 references 只给技术合同）。',
    '',
    `- 项目 ID：${input.projectId}`,
    `- 授权方案（planId）：${input.planId}`,
    `- 执行任务（taskId）：${input.taskId}`,
    `- 方案对象：${input.objectIds.join('、')}`,
    `- 案例目录（唯一可写目录）：${input.casePath}`,
    `- 本方案产物目录：${planDir}（交付件只能写在这里）`,
    `- 本轮知识快照指纹：${input.knowledgeDigest}`,
    '',
    '## 边界（越权会被 Host 拒绝）',
    '- **只处理本方案的对象**：不改组、不新增方案、不动别的方案目录；',
    '- 知识与能力缺口如实记录并**停止该步**，不要自己找网页、拼命令或安装东西；',
    '- 可见人机验证由取数 Tool 自动调用固定恢复能力；未恢复时保存断点，不要循环重试或 sleep；',
    '- 结论、计算与完成判定都由脚本与 `crwu_valuation_finalize` 给出，不要自己宣布完成。',
    '',
    '## 交付',
    `在 ${planDir} 下产出：估值案例.json、估值参数.json、模板验真.json、估值报告数据.json、`,
    '估值报告.html、估值底稿.xlsx、产物清单.json（截图放本方案的 推理结果/图片/<caseId-名称>/）；',
    '然后调用 `crwu_valuation_artifact_validate` 与 `crwu_valuation_finalize`（都带本方案 planId）。',
  ].join('\n')
}

interface ExecutionToolDeps extends ToolDeps {
  valuationLeases?: TaskLeaseStore
}

interface DispatchResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  projectId: string
  mode: string
  reason: string
  degradation: string[]
  concurrencyCap: number
  parentTaskIds: string[]
  delegated: Array<{ taskId: string; planId: string; childSessionId: string }>
  skipped: Array<{ taskId: string; reason: string }>
  failed: Array<{ taskId: string; error: string }>
  activeTaskIds: string[]
  notes: string[]
}

interface JoinResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  tasks: Array<{
    taskId: string
    planId: string
    executor: string
    childSessionId: string
    leaseState: string
    childStatus: string
    settled: boolean
    quiescent: boolean
    note: string
  }>
  activeTaskIds: string[]
  runningTaskIds: string[]
}

const DISPATCH_FIELDS = {
  ok: { type: 'boolean', required: true },
  errorKind: { type: 'string', required: true },
  error: { type: 'string', required: true },
  caseDir: { type: 'string', required: true },
  projectId: { type: 'string', required: true },
  mode: { type: 'string', required: true, description: 'parallel / sequential' },
  reason: { type: 'string', required: true },
  degradation: { type: 'array', required: true, items: { type: 'string' } },
  concurrencyCap: { type: 'integer', required: true },
  parentTaskIds: { type: 'array', required: true, items: { type: 'string' } },
  delegated: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
  skipped: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
  failed: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
  activeTaskIds: { type: 'array', required: true, items: { type: 'string' } },
  notes: { type: 'array', required: true, items: { type: 'string' } },
} as const

export function valuationExecutionTools(deps: ExecutionToolDeps) {
  /** 调用者是否被授权调度这个任务（方案级调用者只能调度自己的方案）。 */
  const ownsTask = (
    planId: string,
    scopePlans: readonly string[] | undefined,
  ): boolean => {
    if (!Array.isArray(scopePlans)) return true
    return scopePlans.includes(planId)
  }

  const dispatch = defineTool({
    name: VALUATION_TOOL_NAMES.executionDispatch,
    description: [
      '按真实 Harness 状态与单执行租约，决定本轮由谁执行哪些估值任务（parallel 有界并行 / sequential 父会话顺序），',
      '并真的把执行者写进租约：重复调度不会把同一个方案排两遍。启动结果未知的任务保留在未知状态，',
      '**父会话不许接手重算**。它只调度项目索引里的任务，不接受任意目录或命令。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      taskIds: { type: 'array', items: { type: 'string' }, description: '只调度这些任务（缺省全部）；必须属于本项目索引。' },
      completedTaskIds: { type: 'array', items: { type: 'string' }, description: '已知完成的任务（缺省由 Host 从租约与方案目录推断）。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: DISPATCH_FIELDS }, render: (_args, value) => renderJson(value) },
    async execute(args: { caseDir?: unknown; taskIds?: unknown; completedTaskIds?: unknown }, exec): Promise<DispatchResult> {
      const ctx = toolContext(deps.ctx, exec)
      const empty: DispatchResult = {
        ok: false, errorKind: '', error: '', caseDir: '', projectId: '', mode: 'sequential', reason: '',
        degradation: [], concurrencyCap: 0, parentTaskIds: [], delegated: [], skipped: [], failed: [],
        activeTaskIds: [], notes: [],
      }
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...empty, ...failure('policy', access.error) }
      if (access.kind !== 'valuation') {
        return { ...empty, ...failure('policy', '这条会话不是本轮估值会话：执行调度只能在估值会话里进行') }
      }
      const casePath = access.casePath
      const leases = deps.valuationLeases
      if (leases === undefined) {
        return { ...empty, caseDir: casePath, ...failure('capability-gap', '执行租约没有装配：无法保证一个任务只有一个执行者，因此不调度。') }
      }
      const identity = callerIdentity(exec)
      const scope = deps.valuationScopes?.scopeOf(identity.childId)
      if (scope === undefined) {
        return { ...empty, caseDir: casePath, ...failure('policy', '拿不到本轮估值的宿主记录：请重新发起本轮估值。') }
      }
      const projectId = text(scope.projectId) || text(scope.valuationId)

      const raw = await readTextIfExists(ctx, joinLocalPath(casePath, VALUATION_PROJECT_INDEX_FILE))
      if (raw.trim() === '') {
        return { ...empty, caseDir: casePath, projectId, ...failure('input', `还没有 ${VALUATION_PROJECT_INDEX_FILE}：先调用 crwu_valuation_project_prepare 固定项目索引。`) }
      }
      let document: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(raw)
        document = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch {
        document = null
      }
      if (document === null) {
        return { ...empty, caseDir: casePath, projectId, ...failure('input', `项目索引不是合法 JSON：无法据此调度。`) }
      }
      const tasks = tasksOf(document)
      if (tasks.length === 0) {
        return { ...empty, caseDir: casePath, projectId, ...failure('input', '项目索引里没有执行任务：先完成分组与方法判定。') }
      }
      const requested = Array.isArray(args.taskIds) ? args.taskIds.map((id) => text(id)).filter((id) => id !== '') : undefined
      const wanted = requested === undefined ? tasks : tasks.filter((task) => requested.includes(task.taskId))
      const foreign = wanted.filter((task) => !ownsTask(task.planId, scope.planIds))
      if (foreign.length > 0) {
        return {
          ...empty, caseDir: casePath, projectId,
          ...failure('policy', `无权调度这些任务所属的方案：${foreign.map((task) => task.planId).join('、')}`),
        }
      }

      const completed = Array.isArray(args.completedTaskIds)
        ? args.completedTaskIds.map((id) => text(id)).filter((id) => id !== '')
        : await completedFromDisk(ctx, casePath, tasks)
      const attemptId = `${identity.childId || 'parent'}:${String(Date.now())}`
      const parentSessionId = text(identity.childId)
      const outcome = await dispatchReadyTasks(
        { projectId, parentSessionId, attemptId, ...(requested === undefined ? {} : { taskIds: requested }), completedTaskIds: completed },
        {
          tasks,
          leases,
          readFacts: ({ readyTaskIds }) => readHarnessFacts({ ctx, leases, readyTaskIds }),
          startChild: async (input) => {
            const startedAt = Date.now()
            const result = await startChild(ctx, {
              label: `估值 ${input.planId}`,
              prompt: valuationPlanPrompt({
                projectId, planId: input.planId, taskId: input.taskId,
                objectIds: input.objectIds, casePath,
                knowledgeDigest: text(scope.snapshot.digest),
              }),
              parentSessionId,
            })
            return {
              ok: result.ok,
              childId: result.childId,
              error: result.error,
              durationMs: result.ok ? Date.now() - startedAt : null,
            }
          },
          missingChildTools: async (childId) => {
            const agents = agentRegistry(ctx)
            if (agents === undefined) return [...VALUATION_CHILD_TOOLS]
            const agent = agents.get(childId as Parameters<typeof agents.get>[0])
            if (agent === undefined) return [...VALUATION_CHILD_TOOLS]
            return missingAuditTools(ctx, agent, VALUATION_CHILD_TOOLS)
          },
          stopChild: async (childId, reason) => { await stopChild(ctx, childId, reason, { parentSessionId }) },
        },
      )
      return { ...empty, caseDir: casePath, projectId, ...outcome }
    },
  })

  const join = defineTool({
    name: VALUATION_TOOL_NAMES.executionJoin,
    description: [
      '回读估值执行任务的租约与真实子会话状态：子会话不在运行、或父会话给出了结论时结算租约，',
      '之后才允许换执行者。它不杀别人的浏览器、不改结论，只回答"这些任务静止了没有"。',
      '父会话顺序计算前必须先用它确认项目内活动子任务已静止。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      taskIds: { type: 'array', required: true, items: { type: 'string' }, description: '要结算/查询的任务 id。' },
      outcomes: {
        type: 'object', additionalProperties: true, properties: {},
        description: '父会话执行完的任务结论：{ taskId: { status, note } }；没给的按"还没做完"处理。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          activeTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          runningTaskIds: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { caseDir?: unknown; taskIds?: unknown; outcomes?: unknown }, exec): Promise<JoinResult> {
      const ctx = toolContext(deps.ctx, exec)
      const empty: JoinResult = { ok: false, errorKind: '', error: '', caseDir: '', tasks: [], activeTaskIds: [], runningTaskIds: [] }
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...empty, ...failure('policy', access.error) }
      if (access.kind !== 'valuation') {
        return { ...empty, ...failure('policy', '这条会话不是本轮估值会话：执行结算只能在估值会话里进行') }
      }
      const leases = deps.valuationLeases
      if (leases === undefined) {
        return { ...empty, caseDir: access.casePath, ...failure('capability-gap', '执行租约没有装配：无法判断任务是否静止。') }
      }
      const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map((id) => text(id)).filter((id) => id !== '') : []
      if (taskIds.length === 0) return { ...empty, caseDir: access.casePath, ...failure('input', 'taskIds 不能为空。') }
      const outcomes = args.outcomes !== null && typeof args.outcomes === 'object' && !Array.isArray(args.outcomes)
        ? args.outcomes as Record<string, { status: string; note?: string }>
        : {}
      const statusOf = makeAgentStatusOf(ctx)
      const receipt = joinTasks({ projectId: '', taskIds, outcomes }, {
        leases,
        childStatusOf: (childId) => statusOf(childId),
      })
      return { ...empty, caseDir: access.casePath, ...receipt }
    },
  })

  return [dispatch, join]
}
