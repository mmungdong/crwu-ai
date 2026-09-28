import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { mkdirCommand, removeFileCommand } from '../platform/shell.ts'
import { runShell } from '../shell/run.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'

/**
 * 案例目录内的**本地文件操作**。
 *
 * 为什么不是 `node:fs`：插件跑在 Host 进程里，直接用 Node 文件 API 会绕过 DSH 的
 * 文件服务与沙箱策略。「删掉上一轮同名产物」这种动作必须走与其它命令同一条路径。
 *
 * 三条口径（2026-09-28 收紧，含一次复查修正）：
 * 1. 命令串由 `platform/shell.ts` 按平台生成 —— 这里不再出现 `cmd /c`、`mkdir`、`rm` 之类字面量；
 * 2. **失败必须传播**：只把「目标已经是我们要的状态」视为成功。旧形态在 Windows 上把任意
 *    mkdir 失败都当成功，故障会推迟到「下一步写文件才炸」，归因到完全无关的地方；
 * 3. **后置条件要回读**，而且回读本身有**三种结果**（2026-09-28 复查修）：
 *    存在 / 不存在 / **查不出来**。DSH `fs.stat` 的契约是「不存在返回 `undefined`，
 *    真故障（权限、解析、基础设施）抛异常」——把异常也折叠成「不存在」，
 *    就会在 `Access denied` 时回报「删除成功」，或把一次读不到的目录当成已建好。
 *    所以「查不出来」一律按基础设施失败如实上报，不猜。
 */
export async function removeFileIfExists(
  ctx: Context,
  path: string,
  options: { workdir: string; platform: string; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const probe = await probePath(ctx, path)
  if (probe.kind === 'error') return { ok: false, error: `无法确认目标状态：${probe.error}（${path}）`.slice(0, 300) }
  if (probe.kind === 'absent') return { ok: true, error: '' }
  if (probe.type !== 'file') return { ok: false, error: `目标不是普通文件，拒绝删除：${path}` }

  const run = await runShell(ctx, removeFileCommand(path, options.platform), {
    workdir: options.workdir,
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!run.ok) {
    return { ok: false, error: (text(run.stderr) || text(run.error) || '删除旧产物失败').slice(0, 300) }
  }
  // 后置条件：退出码 0 不等于真的删掉了（占用 / 只读属性 / 被虚拟化的路径都可能骗过退出码）。
  const after = await probePath(ctx, path)
  if (after.kind === 'error') {
    return { ok: false, error: `删除命令返回成功，但无法确认目标是否已删除：${after.error}`.slice(0, 300) }
  }
  if (after.kind === 'present') return { ok: false, error: `删除命令返回成功，但文件仍然存在：${path}` }
  return { ok: true, error: '' }
}

/** 确保目录存在（`mkdir -p` / `New-Item -ItemType Directory -Force`）。 */
export async function ensureDirectory(
  ctx: Context,
  path: string,
  options: { workdir: string; platform: string; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const run = await runShell(ctx, mkdirCommand(path, options.platform), {
    workdir: options.workdir,
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const after = await probePath(ctx, path)
  if (after.kind === 'error') {
    // 连目标状态都确认不了时不许报成功：这正是「以为建好了、下一步写文件才炸」的来源。
    return { ok: false, error: `无法确认目录是否已创建：${after.error}（${path}）`.slice(0, 300) }
  }
  if (after.kind === 'present' && after.type === 'directory') {
    // 命令失败但目标已经是我们要的状态 → 幂等成功（重审会再走一次）。
    return { ok: true, error: '' }
  }
  if (!run.ok) {
    return { ok: false, error: (text(run.stderr) || text(run.error) || '创建目录失败').slice(0, 300) }
  }
  if (after.kind === 'present') {
    return { ok: false, error: `创建目录命令返回成功，但目标不是目录：${path}` }
  }
  return { ok: false, error: `创建目录命令返回成功，但目录不存在：${path}` }
}

/**
 * 目标状态的**三态**探测。
 *
 * `absent` 只对应「`fs.stat` 明确回了 `undefined`」。抛异常一律进 `error` ——
 * 它与「没有这个文件」是两件事，合并就会把权限/解析故障说成成功。
 */
type PathProbe =
  | { kind: 'absent' }
  | { kind: 'present'; type: string }
  | { kind: 'error'; error: string }

async function probePath(ctx: Context, path: string): Promise<PathProbe> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return { kind: 'error', error: 'Host 文件服务不可用' }
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    if (info === undefined) return { kind: 'absent' }
    return { kind: 'present', type: text(info.type) }
  } catch (error) {
    return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
