/**
 * 交付形状的**冻结清单**：必需业务 Tool 与宿主操作的名单/数量。
 *
 * 为什么单独一份而不是在各测试里写裸数字：这里以前写的是「9 个工具」，而加进 iFinD 之后
 * 真实值是 10 —— 断言照样"通过"过一次（断言的是老数字与老产物），说明裸数字既没人看、
 * 也会在改动时静默过期。现在：
 *
 * - `host-tools.test.mjs`（源码侧的注册清单）与 `host-package.test.mjs`（真实 tarball 里
 *   装出来的包）**共用同一份名字清单**，两处一起红或一起绿；
 * - 数量只出现一次（本文件），改名/加工具时改这里一处，忘记改就会被两条断言同时拦住。
 */
import { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_CHILD_TOOLS, REQUIRED_AUDIT_TOOLS } from '../../src/host/tools/consts.ts'

/**
 * 插件**注册**的全部业务 Tool：**逐字**照 `CRWU_BUSINESS_TOOLS`（单一事实源在源码里）。
 *
 * ⚠️ 这不是"审核子会话的能力集"。2026-09-29 起两者刻意分开：
 * `REQUIRED_AUDIT_TOOLS`（审核必需）不含两条氚云查询 Tool —— 它们的 `objectId` 由模型提交、
 * Host 绑不到本轮审核。但插件**仍然注册**它们（面板 / 宿主后台要用），
 * 所以"装出来的包注册几个 Tool"必须对账**注册面**。
 */
export const FROZEN_AUDIT_TOOLS = [...CRWU_BUSINESS_TOOLS]

/** 审核子会话的能力集（比注册面小）；用例直接引用它来断言"子会话不该看到哪些"。 */
export const FROZEN_REQUIRED_AUDIT_CHILD_TOOLS = [...REQUIRED_AUDIT_CHILD_TOOLS]
export const FROZEN_REQUIRED_AUDIT_TOOLS = [...REQUIRED_AUDIT_TOOLS]

/** 必需 Tool 的条数（等于真实产物里注册进注册表的条数）。 */
export const FROZEN_AUDIT_TOOL_COUNT = FROZEN_AUDIT_TOOLS.length

/**
 * 宿主操作表：旧动态形态的 24 个 handler + 包形态新增/调整后的合计 39 个。
 * 顺序按「加入时间」排，便于后来者看出哪一批是哪次改造加的。
 *
 * `install-prompt` 已**删除**（2026-09-26）：那套「复制安装提示词发给 Agent」在二进制随包发布、
 * 登录与密钥都在界面上填完之后没有任何运行时用途，留在环境页只会把员工指去绕路。
 */
export const FROZEN_OPERATIONS = [
  'ping', 'boot', 'workspace', 'workspace-auto', 'trust', 'bind-session', 'env', 'pending',
  'crwu', 'audit-start', 'audit-stop', 'audit-status', 'audit-release', 'oss-index', 'oss-result', 'oss-link',
  'oss-upload', 'oss-cred-save', 'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred',
  // 第 26 个：一份报告的全部相关文件（只列举、不下载）—— 面板一打开就查。
  'report-files',
  // 第 27~30 个：iFinD 凭据生命周期（插件 Host 自己保管 SK；不再是"读技能目录里的文件"）。
  'ifind-status', 'ifind-credential-save', 'ifind-credential-clear', 'ifind-probe',
  // 第 31~34 个：自助更新（协议 16）。检查 / 手动检查 / 安装 / 取消；安装目标由 Host 自己授权，
  // 调用方只能传空参数（边界在 `src/host/update/ops.ts`，测试在 host-update-operations.test.mjs）。
  'update-status', 'update-check', 'update-install', 'update-cancel',
  // 第 34~35 个：本机访问授权（协议 18）。`trust` 保留一代但只回协议不匹配的失败，
  // 真正的授予/撤销是这两个显式操作（提交规范能力清单 / 写撤销墓碑）。
  'local-access-grant', 'local-access-revoke',
  // 第 36 个：本机访问诊断（协议 18 · B3）——只读、脱敏，给「开发者诊断」看。
  'access-diagnostics',
  // 第 37~38 个：DWS 本机目录的只读体检与最小权限修复（协议 18 · 子项目 D）。
  'dws-local-doctor',
  'dws-local-permission-repair',
  // 第 39 个：报告讨论会话的**受限材料登记**（协议 23）。讨论不是审核 —— 它没有审核记录，
  // 所以 Host 在登记时自己重新取一次附件清单，只把那一批 `fileId` 写进内存白名单。
  'discussion-material-open',
  // ⚠️ 协议 22（2026-09-30）**删掉**了 `browser-session-bind`（氚云内置浏览器扫码，协议 20）
  // 与 `dws-login-start` / `dws-login-status`（钉钉设备码 / 两阶段登录，协议 21）：
  // DSH 只读取、检查已有凭据，登录由本机 CLI 打开系统浏览器完成。
]

/** 宿主操作的条数。 */
export const FROZEN_OPERATION_COUNT = FROZEN_OPERATIONS.length
