/**
 * `dws`（钉钉工作台 CLI）在自研审核链路里被允许使用的**命令白名单**。
 *
 * 为什么要有这张表：Tool 内部需要用 `ctx.shell` 执行 `dws`，而 `dws` 自己是一个通用 CLI。
 * 如果只把「二进制路径 + 业务参数」拼起来，就等于给模型开了一个任意 `dws` 命令的逃生口
 * （`dws api ...` 能打任意 OpenAPI）。所以每一条 Tool 只能构造表内的命令形状，
 * 表外一律在执行前拒绝 —— **默认拒绝**，新增业务能力时必须显式登记。
 *
 * 表里用 **argv 前缀**表达（前缀逐字相等，其余是可解释的业务参数）：
 * - `profile list` / `wiki +space-list|+node-list|+node-get` / `wiki space list` /
 *   `doc +export` / `drive +download`：知识库与钉盘只读取数；
 * - `drive +list|+create-folder|+upload|+inspect`：结果回传区的年月归档与写后验证；
 * - `contact user get-self` / `aisearch person` / `chat +messages-send|+chat-messages` /
 *   `ding message send-by-message`：把 HTML 发到自己的单聊并把那条消息转成 DING；
 * - `auth status|login`：环境自检与登录（既有能力，登记在这里只是让白名单完整）。
 *
 * **故意不含**：`api`（未封装 OpenAPI 逃生舱）、`sms` / `call`（有成本的 DING 通道）、
 * 任何写 wiki/doc 的命令、任何 profile 切换命令（profile 由真实返回里取出后显式传参）。
 */

/** 允许的 `dws` argv 前缀；调用方只能在其后追加业务参数。 */
export const DWS_ALLOWED_PREFIXES: readonly (readonly string[])[] = [
  ['auth', 'status'],
  ['auth', 'login'],
  ['profile', 'list'],
  ['wiki', '+space-list'],
  ['wiki', '+space-search'],
  ['wiki', '+space-get'],
  ['wiki', '+node-list'],
  ['wiki', '+node-search'],
  ['wiki', '+node-get'],
  // 团队空间（钉盘）发现：`wiki space list --type orgSpace`，取 spaceId/rootFolderId。
  ['wiki', 'space', 'list'],
  ['doc', '+export'],
  ['drive', '+download'],
  ['drive', '+list'],
  ['drive', '+create-folder'],
  ['drive', '+upload'],
  ['drive', '+inspect'],
  ['contact', 'user', 'get-self'],
  ['aisearch', 'person'],
  ['chat', '+messages-send'],
  ['chat', '+chat-messages'],
  ['ding', 'message', 'send-by-message'],
] as const

/**
 * 允许申请无沙箱执行（`sandboxPolicy: danger-full-access`）的命令前缀。
 *
 * 判据只有一条：**这条命令必须读本机凭据（钥匙串 / 本机 dws profile）才能工作** ——
 * 受限沙箱下读不到 token，`dws` 会如实回「未登录」，那是**假结论**。所以这一层与插件既有的
 * 「读本机凭据的命令才提权」口径同源，不是新增权限类别。
 *
 * 提权还额外要求 `trustCredentials` 已授权、`workspaceRoot` 已知（见 `runDws`）。
 * 白名单外的命令即使被误标也不提权（`runDws` 双重校验）。
 */
export const DWS_ESCALATION_PREFIXES: readonly (readonly string[])[] = DWS_ALLOWED_PREFIXES

/** 结果回传区的固定目标：组织 / 团队空间 / 结果根目录（契约见技能 `13-dingtalk-result-publish.md`）。 */
export const DINGTALK_TARGET = {
  corpName: '中瑞世联资产评估集团有限公司',
  spaceName: '00-【系统专用】AI结果回传区（自动同步·请勿删改）',
  rootFolderName: 'AI资产评估审核结果',
} as const

/** 知识库默认库名（crwu-dws 的目标库）。 */
export const KNOWLEDGE_DEFAULT_SPACE_NAME = '中瑞世联评估审核知识库'

/** `dws` 调用的默认 stdout 预算；目录快照可能很大。 */
export const DWS_STDOUT_MAX = 16 * 1024 * 1024

/** `dws` 调用的默认超时。 */
export const DWS_TIMEOUT_MS = 180_000

/** 结果回传区的组织列表最多翻 20 页，防止分页循环。 */
export const DWS_MAX_PAGES = 20
