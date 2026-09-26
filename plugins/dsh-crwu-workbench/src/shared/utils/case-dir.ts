import { text } from './value.ts'

/**
 * 一条报告的**案例目录**：`<工作空间>/<流水号>`。
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
 * 拼接方式与 Host 原实现逐字一致（用 `/` 连接、去掉工作空间末尾的斜杠），
 * 因为提示词里给出的是**跨平台都一样的字符串**，不引入 `node:path` 的平台差异。
 * 任一侧为空时返回空串，调用方据此**不写这一段**（宁可不给，也不给一个半截路径）。
 */
export function caseDirOf(workspacePath: unknown, seqNo: unknown): string {
  const workspace = text(workspacePath).replace(/\/+$/, '')
  const seq = text(seqNo).trim()
  if (workspace === '' || seq === '') return ''
  return `${workspace}/${seq}`
}
