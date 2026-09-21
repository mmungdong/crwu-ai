import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { text } from '../../shared/utils/value.ts'

/**
 * 工作区与会话根路径。
 *
 * `ctx.fs.resolve()` 返回的是 **FsTarget 对象**（`targetKey` + `displayPath`），不是字符串 ——
 * 禁止对路径做字符串拼接，必须把 FsTarget 原样传给 `readText` / `stat` / `writeText`。
 * 这里只把 `displayPath` 取出来给界面和命令 `workdir` 用。
 */
export interface WorkspacePaths {
  /** 当前会话的工作目录（`fs.resolve('.')`）；不可用时为空串。 */
  sessionRoot: string
  /** 用户主目录；探测不到时为空串。 */
  home: string
}

/** 取可选的 fs 服务。可选服务一律走 `ctx.get`，只有硬依赖才写进 `inject`。 */
export function fileSystem(ctx: Context): FileSystem | undefined {
  return ctx.get('fs') as FileSystem | undefined
}

/** 解析路径为 FsTarget；fs 服务缺失时抛错（调用方需要知道无法继续）。 */
export async function resolveTarget(ctx: Context, path: string, cwd?: string): Promise<FsTarget> {
  const fs = fileSystem(ctx)
  if (fs === undefined) throw new Error('Host 文件服务不可用')
  return await fs.resolve(path, cwd === undefined ? undefined : { cwd })
}

/** 目标是否存在且为文件。 */
export async function isFile(ctx: Context, path: string, cwd?: string): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    const info = await fs.stat(await fs.resolve(path, cwd === undefined ? undefined : { cwd }))
    return info?.type === 'file'
  } catch (error) {
    // 路径不存在/无法解析都等价于「不是文件」，调用方据此走降级分支。
    void error
    return false
  }
}

/** 目标是否存在且为目录。 */
export async function isDir(ctx: Context, path: string, cwd?: string): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    const info = await fs.stat(await fs.resolve(path, cwd === undefined ? undefined : { cwd }))
    return info?.type === 'directory'
  } catch (error) {
    void error
    return false
  }
}

/** 读取文本文件；失败返回空串（调用方按空串走降级）。 */
export async function readTextIfExists(ctx: Context, path: string, cwd?: string): Promise<string> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return ''
  try {
    return await fs.readText(await fs.resolve(path, cwd === undefined ? undefined : { cwd }))
  } catch (error) {
    void error
    return ''
  }
}

/** 会话工作目录；不可用时返回空串。 */
export async function sessionRoot(ctx: Context): Promise<string> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return ''
  try {
    return text((await fs.resolve('.')).displayPath)
  } catch (error) {
    void error
    return ''
  }
}
