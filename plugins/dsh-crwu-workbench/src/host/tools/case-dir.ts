import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { failure, type ToolFailure } from './outcome.ts'

/**
 * 案例目录门禁。
 *
 * 两条硬要求（来自审核链路的安全边界）：
 * 1. **所有产物都落在案例目录内**：`crwu_h3yun_file_get` 的下载目标、OSS 上传的源文件
 *    都必须通过 `contains()` 证明在案例目录之下。没有这一条，Tool 就成了
 *    「让宿主往任意路径写文件 / 把任意文件传到 OSS」的入口。
 * 2. **案例目录本身必须在插件选定的工作空间之下**（父级由 Host 判定，不由模型提交）。
 *
 * 判据用 `fs.contains()`（后端自己 realpath 之后比较），不做字符串前缀匹配 ——
 * `..`、符号链接和 Windows 的盘符大小写都会让字符串比较失效。
 */

export interface CaseResolution {
  ok: true
  /** 案例目录的 displayPath（原样回给模型与命令的 workdir）。 */
  path: string
}

export type CaseCheck = CaseResolution | ToolFailure

/** 把模型给的案例目录解析成绝对 displayPath；空串/相对路径一律拒绝。 */
export async function requireCaseDir(ctx: Context, raw: unknown): Promise<CaseCheck> {
  const value = text(raw).trim()
  if (value === '') return { ...failure('input', '缺少案例目录（caseDir 必须是绝对路径）') }
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) {
    return { ...failure('input', `案例目录必须是绝对路径：${value}`) }
  }
  if (value.split(/[\\/]/).includes('..')) {
    return { ...failure('input', `案例目录不能包含 .. 片段：${value}`) }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ...failure('infrastructure', 'Host 文件服务不可用') }
  try {
    const target = await resolveTarget(ctx, value)
    const info = await fs.stat(target)
    if (info?.type !== 'directory') {
      return { ...failure('input', `案例目录不存在或不是目录：${value}`) }
    }
    return { ok: true, path: text(target.displayPath) || value }
  } catch (error) {
    return {
      ...failure('input', `案例目录不可解析：${value}（${error instanceof Error ? error.message : String(error)}）`),
    }
  }
}

/**
 * 解析案例目录下的一个**相对**文件路径，并证明它没有逃出案例目录。
 *
 * 相对路径里出现 `..` 或盘符/前导 `/` 直接拒绝：调用方是模型，不是可信代码。
 */
export async function requireInsideCase(
  ctx: Context,
  casePath: string,
  relative: unknown,
): Promise<{ ok: true; path: string } | ToolFailure> {
  const name = text(relative).trim().replace(/\\/g, '/')
  if (name === '') return { ...failure('input', '缺少案例目录内的相对路径') }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return { ...failure('input', `只接受案例目录内的相对路径：${name}`) }
  }
  if (name.split('/').includes('..')) {
    return { ...failure('input', `相对路径不能包含 ..：${name}`) }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ...failure('infrastructure', 'Host 文件服务不可用') }
  const full = `${casePath.replace(/[\\/]+$/, '')}/${name}`
  try {
    const root = await resolveTarget(ctx, casePath)
    const target = await fs.resolve(name, { cwd: text(root.displayPath) })
    if (fs.contains(root, target) !== true) {
      return { ...failure('policy', `目标逃出了案例目录：${name}`) }
    }
    return { ok: true, path: text(target.displayPath) || full }
  } catch (error) {
    return {
      ...failure('input', `路径不可解析：${name}（${error instanceof Error ? error.message : String(error)}）`),
    }
  }
}

/** 目标是否已存在且是普通文件。 */
export async function isRegularFile(ctx: Context, path: string): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    return info?.type === 'file'
  } catch (error) {
    void error
    return false
  }
}

/** 文件字节数；读不到返回 0。 */
export async function fileSize(ctx: Context, path: string): Promise<number> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return 0
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    return typeof info?.size === 'number' && Number.isFinite(info.size) ? info.size : 0
  } catch (error) {
    void error
    return 0
  }
}
