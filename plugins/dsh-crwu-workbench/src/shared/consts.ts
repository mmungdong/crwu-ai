/** Host 与 Client 共用的同源工作台端点。 */
export const WORKBENCH_ROUTE = '/api/crwu-workbench'

/**
 * 宿主插件与客户端产物的**协议代数**。
 *
 * 两侧是**分开加载**的：客户端产物随页面刷新就换新，宿主产物只有重启 profile 才会换。
 * 于是很容易出现「界面是新的、逻辑是旧的」——审核挂错会话那次就是这么来的（用户看到新按钮、
 * 跑的是老代码，报障说「还是挂错位置」）。
 *
 * 规则：**每次改动跨进程契约（Host 操作的字段/语义、审核父级这类关键行为）就把这里 +1**，
 * `ping` / `boot` 会带上它；客户端发现不一致就明说「宿主是旧构建，请重启 profile」并停发起审核，
 * 而不是拿旧逻辑干新活。
 */
export const WORKBENCH_PROTOCOL = 5

/**
 * 报告流水号（SeqNo）的形状：`2026-301705-LX10170-BG8746`。
 *
 * 为什么放共享常量：Host 拿它当**安全边界**（流水号会被拼进 OSS 路径，不校验的话 `../` 能越出
 * 配置前缀），Client 拿它做即时校验（不合形状就不发请求、直接给人话提示）。两边各写一份正则
 * 必然漂移，所以只此一份。
 *
 * 规则：`<4 位年>-<数字>-<字母数字与 ._- >`；**不含 `/`**、**不含 `..`**、长度 ≤ 128。
 */
export const SEQ_NO_PATTERN = /^\d{4}-\d+-[0-9A-Za-z][0-9A-Za-z._-]*$/
export const SEQ_NO_MAX_LENGTH = 128

/** 这个流水号能不能安全地当作 OSS 路径的一段（Host 与 Client 同一个判据）。 */
export function isSafeSeqNo(value: string): boolean {
  const raw = value.trim()
  return raw !== '' && raw.length <= SEQ_NO_MAX_LENGTH && SEQ_NO_PATTERN.test(raw) && !raw.includes('..')
}
