import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isFile, resolveTarget } from '../fs/paths.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import { parseSessionOutput, type H3yunSession } from '../h3yun/session.ts'
import { readOssCred, type OssCredView } from '../oss/cred.ts'
import { shellInvoke, clipboardCommand, openExternalCommand } from '../platform/shell.ts'
import { describeLoginAdvice, loginFailureAdvice } from './login-failure.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import { runDws } from '../dws/run.ts'
import { defaultCaseRoot } from '../audit/state.ts'
import type { WorkbenchState } from '../state/types.ts'


/**
 * 第 5 层的零碎操作：剪贴板、打开文件、登录、会话查询、凭据查看。
 *
 * 两个安全/正确性要点：
 * 1. **`openPath` 必须做目录包含检查**：只允许打开案例根目录内的文件。
 *    没有这一条，面板就成了「让宿主机用默认程序打开任意路径」的入口。
 * 2. **提权命令必须有工作目录**：`pbcopy` / `open` / `dws auth login` 都要读钥匙串或
 *    系统服务，得在沙箱外跑；而 DSH 拒绝「无工作区的提权执行」，所以每个都显式传 workdir。
 */

export interface SystemDeps {
  ctx: Context
  state: WorkbenchState
  platform: string
  workdir: () => Promise<string>
  /** Broker（协议 18）：剪贴板 / 打开文件 / 登录都是跨边界的本机动作。 */
  access: LocalAccessBroker
}

export interface SimpleResult {
  ok: boolean
  error: string
}

// ── clipboard ───────────────────────────────────────────────────────────────

/**
 * 把文本写进系统剪贴板。
 *
 * 内容通过 **stdin** 传给命令，不作为参数 —— 拼进命令行会被 shell 解释，
 * 提示词里的引号、反引号、`$` 全都会出问题。
 */
export async function clipboard(deps: SystemDeps, args: Record<string, unknown>): Promise<SimpleResult> {
  const content = text(args.text)
  if (content === '') return { ok: false, error: '没有内容' }
  const run = await deps.access.runShell(
    { operation: 'system.clipboard.write', source: 'panel', workdir: await deps.workdir() },
    clipboardCommand(deps.platform),
    { timeoutMs: 20_000, stdinText: content, summary: 'system.clipboard.write' },
  )
  return { ok: run.ok, error: run.ok ? '' : (text(run.stderr) || text(run.error) || '剪贴板命令不可用').slice(0, 200) }
}

// ── open-path ───────────────────────────────────────────────────────────────

export interface OpenPathResult extends SimpleResult {
  path: string
  platform: string
}

/** 用系统默认程序打开案例目录内的文件。 */
export async function openPath(deps: SystemDeps, args: Record<string, unknown>): Promise<OpenPathResult> {
  const path = text(args.path)
  const failed = (error: string): OpenPathResult => ({ ok: false, error, path, platform: deps.platform })
  if (path === '') return failed('缺少路径')

  const fs = fileSystem(deps.ctx)
  if (fs === undefined) return failed('Host 文件服务不可用')

  const root = await defaultCaseRoot(deps.ctx, deps.state, deps.workdir)
  // **案例根未知 = 没有信任域 = 拒绝**，而且必须排在 `resolve` / `stat` **之前**。
  //
  // 旧形态是 `if (root !== '') { …包含检查… }`：案例根拿不到时整段检查被跳过。
  // 那时唯一挡住它的是 Broker 的"提权操作必须有工作目录"（而 `defaultCaseRoot` 的兜底
  // 恰好就是那个 workdir）—— 也就是说边界成立靠的是**两处巧合相等**，不是本函数自己的判据。
  // 一旦以后有人把这条操作改成非提权、或给它一个静态 workdir，那个洞会**静默**打开。
  // 所以这里显式 fail closed，判据落在最前面。
  if (root === '') return failed('还没有选定工作空间：拒绝打开范围未确定的文件')
  try {
    const target = await resolveTarget(deps.ctx, path)
    {
      const rootTarget = await resolveTarget(deps.ctx, root)
      // 没有这一条，面板就是「用默认程序打开任意路径」的入口。
      if (fs.contains(rootTarget, target) !== true) return failed('只允许打开案例根目录内的文件')
    }
    if (!await isFile(deps.ctx, path)) return failed(`目标不是文件：${path}`)
  } catch (error) {
    return failed(`路径解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const run = await deps.access.runShell(
    { operation: 'system.case-file.open', source: 'panel', workdir: await deps.workdir() },
    openExternalCommand(path, deps.platform),
    { timeoutMs: 30_000, summary: 'system.case-file.open' },
  )
  return {
    ok: run.ok,
    path,
    platform: deps.platform,
    error: run.ok ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 300),
  }
}

// ── 登录 ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  ok: boolean
  error: string
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  /**
   * 这次失败属于「本机访问被挡在工作区之外」（登录**必须**写工作区之外的路径：
   * 临时浏览器 profile / `<HOME>/.dws` 的登录态 / 操作系统凭据存储）。
   *
   * 界面据此把它说成"沙箱挡住了"并给出可执行的下一步，而不是把
   * `mkdir …: Access is denied` 这种原文丢给员工。
   */
  sandboxBlocked: boolean
  /** 员工可执行的下一步；空串 = 没有归因、照原样显示 `error`。 */
  advice: string
}

/** 输出可能很长（扫码登录会打印提示），只回尾部给界面。 */
function tails(run: { stdout?: unknown; stderr?: unknown }): { stdoutTail: string; stderrTail: string } {
  return { stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600) }
}


/**
 * 钉钉登录（`dws auth login`，OAuth loopback + **系统浏览器**）。
 *
 * ⚠️ **没有设备码分支**（2026-09-30 口径）：DSH 不再提供钉钉设备码登录 —— 入参里的 `device`
 * 被忽略（调用方也不再传它）。需要设备码的用户请在本机终端跑 `dws auth login --device`：
 * 那是 CLI 自己的能力，不属于插件界面。
 *
 * CLI 自己拉起系统浏览器：插件不创建浏览器 Tab、不显示二维码 / 设备码、也不轮询登录进度。
 */
export async function dwsLogin(deps: SystemDeps, _args: Record<string, unknown>, home: string): Promise<LoginResult> {
  // 用**包内绝对路径**：只按名字调用在 Finder 启动的桌面端会 `bash: dws: command not found`，
  // 表现就是「点了钉钉登录没有任何反应」（客户端此前又把返回值丢掉了，所以连错误都看不到）。
  const argv = [await resolveBundledCommand(deps.ctx, deps.platform, 'dws'), 'auth', 'login']
  const workdir = await deps.workdir()
  // 目录与临时目录都用 CLI 自己的默认：插件不再替它决定位置（自指定目录那条通道已整体下掉，见 §16）。
  const run = await deps.access.runShell(
    { operation: 'dws.auth.login', source: 'panel', workdir },
    shellInvoke(argv[0] ?? '', argv.slice(1), deps.platform),
    // 扫码要等人，5 分钟。
    { timeoutMs: 300_000, summary: 'dws auth login' },
  )
  // 钉钉这条路以前**不做归因**（`runDws` 才做），于是沙箱挡住 `.dws` 锁时员工看到的是
  // dws 的原话（像它自己的 bug）。设备码那条同样要抢同一个锁，所以归因对两条都成立。
  const advice = loginFailureAdvice('dws', {
    error: run.error, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode,
    timedOut: run.timedOut, sandbox: run.sandbox,
  })
  // 成功时 `error` 必须是空串（旧形状）：`describeFailure` 对成功会回「命令退出码 0」，
  // 那会让界面把一次成功显示成失败。
  const raw = text(run.stderr).trim() || text(run.error).trim()
  const error = run.ok
    ? ''
    : (advice.blocked ? describeLoginAdvice('dws', advice, raw) : describeFailure(run))
  return {
    ok: run.ok,
    error,
    timedOut: run.timedOut,
    sandboxBlocked: advice.blocked,
    advice: advice.blocked ? advice.action : '',
    ...tails(run),
  }
}

export interface ReloginResult extends LoginResult {
  session: H3yunSession | null
}

/** 氚云重新登录（`crwu h3yun session login` 在提权白名单里）。 */
export async function relogin(deps: SystemDeps, home: string): Promise<ReloginResult> {
  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'login'], {
    workdir: await deps.workdir(),
    timeoutMs: 300_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
    // 扫码要起的临时浏览器 profile 落在插件自己的 scratch 目录里，
    // 不再依赖系统 TEMP（Windows 实测两者都会被这台机器拒绝）。
  })
  // `runCrwu` 只会对**结构化事实**说出的沙箱问题补文案（事实干净就不猜文本）；
  // 扫码这条还多一种形态：宿主按完全访问跑、操作系统的沙箱/ACL 仍然拒绝临时 profile 目录
  // （2026-09-29 实测）。登录的判据更强（目标就是登录必须写的那个目录），所以这里补上。
  const advice = loginFailureAdvice('h3yun', {
    error: run.error, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode,
    timedOut: run.timedOut, sandbox: run.sandbox,
  })
  // `runCrwu` 已经把**结构化**沙箱问题补进 `run.error` 了；这一次补的是事实干净、
  // 但操作系统层面仍然拒绝临时 profile 目录的那一形态，所以证据只取命令自己的原话
  // （stderr），避免同一句归因说两遍。
  const error = run.ok
    ? ''
    : (advice.blocked ? describeLoginAdvice('h3yun', advice, text(run.stderr)) : run.error)
  return {
    ok: run.ok,
    error,
    timedOut: run.timedOut,
    sandboxBlocked: advice.blocked,
    advice: advice.blocked ? advice.action : '',
    session: parseSessionOutput(run.stdout),
    ...tails(run),
  }
}

// ── session ─────────────────────────────────────────────────────────────────

export interface SessionResult {
  ok: boolean
  error: string
  session: H3yunSession | null
}

/** 查氚云会话状态（不登录）。 */
export async function sessionStatus(deps: SystemDeps): Promise<SessionResult> {
  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'status'], {
    workdir: await deps.workdir(),
    timeoutMs: 20_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
  })
  return {
    ok: run.ok,
    error: run.ok ? '' : describeFailure(run),
    session: parseSessionOutput(run.stdout),
  }
}

// ── oss-cred ────────────────────────────────────────────────────────────────

export interface OssCredResult {
  ok: boolean
  cred: OssCredView
}

/** 查看当前 AK 配置（**脱敏视图**，只回 endpoint 与打码后的 key）。 */
export async function ossCred(deps: SystemDeps, home: string): Promise<OssCredResult> {
  return { ok: true, cred: await readOssCred(deps.ctx, home, { access: deps.access, source: 'panel', workdir: home }) }
}
