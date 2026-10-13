import type { WorkspaceFailureReason, WorkspaceSessionFailure } from './types.ts'

/**
 * 工作区会话失败的人话文案。
 *
 * 集中在一处：同一句故障在界面上出现在四个模块里（报告审核 / 报告评估 / 本地审核 / 报告讨论），
 * 各写一遍必然漂移成四种说法，用户无法判断"这是不是同一件事"。
 *
 * 措辞口径（沿用环境信息页的既有口径）：
 *   - 员工自己能修的 → 直接说去做什么（"请先在【环境信息】里选择一个已有目录"）；
 *   - 员工修不了的 → 说清楚找谁 / 重启什么，**不**让员工去装包或改系统。
 */
const MESSAGES: Record<WorkspaceFailureReason, string> = {
  'no-workspace': '尚未选定工作区：请先在【环境信息】里选择一个已有目录，再发起本页操作。',
  'workspace-missing': '已选定的工作区目录已不存在或已被移动：请回到【环境信息】重新选择。',
  'workspace-unchecked': '工作区状态尚未通过环境自检：请先在【环境信息】完成自检（或点一次「重新自检」）。',
  'workspace-unregistered': '选定的工作区没有登记到 DSH 工作区注册表：请回到【环境信息】重新选择该目录。',
  'workspace-path-mismatch': '选定的工作区路径与 DSH 注册表里的记录不是同一个目录：请回到【环境信息】重新选择。',
  'workspace-not-a-directory': '选定的工作区路径不是一个目录：请回到【环境信息】重新选择一个已有目录。',
  'services-unavailable': '宿主的工作区/会话服务不可用：无法确认会话落点，已停止创建。请重启 DeepSeek Harness 后重试。',
  'session-create-failed': '创建会话失败。',
  'session-attach-failed': '会话已创建，但没能挂到选定的工作区下面：已停止后续步骤，避免把内容写进错误的目录。',
  'session-membership-missing': '会话创建后没有出现在选定工作区的成员清单里：已停止后续步骤。',
  'session-cwd-mismatch': '会话的工作目录与选定工作区不一致：已停止后续步骤。',
  'session-agent-missing': '会话的 Agent 不在运行中（进程可能已重启）。',
}

/** 一个可读的失败原因（不带任何路径 / id）。 */
export function workspaceFailureReasonText(reason: WorkspaceFailureReason): string {
  return MESSAGES[reason]
}

/**
 * 造一条失败。
 *
 * `detail` 是**补充事实**（DSH 抛出来的原始消息），拼在人话后面；调用方保证它不含凭据 ——
 * 这里不做清洗，因为清洗会掩盖真正的故障原因，而进入这里的字符串都来自本地服务调用。
 */
export function workspaceFailure(
  reason: WorkspaceFailureReason,
  detail = '',
): WorkspaceSessionFailure {
  const base = MESSAGES[reason]
  return {
    ok: false,
    reason,
    error: detail === '' ? base : `${base}（${detail}）`,
  }
}
