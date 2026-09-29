import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isFile, resolveTarget } from '../fs/paths.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import { parseSessionOutput, type H3yunSession } from '../h3yun/session.ts'
import { readOssCred, type OssCredView } from '../oss/cred.ts'
import { shellInvoke, clipboardCommand, openExternalCommand } from '../platform/shell.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { resolveBundledCommand } from '../platform/command.ts'
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
}

/** 输出可能很长（扫码登录会打印提示），只回尾部给界面。 */
function tails(run: { stdout?: unknown; stderr?: unknown }): { stdoutTail: string; stderrTail: string } {
  return { stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600) }
}

/** 钉钉登录。`--device` 走设备码流程（无浏览器时用）。 */
export async function dwsLogin(deps: SystemDeps, args: Record<string, unknown>): Promise<LoginResult> {
  // 用**包内绝对路径**：只按名字调用在 Finder 启动的桌面端会 `bash: dws: command not found`，
  // 表现就是「点了钉钉登录没有任何反应」（客户端此前又把返回值丢掉了，所以连错误都看不到）。
  const argv = [await resolveBundledCommand(deps.ctx, deps.platform, 'dws'), 'auth', 'login']
  if (args.device === true) argv.push('--device')
  const run = await deps.access.runShell(
    { operation: 'dws.auth.login', source: 'panel', workdir: await deps.workdir() },
    shellInvoke(argv[0] ?? '', argv.slice(1), deps.platform),
    // 扫码要等人，5 分钟。
    { timeoutMs: 300_000, summary: 'dws auth login' },
  )
  return { ok: run.ok, error: run.error, timedOut: run.timedOut, ...tails(run) }
}

export interface ReloginResult extends LoginResult {
  session: H3yunSession | null
}

/** 氚云重新登录（`crwu h3yun session login` 在提权白名单里）。 */
export async function relogin(deps: SystemDeps): Promise<ReloginResult> {
  const run = await runCrwu(deps.ctx, ['crwu', 'h3yun', 'session', 'login'], {
    workdir: await deps.workdir(),
    timeoutMs: 300_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
  })
  return {
    ok: run.ok,
    error: run.error,
    timedOut: run.timedOut,
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
