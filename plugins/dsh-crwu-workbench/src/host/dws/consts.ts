import type { LocalAccessOperation } from '../access/operations.ts'

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
  // 只读健康检查（子项目 D2）：读 `~/.dws` 与钥匙串状态，不写、不改。
  ['doctor'],
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
 * 白名单前缀 → 本机访问操作（协议 18）。
 *
 * 与 `DWS_ALLOWED_PREFIXES` 放在同一个文件：**能跑什么**与**算哪一类本机访问**必须一起读，
 * 分开放会漂移 —— 新增一个白名单前缀却忘了登记操作时，`runDws` 会拒绝它（默认拒绝），
 * 而不是悄悄按"不需要凭据"跑一遍。
 */
export const DWS_OPERATION_BY_PREFIX: readonly (readonly [readonly string[], LocalAccessOperation])[] = [
  [['auth', 'status'], 'dws.auth.status'],
  [['auth', 'login'], 'dws.auth.login'],
  [['doctor'], 'dws.doctor.read'],
  [['profile', 'list'], 'dws.profile.read'],
  [['wiki', '+space-list'], 'dws.knowledge.read'],
  [['wiki', '+space-search'], 'dws.knowledge.read'],
  [['wiki', '+space-get'], 'dws.knowledge.read'],
  [['wiki', '+node-list'], 'dws.knowledge.read'],
  [['wiki', '+node-search'], 'dws.knowledge.read'],
  [['wiki', '+node-get'], 'dws.knowledge.read'],
  [['wiki', 'space', 'list'], 'dws.knowledge.read'],
  [['doc', '+export'], 'dws.knowledge.read'],
  [['drive', '+download'], 'dws.drive.read'],
  [['drive', '+list'], 'dws.drive.read'],
  [['drive', '+inspect'], 'dws.drive.read'],
  [['drive', '+create-folder'], 'dws.drive.write'],
  [['drive', '+upload'], 'dws.drive.write'],
  [['contact', 'user', 'get-self'], 'dws.contact.read'],
  [['aisearch', 'person'], 'dws.contact.read'],
  // 会话类命令：发消息与读自己的会话记录同属"消息"能力（读也只读员工自己的会话）。
  [['chat', '+messages-send'], 'dws.message.write'],
  [['chat', '+chat-messages'], 'dws.message.write'],
  [['ding', 'message', 'send-by-message'], 'dws.message.write'],
]

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
