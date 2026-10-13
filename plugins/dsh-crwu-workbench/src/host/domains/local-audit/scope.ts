/**
 * 本地审核的**案例 scope**（协议 28）。
 *
 * 单独一个文件只有一件事要说清楚：案例内工具（`crwu_run_python_script` / `crwu_h3yun_file_get` …）
 * 判断"这条会话能用哪个案例目录"时，需要的**唯一**能力就是这个只读查询。
 *
 * 为什么不让 `audit/case-access.ts` 直接依赖 handoff 注册表的实现：案例门禁是安全边界，
 * 它应该只认识一个窄接口（"这条会话的案例目录是什么"），而不是认识 handoff 的创建、过期、
 * 清理与 IO。接口窄了，能改坏它的地方就少。
 */

export interface LocalAuditScope {
  handoffId: string
  /** Host 自己拼出来的临时快照目录（本地审核的信任域）。 */
  casePath: string
  claimedAt: number
}

export interface LocalAuditScopeRegistry {
  /** 这条会话当前的本地审核案例 scope；没有则 `undefined`。 */
  scopeOf(sessionId: string): LocalAuditScope | undefined
}
