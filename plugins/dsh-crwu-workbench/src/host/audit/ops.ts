import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import { normalizeOss } from '../environment/manifest.ts'
import { persistAudits, ensureRegistry } from '../state/registry.ts'
import type { AuditRecord, WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import { auditLabel, seqNoFromLabel } from './consts.ts'
import { auditPrompt } from './prompt.ts'
import { startChild, stopChild } from './spawn.ts'
import { ensureAuditRoot } from './root.ts'
import {
  applyAssessment,
  assessAudit,
  collectChildren,
  defaultCaseRoot,
  makeAgentStatusOf,
  occupancyIsDead,
  reclaimActive,
  releaseActive,
  stopAuditChild,
} from './state.ts'

/**
 * 审核生命周期的四个操作。
 *
 * 三个门禁必须一起生效，少一个就会出事故：
 * 1. **只挂顶层会话**：父级是子代理 → 派生的审核是 depth 2，「只监控一层」失效，
 *    父级自己结束之后状态就跟丢了；
 * 2. **单条并发**：同一时间只允许一条审核；同一条报告再次发起 = **带时间戳重启**
 *    （先停旧的，否则两条会往同一个案例目录对写）；
 * 3. **创建中防重**：连点两次不能起两条子会话（`startingKey` 是进程内锁）。
 */

export interface AuditDeps {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  world: WorldFacts
  /**
   * 「出结果就传」的钩子。
   *
   * 为什么在**状态轮询**里触发，而不是只靠上传看门狗：看门狗只处理「当前活动的」或
   * `ended === true` 的记录，而 `ended` 依赖 `subagent/end` 事件 —— 插件重装、事件丢失时
   * 它就不会被置上。在轮询里按 `status === 'done'` 再触发一次，是这条链路的兜底。
   */
  autoUpload?: (record: AuditRecord) => Promise<unknown>
}

/** 从 args/state 里取任务标识。 */
function auditKeyOf(args: Record<string, unknown>): string {
  return text(args.key) || text(args.seqNo)
}

/**
 * 审核根会话用哪个 preset：优先跟「你正在用的那个会话」，这样审核的工具链与你手动跑时一致。
 */
function presetHintOf(ctx: Context, state: WorkbenchState): string {
  const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: Record<string, unknown> } | undefined } | undefined
  if (state.parentSessionId === '' || typeof sessions?.get !== 'function') return ''
  return text(sessions.get(state.parentSessionId)?.header?.agentPreset)
}

/**
 * 找出「同一条报告已有的子会话」。
 *
 * 两边都算：记录里的（本进程启动过）+ 清单里 label 命中同一流水号且**真的还在 running**
 * 的（插件重装后记录可能已经没了，而那个子会话还在跑）。漏掉后者就会让两条子会话
 * 交叉写同一个案例目录。
 */
async function findStaleChildren(
  deps: AuditDeps,
  key: string,
  previous: AuditRecord | undefined,
  seqNo: string,
): Promise<string[]> {
  const stale: string[] = []
  if (previous !== undefined && previous.childId !== '' && previous.ended !== true && previous.stopped !== true) {
    stale.push(previous.childId)
  }
  // 挂在同一个根下：本进程的根就是 state.auditRoot，重启后旧的根仍在记录里，
  // 所以两处都查（见文件头的「状态跟不丢」约定）。
  const parentIds = new Set<string>()
  if (deps.state.auditRoot.sessionId !== '') parentIds.add(deps.state.auditRoot.sessionId)
  if (previous !== undefined && previous.parentSessionId !== '') parentIds.add(previous.parentSessionId)
  if (parentIds.size === 0) return stale
  const children = await collectChildren(deps.ctx, [...parentIds])
  const statusOf = makeAgentStatusOf(deps.ctx)
  for (const [childId, label] of Object.entries(children.labels)) {
    if (stale.includes(childId)) continue
    if (seqNoFromLabel(label) !== seqNo) continue
    if (statusOf(childId) !== 'running') continue
    stale.push(childId)
  }
  void key
  return stale
}

export interface AuditStartResult {
  ok: boolean
  error: string
  childId: string
  provider: string
  parentSessionId: string
  mode: string
  isRetry: boolean
  replaced: string
  replacedCount: number
  startedAt: string
  attempt: number
}

export async function auditStart(deps: AuditDeps, args: Record<string, unknown>): Promise<AuditStartResult> {
  const { ctx, config, state } = deps
  const failed = (error: string): AuditStartResult => ({
    ok: false, error, childId: '', provider: '', parentSessionId: state.auditRoot.sessionId,
    mode: 'one-shot', isRetry: false, replaced: '', replacedCount: 0, startedAt: '', attempt: 0,
  })

  await ensureRegistry(ctx, await deps.world.home(), state)

  const key = auditKeyOf(args)
  if (key === '') return failed('缺少任务标识')
  if (state.startingKey !== '') {
    return failed(`正在创建审核子会话（${state.startingKey}），请勿重复提交。`)
  }
  // 硬门禁零：没有选定的工作空间就不发起。
  //
  // 这条不是「体验优化」，是**安全门禁**：审核指令里的案例目录由 `workspacePath` 决定，
  // 为空时指令里根本不会出现「唯一根目录」，子会话的 cwd 又只能继承父会话 ——
  // 于是审核产物会落到父会话的工作目录里（常常就是源码仓库）。
  // 本仓反复强调的「绝不采用父会话自己的工作空间」这条规则，缺了这道门禁就等于没有。
  if (!state.workspaceChosen) {
    return failed(state.workspaceMissing
      ? `已选定的工作空间不存在：${state.workspacePath}。请在 ① 里重新选择（插件不会自动换到别的工作空间）。`
      : '尚未选定工作空间：请先在第 ① 步选定工作空间。')
  }
  state.startingKey = key
  try {
    const seqNo = text(args.seqNo)

    // 硬门禁一：审核必须挂在**审核根会话**下 —— 一个建在插件选定工作空间里的干净顶层会话。
    //
    // 这里原来是「哪个会话头最后挂载就用谁当父级」，于是你从工作空间 A 的会话点开面板，
    // 审核就挂到 A 下，从别处点开又挂到别处（用户报的「创建新会话时挂错了」）。
    // 根会话还顺带解决了 cwd：子会话只能继承父会话的 cwd，而根的 cwd 就是案例根目录。
    const root = await ensureAuditRoot(deps, { presetHint: presetHintOf(ctx, state) })
    if (!root.ok) return failed(root.error)
    const parentSessionId = root.sessionId

    const previous = state.audits[key]

    // 硬门禁二：别的报告正在跑时拒绝；同一条报告走下面的「重启」。
    if (state.activeChildId !== '' && state.activeKey !== key) {
      return failed(`已有审核在进行中（${state.activeKey || state.activeChildId}）。同一时间只允许一条，等它结束或先点「停止」。`)
    }

    const stale = await findStaleChildren(deps, key, previous, seqNo)
    // 有前一轮（记录里的或清单里的）→ 走重审提示词：从零重跑、不读旧产物。
    // 界面知道「云端已有审核意见」而 Host 不知道，所以它也显式传 retry:true。
    const isRetry = stale.length > 0 || previous !== undefined || args.retry === true

    let replaced = ''
    for (const childId of stale) {
      const stopped = await stopChild(ctx, childId, '这条报告已有审核子会话，先停掉它再重启一条', {
        handle: state.runs[childId],
        parentSessionId,
      })
      if (!stopped.aborted && stopped.errors.length > 0) {
        return failed(`已有的审核子会话（${childId.slice(0, 8)}）停不掉，为避免两条子会话交叉写同一个案例目录，已中止本次重启：${stopped.errors.join('；')}`)
      }
      delete state.runs[childId]
      if (replaced === '') replaced = childId
    }

    const stamp = new Date()
    const manifest = state.manifest
    const started = await startChild(ctx, {
      label: auditLabel(seqNo, stamp),
      prompt: auditPrompt({
        objectId: text(args.objectId),
        seqNo,
        project: text(args.project),
        workspace: state.workspacePath || state.caseRoot,
        oss: normalizeOss(manifest.oss, manifest.oss),
        isRetry,
      }),
      parentSessionId,
    })
    if (!started.ok) return failed(started.error)

    // 留住「可中止的信号 + run 句柄」：一次性运行没有别的停止入口
    // （subagents.interrupt 对 one-shot 是 no-op）。停止时必须先 abort 再 dispose。
    if (started.handle.run !== undefined || started.handle.abort !== undefined) {
      state.runs[started.childId] = started.handle
    }

    const record: AuditRecord = {
      key,
      childId: started.childId,
      seqNo,
      project: text(args.project),
      objectId: text(args.objectId),
      startedAt: stamp.toISOString(),
      parentSessionId,
      status: 'running',
      ended: false,
      stopped: false,
      stopReason: '',
      endReason: '',
      casePath: '',
      resultFile: '',
      htmlFile: '',
      caseName: '',
      uploadedAt: '',
      uploadError: '',
      ossPrefix: '',
      attempt: (previous?.attempt ?? 0) + 1,
      replacedChildId: replaced,
    }
    state.audits[key] = record
    state.activeKey = key
    state.activeChildId = started.childId
    state.activeSince = stamp.getTime()
    await persistAudits(ctx, await deps.world.home(), state)

    return {
      ok: true,
      error: '',
      childId: started.childId,
      provider: started.provider,
      parentSessionId,
      mode: 'one-shot',
      isRetry,
      replaced,
      replacedCount: stale.length,
      startedAt: record.startedAt,
      attempt: record.attempt,
    }
  } finally {
    if (state.startingKey === key) state.startingKey = ''
  }
}

export interface AuditStopResult {
  ok: boolean
  error: string
  key: string
  aborted: boolean
  disposed: boolean
  interrupted: boolean
  agentCancelled: boolean
  errors: string[]
}

export async function auditStop(deps: AuditDeps, args: Record<string, unknown>): Promise<AuditStopResult> {
  const { ctx, state } = deps
  await ensureRegistry(ctx, await deps.world.home(), state)
  const childId = text(args.childId) || state.activeChildId
  if (childId === '') {
    return { ok: false, error: '当前没有正在运行的审核子会话。', key: '', aborted: false, disposed: false, interrupted: false, agentCancelled: false, errors: [] }
  }
  const outcome = await stopAuditChild(ctx, state, childId, '用户在中瑞世联工作台手动停止了这条审核')
  await persistAudits(ctx, await deps.world.home(), state)
  return {
    ok: outcome.ok,
    error: outcome.error,
    key: outcome.key,
    aborted: true,
    disposed: false,
    interrupted: false,
    agentCancelled: false,
    errors: outcome.errors,
  }
}

export async function auditRelease(deps: AuditDeps): Promise<{ ok: boolean; released: string }> {
  const { state } = deps
  const previous = state.activeKey || state.activeChildId
  releaseActive(state)
  await persistAudits(deps.ctx, await deps.world.home(), state)
  return { ok: true, released: previous }
}

export interface AuditStatusResult {
  ok: boolean
  audits: AuditRecord[]
  parentSessionId: string
  active: { key: string; childId: string; since: number }
}

export async function auditStatus(deps: AuditDeps, args: Record<string, unknown>): Promise<AuditStatusResult> {
  const { ctx, state } = deps
  await ensureRegistry(ctx, await deps.world.home(), state)

  const wanted = Array.isArray(args.keys) ? args.keys.map((item) => text(item)) : []
  // 优先用**审核根会话**（子代理真正挂着的那个）；`state.parentSessionId` 只是「用户最后看过哪个
  // 会话」，拿它当主查询目标会随浏览漂移。
  const boundParentId = text(args.parentSessionId) || state.auditRoot.sessionId || state.parentSessionId
  const now = Date.now()

  // 一次要查**多个**父会话：每条记录都记着自己启动时那个父会话，而 state.parentSessionId
  // 只是「用户最后看过哪个会话」，会随浏览漂移。只查全局那一个，父会话一变所有记录
  // 都查不到 —— 界面集体退化成「未出结果」，也就是「会话跟丢」。
  const parentIds = new Set<string>()
  if (boundParentId !== '') parentIds.add(boundParentId)
  for (const record of Object.values(state.audits)) {
    if (record.parentSessionId !== '') parentIds.add(record.parentSessionId)
  }

  const { listed, labels, parentOf } = await collectChildren(ctx, [...parentIds])
  const statusOf = makeAgentStatusOf(ctx)

  // ── 兜底认领 ──────────────────────────────────────────────────────────────
  // 面板应该投影「父会话当前真实的子代理清单」，而不只是「本进程记过的东西」。
  // 还在跑但本进程没有记录的审核（插件重装、或当时还没落盘）按 label 认回对应的报告行；
  // 否则它在面板上完全不显示，也就没有任何入口能停掉它 —— 正是「子任务还在跑但看不到状态」。
  let adoptedAny = false
  for (const [childId, label] of Object.entries(labels)) {
    if (childId === '') continue
    const claimed = Object.values(state.audits).some((record) => record.childId === childId)
    if (claimed) continue
    // 只认领**真的还在跑**的：listChildren 是会话存储驱动的，跑完的一次性子会话依然在列。
    if (statusOf(childId) !== 'running') continue
    const seq = seqNoFromLabel(label)
    if (seq === '' || state.audits[seq] !== undefined) continue
    state.audits[seq] = {
      key: seq,
      childId,
      seqNo: seq,
      project: '',
      objectId: '',
      startedAt: '',
      parentSessionId: parentOf[childId] ?? boundParentId,
      status: 'running',
      ended: false,
      stopped: false,
      stopReason: '',
      endReason: '',
      casePath: '',
      resultFile: '',
      htmlFile: '',
      caseName: '',
      uploadedAt: '',
      uploadError: '',
      ossPrefix: '',
      attempt: 1,
      adopted: true,
    }
    if (reclaimActive(state, seq, childId, now)) adoptedAny = true
  }

  const keys = wanted.length > 0 ? wanted : Object.keys(state.audits)
  const out: AuditRecord[] = []
  let changed = adoptedAny
  const caseRoot = await defaultCaseRoot(ctx, state, () => deps.world.workdir())

  for (const key of keys) {
    const record = state.audits[key]
    if (record === undefined) continue
    const assessment = await assessAudit(
      { ctx, state, listed, agentStatusOf: statusOf, caseRoot, now },
      record,
    )
    // 判据是子 Agent 自己还在不在 running，所以父会话漂移、或这条审核挂在别的
    // 子代理之下，都不会再跟丢。
    const next = applyAssessment(record, assessment, record.childId === '' ? '' : (labels[record.childId] ?? ''))
    if (assessment.changed || record.status !== next.status) changed = true
    state.audits[key] = next

    // 占用锁自愈：锁可能因为父会话漂移被误释放（明明还有一条在跑，却判定「子会话不在了」）。
    if (assessment.childAlive && reclaimActive(state, key, next.childId, now)) changed = true

    // rec.ended 才是权威：idle（正常跑完但还没扫到交付件）同样必须释放占用，
    // 否则「重新审核」会被上一轮的锁永久挡住。
    if (assessment.release) releaseActive(state, next.childId)

    // 出结果就传：按磁盘上的交付件判定，不依赖 ended 事件是否到达。
    if (next.status === 'done' && next.uploadedAt === '' && next.uploading !== true && deps.autoUpload !== undefined) {
      await deps.autoUpload(next)
    }

    out.push(next)
  }

  // 门禁自愈：锁可能指向一个早已结束、甚至**没有记录**的子会话（重装 + 记录丢失）。
  // 那种情况下界面上没有任何入口能释放它，这条报告就再也起不来了。
  if (occupancyIsDead(state, out, statusOf)) {
    releaseActive(state)
    changed = true
  }

  // 只在真的有变化时落盘：这个接口每 10 秒被轮询一次。
  if (changed) await persistAudits(ctx, await deps.world.home(), state)

  return {
    ok: true,
    audits: out,
    parentSessionId: boundParentId,
    active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
  }
}

/** 会话层级：只有子代理才有 `origin === 'subagent'` / `delegationDepth`。 */
function delegationOf(ctx: Context, id: string): { found: boolean; subagent: boolean; depth: number } {
  const out = { found: false, subagent: false, depth: 0 }
  if (id === '') return out
  try {
    const sessions = ctx.get('sessions') as { get?: (sid: string) => { header?: Record<string, unknown> } | undefined } | undefined
    if (sessions === undefined || typeof sessions.get !== 'function') return out
    const header = sessions.get(id)?.header
    if (header === undefined) return out
    out.found = true
    out.subagent = text(header.origin) === 'subagent'
    out.depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0
  } catch (error) {
    // 会话服务不可用时保留「未知」，不阻断用户继续处理环境问题。
    void error
  }
  return out
}
