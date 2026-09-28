import { text } from './value.ts'
import { basenameLocalPath, joinLocalPath } from './local-path.ts'

/**
 * 一条报告的**案例目录**：`<工作空间>/<流水号>`（Windows 上是 `<工作空间>\<流水号>`）。
 *
 * 这是 Host 与 Client 都依赖的唯一约定，所以只在这里定义一次：
 * - Host 的审核提示词拿它告诉审核子代理「本案例目录必须是 …」（`host/audit/prompt.ts`）；
 * - Client 的讨论 / 分析提示词拿它告诉模型「下载与读取只允许在这个目录里」。
 *
 * **为什么必须共用一份**：2026-09-25 实测到漂移的代价 —— 审核链路一直用
 * `<工作空间>/<流水号>`，而讨论会话的模型没人告诉它目录，于是它自己 `ls` + `find` 去猜，
 * 猜成了 `<工作空间>/cases/<流水号>`：既扫了用户的磁盘，又把材料下到了错的地方。
 * 两处各写一份拼接逻辑就是这种漂移的温床，所以宁可多一个共享模块。
 *
 * **拼接交给 `joinLocalPath`**（2026-09-28 Windows 适配）：分隔符随工作空间的风格走 ——
 * 在 Windows 上硬拼 `/` 会得到 `C:\Work/S1` 这种混用形式，而这条路径既进提示词
 * （模型照着写 PowerShell 命令）又进 `ctx.shell` 的 `workdir`。
 *
 * 任一侧为空、或流水号不是安全的一段（绝对路径 / 含 `..`）时返回空串，
 * 调用方据此**不写这一段**（宁可不给，也不给一个半截或越界的路径）。
 */
export function caseDirOf(workspacePath: unknown, seqNo: unknown): string {
  const workspace = text(workspacePath)
  const seq = text(seqNo).trim()
  if (workspace === '' || seq === '') return ''
  try {
    return joinLocalPath(workspace, seq)
  } catch (error) {
    // `joinLocalPath` 对绝对片段与 `..` 抛错：这里按「这一侧不可用」处理，
    // 与空工作空间同一条出口（调用方一律不写这一段）。
    void error
    return ''
  }
}

/** 案例目录名（= 流水号那一段）。Windows 的 `\` 与 POSIX 的 `/` 都要能取到末段。 */
export function caseDirName(workspacePath: unknown, seqNo: unknown): string {
  const dir = caseDirOf(workspacePath, seqNo)
  return dir === '' ? '' : basenameLocalPath(dir)
}
