/**
 * CRWU 业务 Tool 的名字与固定协议值。
 *
 * 名字是**跨进程契约**的一部分：审核提示词、审核根会话的 capability 预检、
 * 技能正文和测试都逐字引用它们。改名字必须同批改那些地方（并有测试盯着）。
 */

/** 审核链路必需的工具集：子代理一个都看不到时必须在创建子代理**之前**失败。 */
export const REQUIRED_AUDIT_TOOLS = [
  'crwu_audit_capabilities',
  // 报告定位与一次取数的交接点：审核启动前 Host 自己调它，子代理只消费它落盘的输入快照。
  'crwu_audit_case_bootstrap',
  'crwu_h3yun_record_get',
  'crwu_h3yun_files_list',
  'crwu_h3yun_file_get',
  'crwu_audit_knowledge_materialize',
  'crwu_audit_oss_publish',
  'crwu_audit_dingtalk_archive',
  'crwu_audit_dingtalk_notify_self',
] as const

export type AuditToolName = typeof REQUIRED_AUDIT_TOOLS[number]

export const TOOL_NAMES = {
  capabilities: 'crwu_audit_capabilities',
  auditCaseBootstrap: 'crwu_audit_case_bootstrap',
  h3yunRecordGet: 'crwu_h3yun_record_get',
  h3yunFilesList: 'crwu_h3yun_files_list',
  h3yunFileGet: 'crwu_h3yun_file_get',
  knowledgeMaterialize: 'crwu_audit_knowledge_materialize',
  ossPublish: 'crwu_audit_oss_publish',
  dingtalkArchive: 'crwu_audit_dingtalk_archive',
  dingtalkNotifySelf: 'crwu_audit_dingtalk_notify_self',
} as const

/** 自研审核链路随包发布的三个二进制。 */
export const AUDIT_BINARIES = ['crwu', 'dws', 'ossutil'] as const

/** 工具输出的失败类别；空串表示成功。 */
export type ToolErrorKind =
  | ''
  | 'input'
  | 'capability-gap'
  | 'approval'
  | 'infrastructure'
  | 'cancelled'
  | 'cli'
  | 'not-found'
  | 'policy'

/** 超过这个长度的命令输出不进模型上下文（截断处会明确标注）。 */
export const TOOL_TEXT_MAX = 8_000

/** 单附件下载的目标目录名（在案例目录内）。 */
export const CASE_MATERIAL_DIR = '材料-源'

/** 知识库材料的落地目录名（在案例目录内）。 */
export const CASE_KNOWLEDGE_DIR = 'knowledge'
