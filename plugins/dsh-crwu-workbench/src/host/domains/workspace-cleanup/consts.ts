/**
 * 清理工作空间的预算与窗口。
 *
 * `SIZE_ENTRY_BUDGET` 只按**条目数**、不按时间：时间预算会让两次扫描得出不同的大小，
 * 而大小参与界面展示（指纹刻意不含它，见 `plan.ts`）。
 */
export const WORKSPACE_CLEANUP_SIZE_ENTRY_BUDGET = 50_000

/** 计划在内存里最多活 5 分钟（确认框开着太久，内容早就变了）。 */
export const WORKSPACE_CLEANUP_PLAN_TTL_MS = 300_000

/** 中止时回给界面的剩余项名字上限（计数仍完整）。 */
export const WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT = 50

/** 归档后等待会话静止的上限与轮询间隔。 */
export const WORKSPACE_CLEANUP_SESSION_WAIT_MS = 30_000
export const WORKSPACE_CLEANUP_SESSION_POLL_MS = 250
