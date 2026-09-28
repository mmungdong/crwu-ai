import type { Context } from '@deepseek-ai/cordis'
import { isWindowsPlatform } from '../platform/detect.ts'
import { shellQuote } from '../environment/probe.ts'
import { runShell } from '../shell/run.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'

/**
 * 案例目录内的**本地文件操作**。
 *
 * 为什么不是 `node:fs`：插件跑在 Host 进程里，直接用 Node 文件 API 会绕过 DSH 的
 * 文件服务与沙箱策略。「删掉上一轮同名产物」这种动作必须走与其它命令同一条路径。
 *
 * 命令串由这里按固定模板 + `shellQuote` 构造：路径全部来自已经过案例目录包含检查的
 * 绝对路径，模型输入不参与拼接。
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
  const quote = (value: string): string => shellQuote(value, options.platform)
  const command = isWindowsPlatform(options.platform)
    ? `cmd /c del /f /q ${quote(path)}`
    : `rm -f -- ${quote(path)}`
  const run = await runShell(ctx, command, {
    workdir: options.workdir,
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { ok: run.ok, error: run.ok ? '' : (run.stderr || run.error || '删除旧产物失败').slice(0, 300) }
}

/** 确保目录存在（`mkdir -p`）。 */
export async function ensureDirectory(
  ctx: Context,
  path: string,
  options: { workdir: string; platform: string; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const quote = (value: string): string => shellQuote(value, options.platform)
  const command = isWindowsPlatform(options.platform)
    ? `cmd /c mkdir ${quote(path)}`
    : `mkdir -p ${quote(path)}`
  const run = await runShell(ctx, command, {
    workdir: options.workdir,
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (run.ok) return { ok: true, error: '' }
  // Windows 的 `mkdir` 在目录已存在时报错，这属于「已经是我们要的状态」。
  if (isWindowsPlatform(options.platform)) return { ok: true, error: '' }
  return { ok: false, error: (run.stderr || run.error || '创建目录失败').slice(0, 300) }
}
