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
 * 三条口径（2026-09-28 Windows 适配收紧）：
 * 1. 命令串由 `platform/shell.ts` 按平台生成 —— 这里不再出现 `cmd /c`、`mkdir`、`rm` 之类的字面量；
 * 2. **失败必须传播**：过去 Windows 上 `cmd /c mkdir` 任意失败都被当成成功，
 *    后果是「以为目录建好了，下一步写文件才炸」；现在只把「已经是目标状态」视为成功；
 * 3. **后置条件要回读**：命令退出码为 0 不等于文件真的没了 / 目录真的在（编码、占用、虚拟文件系统
 *    都可能骗人），所以两个操作都用 `ctx.fs.stat` 复核一次。
 */
export async function removeFileIfExists(
  ctx: Context,
  path: string,
  options: { workdir: string; platform: string; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ok: false, error: 'Host 文件服务不可用' }
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    if (info === undefined) return { ok: true, error: '' }
    if (info.type !== 'file') return { ok: false, error: `目标不是普通文件，拒绝删除：${path}` }
  } catch (error) {
    // 不存在就是「没什么可删的」，不是错误。
    void error
    return { ok: true, error: '' }
  }
  const run = await runShell(ctx, removeFileCommand(path, options.platform), {
    workdir: options.workdir,
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!run.ok) {
    return { ok: false, error: (text(run.stderr) || text(run.error) || '删除旧产物失败').slice(0, 300) }
  }
  // 后置条件：退出码 0 不等于真的删掉了（占用 / 只读属性 / 被虚拟化的路径都可能骗过退出码）。
  const stillThere = await existsAsFile(ctx, path)
  if (stillThere) return { ok: false, error: `删除命令返回成功，但文件仍然存在：${path}` }
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
  if (!run.ok) {
    // 只有「目标已经是我们要的状态」才算成功 —— 那由下面的后置条件判定，不是由退出码猜。
    const alreadyThere = await existsAsDirectory(ctx, path)
    if (alreadyThere) return { ok: true, error: '' }
    return { ok: false, error: (text(run.stderr) || text(run.error) || '创建目录失败').slice(0, 300) }
  }
  if (!await existsAsDirectory(ctx, path)) {
    return { ok: false, error: `创建目录命令返回成功，但目录不存在：${path}` }
  }
  return { ok: true, error: '' }
}

/** 目标是否是普通文件（路径不存在 / 解析失败都算「不是」）。 */
async function existsAsFile(ctx: Context, path: string): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    return (await fs.stat(await resolveTarget(ctx, path)))?.type === 'file'
  } catch (error) {
    void error
    return false
  }
}

/** 目标是否是目录。 */
async function existsAsDirectory(ctx: Context, path: string): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    return (await fs.stat(await resolveTarget(ctx, path)))?.type === 'directory'
  } catch (error) {
    void error
    return false
  }
}
