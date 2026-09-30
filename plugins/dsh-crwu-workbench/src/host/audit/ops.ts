import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import { normalizeOss } from '../environment/manifest.ts'
import { persistAudits, ensureRegistry } from '../state/registry.ts'
import type { AuditFailureRecord, AuditRecord, WorkbenchState } from '../state/types.ts'
import type { AuditStopPhase, AuditStopView } from '../../shared/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { auditLabel, seqNoFromLabel } from './consts.ts'
import { REQUIRED_AUDIT_CHILD_TOOLS } from '../tools/consts.ts'
import { auditPrompt } from './prompt.ts'
import { agentRegistry, boundParentAgent, startChild, stopChild } from './spawn.ts'
import { inspectAuditRootPolicy } from './policy.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ensureAuditRoot } from './root.ts'
import { auditToolsVisible, bootstrapInputSnapshot, capabilityPreflight } from './preflight.ts'
import { ensureCaseDirectory } from '../tools/case-files.ts'
import type { H3yunFormResolver } from '../h3yun/form.ts'
import type { PythonRuntimeResolver } from '../runtime/python.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'
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
  /** Broker（协议 18）：状态落盘与跨边界取数都经它；审核链路**没有**第二条特权通道。 */
  access: LocalAccessBroker
  /** 表单 code 的实例级解析器：审核启动必须先把 `schemaCode` 解析出来，再交给 bootstrap。 */
  form: H3yunFormResolver
  /** DSH 自带 Python：审核脚本的运行时，启动前必须解析成功（否则子代理会去找系统 python3）。 */
  python: PythonRuntimeResolver
  /**
   * 「出结果就传」的钩子。
   *
   * 为什么在**状态轮询**里触发，而不是只靠上传看门狗：看门狗只处理「当前活动的」或
   * `ended === true` 的记录，而 `ended` 依赖 `subagent/end` 事件 —— 插件重装、事件丢失时
   * 它就不会被置上。在轮询里按 `status === 'done'` 再触发一次，是这条链路的兜底。
   */
  autoUpload?: (record: AuditRecord) => Promise<unknown>
  /**
   * **授权后的环境就绪检查**（协议 18 · C3）。
   *
   * 由 Host 接线到与界面门禁**同一份能力快照**（`environment/gate.ts`）。为什么在
   * `audit-start` 已经判过一次之后还要再判：那一次判的是"操作能不能进"，这一次判的是
   * "**创建子代理**之前事实有没有变"——两者之间隔着根会话创建、能力预检与输入快照三条
   * 外部调用（各要几秒到几十秒），期间员工完全可能撤销授权或把工作空间改掉。
   * 缺省（测试直接调 `auditStart`）时跳过，生产路径由 `ops/core.ts` 注入。
   */
  readiness?: () => Promise<{ ok: boolean; error: string }>
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

  /**
   * 当前阶段：**每个失败都要留档**，而"卡在哪一步"要由代码说，不能事后从文案里猜。
   * 所以这里是一个显式游标，通过在阶段边界赋值推进（见每一处 `stage = …`）。
   */
  let stage = '准备'
  /** Host 自己算出来的案例目录：失败记录里要留**这个**（模型提交的 `caseDir` 只是主张，Host 不采信）。 */
  let resolvedCaseDir = ''
  /** 被降级吞掉的事实（如"会话已建，但没能挂到工作空间"）—— 它们最容易被丢掉，必须跟失败一起留档。 */
  let notes: string[] = []

  /**
   * 构造失败结果，并把**这一次失败的全部信息**落盘（记忆 `state.lastAuditFailure`）后返回。
   *
   * 为什么在这里而不是 RPC 层：`auditStart` 的每一条失败路径都走这个闭包 —— 放在这里就**漏不掉**；
   * 放 RPC 层还得再判断一次"哪些算失败"。留档内容见 `AuditFailureRecord`（脱敏，不含命令原文与凭据）。
   */
  const failed = (error: string, extra: { errorKind?: string; notes?: string[] } = {}): AuditStartResult => {
    const record: AuditFailureRecord = {
      at: new Date().toISOString(),
      reason: error,
      stage,
      errorKind: extra.errorKind ?? '',
      seqNo: text(args.seqNo),
      objectId: text(args.objectId),
      caseDir: resolvedCaseDir,
      attemptId: state.startingKey,
      notes: [...notes, ...(extra.notes ?? [])],
    }
    state.lastAuditFailure = record
    // 也给宿主日志一份（界面上只有一句话，结构化事实在这里）。
    ctx.logger?.error?.('crwu-workbench: 审核发起失败 %o', record)
    return {
      ok: false, error, childId: '', provider: '', parentSessionId: state.auditRoot.sessionId,
      mode: 'one-shot', isRetry: false, replaced: '', replacedCount: 0, startedAt: '', attempt: 0,
    }
  }

  stage = '工作空间'
  await ensureRegistry({ ctx, home: await deps.world.home(), state, access: deps.access })

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
    const platform = await deps.world.platform()
    const previous = state.audits[key]

    // 硬门禁一：别的报告正在跑时拒绝；同一条报告走后面的「重启」。
    // 放在**建案例目录与建根之前**：并发冲突是最便宜的拒绝理由，被拒的发起不该留下
    // 空目录、更不该新起一个根会话（那会让面板上多出一个没人用的根）。
    if (state.activeChildId !== '' && state.activeKey !== key) {
      return failed(`已有审核在进行中（${state.activeKey || state.activeChildId}）。同一时间只允许一条，等它结束或先点「停止」。`)
    }

    // 硬门禁零之二：**先由 Host 把本轮的案例目录算出来并建出来**。
    //
    // 顺序是硬要求（2026-09-29 用户复查 P1 的第 4 条）：审核根的 cwd 与沙箱边界**都是案例目录**，
    // 所以案例目录必须先存在；"先建根、再算案例目录"会让根在那个瞬间没有合法边界。
    //
    // ⚠️ 这一级目录是插件**唯一**允许自动创建的目录，而它在会话 cwd 之外 —— 所以它必须经
    // Broker 的 `system.case-directory.write`（特权、来源 `audit-host`、边界 = 已选工作空间）。
    // 2026-09-30 的现场就是这里绕过 Broker 直接调裸 `runShell` 的结果：命令拿到部署默认的
    // `workspace-write` 沙箱，`mkdir` 回 `Operation not permitted`，而员工本人对那个目录是有写权限的。
    const workspace = state.workspacePath || state.caseRoot
    const caseDir = caseDirOf(workspace, seqNo)
    resolvedCaseDir = caseDir
    if (caseDir === '') return failed('缺少案例目录：请先在第 ① 步选定工作空间，并确认任务带有流水号。')
    stage = '案例目录'
    const madeCase = await ensureCaseDirectory(deps.access, caseDir, {
      workspace,
      // 只读探测的 cwd 用一个确定存在的目录（会话 cwd）：拿工作空间自己当 cwd 时，
      // "目录不存在"与"沙箱没放行"会塌成同一个结论。
      probeWorkdir: await deps.world.workdir(),
      platform,
    })
    if (!madeCase.ok) {
      return failed(`创建案例目录失败：${caseDir}（${madeCase.error}）`, { errorKind: madeCase.errorKind })
    }

    // 硬门禁一：审核必须挂在**审核根会话**下 —— 一个 cwd 就是本轮案例目录的干净顶层会话。
    //
    // 这里原来是「哪个会话头最后挂载就用谁当父级」，于是你从工作空间 A 的会话点开面板，
    // 审核就挂到 A 下，从别处点开又挂到别处（用户报的「创建新会话时挂错了」）。
    // 根会话还顺带解决了 cwd：子会话只能继承父会话的 cwd，而根的 cwd 就是案例根目录。
    stage = '审核根会话'
    const root = await ensureAuditRoot(deps, { presetHint: presetHintOf(ctx, state), casePath: caseDir })
    if (!root.ok) return failed(root.error, { notes: root.notes })
    const parentSessionId = root.sessionId

    // 硬门禁三：**结构化 Tool 链路必须在创建子代理之前证明可用**。
    //
    // 两件事缺一不可（见 `preflight.ts`）：
    // 1. 全部必需 Tool 对审核根 Agent 可见 —— 看不到就绝不创建子代理，
    //    否则子代理只能去 shell 里找命令（正是本次改造要消灭的行为）；
    // 2. 真的通过 policy pipeline 调一次零副作用的 `crwu_audit_capabilities` ——
    //    证明注册表、参数校验、pre/guard/post 链路与输出 schema 都对得上。
    // 重建根时会查一次，但**复用的根不会重新预检**，所以这里每次发起都必须再查。
    // 放在占用门禁之后：并发冲突是更早、更便宜的拒绝理由，不该被能力检查的耗时挡在后面。
    // 取法只有一处实现（`boundParentAgent`）：空 id 回 undefined，与"没绑定会话"是同一支。
    const rootAgent = boundParentAgent(ctx, parentSessionId)
    const gate = await capabilityPreflight(ctx, rootAgent)
    if (!gate.ok) return failed(`审核能力预检未通过：${gate.error}`)

    // 硬门禁四：**报告必须在 Host 侧精确定位并取一次数**，然后才允许创建子代理。
    //
    // 为什么放在创建子代理之前：原来只把 objectId/seqNo/project 交给子代理，而记录接口要
    // `schemaCode` —— 子代理于是自己去「发现表单、列记录、在案例目录里翻找材料」，既重复取数，
    // 也可能读到别的流水号的过期材料。`schemaCode` 是 Host 的基础设施状态，这里一次性解析好，
    // 并把记录与附件元数据落成输入快照交给它。
    const objectId = text(args.objectId)

    const form = await deps.form.ensure()
    if (!form.ok) return failed(`无法定位氚云表单（报告审核），已终止本次审核：${form.error}`)

    // DSH 自带 Python 是审核脚本的运行时。解析不出来就**不要**起子代理 ——
    // 否则子代理会退回系统 `python3`（缺 openpyxl，结果不可信）。
    const python = await deps.python.check({ agent: rootAgent })
    if (!python.ok && python.unresolved !== true) {
      // **确实缺失**（载荷没有 python / 路径不可用 / 缺必需包）→ 拒绝启动：
      // 子代理否则会退回系统解释器（缺 openpyxl，结果不可信）。
      //
      // ⚠️ 但「受限沙箱起不了进程」**不是**「运行时不可用」（2026-09-30 真机：控制探测证明
      // 连 pwsh 自己都起不来）。两者处置完全不同，所以门禁的**第一句**必须跟着事实走 ——
      // 否则维护者会去重装运行时，而真正要修的是部署侧的沙箱后端。
      const headline = python.blockedBySandbox
        ? '本机受限沙箱起不了任何进程（部署侧问题），已终止本次审核'
        : 'DSH 脚本运行时不可用，已终止本次审核'
      return failed(`${headline}：${python.error || python.state}`)
    }
    // `unresolved`（宿主这次**没问到**：工具调用失败/超时/报错，常见于宿主没有会话作用域）
    // **不再拒绝启动** —— 子会话本身有 agent 作用域，能在那里把运行时解析出来；
    // 提示词会相应换成「由你在子会话里解析」那一段（唯一来源仍是那个工具的返回）。

    // **没确认静默之前不许启动下一条审核**（F1）。两条判据：
    // ① 还有停止流程在跑（内存事实）；② 上一条留下 stopPhase=timeout/failed 且 quiesced=false
    //（持久化事实，跨重启也成立）。占用门禁管的是"同一条报告的锁"，这里管的是"停止未确认"。
    const stoppingNow = Object.keys(state.stopInFlight).length > 0
    const unquiet = Object.values(state.audits).some((record) => record !== undefined
      && record.quiesced === false
      && (record.stopPhase === 'timeout' || record.stopPhase === 'failed'))
    if (stoppingNow || unquiet) {
      return failed('上一条审核还在停止过程中（尚未确认子会话完全退出）：确认停止前不能启动新的审核。请在工作台「停止审核」重试或等待。')
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
      // 判据是**静默**（`quiesced`），不是"abort 发出去了"：dispose 超时 + Agent 仍在 running 时，
      // 旧子会话可能还在写同一个案例目录，起第二条会造成两条对写并覆盖旧 childId（2026-09-29 用户复查的 P1）。
      if (!stopped.quiesced) {
        return failed(`已有的审核子会话（${childId.slice(0, 8)}）没法确认已经停下来，为避免两条子会话交叉写同一个案例目录，已中止本次重启：${[...stopped.errors, ...stopped.notes].join('；') || '状态未知'}`)
      }
      delete state.runs[childId]
      if (replaced === '') replaced = childId
    }

    const stamp = new Date()
    const manifest = state.manifest
    // attemptId 每轮都新：重审必须得到**新的**快照，而不是复用上一轮的输入。
    const attemptId = `${key}-a${String((previous?.attempt ?? 0) + 1)}-${stamp.getTime().toString(36)}`
    // 重审（或任何带旧记录的情形）强制刷新快照：上一轮的记录可能已经过期。
    stage = '输入快照'
    const boot = await bootstrapInputSnapshot(ctx, rootAgent, {
      objectId,
      seqNo,
      caseDir,
      attemptId,
      refresh: isRetry || previous !== undefined,
    })
    if (!boot.ok || boot.snapshot === null) {
      return failed(`输入快照交接未完成，已终止本次审核（未创建子代理）：${boot.error}`,
        { errorKind: boot.errorKind === '' ? 'infrastructure' : boot.errorKind })
    }
    const snapshot = boot.snapshot

    // 硬门禁五：**创建子代理之前的最后一道环境就绪检查**（协议 18 · C3）。
    //
    // 到这一步为止已经花掉了根会话策略收敛、工具可见性预检、能力自检与输入快照四段
    // 外部调用；期间"允许本机访问"可能被撤销、工作空间可能被换掉。带着过期事实去起一条
    // 审核，后果不是"晚一点失败"，而是**一条注定拿不到凭据的审核**（它会一路把
    // 「未登录 / 密钥错误」当结论写进交付件）。
    if (deps.readiness !== undefined) {
      const ready = await deps.readiness()
      if (!ready.ok) return failed(`审核启动前环境已不就绪，未创建子代理：${ready.error}`)
    }

    // **两阶段握手**（2026-09-29 用户复查的 P1）：子会话在 `start()` 返回**之前**就已经发布、
    // prompt 也开始跑，所以权威 scope 必须**先**落盘 —— 否则那段窗口里：
    //   · 面板类 Tool 的身份拒绝（`isAuditChild`）失效（childId 还不存在）；
    //   · 案例内 Tool 因为没有 scope 而随机 fail closed。
    // 预留的身份是"**父会话 = 审核根**"：`start()` 返回后再把真 childId 写上去。
    const pendingRecord: AuditRecord = {
      key,
      childId: '',
      seqNo,
      project: text(args.project),
      objectId,
      startedAt: stamp.toISOString(),
      parentSessionId,
      status: 'running',
      ended: false,
      stopped: false,
      stopReason: '',
      endReason: '',
      casePath: caseDir,
      attemptId,
      allowedAttachmentIds: (Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds : [])
        .map((id) => text(id)).filter((id) => id !== ''),
      pending: true,
      resultFile: '',
      htmlFile: '',
      caseName: '',
      uploadedAt: '',
      uploadError: '',
      ossPrefix: '',
      attempt: (previous?.attempt ?? 0) + 1,
      replacedChildId: replaced,
    }
    const previousRecord = state.audits[key]
    state.audits[key] = pendingRecord
    const pendingPersisted = await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
    if (!pendingPersisted) {
      // 连 scope 都落不下来就**不要**创建子会话（这正是最初 Windows 权限现场会踩的坑）。
      if (previousRecord === undefined) delete state.audits[key]
      else state.audits[key] = previousRecord
      return failed('审核 scope 没能写入状态文件（本机权限或磁盘问题）：未创建子会话。')
    }

    const started = await startChild(ctx, {
      label: auditLabel(seqNo, stamp),
      prompt: auditPrompt({
        objectId,
        seqNo,
        project: text(args.project),
        workspace: state.workspacePath || state.caseRoot,
        oss: normalizeOss(manifest.oss, manifest.oss),
        isRetry,
        attemptId,
        platform,
        // 没问到就交空值 → 提示词换成「由子会话自己解析」那一段（不许去找系统解释器）。
        python: python.ok ? { path: python.path, versionText: python.versionText, distributions: python.distributions } : null,
        snapshot: {
          attemptId: text(snapshot.attemptId) || attemptId,
          dir: text(snapshot.snapshotDir),
          recordPath: text(snapshot.snapshotPath),
          attachmentsPath: text(snapshot.attachmentsPath),
          metadataPath: text(snapshot.metadataPath),
          digest: text(snapshot.digest),
          fieldCount: typeof snapshot.fieldCount === 'number' ? snapshot.fieldCount : 0,
          attachmentCount: typeof snapshot.attachmentCount === 'number' ? snapshot.attachmentCount : 0,
          objectId: text(snapshot.objectId) || objectId,
          seqNo: text(snapshot.seqNo) || seqNo,
        },
      }),
      parentSessionId,
    })
    if (!started.ok) {
      // 回滚 pending：否则会留下一条永远"待接管"的记录（面板上显示在跑，其实没有子会话）。
      if (previousRecord === undefined) delete state.audits[key]
      else state.audits[key] = previousRecord
      await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
      return failed(started.error)
    }

    // **没确认停下来就不许丢身份**（2026-09-29 第三轮复查的 P1）：
    // 把记录标成退役（只拒绝、不放行），**保留** run 句柄与占用，直到确认静默。
    // `stopChild` 的超时/仍在运行语义只有在调用方检查 `quiesced` 时才有意义。
    const retireNotQuiesced = async (childId: string, stopped: { errors: string[]; notes: string[] }): Promise<void> => {
      // 用**真实记录**（含 childId）：退役之后仍然要靠它认出那个子会话、再停一次。
      state.audits[key] = {
        ...record,
        retired: true,
        pending: false,
        ended: false,
        stopped: false,
        status: 'unknown',
        stopReason: '失败后未能确认子会话停止',
      }
      // 句柄与占用都留着：用户还能在工作台再停一次，也只许停这一条。
      if (started.handle.run !== undefined || started.handle.abort !== undefined) {
        state.runs[childId] = started.handle
      }
      state.activeKey = key
      state.activeChildId = childId
      await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
      void stopped
    }
    const notQuiescedText = (stopped: { errors: string[]; notes: string[] }): string =>
      [...stopped.errors, ...stopped.notes].join('；') || '状态未知'

    // 子会话起来之后的任何失败都要把**这条 pending 记录**一起回滚：
    // 留着它面板会显示"在跑"，而实际没有可用的子会话（2026-09-29 用户复查的 P1 修复配套）。
    // ⚠️ 只有在**确认子会话已经停下来**之后才允许调用（调用方负责先看 `stopChild().quiesced`）。
    const rollbackRecord = async (): Promise<void> => {
      if (previousRecord === undefined) delete state.audits[key]
      else state.audits[key] = previousRecord
      delete state.runs[started.childId]
      releaseActive(state, started.childId)
      await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
    }

    // 真身份到手：把记录**先**构造出来（下面的子会话复查失败时，退役记录要用它保住 childId）。
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
      // **scope 的核心字段在这里就写死**（Host 自己算出来的案例目录，不是模型提交的字符串）。
      // 留空再等评估阶段回填是不行的：子会话在评估之前就已经能调 Tool 了，
      // 那段时间里"这轮的案例目录是什么"完全没有权威答案 —— 正是越界读写的窗口。
      casePath: caseDir,
      attemptId,
      // 只认本轮**可信快照**里登记的附件。空数组不是"都允许"，是"一个都不允许"。
      allowedAttachmentIds: (Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds : [])
        .map((id) => text(id)).filter((id) => id !== ''),
      resultFile: '',
      htmlFile: '',
      caseName: '',
      uploadedAt: '',
      uploadError: '',
      ossPrefix: '',
      attempt: (previous?.attempt ?? 0) + 1,
      replacedChildId: replaced,
      // 真身份到手：清掉 pending 标记（窗口关闭）。
      pending: false,
    }

    // 硬门禁四（child scope）：provider 可能在子会话上再收窄一次工具可见范围。
    //
    // 根 Agent 可见 **不等于** 子代理可见 —— 子代理是新的 scope，预设/委托运行时都可能
    // 再加一层 restriction。所以子会话一发布就按**它自己的 scope** 复查一遍；
    // 缺任何一个就立刻停掉它并失败，不让一条注定要去找 PATH 的审核跑下去。
    // 子 Agent 还查不到时只记一条 note（不阻断）—— 那种情况下下面的记录里会带 `childGate` 说明。
    // ⚠️ 优先用 `started.localAgent`：那是 DSH 在 `start` 兑现时给出的**同一个**本进程子 Agent，
    // 比事后 `agents.get(id)` 更权威（也可能在注册表里查不到）。
    const childAgent = started.localAgent ?? agentRegistry(ctx)?.get(started.childId as SessionId)
    if (childAgent !== undefined) {
      // ⚠️ 子会话复查必须用**子会话必需集**：`crwu_audit_case_bootstrap` 是"根必需 + 子会话 deny"，
      // 用根必需集检查会把每一条正常子会话判成缺工具并立刻停掉（2026-09-29 第三轮复查的 P1）。
      const missingInChild = auditToolsVisible(ctx, childAgent, REQUIRED_AUDIT_CHILD_TOOLS)
      if (missingInChild.length > 0) {
        const stopped = await stopChild(ctx, started.childId, '审核子代理看不到必需的 CRWU Tool，停止这条审核', {
          handle: started.handle,
          parentSessionId,
        })
        if (!stopped.quiesced) {
          await retireNotQuiesced(started.childId, stopped)
          return failed(`审核子代理看不到必需的 CRWU Tool（${missingInChild.join('、')}），而且没法确认它已经停下来（${notQuiescedText(stopped)}）：已保留它的身份与占用，请在工作台「停止审核」重试；确认停止前不要启动新的审核。`)
        }
        await rollbackRecord()
        return failed(`审核子代理看不到必需的 CRWU Tool：${missingInChild.join('、')}。已停止该子会话；请让部署方确认子代理 preset 没有收窄工具集。`)
      }
    } else {
      // **读不到就停**（2026-09-29 第三轮复查的 P1）：工具可见性、沙箱、审批、cwd、workspaceRoot
      // 的复查全都需要那个 child Agent；只记一条 warning 继续跑，等于"审核在无法验证边界的
      // 子会话里跑完"。远程 provider（`localAgent === undefined`）正是这一情形。
      const stopped = await stopChild(ctx, started.childId, '读不到审核子代理的 Agent，无法复查边界，停止这条审核', {
        handle: started.handle,
        parentSessionId,
      })
      if (!stopped.quiesced) {
        await retireNotQuiesced(started.childId, stopped)
        return failed(`读不到审核子代理的 Agent（provider 可能是远程运行），无法复查它的沙箱/审批/工具可见性；而且没法确认它已经停下来（${notQuiescedText(stopped)}）：已保留它的身份与占用，请在工作台「停止审核」重试。`)
      }
      await rollbackRecord()
      return failed('读不到审核子代理的 Agent（provider 可能是远程运行），无法复查它的沙箱/审批与工具可见性：已停止该子会话，本次发起失败。审核只允许能在本进程里验证边界的子代理 provider。')
    }

    // 硬门禁四（child policy，协议 18 · C3）：子会话的**沙箱与审批**同样按它自己复查一遍。
    //
    // 为什么是"复查 + 停止"而不是"先拦后起"：子会话的策略由 DSH 在委派边界上 seed，
    // 安全性来自**创建前**已经把根设对并验证过（`ensureAuditRoot` 的 `applyAuditRootPolicy`）。
    // 发布之后再读一次是为了**证伪**那一步 —— 真读到不对就是契约被破坏了，
    // 这时唯一安全的动作是停掉它并如实报出来，而不是让它带着错的边界跑完。
    if (childAgent !== undefined) {
      // 期望值是**已选工作空间**（协议 24：子会话继承父会话的 cwd，而根的 cwd = 工作空间路径 ——
      // DSH 的沙箱边界就是 cwd，且 cwd 必须等于工作空间路径才挂得上工作空间）。
      // ⚠️ 这一条与案例内的 scope 是**两件事**：这里问"沙箱会拦到哪儿"，
      // `requireAuditScope` 问"这次审核被允许碰哪个案例"（按本轮 casePath 精确相等）。
      const childPolicy = inspectAuditRootPolicy(ctx, childAgent, workspace)
      if (!childPolicy.ok) {
        const stopped = await stopChild(ctx, started.childId, '审核子代理的沙箱/审批策略不符合要求，停止这条审核', {
          handle: started.handle,
          parentSessionId,
        })
        if (!stopped.quiesced) {
          await retireNotQuiesced(started.childId, stopped)
          return failed(`审核子代理的策略不符合要求（${childPolicy.error}），而且没法确认它已经停下来（${notQuiescedText(stopped)}）：已保留它的身份与占用，请在工作台「停止审核」重试；确认停止前不要启动新的审核。`)
        }
        await rollbackRecord()
        return failed(`审核子代理的策略不符合要求：${childPolicy.error}。已停止该子会话。`)
      }
    }

    // 留住「可中止的信号 + run 句柄」：一次性运行没有别的停止入口
    // （subagents.interrupt 对 one-shot 是 no-op）。停止时必须先 abort 再 dispose。
    if (started.handle.run !== undefined || started.handle.abort !== undefined) {
      state.runs[started.childId] = started.handle
    }

    state.audits[key] = record
    // 发起成功：清掉上一次的失败记录（它只描述"最近一次失败"）。
    state.lastAuditFailure = undefined
    state.activeKey = key
    state.activeChildId = started.childId
    state.activeSince = stamp.getTime()
    // 落盘失败**不能**当成成功（2026-09-29 用户复查的 P2）：那会留下"子会话在跑、但 scope 与占用锁
    // 只在内存里"的形态 —— 热重载后既授权不了案例内 Tool，又能重复发起。停掉它、回滚、如实失败。
    const persisted = await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
    if (!persisted) {
      const stopped = await stopChild(ctx, started.childId, '审核记录没能落盘，停止这条审核', {
        handle: started.handle,
        parentSessionId,
      })
      if (!stopped.quiesced) {
        // 落盘本来就坏了，退役写盘也会失败 —— 但**内存里必须保留身份、句柄与占用**：
        // 丢掉的后果是"旧子会话继续写案例目录，而 Host 已经不认识它"。
        await retireNotQuiesced(started.childId, stopped)
        return failed(`审核记录没能写入状态文件，而且没法确认刚创建的子会话已经停下来（${notQuiescedText(stopped)}）：已在内存里保留它的身份与占用，请在工作台「停止审核」重试。`)
      }
      delete state.audits[key]
      delete state.runs[started.childId]
      releaseActive(state, started.childId)
      return failed('审核记录没能写入状态文件（本机权限或磁盘问题）：已停止刚创建的子会话，本次发起失败。')
    }

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
  /** 停止请求是否已被接受（F1 两阶段：接受 ≠ 已停止）。 */
  accepted: boolean
  /** 重复点击：已经有一条停止流程在跑，本次没有启动第二条。 */
  alreadyStopping: boolean
  /** 当前阶段（Host 权威）。 */
  phase: AuditStopPhase
  aborted: boolean
  disposed: boolean
  /** **是否已确认静默**（dispose 完成，或 Agent 已不在 running）。前端据此决定能不能启动下一条。 */
  quiesced: boolean
  interrupted: boolean
  agentCancelled: boolean
  /** 阻塞性错误（非空 = 没停好）。 */
  errors: string[]
  /** 非阻塞观察（例如"dispose 超时但 Agent 已不在运行"）。 */
  notes: string[]
}

export async function auditStop(deps: AuditDeps, args: Record<string, unknown>): Promise<AuditStopResult> {
  const { ctx, state } = deps
  await ensureRegistry({ ctx, home: await deps.world.home(), state, access: deps.access })
  const childId = text(args.childId) || state.activeChildId
  if (childId === '') {
    // 没有可停的子会话：不算错，且"静默"天然成立（没有东西在跑）。
    return {
      ok: false, error: '当前没有正在运行的审核子会话。', key: '',
      accepted: false, alreadyStopping: false, phase: 'idle',
      aborted: false, disposed: false, quiesced: true,
      interrupted: false, agentCancelled: false, errors: [], notes: [],
    }
  }
  const key = Object.keys(state.audits).find((candidate) => state.audits[candidate]?.childId === childId) ?? ''
  const record = key === '' ? undefined : state.audits[key]

  // **幂等**（F1）：已经在停 → 立刻把当前阶段回给调用方，绝不启动第二条停止流程。
  // 判据是"进程内正在跑"或"持久化阶段还在进行中"两者之一。
  const persistedPhase = record?.stopPhase
  const inFlight = state.stopInFlight[childId] !== undefined
  if (inFlight || persistedPhase === 'requested' || persistedPhase === 'aborting' || persistedPhase === 'waiting-quiescence') {
    return {
      ok: false,
      error: '这条审核的停止流程已经在进行中（重复点击不会启动第二条）。',
      key,
      accepted: true,
      alreadyStopping: true,
      phase: persistedPhase ?? 'requested',
      aborted: true, disposed: false, quiesced: record?.quiesced === true,
      interrupted: false, agentCancelled: false,
      errors: [], notes: Array.isArray(record?.stopNotes) ? record.stopNotes : [],
    }
  }

  const requestedAt = Date.now()
  const writePhase = async (
    phase: AuditStopPhase,
    extra: { error?: string; notes?: string[]; quiesced?: boolean; aborted?: boolean; disposed?: boolean } = {},
  ): Promise<void> => {
    const current = state.audits[key]
    if (current === undefined) return
    state.audits[key] = {
      ...current,
      stopPhase: phase,
      stopRequestedAt: requestedAt,
      stopElapsedMs: Math.max(0, Date.now() - requestedAt),
      ...(extra.quiesced === undefined ? {} : { quiesced: extra.quiesced }),
      ...(extra.aborted === undefined ? {} : { stopAborted: extra.aborted }),
      ...(extra.disposed === undefined ? {} : { stopDisposed: extra.disposed }),
      ...(extra.error === undefined ? {} : { stopError: extra.error }),
      ...(extra.notes === undefined ? {} : { stopNotes: extra.notes }),
    }
    await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
  }

  // **第一阶段：尽快接受**（F1）。先把 `requested` 落盘，界面 100ms 内就能看到
  // 「正在请求停止审核…」，不必等 abort / dispose 走完。
  await writePhase('requested', { error: '', notes: [], quiesced: false })

  // **第二阶段：后台把 abort → dispose → 状态复查走完**，每个阶段都落盘。
  // 这里刻意不 await：`audit-stop` 立刻返回"已接受"，客户端靠 `audit-status` 轮询阶段。
  // 但把 Promise 存在状态里：`audit-status` 与测试都能等待它收敛（也用于幂等判据）。
  const task = (async () => {
    try {
      const stopped = await stopAuditChild(ctx, state, childId, '用户在中瑞世联工作台手动停止了这条审核',
        async (phase) => { await writePhase(phase) })
      const quiesced = stopped.outcome.quiesced
      await writePhase(quiesced ? 'quiesced' : 'timeout', {
        quiesced,
        aborted: stopped.outcome.aborted,
        disposed: stopped.outcome.disposed,
        error: stopped.ok ? '' : stopped.error,
        notes: stopped.outcome.notes,
      })
      // 停止执行了但状态文件写不进去：阶段如实记 `failed`，**不伪装成已停止**。
      const persisted = await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })
      if (!persisted) await writePhase('failed', { quiesced, error: '停止已执行，但状态文件没能写入（重启后可能看到旧的占用记录）。' })
    } catch (error) {
      await writePhase('failed', { quiesced: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      delete state.stopInFlight[childId]
    }
  })()
  state.stopInFlight[childId] = task

  return {
    ok: true,
    error: '',
    key,
    accepted: true,
    alreadyStopping: false,
    phase: 'requested',
    aborted: false, disposed: false, quiesced: false,
    interrupted: false, agentCancelled: false,
    errors: [], notes: [],
  }
}

export async function auditRelease(deps: AuditDeps): Promise<{ ok: boolean; released: string }> {
  const { state } = deps
  const previous = state.activeKey || state.activeChildId
  releaseActive(state)
  const persisted = await persistAudits({ ctx: deps.ctx, home: await deps.world.home(), state, access: deps.access })
  // 内存里的占用已经放开（这是"释放"这个动作本身），但**磁盘上可能还留着** ——
  // 如实返回失败，让调用方知道重启后可能看到旧的占用记录（2026-09-29 用户复查的 P2）。
  return { ok: persisted, released: previous }
}

export interface AuditStatusResult {
  ok: boolean
  audits: AuditRecord[]
  parentSessionId: string
  active: { key: string; childId: string; since: number }
  /**
   * 现在**能不能启动下一条审核**（F4）。
   *
   * ⚠️ 只能由 Host 判定：真实静默（`quiesced`）+ 停止流程是否还在跑 + 占用锁是否真的空。
   * 客户端不许用 `status !== 'running'` 自己推。
   */
  canStartNext: boolean
}

/** 审核停止阶段视图（F4）：把持久化字段 + Host 现算的时长/可启动性合成给客户端。 */
export function stopViewOf(record: AuditRecord, canStartNext: boolean, now: number): AuditStopView {
  const requestedAt = typeof record.stopRequestedAt === 'number' ? record.stopRequestedAt : 0
  const waited = requestedAt === 0 ? 0 : Math.max(0, now - requestedAt)
  return {
    phase: record.stopPhase ?? 'idle',
    requestedAt,
    // 取"记录里的"与"现算的"较大者：落盘只在阶段变化时发生，界面要看到**跳动的秒数**。
    elapsedMs: Math.max(typeof record.stopElapsedMs === 'number' ? record.stopElapsedMs : 0, waited),
    quiesced: record.quiesced === true,
    aborted: record.stopAborted === true,
    disposed: record.stopDisposed === true,
    error: text(record.stopError),
    notes: Array.isArray(record.stopNotes) ? record.stopNotes : [],
    canStartNext,
  }
}

/** 现在能不能启动下一条：没有停止流程在跑，且占用锁指向的子会话已确认静默（或锁本来就是空的）。 */
export function canStartNextNow(state: WorkbenchState): boolean {
  if (Object.keys(state.stopInFlight ?? {}).length > 0) return false
  const records = Object.values(state.audits ?? {}).filter((item) => item !== undefined)
  // 任何**没确认静默**的停止都一律不许启动下一条（用户的 F1 口径：
  // "任何未确认 quiesced 的情况都不能释放安全边界或启动下一条审核"）：
  // · `failed` —— 停止执行了但状态没落盘，磁盘上可能还带着占用锁；
  // · `timeout` —— 有界等待到点仍无法确认，旧子会话可能还在写案例目录；
  // · `requested` / `aborting` / `waiting-quiescence` —— 流程还没走完。
  // 注意判据不依赖占用锁在不在：重启后锁可能没有被恢复，但"没确认停下"这个事实仍然成立。
  if (records.some((record) => record.stopPhase === 'failed'
    || record.stopPhase === 'timeout'
    || record.stopPhase === 'requested'
    || record.stopPhase === 'aborting'
    || record.stopPhase === 'waiting-quiescence')) return false
  const active = state.activeChildId
  if (active === '') return true
  const record = records.find((item) => item.childId === active)
  if (record === undefined) return true
  return record.quiesced === true || record.ended === true || record.stopped === true
}

export async function auditStatus(deps: AuditDeps, args: Record<string, unknown>): Promise<AuditStatusResult> {
  const { ctx, state } = deps
  await ensureRegistry({ ctx, home: await deps.world.home(), state, access: deps.access })

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
      // 认领来的记录**没有**本轮 scope（不知道当初的 casePath / attemptId / 附件白名单）：
      // 留空，案例内 Tool 会 fail closed。不许在这里"猜一个"——猜出来的 scope 等于没有门禁。
      casePath: '',
      attemptId: '',
      allowedAttachmentIds: [],
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
  if (changed) await persistAudits({ ctx, home: await deps.world.home(), state, access: deps.access })

  const canStartNext = canStartNextNow(state)
  return {
    ok: true,
    // 每条记录都带上 Host 现算的停止视图（F4）：客户端据此渲染阶段，**不许**自己推断。
    audits: out.map((record) => ({ ...record, stop: stopViewOf(record, canStartNext, now) })),
    parentSessionId: boundParentId,
    active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
    canStartNext,
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
