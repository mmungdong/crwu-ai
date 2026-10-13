import type { LocalAuditSkipped } from './scan.ts'
import type { SnapshotFile } from './snapshot.ts'

/**
 * 本地审核的**固定指令**（进对话的第一条 prompt，也是「复制审核提示词」复制的那一段）。
 *
 * ## 它里面只能有什么（设计 §8 的硬要求）
 *
 * 允许：`handoffId`、文件的**展示名**、快照内的**相对路径**、快照状态（提供/跳过与原因）、
 * 固定审核要求、用户的补充提示词。
 *
 * **不允许**：用户原始绝对路径、凭据、OSS 地址、氚云信息。所以：
 * - 案例目录不在提示词里 —— 它由 `crwu_audit_local_claim` 在对话里发回来；
 * - 提示词里出现的每一条路径都以 `材料-源/` 开头（相对路径），不是绝对路径；
 * - 不出现任何 `oss://`、bucket、endpoint 或氚云表单标识。
 *
 * 这段文本同时是**验收面**（`tests/unit/host-local-audit-prompt.test.mjs` 逐条断言），
 * 所以修改前先看那份测试。
 */

export interface LocalAuditPromptInput {
  handoffId: string
  files: readonly SnapshotFile[]
  skipped: readonly LocalAuditSkipped[]
  /** 用户填的补充提示词；空串 = 使用默认本地审核规则。 */
  extraPrompt: string
}

/** 一句话总结快照状态（界面与提示词共用同一口径）。 */
export function snapshotStatusLine(fileCount: number, skippedCount: number): string {
  const parts = [`已提供 ${String(fileCount)} 个文件`]
  if (skippedCount > 0) parts.push(`跳过 ${String(skippedCount)} 个文件`)
  return parts.join('，')
}

export function localAuditPrompt(input: LocalAuditPromptInput): string {
  const extra = input.extraPrompt.trim()
  const L: string[] = []
  L.push('请对下面这批**本机文件**执行一次完整的资产评估审核（本地审核）。')
  L.push('')
  L.push('## 第一步：认领这次交接')
  L.push('')
  L.push('这是一次**一次性交接**，材料已经复制进一个案例目录（在工作空间下的 `本地审核/` 里）。先调用一次：')
  L.push('')
  L.push('```text')
  L.push(`crwu_audit_local_claim({ handoffId: "${input.handoffId}" })`)
  L.push('```')
  L.push('')
  L.push('它返回本轮**案例目录**（也是你的工作目录与可写范围）与材料清单。')
  L.push('之后所有案例内操作（`crwu_run_python_script` 等）的 `caseDir` 参数一律用返回的那条路径。')
  L.push('如果它报「已过期 / 已使用 / 快照不在了」：**立即停止**，把原文告诉我，不要自己找文件、不要重新扫描本机目录。')
  L.push('')
  L.push('## 审核范围')
  L.push('')
  L.push(`已提供 ${String(input.files.length)} 个文件：`)
  L.push('')
  for (const file of input.files) {
    L.push(`- ${file.name} → ${file.relativePath}`)
  }
  L.push('')
  if (input.skipped.length > 0) {
    L.push(`另有 ${String(input.skipped.length)} 个文件**没有进入审核范围**（跳过），必须如实记入「未审核」：`)
    L.push('')
    for (const item of input.skipped) {
      L.push(`- ${item.name}（${item.relativePath}）：${item.reason}`)
    }
    L.push('')
  }
  L.push('## 固定审核要求')
  L.push('')
  L.push('1. **按 crwu-audit 技能执行**：先读 `references/14-orchestration-workflow.md`，按它的步骤 1–16 走完两阶段（阶段一独立审核并冻结，再进入阶段二复核对照）。')
  L.push('2. **材料只在快照目录里**：不要读我本机的其它目录，不要按文件名去别处找材料，也不要在本机做任何搜索。')
  L.push('3. **这次是本地审核，不是报告审核**：没有氚云记录、没有报告流水号，也没有人工复核件。')
  L.push('   涉及氚云记录 / 附件 / 复核对照的步骤在没有对应材料时**记为不适用**，不要伪造，也不要当成材料缺失。')
  L.push('4. **禁止任何上传与回传**：不要调用 OSS 发布、钉钉归档、钉钉通知这三条由云端交付使用的工具，')
  L.push('   也不要把材料或结论发到任何远端。交付件只落在案例目录里。')
  L.push('5. **交付件必须标记为「本地审核」**：`审核结果.<项目ID>.json` 与 `审核意见.<项目ID>.html` 都写成')
  L.push('   `本地审核` / `本地文件审核`，不要写成报告审核或氚云审核。')
  L.push('6. **HTML 必须明确区分四种状态**：没有该数据（中性灰）、数据存在但处理失败（错误色）、')
  L.push('   当前类型不适用、以及**文件没有被审核**；并且逐条列出已审核 / 未审核 / 画像缺失与不可用字段。')
  L.push('   不许只用颜色表达状态，也不要用大面积红色背景。')
  L.push('7. **算不出来的必须写「未核」**：禁止心算、估算，也禁止把「未核」写成「缺失」或「已核」。')
  L.push('8. **能力缺口如实登记**：缺什么就写什么，不擅自下确定性结论。')
  L.push('')
  L.push('## 汇报口径（对话里，不是交付件）')
  L.push('')
  L.push('开始审核时先给一句**简短阶段说明**（不要连续百分比、不要假装有进度条），例如：')
  L.push('')
  L.push('```text')
  L.push('本地审核已开始。')
  L.push('')
  L.push(`审核范围：${String(input.files.length)} 个文件`)
  L.push('当前阶段：正在分析文件内容')
  L.push('```')
  L.push('')
  L.push('审核结束后，必须按这个结构收尾：')
  L.push('')
  L.push('```text')
  L.push('本次本地审核已完成。')
  L.push('')
  L.push('交付件（**完整路径**，方便我直接点开）：')
  L.push('- <caseDir>/审核意见.<项目ID>.html')
  L.push('- <caseDir>/审核结果.<项目ID>.json')
  L.push('')
  L.push('已审核：')
  L.push('- <文件名>')
  L.push('')
  L.push('未审核：')
  L.push('- <文件名>：<原因>')
  L.push('')
  L.push('画像缺失：')
  L.push('- <画像字段>：<为什么拿不到>')
  L.push('```')
  L.push('')
  L.push('⚠️ **交付件那一块必须写完整路径**（用 `crwu_audit_local_claim` 返回的 `caseDir` 拼上文件名），')
  L.push('不要只写文件名：界面里的文件链接是**按这条会话的工作空间根去解析**的，只写文件名会指到一个')
  L.push('不存在的路径（点开什么都没有）。同一句话里也不要写成 Markdown 链接的假地址。')
  L.push('')
  L.push('## 补充要求')
  L.push('')
  L.push(extra === '' ? '（我没有额外要求，按默认本地审核规则执行。）' : extra)
  return L.join('\n')
}
