import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { callerSessionPolicy } from '../access/caller-policy.ts'
import { mkdirCommand, parsePathProbe, pathProbeCommand, removeFileCommand } from '../platform/shell.ts'
import type { ShellResult } from '../shell/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessOperation, LocalAccessSource } from '../access/operations.ts'
import { PLUGIN_REV } from '../consts.ts'
import { processStartedOf } from '../access/diagnostics.ts'

/**
 * 案例目录的**本地文件操作**（建目录 / 删产物 / 只读探测）。
 *
 * ## 为什么全部经 Broker
 *
 * 这些动作的目标都在「会话 cwd」之外（案例目录在员工选定的工作空间里），所以它们跨了
 * 沙箱边界。2026-09-30 的现场就是这一条被违反的结果：`ensureDirectory` 直接调
 * `shell/run.ts` 的裸 `runShell`，于是它拿到的是**部署默认沙箱**（`workspace-write`，
 * 边界 = 员工打开面板的那个目录），`mkdir /Users/<员工>/中瑞世联工作空间/<流水号>` 直接
 * `Operation not permitted` —— 而员工本人对那个目录是有写权限的。
 *
 * 现在每一条命令都带着「操作 + 来源」交给 Broker，由它决定这一条要不要逐次声明
 * `danger-full-access`、以哪个目录为边界；这里只负责**拼命令**（方言由 `platform/shell.ts`
 * 生成）与**回读后置条件**。
 *
 * ## 三条不许退回去的口径
 *
 * 1. **命令串由 `platform/shell.ts` 按平台生成** —— 这里不出现 `cmd /c`、`mkdir`、`rm`
 *    之类字面量；
 * 2. **失败必须传播**：只把「目标已经是我们要的状态」视为成功。旧形态在 Windows 上把任意
 *    mkdir 失败都当成功，故障会推迟到「下一步写文件才炸」，归因到完全无关的地方；
 * 3. **后置条件要回读**，而且回读本身有**三种结果**（存在 / 不存在 / **查不出来**）。
 *    「查不出来」一律按基础设施失败如实上报，不猜 —— 把异常折叠成「不存在」，
 *    就会在 `Access denied` 时回报「删除成功」。
 */

/**
 * 一次案例内命令的**执行事实**（脱敏：只有操作名、来源、三个模式与三个布尔）。
 *
 * 与 `access/diagnostics.ts` 的 `AccessDiagnostic` 同一套口径 —— 「请求了什么、执行器解析成
 * 什么、实际跑在什么下、有没有被拒、进程起没起来」是排查"为什么建不出来"的全部事实。
 */
export interface CaseShellFacts {
  operation: LocalAccessOperation
  source: LocalAccessSource
  /** 我们声明的沙箱模式（空串 = 交给部署默认）。 */
  requested: string
  /** 执行器 `resolve()` 回来、实际会用的模式。 */
  resolved: string
  /** 命令**实际**跑在哪个模式。 */
  ran: string
  /** 沙箱是否真的拒绝了一次文件操作。 */
  denied: boolean
  /** 沙箱 runner 在命令跑起来之前就失败了。 */
  runnerFailed: boolean
  /** **进程真的起来了吗**（计划里那个 `ran` 布尔）：没起来时后续的都是"没跑过"。 */
  processStarted: boolean
}

/**
 * 失败类别（**判据只有这一处**）。
 *
 * 三类的处置完全不同，所以不许压成一句话：
 * - `sandbox`：DSH 没放行（未授权 / 请求被降级 / 沙箱真的拒了）→ 查权限策略与插件版本；
 * - `permission`：沙箱放行了，是操作系统层面的 ACL / 所有者 / 只读挂载 → 查目录所有者；
 * - `missing`：目标（工作空间）本来就不存在 → 让员工重新选一个已有目录；
 * - `policy`：Broker 的封闭操作表拒绝了这次调用（来源 / 授权收据）→ 维护者要看的；
 * - `infrastructure`：命令根本没跑起来、或跑成功了却没有后置条件。
 */
export type CaseFailureKind = 'sandbox' | 'permission' | 'missing' | 'policy' | 'infrastructure'

export interface CaseOpResult {
  ok: boolean
  error: string
  /** 成功时为空串。 */
  errorKind: CaseFailureKind | ''
  /** 这一次的沙箱与来源事实（成功也带回来：诊断要看的就是它）。 */
  facts: CaseShellFacts
  /**
   * **后置条件回读的结论**：目标现在到底是什么。
   *
   * - `directory` = 目标确实是个目录（成功）；
   * - `file` / `absent` = 回读出来了，但不是我们要的；
   * - `unknown` = **回读没有结论**（命令没跑起来 / 输出不可识别）——不许当成"不存在"。
   */
  postcondition: 'directory' | 'file' | 'absent' | 'unknown'
}

export interface PathProbeResult {
  /** 目标状态；`error` = **查不出来**（不是"不存在"）。 */
  kind: 'directory' | 'file' | 'absent' | 'error'
  error: string
  facts: CaseShellFacts
}

/** 没起进程时的空事实。 */
function idleFacts(operation: LocalAccessOperation, source: LocalAccessSource): CaseShellFacts {
  return {
    operation, source, requested: '', resolved: '', ran: '', denied: false, runnerFailed: false,
    processStarted: false,
  }
}

/** 从一次 `ShellResult` 收下沙箱事实。 */
function factsOf(
  operation: LocalAccessOperation,
  source: LocalAccessSource,
  result: ShellResult,
): CaseShellFacts {
  const facts = {
    operation,
    source,
    requested: text(result.sandbox.requested),
    resolved: text(result.sandbox.resolved),
    ran: text(result.sandbox.ran),
    denied: result.sandbox.denied === true,
    runnerFailed: result.sandbox.runnerFailed === true,
  }
  return { ...facts, processStarted: processStartedOf({ ...facts, error: result.error }) }
}

function resultOf(
  facts: CaseShellFacts,
  errorKind: CaseFailureKind | '',
  error: string,
  postcondition: CaseOpResult['postcondition'] = 'unknown',
): CaseOpResult {
  return { ok: errorKind === '', error: error.slice(0, 600), errorKind, facts, postcondition }
}

/**
 * 这一次失败看起来是**沙箱**造成的吗。
 *
 * 判据全部是结构化事实 —— 不看错误文本是不是写了「权限不足」（那是 §D5 明确禁止的猜测）：
 * 沙箱真的拒了 / runner 起不来 / 我们请求的模式被执行器降级了。
 */
function looksSandboxed(facts: CaseShellFacts): boolean {
  if (facts.denied || facts.runnerFailed) return true
  return facts.requested !== '' && facts.resolved !== '' && facts.requested !== facts.resolved
}

/**
 * 沙箱**放行**了之后，文本里带操作系统权限指纹吗。
 *
 * 只在事实已经排除沙箱时才看文本：反过来做会把"嵌套沙箱起不来"翻译成"文件权限问题"，
 * 让员工去改一个本来没错的目录所有者。
 */
const OS_PERMISSION_HINT = /permission denied|access is denied|operation not permitted|拒绝访问|eacces|eperm/i

/**
 * 一句话说明沙箱事实（诊断与错误里都能贴，不含路径与命令原文）。
 *
 * 末尾带上**插件版本**：真机排障时第一件事就是"装的是哪一份产物"，而客户端徽章在源码检出形态下
 * 只显示 `dev`。2026-09-30 那次就是因为版本号对不上、白排查了一轮。
 */
export function describeCaseFacts(facts: CaseShellFacts): string {
  const parts = [`操作 ${facts.operation}`, `来源 ${facts.source}`]
  if (facts.requested !== '') parts.push(`请求 ${facts.requested}`)
  if (facts.resolved !== '' && facts.resolved !== facts.requested) parts.push(`解析为 ${facts.resolved}`)
  if (facts.ran !== '') parts.push(`实际 ${facts.ran}`)
  if (facts.denied) parts.push('沙箱拒绝=是')
  if (facts.runnerFailed) parts.push('runner 失败=是')
  parts.push(`插件 ${PLUGIN_REV}`)
  return parts.join(' · ')
}

/**
 * 只读探测一个路径（目录 / 普通文件 / 不存在）。
 *
 * 操作与来源**由调用方给**，因为两条链路的权限不同，而且这个差别必须留在操作表里：
 * - 审核编排（`audit-host`）探的是**会话 cwd 之外**的工作空间 / 案例目录 →
 *   `system.workspace-directory.read`（特权：受限沙箱下连"在不在"都问不出来）；
 * - 审核子代理（`audit-tool`）探的是**自己案例目录之内**的路径 →
 *   `system.case-file.read`（不提权：边界之内就是它的工作区）。
 */
export async function probeLocalPath(
  access: LocalAccessBroker,
  path: string,
  options: {
    operation: 'system.workspace-directory.read' | 'system.case-file.read'
    source: LocalAccessSource
    workdir: string
    platform: string
    /** 非特权探测（案例目录之内）必须带调用者的会话，见 `CaseScopeOptions`。 */
    session?: Session
    signal?: AbortSignal
  },
): Promise<PathProbeResult> {
  const { operation, source } = options
  const run = await access.runShell(
    { operation, source, workdir: options.workdir },
    pathProbeCommand(path, options.platform),
    {
      timeoutMs: 20_000,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  const facts = factsOf(operation, source, run)
  const probe = parsePathProbe(run)
  if (probe === undefined) {
    // 命令没跑起来 / 输出不可识别：**查不出来**，不是"不存在"。
    const detail = text(run.error) || text(run.stderr) || '路径探测没有得到结论'
    return { kind: 'error', error: `${detail}（${describeCaseFacts(facts)}）`.slice(0, 600), facts }
  }
  return { kind: probe, error: '', facts }
}

/** 审核编排侧的只读探测（特权、来源 `audit-host`）。 */
function probeExternalPath(
  access: LocalAccessBroker,
  path: string,
  options: {
    workdir: string
    platform: string
    source?: 'audit-host' | 'panel'
    session?: Session
    signal?: AbortSignal
  },
): Promise<PathProbeResult> {
  return probeLocalPath(access, path, {
    operation: 'system.workspace-directory.read',
    source: options.source ?? 'audit-host',
    workdir: options.workdir,
    platform: options.platform,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/** 案例目录**之内**的只读探测（不提权、来源 `audit-tool`）。 */
function probeCasePath(
  access: LocalAccessBroker,
  path: string,
  options: { workdir: string; platform: string; session?: Session; signal?: AbortSignal },
): Promise<PathProbeResult> {
  return probeLocalPath(access, path, {
    operation: 'system.case-file.read',
    source: 'audit-tool',
    ...options,
  })
}

/**
 * 案例目录之内的命令按**哪条会话**的策略执行。
 *
 * 判据是把 `exec.agent.session` 交给 Broker（它用 DSH 的 `sandboxPolicy.resolve({ session })`
 * 算出策略放进请求）。**不传**时会落到执行器的部署默认（进程 cwd）—— DSH 的执行器**不持有会话**，
 * 2026-09-30 真机两次现场就是这么把 `mkdir <案例目录>/输入快照` 拦成
 * `Operation not permitted` 的。所以案例内的调用点**必须**把调用者的会话传下来。
 */
export interface CaseScopeOptions {
  session?: Session
}

/**
 * 确保**本轮案例目录**存在（`<已选工作空间>/<流水号>`）。
 *
 * 这是审核启动链路里**唯一**允许插件自动创建的一级目录（工作空间根必须由员工先选好、
 * 且真实存在；见 `audit/root.ts`）。顺序刻意固定：
 *
 * 1. 先只读探测**工作空间**是否真的存在（不存在 → `missing`，让员工重选，不"顺手建一个"）；
 * 2. 经 `system.case-directory.write` 逐次声明 `danger-full-access` + `workspaceRoot = 工作空间`
 *    执行 `mkdir`；
 * 3. 再回读**案例目录**的后置条件（成功 / 不存在 / 查不出来）。
 */
export async function ensureCaseDirectory(
  access: LocalAccessBroker,
  path: string,
  options: {
    workspace: string
    probeWorkdir: string
    platform: string
    /**
     * 谁在发起。**不是权限开关**（提权由操作表决定，两者都是特权来源）——
     * 它只回答"这一步是怎么来的"，好让诊断与操作表对得上：
     * `audit-host` = 审核启动；`panel` = 报告讨论的材料准备。
     */
    source?: 'audit-host' | 'panel'
    signal?: AbortSignal
  },
): Promise<CaseOpResult> {
  const operation = 'system.case-directory.write' as const
  const source = options.source ?? 'audit-host'
  const workspace = text(options.workspace)
  if (workspace === '') {
    return resultOf(idleFacts(operation, source), 'missing',
      '尚未选定工作空间，请先选择一个已有目录。')
  }

  // ⓪ 先问策略（零副作用）：未授权 / 来源不对时给一句**能做点什么**的话，而不是把 Broker
  //    的拒绝包成 "mkdir 失败"。`runShell` 内部还会再判一次（策略判据只有一处），
  //    这里只是让失败类别落在 `policy` 上、并且**一个进程都不起**。
  const decision = access.authorize({ operation, source, workdir: workspace })
  if (!decision.ok) {
    return resultOf(idleFacts(operation, source), 'policy',
      `案例目录创建没有被本机访问策略放行：${decision.error}`)
  }

  // ① 工作空间必须**已经存在**。
  //
  // ⚠️ 探测的 cwd 用一个**确定存在**的目录（调用方给会话 cwd），**不是**工作空间自己：
  // 拿一个可能不存在的目录当 cwd，命令会先在 spawn 上失败，于是"沙箱没放行"与"目录不存在"
  // 会变成同一个结论 —— 而那正是这一段要分开的两件事。
  const probeWorkdir = text(options.probeWorkdir) || workspace
  const workspaceProbe = await probeExternalPath(access, workspace, {
    workdir: probeWorkdir,
    platform: options.platform,
    source,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  // ⚠️ **"查不出来"不是"不存在"**：探测命令没跑起来 / 被沙箱拦下 / 输出不可识别时，
  // 只能说"无法确认"，并如实归因 —— 把它们折叠成"工作空间不存在"会把一次宿主的
  // 沙箱拒绝说成"员工选错了目录"，让员工去重选一个本来没错的目录。
  if (workspaceProbe.kind === 'error') {
    return resultOf(workspaceProbe.facts,
      looksSandboxed(workspaceProbe.facts) ? 'sandbox' : 'infrastructure',
      `无法确认所选工作空间是否存在（探测没有得到结论）：${workspaceProbe.error}`)
  }
  if (workspaceProbe.kind === 'absent') {
    return resultOf(workspaceProbe.facts, 'missing',
      `所选工作空间不存在，无法启动审核：${workspace}。请重新选择一个已有目录。`)
  }
  if (workspaceProbe.kind !== 'directory') {
    return resultOf(workspaceProbe.facts, 'missing',
      `所选工作空间不是目录，无法启动审核：${workspace}。请重新选择一个已有目录。`)
  }

  // ② 建本轮案例目录。提权由操作表决定（`system.case-directory.write`），
  //    边界就是这个工作空间 —— 不是整个文件系统，也不是会话默认工作区。
  const run = await access.runShell(
    { operation, source, workdir: workspace },
    mkdirCommand(path, options.platform),
    { timeoutMs: 20_000, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  )
  const facts = factsOf(operation, source, run)

  // ③ 后置条件：无论命令成败都回读一次（幂等重审时命令可能报错而目录其实建好了）。
  const after = await probeExternalPath(access, path, {
    workdir: workspace,
    platform: options.platform,
    source,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (after.kind === 'directory') return resultOf(facts, '', '', 'directory')
  if (after.kind === 'error') {
    return resultOf(facts, looksSandboxed(facts) ? 'sandbox' : 'infrastructure',
      `无法确认案例目录是否已创建：${after.error}（${describeCaseFacts(facts)}）`, 'unknown')
  }

  // 命令没跑成功 → 按结构化事实分类；命令"成功"却没建出来 → 基础设施（后置条件不成立）。
  const detail = text(run.error) || text(run.stderr) || text(run.stdout) || '创建目录失败'
  if (looksSandboxed(facts)) {
    return resultOf(facts, 'sandbox',
      'DSH 主机未授予案例目录创建所需的 danger-full-access：请检查当前 Host 权限策略与插件版本。'
      + `（${describeCaseFacts(facts)}；工作空间 ${workspace}）`)
  }
  if (!run.ok && OS_PERMISSION_HINT.test(`${text(run.stderr)}\n${text(run.error)}`)) {
    return resultOf(facts, 'permission',
      '当前系统账户无法写入所选工作空间：请检查目录所有者与操作系统文件访问权限。'
      + `（${describeCaseFacts(facts)}；工作空间 ${workspace}）`)
  }
  if (run.ok) {
    return resultOf(facts, 'infrastructure',
      `创建目录命令返回成功，但案例目录不存在：${path}（${describeCaseFacts(facts)}）`,
      after.kind === 'file' ? 'file' : 'absent')
  }
  return resultOf(facts, 'infrastructure', `${detail}（${describeCaseFacts(facts)}）`, after.kind)
}

/**
 * 写一个**案例目录之内**的文本文件（输入快照的三个 JSON、知识文档清单…）。
 *
 * ⚠️ **必须带调用方会话的策略**（第 5 个参数）。DSH 的 fs 服务与 shell 执行器一样**不持有会话**：
 * `dsh-fs-sandbox` 的 `checkedTarget()` 是 `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`
 * —— 不传策略就落到**部署默认**（进程 cwd），于是"往自己所在的案例目录里写文件"会被自家沙箱拒掉：
 * `FS_SANDBOX_DENIED: cannot write "…": file access denied under workspace-write mode`。
 * 2026-09-30 真机第三次故障就是它（`mkdir 输入快照` 已经成功、三个 JSON 写不进去 → 审核在
 * "未创建子代理"处终止）。
 *
 * 写完**必须回读**：`writeText` 返回成功不等于文件真的在那儿（也会被别的东西改掉）。
 * 回读拿不到结论时如实报 `unknown`，**不报成功**。
 */
export async function writeCaseText(
  ctx: Context,
  path: string,
  content: string,
  options: { session?: Session; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error: string; errorKind: 'sandbox' | 'permission' | 'infrastructure' | ''; postcondition: 'file' | 'unknown' }> {
  const fs = fileSystem(ctx)
  if (fs === undefined) {
    return { ok: false, error: 'Host 文件服务不可用', errorKind: 'infrastructure', postcondition: 'unknown' }
  }
  let target: Awaited<ReturnType<typeof resolveTarget>>
  try {
    target = await resolveTarget(ctx, path)
  } catch (error) {
    return {
      ok: false,
      error: `无法解析目标路径：${error instanceof Error ? error.message : String(error)}`,
      errorKind: 'infrastructure',
      postcondition: 'unknown',
    }
  }
  const policy = callerSessionPolicy(ctx, options.session)
  try {
    await fs.writeText(target, content, undefined, options.signal, policy)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message, errorKind: classifyWriteFailure(error, message), postcondition: 'unknown' }
  }
  // 回读：拿不到结论就说不知道（`unknown`），不要替员工宣布成功。
  try {
    const back = await fs.readText(target, options.signal)
    if (back !== content) {
      return {
        ok: false,
        error: `写入后回读的内容与预期不一致（期望 ${content.length} 字符，读回 ${back.length} 字符）`,
        errorKind: 'infrastructure',
        postcondition: 'unknown',
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: `写入命令返回成功，但无法确认文件是否真的落盘：${error instanceof Error ? error.message : String(error)}`,
      errorKind: 'infrastructure',
      postcondition: 'unknown',
    }
  }
  return { ok: true, error: '', errorKind: '', postcondition: 'file' }
}

/**
 * 写失败的归因：**只看结构化事实**（错误码），拿不到码时才看原话里那句沙箱/权限措辞。
 *
 * 判据来源：`dsh-fs-sandbox` 抛的 `FsError` 带 `code: 'FS_SANDBOX_DENIED'`；OS 级 EACCES/EPERM
 * 由 `dsh-fs-local` 原样透出（`code` 为 `EACCES` / `EPERM`）。
 */
function classifyWriteFailure(error: unknown, message: string): 'sandbox' | 'permission' | 'infrastructure' {
  const code = text((error as { code?: unknown } | undefined)?.code)
  if (code === 'FS_SANDBOX_DENIED' || /access denied under (read-only|workspace-write|danger-full-access) mode/.test(message)) {
    return 'sandbox'
  }
  if (code === 'EACCES' || code === 'EPERM' || /operation not permitted|permission denied/i.test(message)) {
    return 'permission'
  }
  return 'infrastructure'
}

/**
 * 确保一个**案例目录之内**的目录存在（输入快照目录、知识文档目录…）。
 *
 * 非特权：这些调用来自审核子代理，而子会话的沙箱边界就是本轮案例目录 —— 边界之内不需要
 * `danger-full-access`。命令照旧由中央适配器按平台生成。
 */
export async function ensureDirectory(
  access: LocalAccessBroker,
  path: string,
  options: { workdir: string; platform: string; session?: Session; signal?: AbortSignal },
): Promise<CaseOpResult> {
  const operation = 'system.case-file.write' as const
  const source = 'audit-tool' as const
  const run = await access.runShell(
    { operation, source, workdir: options.workdir },
    mkdirCommand(path, options.platform),
    {
      timeoutMs: 20_000,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  const facts = factsOf(operation, source, run)
  const after = await probeCasePath(access, path, {
    workdir: options.workdir,
    platform: options.platform,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (after.kind === 'error') {
    // 连目标状态都确认不了时不许报成功：这正是「以为建好了、下一步写文件才炸」的来源。
    return resultOf(facts, 'infrastructure',
      `无法确认目录是否已创建：${after.error}（${path}）`)
  }
  if (after.kind === 'directory') {
    // 命令失败但目标已经是我们要的状态 → 幂等成功（重审会再走一次）。
    return resultOf(facts, '', '', 'directory')
  }
  if (!run.ok) {
    const detail = text(run.stderr) || text(run.error) || '创建目录失败'
    return resultOf(facts, looksSandboxed(facts) ? 'sandbox' : 'infrastructure',
      `${detail}（${describeCaseFacts(facts)}）`, after.kind)
  }
  if (after.kind === 'file') {
    return resultOf(facts, 'infrastructure', `创建目录命令返回成功，但目标不是目录：${path}`, 'file')
  }
  return resultOf(facts, 'infrastructure', `创建目录命令返回成功，但目录不存在：${path}`, 'absent')
}

/** 幂等删除案例目录内的一个普通文件（清理上一轮同名产物）。 */
export async function removeFileIfExists(
  access: LocalAccessBroker,
  path: string,
  options: { workdir: string; platform: string; session?: Session; signal?: AbortSignal },
): Promise<CaseOpResult> {
  const operation = 'system.case-file.write' as const
  const source = 'audit-tool' as const
  const probe = await probeCasePath(access, path, {
    workdir: options.workdir,
    platform: options.platform,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (probe.kind === 'error') {
    return resultOf(probe.facts, 'infrastructure', `无法确认目标状态：${probe.error}（${path}）`)
  }
  if (probe.kind === 'absent') return resultOf(probe.facts, '', '')
  if (probe.kind !== 'file') {
    return resultOf(probe.facts, 'infrastructure', `目标不是普通文件，拒绝删除：${path}`)
  }

  const run = await access.runShell(
    { operation, source, workdir: options.workdir },
    removeFileCommand(path, options.platform),
    {
      timeoutMs: 20_000,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  const facts = factsOf(operation, source, run)
  if (!run.ok) {
    const detail = text(run.stderr) || text(run.error) || '删除旧产物失败'
    return resultOf(facts, looksSandboxed(facts) ? 'sandbox' : 'infrastructure',
      `${detail}（${describeCaseFacts(facts)}）`)
  }
  // 后置条件：退出码 0 不等于真的删掉了（占用 / 只读属性 / 被虚拟化的路径都可能骗过退出码）。
  const after = await probeCasePath(access, path, {
    workdir: options.workdir,
    platform: options.platform,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (after.kind === 'error') {
    return resultOf(facts, 'infrastructure', `删除命令返回成功，但无法确认目标是否已删除：${after.error}`)
  }
  if (after.kind !== 'absent') {
    return resultOf(facts, 'infrastructure', `删除命令返回成功，但文件仍然存在：${path}`, after.kind)
  }
  return resultOf(facts, '', '', 'absent')
}
