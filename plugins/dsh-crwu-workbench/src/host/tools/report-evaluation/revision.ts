import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { planDirRelative, planFilePath, type FinalizeReaders } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import { collectPlanFinalizeFacts } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import { finalizeReadersOf } from './finalize.ts'
import { finalizePlan } from '../../domains/report-evaluation/delivery/finalize.ts'
import { recalcProvidersOf } from '../../domains/report-evaluation/delivery/recalculation-engine.ts'
import {
  REVISION_INDEX_FILE,
  appendRevision,
  decideRevision,
  emptyRevisionIndex,
  failRevision,
  isRevisionChangeKind,
  promoteRevision,
  revisionDirectoryOf,
  revisionIndexFromJson,
} from '../../domains/report-evaluation/delivery/revision.ts'
import {
  candidateIdentityOf,
  emptyRegister,
  mergeCandidates,
  registerDigest,
  registerFromJson,
  resolveSelection,
  type CandidateInput,
  type CandidateRegister,
} from '../../domains/report-evaluation/market/candidates.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_revision`：**候选编号册 + 修订版本**（协议 39 · 设计稿 §7 / §6）。
 *
 * ## 它回答的四件事
 *
 * 1. `candidates`：把本次取到的候选并在**稳定编号册**上（`候选案例.json`），
 *    返回带编号的清单（采用 / 相近未达标 / 剔除 + 差异与理由）—— 这是员工看到并据以
 *    "加入 A、C 重算"的那份清单；
 * 2. `list`：当前版本、历史版本与编号册（旧版报告与底稿原样可读）；
 * 3. `recompute`：校验用户给的编号（未知 / 已退休分别报），建立**新版本**并写索引 ——
 *    新版本一出生是 `pending`，**不动当前指针**；
 * 4. `promote`：对**那一版自己的交付件**跑一次 Host 侧的完成判定，
 *    通过才把它设为当前版（上一版标成 `superseded` 并保留）。
 *
 * ## 三条不许含糊的口径
 *
 * - **编号由 Host 发、只增不重用**：用户说的"3 号"必须永远指同一条房源（`market/candidates.ts`）；
 * - **重复提交幂等**：同一（父版本、原因、编号集合、候选册指纹）不新建版本；
 * - **失败不前进**：重算失败时记录保留、编号保留、**当前指针不动**（旧版仍是当前版）。
 */

/** JSON 值（工具输出 schema 推导出来的形状要求）—— 用 `type` 才有隐式索引签名。 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const OPS = ['candidates', 'list', 'recompute', 'promote'] as const
type Op = typeof OPS[number]

interface RevisionArgs {
  caseDir?: unknown
  planId?: unknown
  op?: unknown
  /** `candidates`：本轮的候选（`status` / `reason` 由 Agent 按知识正文判定后给出）。 */
  candidates?: unknown
  /** `candidates`：检索轮次（补搜才 +1）。 */
  round?: unknown
  /** `recompute`：变更种类。 */
  changeKind?: unknown
  /** `recompute`：变更原因（用户说过什么）。 */
  reason?: unknown
  /** `recompute`：用户明确选中的候选编号。 */
  numbers?: unknown
  /** `recompute`：知识与模板指纹（本轮依据的版本）。 */
  knowledgeDigest?: unknown
  templateDigest?: unknown
  /** `promote`：要提升的版本。 */
  revision?: unknown
}

function opOf(value: unknown): Op | null {
  const raw = text(value).trim()
  return (OPS as readonly string[]).includes(raw) ? raw as Op : null
}

function numberListOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'number' && Number.isFinite(item) ? Math.trunc(item) : Number.NaN))
    .filter((item) => Number.isFinite(item))
}

function candidateInputsOf(value: unknown): CandidateInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is CandidateInput =>
    item !== null && typeof item === 'object' && !Array.isArray(item))
}

/** 编号册的对外视图（把"差异与理由"原样带出去）。 */
function registerView(register: CandidateRegister): Array<Record<string, Json>> {
  return [...register.entries]
    .sort((a, b) => a.number - b.number)
    .map((entry) => ({
      number: entry.number,
      status: entry.status,
      retired: entry.retired,
      source: entry.source,
      url: entry.url,
      community: entry.community,
      unitPrice: entry.unitPrice,
      buildingArea: entry.buildingArea,
      transactionType: entry.transactionType,
      evidence: entry.evidence,
      reason: entry.reason,
      firstSeenRound: entry.firstSeenRound,
      identity: entry.identity,
    }))
}

export function valuationRevisionTools(deps: ToolDeps) {
  const { ctx } = deps

  const tool = defineTool({
    name: VALUATION_TOOL_NAMES.revision,
    description: [
      '候选案例的**稳定编号册**与**修订版本**：按编号把相近候选纳入重算，生成新版并保留旧版。',
      'op=candidates：把本轮候选并在编号册上（已见过的房源沿用原编号，只增不重用），返回带编号的清单。',
      'op=list：当前版本、历史版本与编号册。',
      'op=recompute：校验用户给的编号后建立新版本（pending，不动当前指针）；重复提交幂等。',
      'op=promote：对那一版自己的交付件跑一次完成判定，通过才设为当前版（上一版保留为 superseded）。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', required: true, description: '方案 id。' },
      op: { type: 'string', required: true, description: OPS.join(' / ') },
      candidates: {
        type: 'array',
        description: 'op=candidates：本轮的候选清单（source / url / community / buildingArea / price / '
          + 'unitPrice / transactionType / evidence / status / reason）。status 由你按本轮知识正文判定。',
        items: { type: 'object', additionalProperties: true },
      },
      round: { type: 'integer', description: 'op=candidates：检索轮次（补搜才 +1，缺省 1）。' },
      changeKind: {
        type: 'string',
        description: 'op=recompute：user-case-selection / research-round / rule-change / manual',
      },
      reason: { type: 'string', description: 'op=recompute：变更原因（用户说过什么）。' },
      numbers: {
        type: 'array', items: { type: 'integer' },
        description: 'op=recompute：用户明确选中的候选编号（按编号册里的数字）。',
      },
      knowledgeDigest: { type: 'string', description: 'op=recompute：本轮知识快照指纹。' },
      templateDigest: { type: 'string', description: 'op=recompute：本轮计算表模板指纹。' },
      revision: { type: 'integer', description: 'op=promote：要提升的版本号。' },
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
          op: { type: 'string', required: true },
          candidatesPath: { type: 'string', required: true },
          revisionIndexPath: { type: 'string', required: true },
          currentRevision: { type: 'integer', required: true },
          nextNumber: { type: 'integer', required: true },
          candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          revisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          revision: { type: 'integer', required: true, description: 'op=recompute / promote 的版本号；其余为 0' },
          revisionDirectory: { type: 'string', required: true, description: '该版的交付件目录（相对方案目录；第 1 版为空串）' },
          duplicate: { type: 'boolean', required: true, description: 'op=recompute：这次提交与已有版本完全相同 → 幂等处理' },
          state: { type: 'string', required: true, description: '该版的当前状态（pending / current / superseded / failed）' },
          problems: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (result) => renderJson(result as Record<string, unknown>),
    },
    async execute(args: RevisionArgs, exec): Promise<RevisionResult> {
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) {
        return { ...idle(), ...failure(access.errorKind ?? 'policy', access.error) }
      }
      if (access.kind !== 'valuation') {
        return { ...idle(), ...failure('policy', '这条会话不是本轮估值会话：候选编号与修订只在估值子会话里登记') }
      }
      const caseDir = access.casePath
      const planId = text(args.planId).trim()
      const planRelative = planDirRelative(planId)
      if (planRelative === '') {
        return { ...idle(), ...failure('input', `planId 不是单段安全标识：「${planId}」`) }
      }
      const planRoot = joinLocalPath(caseDir, planRelative)
      const op = opOf(args.op)
      if (op === null) {
        return { ...idle(), ...failure('input', `未知的 op：「${text(args.op)}」（只允许 ${OPS.join(' / ')}）`) }
      }
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }
      const workdir = await deps.world.workdir()
      const platform = await deps.world.platform()
      const madeDirs = (dir: string) =>
        ensureDirectory(deps.access, dir, { workdir, platform, ...writeOptions })

      const candidatesPath = joinLocalPath(planRoot, '候选案例.json')
      const indexRelative = planFilePath(planId, REVISION_INDEX_FILE)
      const indexPath = joinLocalPath(caseDir, indexRelative)
      const notes: string[] = []

      // ── 读回候选册与修订索引（形状不认识时重建并如实说明）──
      const storedRegister = await readTextIfExists(ctx, candidatesPath)
      let register: CandidateRegister = emptyRegister({ planId, updatedAt: new Date().toISOString() })
      if (storedRegister.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(storedRegister)
        } catch {
          notes.push('上一轮的候选案例.json 不是合法 JSON：按新册开始，**编号可能重排**，请人工核对。')
          parsed = null
        }
        const previous = registerFromJson(parsed)
        if (previous !== null && previous.planId === planId) register = previous
        else if (parsed !== null) notes.push('上一轮的候选案例.json 结构不认识或属于别的方案：按新册开始。')
      }
      const storedIndex = await readTextIfExists(ctx, indexPath)
      let index = emptyRevisionIndex({ planId, updatedAt: new Date().toISOString() })
      if (storedIndex.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(storedIndex)
        } catch {
          notes.push('上一轮的修订记录.json 不是合法 JSON：本轮不新建版本，请人工先修好它（**不许**在坏索引上写）。')
          return { ...idle(), ...failure('infrastructure', notes[notes.length - 1]) }
        }
        const previous = revisionIndexFromJson(parsed)
        if (previous !== null && previous.planId === planId) index = previous
        else notes.push('上一轮的修订记录.json 结构不认识或属于别的方案：本轮不新建版本。')
      }

      const base = {
        ...idle(),
        caseDir,
        planId,
        op,
        candidatesPath: '候选案例.json',
        revisionIndexPath: indexRelative,
        currentRevision: index.currentRevision,
        nextNumber: register.nextNumber,
        candidates: registerView(register),
        revisions: index.records.map((record) => ({ ...record })),
        notes,
      }

      if (op === 'list') {
        return { ...base, ok: true }
      }

      if (op === 'candidates') {
        const incoming = candidateInputsOf(args.candidates)
        if (incoming.length === 0) {
          return { ...base, ...failure('input', 'op=candidates 需要给候选清单：没有候选就没有编号可发') }
        }
        const merged = mergeCandidates(register, incoming, {
          round: typeof args.round === 'number' ? args.round : 1,
          updatedAt: new Date().toISOString(),
        })
        const made = await madeDirs(planRoot)
        if (!made.ok) return { ...base, ...failure('infrastructure', `方案目录不可写：${made.error}`) }
        const written = await writeCaseText(ctx, candidatesPath, canonicalJson({
          ...merged.register, updatedAt: merged.register.updatedAt,
        }), writeOptions)
        if (!written.ok) return { ...base, ...failure('infrastructure', `候选册落盘失败：${written.error}`) }
        return {
          ...base,
          ok: true,
          nextNumber: merged.register.nextNumber,
          candidates: registerView(merged.register),
          notes: [
            ...notes,
            merged.added.length > 0 ? `新登记 ${String(merged.added.length)} 条候选（编号 ${merged.added.join('、')}）` : '',
            merged.register.entries.some((entry) => entry.retired)
              ? '有候选这一轮没有出现：编号保留并标记为 retired（不重排、不重用）' : '',
          ].filter((item) => item !== ''),
        }
      }

      if (op === 'recompute') {
        const numbers = numberListOf(args.numbers)
        const changeKind = text(args.changeKind).trim() || 'user-case-selection'
        if (!isRevisionChangeKind(changeKind)) {
          return { ...base, ...failure('input', `不认识的变更种类：${changeKind}`) }
        }
        // ① 编号校验：未知 / 已退休分别报出来（**不静默忽略**）。
        if (changeKind === 'user-case-selection') {
          const selection = resolveSelection(register, numbers)
          if (selection.unknown.length > 0) {
            return {
              ...base,
              ...failure('input',
                `编号 ${selection.unknown.join('、')} 不在候选册里：可选编号是 `
                + `${register.entries.filter((entry) => !entry.retired).map((entry) => entry.number).join('、') || '(空)'}`),
            }
          }
          if (selection.retired.length > 0) {
            return {
              ...base,
              ...failure('input',
                `编号 ${selection.retired.join('、')} 已经不在最新一轮结果里（retired）：`
                + '请确认要不要按它重算（那要用它的历史证据），或改用当前清单里的编号'),
            }
          }
          if (!selection.ok) {
            return { ...base, ...failure('input', '没有有效的候选编号：请给出用户明确选中的编号') }
          }
        }
        // ② 决定这一版该不该建（重复提交幂等）。
        const decision = decideRevision(index, {
          changeKind,
          reason: text(args.reason),
          adoptedNumbers: numbers,
          candidatesDigest: registerDigest(register),
          knowledgeDigest: text(args.knowledgeDigest),
          templateDigest: text(args.templateDigest),
          searchRound: typeof args.round === 'number' ? args.round : 1,
        }, { now: new Date().toISOString() })
        if (decision.kind === 'invalid') {
          return { ...base, ...failure('input', decision.reason) }
        }
        if (decision.kind === 'duplicate') {
          const existing = index.records.find((record) => record.revision === decision.revision)
          return {
            ...base,
            ok: true,
            duplicate: true,
            revision: decision.revision,
            revisionDirectory: existing?.directory ?? revisionDirectoryOf(decision.revision),
            state: existing?.state ?? 'pending',
            revisions: index.records.map((record) => ({ ...record })),
            notes: [...notes, decision.reason],
          }
        }
        // ③ 建目录并落索引；**当前指针不动**。
        const directory = revisionDirectoryOf(decision.record.revision)
        if (directory !== '') {
          const made = await madeDirs(joinLocalPath(planRoot, directory))
          if (!made.ok) {
            return { ...base, ...failure('infrastructure', `修订目录不可写：${made.error}`) }
          }
        }
        const appended = appendRevision(index, decision.record, decision.record.createdAt)
        const written = await writeCaseText(ctx, indexPath, canonicalJson({
          ...appended, updatedAt: appended.updatedAt,
        }), writeOptions)
        if (!written.ok) {
          // 落盘失败 = 这一版没有被登记：如实失败，**不**假装建好了。
          return { ...base, ...failure('infrastructure', `修订记录落盘失败：${written.error}`) }
        }
        return {
          ...base,
          ok: true,
          revision: decision.record.revision,
          revisionDirectory: directory,
          state: decision.record.state,
          revisions: appended.records.map((record) => ({ ...record })),
          notes: [
            ...notes,
            `已建立第 ${String(decision.record.revision)} 版（pending）：把这一版的结论 / 报告 / 底稿写进 `
            + `${directory === '' ? '方案根' : directory}，再调 op=promote 核对通过后才会成为当前版。`,
            `旧版（第 ${String(index.currentRevision)} 版）保持原样，报告与底稿都不被覆盖。`,
          ],
        }
      }

      // ── op=promote：对**那一版自己的交付件**跑一次 Host 侧完成判定 ──
      const revision = typeof args.revision === 'number' && Number.isFinite(args.revision)
        ? Math.max(0, Math.trunc(args.revision)) : 0
      const target = index.records.find((record) => record.revision === revision)
      if (target === undefined) {
        return { ...base, ...failure('input', `不存在的修订版本：${String(revision)}`) }
      }
      const readers: FinalizeReaders = {
        ...finalizeReadersOf(ctx, caseDir),
        recalcProviders: async () => recalcProvidersOf(deps.config),
      }
      const facts = await collectPlanFinalizeFacts({
        projectId: text(deps.valuationScopes?.scopeOf(callerIdentity(exec).childId)?.projectId)
          || caseDir.split(/[\\/]/).pop() || '',
        planId,
        taskId: planId,
        requestedStatus: 'completed',
        frozenInputDigest: '',
        screenshotRequired: false,
        valuationPath: 'combined',
        revision,
        verifiedAt: new Date().toISOString(),
      }, readers)
      const receipt = finalizePlan(facts)
      if (!receipt.ok || receipt.status === 'blocked' || receipt.problems.length > 0) {
        // 核对没过：**不提升**，把这一版标成失败（记录保留、编号保留、当前指针不动）。
        const failed = failRevision(index, revision, receipt.problems.join('；').slice(0, 400) || `状态 ${receipt.status}`,
          new Date().toISOString())
        await writeCaseText(ctx, indexPath, canonicalJson({ ...failed, updatedAt: failed.updatedAt }), writeOptions)
        return {
          ...base,
          ...failure('input',
            `第 ${String(revision)} 版没有通过核对（状态 ${receipt.status}）：`
            + `${receipt.problems.slice(0, 5).join('；') || '缺交付件'}。当前版仍是第 ${String(index.currentRevision)} 版。`),
          problems: receipt.problems,
          state: 'failed',
        }
      }
      const promoted = promoteRevision(index, revision, {
        checked: true, checkedRevision: revision, checkedAt: new Date().toISOString(),
      })
      if (!promoted.ok) {
        return { ...base, ...failure('input', promoted.reason) }
      }
      const written = await writeCaseText(ctx, indexPath, canonicalJson({
        ...promoted.index, updatedAt: promoted.index.updatedAt,
      }), writeOptions)
      if (!written.ok) {
        return { ...base, ...failure('infrastructure', `修订记录落盘失败：${written.error}`) }
      }
      return {
        ...base,
        ok: true,
        revision,
        revisionDirectory: target.directory,
        state: 'current',
        currentRevision: promoted.index.currentRevision,
        revisions: promoted.index.records.map((record) => ({ ...record })),
        notes: [
          ...notes,
          `第 ${String(revision)} 版通过核对，已成为当前版；上一版（第 ${String(target.parentRevision)} 版）标为 superseded 并保留。`,
        ],
      }
    },
  })

  return [tool]
}

/** 工具应答的形状（与 output schema 一一对应）。 */
interface RevisionResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  planId: string
  op: string
  candidatesPath: string
  revisionIndexPath: string
  currentRevision: number
  nextNumber: number
  candidates: Array<Record<string, Json>>
  revisions: Array<Record<string, Json>>
  revision: number
  revisionDirectory: string
  duplicate: boolean
  state: string
  problems: string[]
  notes: string[]
}

function idle(): RevisionResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', planId: '',
    op: '', candidatesPath: '', revisionIndexPath: '', currentRevision: 0, nextNumber: 1,
    candidates: [], revisions: [], revision: 0, revisionDirectory: '',
    duplicate: false, state: '', problems: [], notes: [],
  }
}

/** 供工具注册表引用（与其它估值工具同一形状）。 */
export { candidateIdentityOf }
