import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { isAbsoluteLocalPath, joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { failure, type ToolFailure } from './outcome.ts'

/**
 * 案例目录门禁。
 *
 * 两条硬要求（来自审核链路的安全边界）：
 * 1. **所有产物都落在案例目录内**：`crwu_h3yun_file_get` 的下载目标、OSS 上传的源文件
 *    都必须通过 `contains()` 证明在案例目录之下。没有这一条，Tool 就成了
 *    「让宿主往任意路径写文件 / 把任意文件传到 OSS」的入口。
 * 2. **案例目录本身必须在插件选定的工作空间之下**（信任域由 Host 判定，不由模型提交）。
 *    ⚠️ 2026-09-29 复查前，第 2 条只写在注释里、**代码里并没有做**：`caseDir` 是模型参数，
 *    只校验了「绝对 + 存在 + 是目录 + 没有 `..`」。后果不是理论上的：
 *    `crwu_audit_oss_publish` 会把**任意可读目录里**的文件传到 OSS（读不受沙箱限制 → 数据外泄），
 *    `crwu_h3yun_record_get` 更是把模型给的字符串**原样当特权命令的 cwd** 用。
 *    现在 `allowedRoot` 是**必填**参数，由调用方从 Host 状态取（`allowedCaseRootOf`），
 *    编译器保证没有调用点能"忘了传"。
 *
 * 判据用 `fs.contains()`（后端自己 realpath 之后比较），不做字符串前缀匹配 ——
 * `..`、符号链接和 Windows 的盘符大小写都会让字符串比较失效。
 */

/**
 * 允许的案例根：**审核链路的信任域** = 选定工作空间（没选就退回案例根）。
 *
 * 与 `ensureAuditRoot` 里 `state.workspacePath || state.caseRoot` 是**同一个表达式** ——
 * 审核根的沙箱边界就是它，所以"案例目录必须落在它之下"与"沙箱只允许在它里面写"是同一条线。
 */
export function allowedCaseRootOf(state: { workspacePath: string; caseRoot: string }): string {
  return text(state.workspacePath) || text(state.caseRoot)
}

export interface CaseResolution {
  ok: true
  /** 案例目录的 displayPath（原样回给模型与命令的 workdir）。 */
  path: string
}

export type CaseCheck = CaseResolution | ToolFailure

/**
 * 把模型给的案例目录解析成绝对 displayPath，并证明它落在 `allowedRoot` 之下。
 *
 * `allowedRoot` **必填**（可以是空串 = Host 还没选工作空间，此时一律拒绝）：
 * 把它做成可选参数就等于给"以后新增的调用点忘了传"留一个静默后门。
 */
export async function requireCaseDir(
  ctx: Context,
  raw: unknown,
  options: { allowedRoot: string },
): Promise<CaseCheck> {
  const value = text(raw).trim()
  if (value === '') return { ...failure('input', '缺少案例目录（caseDir 必须是绝对路径）') }
  // 盘符绝对路径与 UNC 都算绝对路径（`isAbsoluteLocalPath` 同时认 POSIX 的 `/…`）。
  // **UNC 的策略是「交给底层验证」**：DSH 的 fs 在 Windows 上原生支持 `\\server\share`，
  // 插件不得自行把它判死；底层解析不了时下面统一回「案例目录不可解析：…（原因）」——
  // 可诊断、也不生成损坏路径（把 `\\server\share` 用字符串规则裁一裁才是真正的损坏）。
  if (!isAbsoluteLocalPath(value)) {
    return { ...failure('input', `案例目录必须是绝对路径：${value}`) }
  }
  if (value.split(/[\\/]/).includes('..')) {
    return { ...failure('input', `案例目录不能包含 .. 片段：${value}`) }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ...failure('infrastructure', 'Host 文件服务不可用') }
  try {
    const target = await resolveTarget(ctx, value)
    // **信任域**：模型给的路径必须在 Host 选定的工作空间之下。
    // 不报路径细节（工作空间由员工自己选，但报错里不必再散一份绝对路径）。
    // 运行时的兜底：TS 调用方必须传，但 JS/旧调用点漏传时**fail closed**（不是抛异常，也不是放行）。
    const allowedRoot = text(options?.allowedRoot).trim()
    if (allowedRoot === '') {
      return { ...failure('policy', '还没有选定工作空间：拒绝在未确定信任域的情况下使用案例目录') }
    }
    const allowedTarget = await resolveTarget(ctx, allowedRoot)
    if (fs.contains(allowedTarget, target) !== true) {
      return { ...failure('policy', '案例目录必须落在当前工作空间之下（案例目录由 Host 判定，不由调用方指定）') }
    }
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
  const full = joinLocalPath(casePath, name)
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
