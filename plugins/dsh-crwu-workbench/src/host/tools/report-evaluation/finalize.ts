import { defineTool } from '@deepseek-ai/dsh-tools'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { text } from '../../../shared/utils/value.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { valuationInputDigest } from '../../domains/report-evaluation/intake/preview.ts'
import type { MaterialMetadata } from '../../domains/report-evaluation/intake/metadata.ts'
import { finalizePlan, finalizeProject, type FinalizeReceipt } from '../../domains/report-evaluation/delivery/finalize.ts'
import { recalcProvidersOf } from '../../domains/report-evaluation/delivery/recalculation-engine.ts'
import {
  FINALIZE_PATHS,
  collectPlanFinalizeFacts,
  type FinalizeReaders,
} from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import { isSafeIdSegment } from '../../domains/report-evaluation/project/contracts.ts'
import { isMethodRequest } from '../../domains/report-evaluation/project/coverage.ts'
import { writeCaseText } from '../common/case-files.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Blocker, ReportStatus, ValuationPath } from '../../../shared/contracts/valuation-project.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_PROJECT_INDEX_FILE, VALUATION_TOOL_NAMES } from './consts.ts'

/** Project-level finalize receipt (design §11.4); persisted next to the authoritative project index. */
const PROJECT_RECEIPT_FILE = '项目估值完成回执.json'

/**
 * `crwu_valuation_finalize`：**显式的完成校验**（设计稿 §11.4，计划 Task 11）。
 *
 * ## 为什么完成必须由这个 Tool 判定，而不是"模型说完成"
 *
 * 面板不再轮询估值完成度之后，没有任何东西会顺手看一眼文件齐不齐。如果这时还允许
 * "写完文件就结束"，`completed` 就退化成了模型的自我声明 —— 而模型说"我完成了"从来不是事实。
 *
 * 所以这里由 Host 用**真实文件与真实校验结果**回答：缺图、缺知识、未重算、报告没渲染、
 * 结论少了一个对象……任何一项不通过都会把状态降级（`completed` → `partial` / `blocked`），
 * 并带回**逐条问题**。`requestedStatus` 只是提示，不参与判定。
 *
 * ## 三条 fail-closed
 *
 * 1. **拿不到宿主记录的冻结输入摘要 → 拒绝校验**（不是"那就用文件里的值"）：
 *    文件是可写的，拿它当权威等于让"改文件"变成"通过校验"。
 * 2. **重算没有落盘记录 → `unavailable`** → 报告上限 `partial`：绝不用"底稿里有公式"推断"已重算"。
 * 3. **`screenshotRequired` 由本轮知识快照给**（调用方传入，来自知识正文），不由这里猜。
 */
/**
 * finalize 回执的**显式投影**（与 `output.schema` 逐字对应）。
 *
 * 为什么不直接把 `receipt.validation` 摊开：`Record<string, unknown>` 这种宽类型在
 * 工具的 Schema 推导下过不去，而且它把"回执里到底有哪些字段"变成了运行时才知道的事。
 * 逐个字段列出来，既过类型检查，也让"回执包含什么"在代码里可读。
 */
// 用 `type` 而不是 `interface`：只有类型别名会拿到**隐式索引签名**，
// 否则它无法赋给工具 Schema 推导出的 `Record<string, JsonValue>`（`interface` 不行）。
type FinalizeValidationView = {
  /** 有回执为 true；`{ present: false }` 表示校验没有通过到"可交付"。 */
  present: boolean
  projectId?: string
  planId?: string
  inputDigest?: string
  knowledgeVerified?: boolean
  templateVerified?: boolean
  evidenceVerified?: boolean
  calculationVerified?: boolean
  workbookRecalculated?: boolean
  reportRendered?: boolean
  verifiedAt?: string
  notes?: string[]
}

/** Project-level summary with an explicit discriminator (`present:false` for plan/error paths). */
type ProjectSummaryView = {
  present: boolean
  projectId?: string
  status?: string
  perPlan?: Array<{ planId: string; status: string }>
  problems?: string[]
  aggregatablePlanIds?: string[]
  conclusionIncludesBlockedAmount?: boolean
  verifiedAt?: string
  receiptPath?: string
}

/** 工具返回形状（与 `output.schema` 逐字对应）。 */
interface FinalizeResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  planId: string
  requestedStatus: string
  status: string
  downgraded: boolean
  problems: string[]
  /** finalize 回执。**没有回执时是 `{ present: false }`** —— 不是 null，也不是空对象。 */
  validation: FinalizeValidationView
  conclusionIncludesBlockedAmount: boolean
  projectSummary: ProjectSummaryView
}

interface FinalizeArgs {
  caseDir?: unknown
  planId?: unknown
  taskId?: unknown
  requestedStatus?: unknown
  screenshotRequired?: unknown
  valuationPath?: unknown
  /** `plan` (default) or `project`; project ignores planId and closes the whole project. */
  target?: unknown
  /** 修订版本（协议 39）：`> 1` 时核对 `修订/<n>/` 下的交付件。 */
  revision?: unknown
}

const REQUESTS: readonly string[] = ['completed', 'blocked', 'partial', 'failed', 'cancelled']

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    : []
}

export function valuationFinalizeTools(deps: ToolDeps) {
  const finalize = defineTool({
    name: VALUATION_TOOL_NAMES.finalize,
    description: [
      '校验本轮方案是否可以标记为完成：核对冻结输入、知识快照、模板验真、逐对象结论、计算轨迹、',
      '截图证据、计算表与重算记录、报告渲染与产物清单，并返回 Host 判定的状态。',
      '请求的状态只是提示：缺任何一项都会降级为 partial / blocked 并列出问题。',
      '没有落盘的重算记录时上限是 partial（不会因为"底稿里有公式"就判完成）。',
      'target=project 时由登记的父会话对整个项目收口：独立核对项目索引里的每个方案，',
      '被阻断 / 部分完成的方案不参与金额合计，并落盘项目完成回执。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      target: {
        type: 'string',
        description: '`plan`（缺省，校验单个方案）或 `project`（父会话对整个项目收口；此时 planId 可省略）。',
      },
      planId: { type: 'string', description: '要校验的方案 id；target=plan 时必填，target=project 时忽略。' },
      taskId: { type: 'string', description: '执行任务 id；缺省用方案 id。' },
      requestedStatus: { type: 'string', description: '请求的状态（completed / partial / blocked / failed / cancelled）；只是提示。' },
      revision: {
        type: 'integer',
        description: '修订版本（协议 39）：> 1 时核对 方案/<planId>/修订/<n>/ 下那一套交付件；缺省 / 1 = 方案根。',
      },
      screenshotRequired: { type: 'boolean', required: true, description: '本轮知识快照是否要求页面截图（由知识正文决定）。' },
      valuationPath: { type: 'string', description: '房地路径（combined / separate / unresolved）。' },
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
          planId: { type: 'string', required: true },
          requestedStatus: { type: 'string', required: true },
          status: { type: 'string', required: true },
          downgraded: { type: 'boolean', required: true },
          problems: { type: 'array', required: true, items: { type: 'string' } },
          validation: { type: 'object', required: true, additionalProperties: true, properties: {} },
          conclusionIncludesBlockedAmount: { type: 'boolean', required: true },
          projectSummary: { type: 'object', required: true, additionalProperties: true, properties: {} },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: FinalizeArgs, exec): Promise<FinalizeResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = {
        ok: false, errorKind: '', error: '', caseDir: '', planId: '',
        requestedStatus: '', status: '', downgraded: false,
        problems: [] as string[], validation: { present: false } as FinalizeValidationView,
        conclusionIncludesBlockedAmount: false,
        projectSummary: { present: false } as ProjectSummaryView,
      } satisfies FinalizeResult

      const target = text(args.target).trim() || 'plan'
      if (target !== 'plan' && target !== 'project') {
        return { ...base, ...failure('input', `未知的 target：${target}（只支持 plan / project）`) }
      }

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...failure('policy', access.error) }
      const casePath = access.casePath ?? ''

      // 权威冻结输入摘要：**只取自宿主记录**（面板确认那一刻写死的那一份）。
      const session = callerSession(exec)
      const scope = session === undefined ? undefined : deps.valuationScopes?.scopeOf(session.id)
      const frozenInputDigest = text(scope?.snapshot.digest)
      if (frozenInputDigest === '') {
        return {
          ...base, caseDir: casePath,
          ...failure('policy', '拿不到本轮估值的宿主记录（冻结输入摘要）：无法做完成校验 —— '
            + '重启后宿主记录不可信，请重新发起本轮估值。'),
        }
      }

      const requested = text(args.requestedStatus).trim() || 'completed'
      if (!REQUESTS.includes(requested)) {
        return { ...base, caseDir: casePath, ...failure('input', `未知的 requestedStatus：${requested}`) }
      }

      const readers = finalizeReadersOf(ctx, casePath)
      const recalcProviders = async () => recalcProvidersOf(deps.config)
      const verifiedAt = new Date().toISOString()
      const writeOptions = {
        ...(session === undefined ? {} : { session }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      }

      if (target === 'project') {
        const caller = session?.id ?? ''
        const registeredParent = text(scope?.parentSessionId)
        if (registeredParent === '' || registeredParent !== caller) {
          return {
            ...base, caseDir: casePath,
            ...failure('policy', '只有登记为本轮父会话的会话能 finalize 项目：子会话的完成请求必须回到父会话。'),
          }
        }

        const rawIndex = await readTextIfExists(ctx, joinLocalPath(casePath, VALUATION_PROJECT_INDEX_FILE))
        if (rawIndex.trim() === '') {
          return {
            ...base, caseDir: casePath,
            ...failure('input', `还没有 ${VALUATION_PROJECT_INDEX_FILE}：先调用 crwu_valuation_project_prepare 固定项目索引。`),
          }
        }
        let index: Record<string, unknown> | null = null
        try {
          const parsed: unknown = JSON.parse(rawIndex)
          index = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
        } catch {
          index = null
        }
        if (index === null) {
          return { ...base, caseDir: casePath, ...failure('input', `项目索引不是合法 JSON：${VALUATION_PROJECT_INDEX_FILE}`) }
        }

        const projectId = text(scope?.projectId) || text(scope?.valuationId)
        const indexProjectId = text(index.projectId)
        if (indexProjectId === '' || indexProjectId !== projectId) {
          return {
            ...base, caseDir: casePath,
            ...failure('policy', `项目索引的项目 id（${indexProjectId || '空'}）与宿主记录（${projectId || '空'}）不一致`),
          }
        }
        const indexDigest = text(index.inputDigest)
        if (indexDigest === '' || indexDigest !== frozenInputDigest) {
          return {
            ...base, caseDir: casePath,
            ...failure('policy', `项目索引声明的冻结摘要（${indexDigest || '空'}）与宿主记录（${frozenInputDigest}）不一致`),
          }
        }

        const indexPlans = asRecordArray(index.plans)
        const indexPlanIds: string[] = []
        for (const plan of indexPlans) {
          const id = text(plan.planId)
          if (!isSafeIdSegment(id)) {
            return { ...base, caseDir: casePath, ...failure('input', `项目索引里的方案 id 不是单段安全标识：「${id}」`) }
          }
          if (indexPlanIds.includes(id)) {
            return { ...base, caseDir: casePath, ...failure('input', `项目索引里的方案 id 重复：${id}`) }
          }
          indexPlanIds.push(id)
        }
        if (indexPlanIds.length === 0) {
          return { ...base, caseDir: casePath, ...failure('input', '项目索引里没有任何登记方案：不能凭空完成项目') }
        }
        const registered = [...new Set((scope?.planIds ?? []).map((item) => text(item)).filter((item) => item !== ''))]
        for (const id of indexPlanIds) {
          if (!registered.includes(id)) {
            return {
              ...base, caseDir: casePath,
              ...failure('policy', `方案「${id}」不在本轮登记范围：不能跳过或接收未登记的方案`),
            }
          }
        }
        for (const id of registered) {
          if (!indexPlanIds.includes(id)) {
            return {
              ...base, caseDir: casePath,
              ...failure('input', `登记的方案「${id}」不在项目索引里：项目索引不是这一轮的权威清单`),
            }
          }
        }

        const receipts: FinalizeReceipt[] = []
        for (const plan of indexPlans) {
          const planId = text(plan.planId)
          const valuationPath = text(plan.valuationPath)
          const facts = await collectPlanFinalizeFacts({
            projectId,
            planId,
            taskId: planId,
            requestedStatus: requested as ReportStatus,
            frozenInputDigest,
            screenshotRequired: args.screenshotRequired === true,
            valuationPath: valuationPath === 'combined' || valuationPath === 'separate' ? valuationPath : 'unresolved',
            verifiedAt,
          }, { ...readers, recalcProviders })
          receipts.push(finalizePlan(facts))
        }
        const projectBlockers = asRecordArray(index.projectBlockers)
          .filter((row) => text(row.reason) !== '') as unknown as Blocker[]
        const project = finalizeProject({ projectId, plans: receipts, projectBlockers, verifiedAt })
        const receiptPath = joinLocalPath(casePath, PROJECT_RECEIPT_FILE)
        const written = await writeCaseText(
          ctx, receiptPath, JSON.stringify(project, null, 2) + '\n', writeOptions,
        )
        if (!written.ok) {
          return {
            ...base, caseDir: casePath,
            ...failure('infrastructure', `项目完成回执落盘失败：${written.error}`),
          }
        }
        return {
          ok: project.ok,
          errorKind: project.ok ? '' : 'input',
          error: project.ok ? '' : project.problems.join('；').slice(0, 600),
          caseDir: casePath,
          planId: '',
          requestedStatus: requested,
          status: project.status,
          downgraded: project.status !== requested,
          problems: project.problems,
          validation: { present: false },
          conclusionIncludesBlockedAmount: project.conclusionIncludesBlockedAmount,
          projectSummary: {
            present: true,
            projectId: project.projectId,
            status: project.status,
            perPlan: project.perPlan.map((row) => ({ planId: row.planId, status: row.status })),
            problems: project.problems,
            aggregatablePlanIds: project.aggregatablePlanIds,
            conclusionIncludesBlockedAmount: project.conclusionIncludesBlockedAmount,
            verifiedAt: project.verifiedAt,
            receiptPath,
          },
        }
      }

      const planId = text(args.planId).trim()
      if (planId === '') {
        return { ...base, caseDir: casePath, ...failure('input', '缺少 planId：完成校验必须针对具体方案。') }
      }

      const facts = await collectPlanFinalizeFacts({
        projectId: text(scope?.projectId) || text(scope?.valuationId),
        planId,
        taskId: text(args.taskId).trim() || planId,
        requestedStatus: requested as ReportStatus,
        frozenInputDigest,
        screenshotRequired: args.screenshotRequired === true,
        valuationPath: (text(args.valuationPath) || 'combined') as ValuationPath,
        // 协议 39：修订版本 > 1 时核对 `修订/<n>/` 下那一套交付件。
        revision: typeof args.revision === 'number' && Number.isFinite(args.revision)
          ? Math.max(0, Math.trunc(args.revision)) : 0,
        verifiedAt,
      }, { ...readers, recalcProviders })

      const receipt: FinalizeReceipt = finalizePlan(facts)
      return {
        ok: receipt.ok,
        errorKind: receipt.ok ? '' : 'input',
        error: receipt.ok ? '' : receipt.problems.join('；').slice(0, 600),
        caseDir: casePath,
        planId: receipt.planId,
        requestedStatus: receipt.requestedStatus,
        status: receipt.status,
        downgraded: receipt.downgraded,
        problems: receipt.problems,
        // 有回执就是回执本体 + `present: true`；没有就是 `{ present: false }`。
        // 用一个显式判别项而不是 null：调用方不必去猜"空对象"到底意味着什么。
        validation: receipt.validation === null
          ? { present: false }
          : {
            present: true,
            projectId: receipt.validation.projectId,
            planId: receipt.validation.planId,
            inputDigest: receipt.validation.inputDigest,
            knowledgeVerified: receipt.validation.knowledgeVerified,
            templateVerified: receipt.validation.templateVerified,
            evidenceVerified: receipt.validation.evidenceVerified,
            calculationVerified: receipt.validation.calculationVerified,
            workbookRecalculated: receipt.validation.workbookRecalculated,
            reportRendered: receipt.validation.reportRendered,
            verifiedAt: receipt.validation.verifiedAt,
            notes: [...receipt.validation.notes],
          },
        conclusionIncludesBlockedAmount: receipt.conclusionIncludesBlockedAmount,
        projectSummary: { present: false },
      }
    },
  })
  return [finalize]
}

/**
 * 估值的**读取面**（finalize 与修订工具共用一份）。
 *
 * 两处各建一份的后果是"finalize 说通过、修订工具说缺件" —— 而它们问的是同一批文件。
 * 提取出来之后，修订工具可以对**某一版**（`修订/<n>/`）跑同一次判定，再决定要不要提升指针。
 */
export function finalizeReadersOf(ctx: Context, casePath: string): FinalizeReaders {
  const readJson = async (relativePath: string): Promise<Record<string, unknown> | null> => {
    const raw = await readTextIfExists(ctx, joinLocalPath(casePath, relativePath))
    if (raw.trim() === '') return null
    try {
      const value: unknown = JSON.parse(raw)
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    } catch {
      // 读不出来就是"读不出来"，**不是空对象** —— 让 finalize 如实判缺口。
      return null
    }
  }
  return {
    readJson,
    exists: async (relativePath) => {
      const raw = await readTextIfExists(ctx, joinLocalPath(casePath, relativePath))
      return raw !== ''
    },
    recomputeInputDigest: async () => {
      // 从**文件自身的字段**重算：这一步的威胁模型就是"案例目录里的 `估值输入.json` 被改过"
      //（估值会话对案例目录有写权限）。字节级的归档校验在 preview/handoff 那一步做。
      const frozen = await readJson(FINALIZE_PATHS.frozenInput)
      if (frozen === null) return ''
      const files = Array.isArray(frozen.files) ? frozen.files : []
      const materials: MaterialMetadata[] = files
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        .map((item, index) => ({
          fileId: text(item.fileId) || `material-${String(index + 1).padStart(3, '0')}`,
          fileName: text(item.fileName),
          // `absolutePath` 不参与指纹（`fingerprintOf` 只看 7 个字段），这里显式留空，
          // 避免把"原始绝对路径"重新带回任何可写产物。
          absolutePath: '',
          archiveRelativePath: text(item.archiveRelativePath),
          kind: text(item.kind),
          sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
          sha256: text(item.sha256),
          createdAt: item.createdAt === null || item.createdAt === undefined ? null : text(item.createdAt),
          modifiedAt: item.modifiedAt === null || item.modifiedAt === undefined ? null : text(item.modifiedAt),
          readable: item.readable !== false,
          duplicateOf: item.duplicateOf === null || item.duplicateOf === undefined ? null : text(item.duplicateOf),
        }))
      const methodRequest = text(frozen.methodRequest)
      // 方法缺失或不是指定方法（例如旧版本写进去的 auto）时**不猜一个**：
      // 摘要重算不出来就返回空串，让 finalize 如实判成缺口而不是拿默认值蒙混过去。
      if (!isMethodRequest(methodRequest)) return ''
      return valuationInputDigest({
        // 资产类型也进摘要：v3 冻结输入必填，缺它说明记录不是这一代的形状。
        assetType: (text(frozen.assetType) || 'real-estate') as 'real-estate',
        methodRequest,
        baseDate: text(frozen.baseDate) === '' ? null : text(frozen.baseDate),
        // 评估目的 / 价值类型也进摘要：遗漏它们会让"改了前提还按旧摘要通过 finalize"成立。
        purpose: text(frozen.purpose) === '' ? null : text(frozen.purpose),
        valueType: text(frozen.valueType) === '' ? null : text(frozen.valueType),
        // 计算表模板角色同样按文件自身字段复算：换了一行底稿，finalize 的摘要就该对不上。
        templateFileId: text(frozen.templateFileId) === '' ? null : text(frozen.templateFileId),
        supplementalPrompt: text(frozen.supplementalPrompt),
        files: materials,
      })
    },
  }
}
