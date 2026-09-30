/**
 * CRWU 业务 Tool 的名字与固定协议值。
 *
 * 名字是**跨进程契约**的一部分：审核提示词、审核根会话的 capability 预检、
 * 技能正文和测试都逐字引用它们。改名字必须同批改那些地方（并有测试盯着）。
 */

/**
 * **审核根会话**必需的工具集（根看不到任何一个就在**创建子代理之前**失败）。
 *
 * ⚠️ 它**不是**子会话的必需集：里面有 Host 专用、子会话被 deny 的 Tool。
 * 子会话的必需集是下面的 `REQUIRED_AUDIT_CHILD_TOOLS` —— 两者混用会让真实 `toolFilter`
 * 生效后把**每一条正常子会话**判成"缺必需工具"并停掉（2026-09-29 第三轮复查的 P1）。
 */
/**
 * 审核链路（根 + 子会话）都要能看到的 Tool。
 *
 * ⚠️ `crwu_h3yun_record_get` / `crwu_h3yun_files_list` 2026-09-29 从这里**移出**：
 * 它们的 `objectId` 由模型提交、Host 无法绑定到本轮审核，于是子会话可以读**别的**记录
 *（提示词要求"只用快照"是请求，不是门禁）。本轮记录与附件清单已由
 * `crwu_audit_case_bootstrap` 取进输入快照，审核链路不需要它们；两条 Tool 仍对非审核调用方
 *（面板 / 宿主后台）注册可用，但**审核子会话调用一律拒绝**（见 `h3yun.ts`）。
 */
export const REQUIRED_AUDIT_TOOLS = [
  'crwu_audit_capabilities',
  // 报告定位与一次取数的交接点：审核启动前 Host 自己调它，子代理只消费它落盘的输入快照。
  'crwu_audit_case_bootstrap',
  'crwu_h3yun_file_get',
  'crwu_audit_knowledge_materialize',
  'crwu_audit_ifind_query',
  'crwu_audit_oss_publish',
  'crwu_audit_dingtalk_archive',
  'crwu_audit_dingtalk_notify_self',
] as const

export type AuditToolName = typeof REQUIRED_AUDIT_TOOLS[number]

/**
 * 审核子会话**必须看不到、也执行不了**的工具（`toolFilter.deny`，单一事实源）。
 *
 * 三条都是"Host 用、子会话不许用"：
 * - `crwu_h3yun_record_get` / `files_list`：`objectId` 由模型提交，Host 绑不到本轮审核；
 * - `crwu_audit_case_bootstrap`：Host 在创建子代理**之前**的交接点，子会话手里已有输入快照。
 *
 * ⚠️ 光把它们从"必需集"里删掉**不是**安全边界（那只是预检名单）：子会话照样看得到、
 * 也执行得了。真正的边界是 provider 的 `toolFilter`（DSH 在子会话的创建窗口里做 scoped
 * `tools.restrict()`：工具从 prompt 消失**并且**拒绝执行）—— 由 `spawn.ts` 显式传下去，
 * 且**不支持过滤的 provider 在创建前就被拒绝**（2026-09-29 用户复查的 P1）。
 */
export const AUDIT_CHILD_DENIED_TOOLS = [
  'crwu_h3yun_record_get',
  'crwu_h3yun_files_list',
  'crwu_audit_case_bootstrap',
] as const

/**
 * 插件**注册**的全部业务 Tool（审核子会话的必需集 + 面向面板/宿主的两条氚云查询）。
 *
 * 两个集合刻意分开：注册面不等于审核面的能力集。`REQUIRED_AUDIT_TOOLS` 回答
 * "起审核之前必须能看到什么"，注册面回答"插件提供什么"。混成一个常量，
 * 就会为了"注册面完整"把不该给子会话的 Tool 重新塞回必需集。
 */
/**
 * **审核子会话**必需（也允许）的工具集 = 根必需集 **减去** 子会话被 deny 的那些。
 *
 * 判据只在这里算一次：任何"子会话缺工具"的复查都必须用它，
 * 否则 deny 生效后必然误杀（`crwu_audit_case_bootstrap` 就是同时"根必需"又"子会话 deny"的那一条）。
 * 有一条门禁断言两个集合**不相交**（`host-tools.test.mjs`）。
 */
export const REQUIRED_AUDIT_CHILD_TOOLS = REQUIRED_AUDIT_TOOLS.filter(
  (name) => !(AUDIT_CHILD_DENIED_TOOLS as readonly string[]).includes(name),
)

export const CRWU_BUSINESS_TOOLS = [
  ...REQUIRED_AUDIT_TOOLS,
  'crwu_h3yun_record_get',
  'crwu_h3yun_files_list',
  // 技能脚本的执行入口（2026-09-30）。**注册面**里有它，但它不进 `REQUIRED_AUDIT_TOOLS`：
  // 审核能不能启动不该取决于"脚本执行工具在不在"，而要用它的时候自然会用。
  'crwu_run_python_script',
] as const

export const TOOL_NAMES = {
  capabilities: 'crwu_audit_capabilities',
  auditCaseBootstrap: 'crwu_audit_case_bootstrap',
  h3yunRecordGet: 'crwu_h3yun_record_get',
  h3yunFilesList: 'crwu_h3yun_files_list',
  h3yunFileGet: 'crwu_h3yun_file_get',
  knowledgeMaterialize: 'crwu_audit_knowledge_materialize',
  ifindQuery: 'crwu_audit_ifind_query',
  ossPublish: 'crwu_audit_oss_publish',
  dingtalkArchive: 'crwu_audit_dingtalk_archive',
  dingtalkNotifySelf: 'crwu_audit_dingtalk_notify_self',
  runPythonScript: 'crwu_run_python_script',
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

/** 知识库下载清单的文件名（落在 `knowledge/` 下，与下载正文同级）。 */
export const KB_MANIFEST_FILE = '.crwu-manifest.json'
