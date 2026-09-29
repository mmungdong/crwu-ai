import type { EnvResult } from '../report-audit/api.ts'

/**
 * 平台相关的**提醒**（纯函数，可单测）。
 *
 * ## 为什么 Windows 要提醒"用管理员身份运行"
 *
 * 钉钉 CLI（`dws`）在登录、读登录态、拉知识库时都要碰 `<HOME>\\.dws`：它先抢
 * `<HOME>\\.dws\\.data.lock`，再把登录态写进操作系统凭据存储（2026-09-29 员工机上实测的原始报错
 * 就是 `acquiring file lock: …\\.dws\\.data.lock: Access is denied.`）。这些位置与文件锁在
 * Windows 上对普通权限的进程并不总是可写 —— 进程没有足够权限时，`dws` 会以"锁被占用 / 拒绝访问"
 * 结束，表现却是**钉钉登录一直不成功**，员工只会去反复点登录。
 *
 * 所以这里在**平台是 Windows** 时给一条**非阻塞**提醒（用户口径 2026-09-30）：
 * 以管理员身份运行 DeepSeek Harness。它不改任何门禁判据 —— 钉钉登录态本身是不是有效，
 * 仍然由环境自检的探测结论说了算（见 `features/environment/steps.ts` 与 `status.ts`）。
 */

/** 平台是 Windows 吗（`env.platform` 形如 `win32-x64`；拿不到平台时按"不是"处理）。 */
export function isWindowsPlatform(platform: string): boolean {
  return /^win32/i.test(platform.trim())
}

/** 要不要显示"请以管理员身份运行 DeepSeek Harness"这条提醒。 */
export function needsWindowsAdminReminder(env: EnvResult | null | undefined): boolean {
  return isWindowsPlatform(String(env?.platform ?? ''))
}
