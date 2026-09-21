import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isFile, resolveTarget } from '../fs/paths.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import { parseSessionOutput, type H3yunSession } from '../h3yun/session.ts'
import { readOssCred, type OssCredView } from '../oss/cred.ts'
import { shellQuote } from '../environment/probe.ts'
import { runShell } from '../shell/run.ts'
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
  const command = deps.platform.startsWith('darwin')
    ? 'pbcopy'
    : (deps.platform.startsWith('win32') ? 'clip' : 'xclip -selection clipboard 2>/dev/null || xsel -b')
  const run = await runShell(deps.ctx, command, {
    workdir: await deps.workdir(),
    timeoutMs: 20_000,
    escalate: true,
    stdinText: content,
  })
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
  try {
    const target = await resolveTarget(deps.ctx, path)
    if (root !== '') {
      const rootTarget = await resolveTarget(deps.ctx, root)
      // 没有这一条，面板就是「用默认程序打开任意路径」的入口。
      if (fs.contains(rootTarget, target) !== true) return failed('只允许打开案例根目录内的文件')
    }
    if (!await isFile(deps.ctx, path)) return failed(`目标不是文件：${path}`)
  } catch (error) {
    return failed(`路径解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const command = deps.platform.startsWith('darwin')
    ? `open ${shellQuote(path, deps.platform)}`
    : (deps.platform.startsWith('win32')
      ? `cmd /c start "" ${shellQuote(path, deps.platform)}`
      : `xdg-open ${shellQuote(path, deps.platform)}`)
  const run = await runShell(deps.ctx, command, {
    workdir: await deps.workdir(),
    timeoutMs: 30_000,
    escalate: true,
  })
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
  const argv = ['dws', 'auth', 'login']
  if (args.device === true) argv.push('--device')
  const run = await runShell(deps.ctx, argv.map((item) => shellQuote(item, deps.platform)).join(' '), {
    workdir: await deps.workdir(),
    // 扫码要等人，5 分钟。
    timeoutMs: 300_000,
    escalate: true,
  })
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
    escalate: true,
    trusted: deps.state.trustCredentials,
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
    trusted: deps.state.trustCredentials,
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
  return { ok: true, cred: await readOssCred(deps.ctx, home) }
}
