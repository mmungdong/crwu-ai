import type { Context } from '@deepseek-ai/cordis'
import type { ShellBackgroundHandle, ShellResult, ShellStartResult } from '../shell/run.ts'
import { runShell, startShell } from '../shell/run.ts'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import type { LocalAccessConsentView } from '../../shared/access/types.ts'
import {
  LOCAL_ACCESS_WRITE_TARGETS,
  localAccessDescriptorOf,
  type LocalAccessOperation,
  type LocalAccessSource,
  type LocalAccessTargetKind,
} from './operations.ts'
import {
  classifyAccessFailure,
  createAccessDiagnostics,
  lockRelatedIn,
  processStartedOf,
  type AccessDiagnostic,
  type AccessDiagnostics,
  type AccessErrorClass,
} from './diagnostics.ts'

/**
 * **Local Access Broker**：所有跨工作区边界的 Host 操作的唯一策略所有者
 * （协议 18 · 子项目 B）。
 *
 * ## 它的职责边界
 *
 * 它**不是**通用命令执行器。它做三件事：
 * 1. `authorize()`：按封闭操作表判「这个来源 + 这个操作 + 这个授权收据」能不能做，
 *    并给出**本次调用**的沙箱策略；
 * 2. `runShell()` / `writeText()`：带着那个策略执行，并把结构化事实记成诊断；
 * 3. `diagnostics()`：给开发者诊断看最近发生过什么（脱敏、只有事实）。
 *
 * 命令形状的正确性**不归它管**：`runCrwu` 校验 `crwu` 的 argv 白名单、`runDws` 校验 `dws` 的
 * 前缀白名单、`ossutil` 由 OSS 模块用固定的 argv 模板拼装、系统命令由 `platform/shell.ts` 生成。
 * Broker 保证的是「**这一步跨不跨边界、跨了用哪个策略**」这一件事只有一处判据。
 *
 * ## 三条不许退回去的口径
 *
 * 1. **提权不是调用方的参数**。`runShell` 不接受 `escalate`；它由操作描述表决定。
 *    模型、客户端、子代理都提交不了这个布尔值（B-03）。
 * 2. **未授权时一个进程都不起**。`authorize()` 不过就返回失败信封，**不调用 `ctx.shell`**
 *    （B-04）——"先试一下、失败了再看是不是没授权"会把受限沙箱的假结论（未登录 / 密钥错误）
 *    真的带回来给员工看。
 * 3. **策略是逐次声明的**，不依赖会话默认值，也不依赖子代理的审批
 *    （§3.1：审核子代理固定 `approval=never`，它申请不到任何审批）。
 */

export interface LocalAccessCall {
  operation: LocalAccessOperation
  source: LocalAccessSource
  /**
   * 这次调用的工作目录。
   *
   * DSH 的提权请求必须带 `workspaceRoot`，所以**特权操作**没有工作目录就是
   * `invalid-workdir`（fail closed，不用服务器 cwd 兜底）。非特权操作可以不给。
   */
  workdir?: string
}

export interface LocalAccessDecision {
  ok: boolean
  error: string
  errorClass: AccessErrorClass
  /** 仅当描述表要求提权时给出；非特权操作是 `undefined`（走部署默认沙箱）。 */
  sandboxPolicy?: { mode: 'danger-full-access'; workspaceRoot: string }
}

export interface BrokerShellOptions {
  workdir?: string
  /** 通过 stdin 交给命令的正文（剪贴板这类：拼进命令行会被 shell 解释）。 */
  stdinText?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  signal?: AbortSignal
  /**
   * **已脱敏**的命令摘要（只有域 + 子命令），进诊断用。
   *
   * 不传时诊断里只记操作名 —— 绝不回退去记原始命令：那会把 `--id <objectId>`、
   * 签名 URL 这类东西写进诊断。
   */
  summary?: string
}

export interface BrokerFsTarget {
  kind: LocalAccessTargetKind
  path: string
}

export interface BrokerFsResult {
  ok: boolean
  error: string
}

export interface LocalAccessBroker {
  /** 判一次调用能不能做（不发任何进程、不写任何文件）。 */
  authorize(call: LocalAccessCall): LocalAccessDecision
  /** 按操作描述执行一条**已由域执行器校验过形状**的命令。 */
  runShell(call: LocalAccessCall, command: string, options?: BrokerShellOptions): Promise<ShellResult>
  /**
   * 起一条**后台**命令并立刻拿回句柄（不等待它结束）。
   *
   * 授权、来源、提权与诊断记录的判据与 {@link runShell} **完全同一条路** ——
   * 「前台/后台」只是调用方要不要 await 结果，不是两种权限。生命周期归调用方：
   * 自己 `kill()`，或等 `done`；`done` 之后再记诊断（前台那次是在返回前记的）。
   */
  startShell(call: LocalAccessCall, command: string, options?: BrokerShellOptions): Promise<ShellStartResult>
  /** 写一个**目标种类与路径都必须对得上**的凭据 / 状态文件。 */
  writeText(call: LocalAccessCall, target: BrokerFsTarget, content: string): Promise<BrokerFsResult>
  /** 当前授权收据的视图（诊断与界面共用一个事实）。 */
  consent(): LocalAccessConsentView
  /** 最近的结构化诊断（新的在前）。 */
  diagnostics(): AccessDiagnostic[]
  /** 只读最近一条（测试与排障用）。 */
  lastDiagnostic(): AccessDiagnostic | null
}

export interface LocalAccessBrokerDeps {
  ctx: Context
  /** 授权收据的**活**视图：每次调用现读，授权/撤销立刻生效。 */
  state: { localAccess: LocalAccessConsentView }
  /** 主目录（目标路径比对与提权的 workspaceRoot 都用它）。 */
  home: () => Promise<string>
  /** 兜底工作目录（调用方没给 workdir 时用）。 */
  workdir: () => Promise<string>
  /**
   * 平台事实（`darwin-arm64` / `win32-x64` …）。
   *
   * 只给分类器用：macOS 钥匙串那几条指纹在 Windows 上不可能出现，反过来也一样 ——
   * 少了它就只能靠"文本里恰好没有别的平台字样"来蒙，那正是 D1 要消灭的猜测。
   */
  platform: () => Promise<string>
  /** 三个可写目标各自的**唯一**路径推导（由领域模块提供，Broker 不自己拼路径）。 */
  targets: Record<LocalAccessTargetKind, (home: string) => string>
  hostVersion: string
  protocolVersion: number
  diagnosticsLimit?: number
}

interface FactInput {
  operation: LocalAccessOperation
  source: LocalAccessSource
  requestedMode?: string
  resolvedMode?: string
  ranMode?: string
  sandboxDenied?: boolean
  runnerFailed?: boolean
  summary?: string
}

function noSandboxFacts(): ShellResult['sandbox'] {
  return { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false }
}

/** 去掉尾部路径分隔符，只用于**同一路径的两种写法**比较。 */
function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

export function createLocalAccessBroker(deps: LocalAccessBrokerDeps): LocalAccessBroker {
  const diagnostics: AccessDiagnostics = createAccessDiagnostics(deps.diagnosticsLimit)
  const consentOf = (): LocalAccessConsentView => deps.state.localAccess
  const granted = (): boolean => consentOf().state === 'granted'
  const consentVersion = (): number => consentOf().schemaVersion

  const record = (input: FactInput, errorClass: AccessErrorClass, facts: {
    requested: string; resolved: string; ran: string; denied: boolean; runnerFailed: boolean
  }, processStarted: boolean, lockRelated = false): void => {
    diagnostics.record({
      operation: input.operation,
      source: input.source,
      consentVersion: consentVersion(),
      requestedMode: facts.requested,
      resolvedMode: facts.resolved,
      ranMode: facts.ran,
      sandboxDenied: facts.denied,
      runnerFailed: facts.runnerFailed,
      errorClass,
      lockRelated,
      processStarted,
      hostVersion: deps.hostVersion,
      protocolVersion: deps.protocolVersion,
      summary: input.summary ?? input.operation,
      at: new Date().toISOString(),
    })
  }

  const deny = (call: LocalAccessCall, error: string, errorClass: AccessErrorClass): LocalAccessDecision => {
    // 被拒绝的调用也要留痕：否则"我点了没反应"在诊断里查不到任何东西。
    record({ operation: call.operation, source: call.source }, errorClass,
      { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false }, false)
    return { ok: false, error, errorClass }
  }

  const authorize = (call: LocalAccessCall): LocalAccessDecision => {
    const descriptor = localAccessDescriptorOf(call.operation)
    if (descriptor === undefined) {
      return deny(call, `未知的本机访问操作：${String(call.operation)}`, 'invalid-source')
    }
    if (!descriptor.allowedSources.includes(call.source)) {
      return deny(call,
        `本机访问操作 ${call.operation} 不接受来自「${call.source}」的调用（允许：${descriptor.allowedSources.join(' / ')}）`,
        'invalid-source')
    }
    // `host-owned-state` 是插件自己的状态文件，不属于员工授予的能力范围，所以不受收据约束。
    if (descriptor.capability !== 'host-owned-state' && !granted()) {
      return deny(call,
        `本机访问尚未允许：${call.operation} 需要先在「账号连接」里允许工作台访问本机账号和配置（${descriptor.capability}）。`,
        'not-authorized')
    }
    if (!descriptor.privileged) return { ok: true, error: '', errorClass: '' }
    // 工作目录只有 **shell** 提权才需要：DSH 拒绝「没有工作区的提权执行」，所以拿不到就
    // fail closed（不用服务器 cwd 兜底）。文件写入的 workspaceRoot 是**主目录**
    // （目标本来就在 `~` 下），它由 `writeText` 自己给，不走这里。
    if (descriptor.transport === 'filesystem') return { ok: true, error: '', errorClass: '' }
    const workdir = call.workdir ?? ''
    if (workdir === '') {
      return deny(call, `特权操作 ${call.operation} 缺少工作目录：DSH 拒绝「没有工作区的提权执行」。`, 'invalid-source')
    }
    return {
      ok: true, error: '', errorClass: '',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
    }
  }

  const failedShell = (error: string, sandbox: ShellResult['sandbox'] = noSandboxFacts()): ShellResult => ({
    ok: false, error, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, sandbox,
  })

  return {
    authorize,
    consent: consentOf,
    diagnostics: () => diagnostics.list(),
    lastDiagnostic: () => diagnostics.list()[0] ?? null,

    async runShell(call, command, options = {}) {
      const descriptor = localAccessDescriptorOf(call.operation)
      if (descriptor !== undefined && descriptor.transport !== 'shell') {
        return failedShell(`${call.operation} 不是 shell 操作（transport=${descriptor.transport}）`)
      }
      const workdir = call.workdir ?? options.workdir ?? await deps.workdir()
      const decision = authorize({ ...call, ...(workdir === '' ? {} : { workdir }) })
      if (!decision.ok) return failedShell(decision.error)

      // 非特权操作不传 `sandboxPolicy`（走部署默认沙箱）；特权操作由 `runShell` 逐次声明
      // `danger-full-access` + `workspaceRoot`（见 `shell/run.ts` 的提权注释）。
      const result = await runShell(deps.ctx, command, {
        ...(workdir === '' ? {} : { workdir }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.stdinText === undefined ? {} : { stdinText: options.stdinText }),
        escalate: decision.sandboxPolicy !== undefined,
      })
      const facts = {
        requested: result.sandbox.requested,
        resolved: result.sandbox.resolved,
        ran: result.sandbox.ran,
        denied: result.sandbox.denied,
        runnerFailed: result.sandbox.runnerFailed,
      }
      // 分类要拿到**平台事实**（子项目 D1）：钥匙串拒绝与 DWS 锁的失败没有结构化字段，
      // 只能看原话。这里的 `text` 只进分类器、出 `errorClass` —— **绝不进**诊断缓冲，
      // 所以 `AccessDiagnostic` 里不会出现路径、CLI 原始报错或上游片段。
      const failureText = `${result.stderr}\n${result.stdout}`
      const verdict = classifyAccessFailure({
        platform: await deps.platform(),
        sandbox: facts,
        error: result.error,
        exitCode: result.exitCode,
        text: failureText,
      })
      // 记录**脱敏的布尔事实**：这次失败与 `.data.lock` 有关吗？
      // 原文只进分类器；入库的只有这个布尔值 —— 后面 doctor 归因 `file-lock` 时必须两个条件都成立。
      record({ ...call, ...(options.summary === undefined ? {} : { summary: options.summary }) },
        verdict, facts, processStartedOf({ sandbox: facts, error: result.error }), lockRelatedIn(failureText))
      return result
    },

    /**
     * 后台命令：授权与提权判据与 `runShell` 逐条相同，只是不等待它结束。
     *
     * 诊断在 `done` 之后补记 —— 沙箱事实要等进程落定才有，而**记的是结构化布尔值**，
     * 不是原文（原文只在 `runShell` 的分类器里用，这里连原文都不取）。
     */
    async startShell(call, command, options = {}) {
      const descriptor = localAccessDescriptorOf(call.operation)
      if (descriptor !== undefined && descriptor.transport !== 'shell') {
        return {
          ok: false,
          error: `${call.operation} 不是 shell 操作（transport=${descriptor.transport}）`,
          sandbox: noSandboxFacts(),
        }
      }
      const workdir = call.workdir ?? options.workdir ?? await deps.workdir()
      const decision = authorize({ ...call, ...(workdir === '' ? {} : { workdir }) })
      if (!decision.ok) return { ok: false, error: decision.error, sandbox: noSandboxFacts() }

      const started = await startShell(deps.ctx, command, {
        ...(workdir === '' ? {} : { workdir }),
        ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
        escalate: decision.sandboxPolicy !== undefined,
      })
      if (!started.ok) return started

      const handle = started.handle
      const declaredMode = decision.sandboxPolicy === undefined ? '' : 'danger-full-access'
      const summary = options.summary
      void handle.done.then(async () => {
        const info = handle.sandbox()
        const facts = {
          requested: declaredMode,
          resolved: declaredMode,
          ran: text(info?.mode),
          denied: info?.denied === true,
          runnerFailed: info?.runnerFailed === true,
        }
        const verdict = classifyAccessFailure({
          platform: await deps.platform(),
          sandbox: facts,
          error: '',
          exitCode: handle.exitCode(),
          text: '',
        })
        record({ ...call, ...(summary === undefined ? {} : { summary }) }, verdict, facts, true, false)
      }).catch(() => undefined)
      return started
    },

    async writeText(call, target, content) {
      const descriptor = localAccessDescriptorOf(call.operation)
      if (descriptor !== undefined && descriptor.transport !== 'filesystem') {
        return { ok: false, error: `${call.operation} 不是文件写入操作（transport=${descriptor.transport}）` }
      }
      const decision = authorize(call)
      if (!decision.ok) return { ok: false, error: decision.error }

      // 每个操作只能写**它自己那一个**目标：种类与路径都要对得上，否则拒绝。
      const expectedKind = LOCAL_ACCESS_WRITE_TARGETS[call.operation]
      if (expectedKind === undefined) {
        return { ok: false, error: `${call.operation} 未登记可写目标，拒绝写入` }
      }
      if (target.kind !== expectedKind) {
        return { ok: false, error: `${call.operation} 只能写 ${expectedKind}，收到 ${target.kind}` }
      }
      const home = await deps.home()
      if (home === '') return { ok: false, error: '主目录未知，拒绝写本机凭据 / 状态文件' }
      const expectedPath = deps.targets[expectedKind](home)
      if (normalizePath(target.path) !== normalizePath(expectedPath)) {
        // 不回显目标路径：它在未授权语境里也是维护者信息（进诊断只看操作名与类别）。
        return { ok: false, error: `${call.operation} 的目标路径不是该操作允许的那一个，拒绝写入` }
      }

      const fs = fileSystem(deps.ctx)
      if (fs === undefined) return { ok: false, error: 'Host 文件服务不可用' }
      const requested = descriptor?.privileged === true ? 'danger-full-access' : ''
      try {
        const resolved = await resolveTarget(deps.ctx, expectedPath)
        await fs.writeText(resolved, content, undefined, undefined, {
          mode: 'danger-full-access',
          workspaceRoot: home,
        })
        record({ ...call }, '', { requested, resolved: '', ran: '', denied: false, runnerFailed: false }, true)
        return { ok: true, error: '' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // DSH 自己的拒绝标记是**结构化可认**的（`file access denied under <mode> mode`）；
        // 它是沙箱事实，不是文本猜测。除此之外只能算基础设施失败 —— 真实 ACL / 文件占用
        // 需要平台原生检查才能定性，那是子项目 D 的 doctor，不在这里猜。
        const denied = /file access denied under\s+\S+\s+mode/i.test(message)
        const facts = { requested, resolved: '', ran: '', denied, runnerFailed: false }
        record({ ...call }, denied ? 'sandbox-denied' : 'infrastructure', facts, false)
        deps.ctx.logger?.warn?.('crwu-workbench: 本机文件写入失败 %o', { operation: call.operation, denied })
        return { ok: false, error: message }
      }
    },
  }
}
