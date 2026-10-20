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
import { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_CHILD_TOOLS, REQUIRED_AUDIT_TOOLS } from '../../src/host/tools/report-audit/consts.ts'

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
 * 宿主操作表：旧动态形态的 24 个 handler + 包形态新增/调整后的合计 52 个。
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
  // 第 40~42 个：**本地审核**（协议 28）。选本机文件 → 扫描 → 建一次性快照与 handoff →
  // 在对话里认领。它**不判环境门禁**（本地审核的意义就是不需要氚云 / OSS / 工作空间），
  // 唯一的前置是本机访问授权（由 Broker 的操作表判）。
  'local-audit-status', 'local-audit-start', 'local-audit-claim',
  // 第 43~47 个：**报告评估（房地产估值）**（协议 32 → 35）。本机选择扫描 / 归档预览
  // （建目录 + 按字节复制 + 清单 + 确认摘要）/ 外部来源门禁预检 / 人工登录的启动与取消 /
  // 冻结快照并交接父会话。落点一律走统一会话服务（`workspaceId`），没有 `cwd` 兜底。
  //
  // ⚠️ 协议 35（2026-10-14，计划 Task 4）**删掉**了四条运行期操作：
  // `valuation-status` / `valuation-result` / `valuation-open-artifact` / `valuation-cancel`
  // —— 面板完成度轮询整体下线，页面在交接成功后直接跳进**顶层父会话**，不再追踪会话完成度。
  // 同时**加入**门禁登录两条。输入侧的取消（若将来需要）必须叫 `intake-cancel`，
  // **不沿用**运行期那个 `valuation-cancel` 名字：它们是两件事（取消一次资料归档准备
  // vs 取消一轮正在跑的估值）。
  'valuation-files-scan', 'valuation-intake', 'valuation-browser-preflight', 'valuation-start',
  'valuation-browser-login', 'valuation-browser-login-cancel',
  // 协议 37（2026-10-14）新增：**打开验证窗口**。员工已登录、受保护页要人机验证时，Host 按
  // `siteId` 复用**同一个**浏览器 profile 重开那一页（Client 提交不了 URL / profile / 命令）。
  // 旧宿主没有它，新界面点「打开验证窗口」只会 404 —— 而"能不能过掉验证"正是员工唯一的出路。
  'valuation-browser-open-verification',
  // P18（2026-10-15）新增：**项目归属的显式恢复** `valuation-project-resume`。插件实例重建
  // （进程重启 / 插件重载）之后，估值的案例归属（进程内注册表）整体丢失，同一条父会话再也拿不到
  // 自己那一份案例目录。恢复只接受 `projectId`，由 Host 从已选工作空间派生目录，并逐项核对
  // 授权收据 / 工作区 / 协议代 / 冻结输入 / 材料字节 / 会话归属；核不过一律拒绝。
  // 客户端由 `src/client/modules/report-evaluation/api.ts` 的 `VALUATION_OPERATION_OF` 登记
  // （不再走审核门面的 `OPERATION_OF`）；冻结操作对账时两份清单合并核对。
  'valuation-project-resume',
  // Protocol 43: the native graph panel operations are part of the same frozen inventory.
  'valuation-workflow-current', 'valuation-workflow-node', 'valuation-workflow-action',
  'valuation-workflow-preview', 'valuation-workflow-cancel', 'valuation-workflow-export',
  'valuation-workflow-load', 'valuation-workflow-clear', 'valuation-workflow-reconcile',
  'valuation-workflow-open-artifact',
  // 第 43~45 个：**钉钉设备流登录**（协议 32，2026-10-13）。用户口径是"loopback 回调不通 /
  // 无头环境"时要有退路：`dws auth login --device` 会打印短 URL 与授权码再等人授权，
  // 同步等它跑完（最多 5 分钟）面板拿不到码，所以必须拆成 start / status / cancel 三条。
  'dws-login-device-start', 'dws-login-device-status', 'dws-login-device-cancel',
  // 第 46 个：**取消正在跑的 loopback 登录**（协议 32）。login 最长要等人 5 分钟，两条路又抢同一把
  // `.dws` 锁 —— 没有这条，员工点了「登录钉钉」之后就没有任何出路（实测按钮一直是灰的）。
  'dws-login-cancel',
  // 第 65~66 个：**清空工作空间**（协议 49，2026-10-20）。`plan` 只读扫描并产出一份
  // 带指纹的内存计划；`apply` 带 planId + 指纹 + 目录名执行（停止并归档会话、可选删日志、
  // 删根下全部直接子项、清审核历史）。旧宿主没有它们，新界面点下去只会 404。
  'workspace-cleanup-plan', 'workspace-cleanup-apply',
  // ⚠️ 协议 22（2026-09-30）**删掉**了 `browser-session-bind`（氚云内置浏览器扫码，协议 20）
  // 与 `dws-login-start` / `dws-login-status`（钉钉设备码 / 两阶段登录，协议 21）。
  // 协议 32 只恢复了**设备流**这一半，而且是新名字：loopback 的同步 `dws-login` 语义未变，
  // 氚云的内置浏览器扫码没有回来。
]

/** 宿主操作的条数。 */
export const FROZEN_OPERATION_COUNT = FROZEN_OPERATIONS.length
