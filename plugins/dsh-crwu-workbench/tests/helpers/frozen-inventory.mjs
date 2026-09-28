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
import { REQUIRED_AUDIT_TOOLS } from '../../src/host/tools/consts.ts'

/** 审核链路的必需 Tool：**逐字**照 `REQUIRED_AUDIT_TOOLS`（单一事实源在源码里）。 */
export const FROZEN_AUDIT_TOOLS = [...REQUIRED_AUDIT_TOOLS]

/** 必需 Tool 的条数（等于真实产物里注册进注册表的条数）。 */
export const FROZEN_AUDIT_TOOL_COUNT = FROZEN_AUDIT_TOOLS.length

/**
 * 宿主操作表：旧动态形态的 24 个 handler + 包形态新增/调整后的合计 29 个。
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
]

/** 宿主操作的条数。 */
export const FROZEN_OPERATION_COUNT = FROZEN_OPERATIONS.length
