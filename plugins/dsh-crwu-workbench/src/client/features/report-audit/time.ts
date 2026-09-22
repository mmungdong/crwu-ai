/**
 * 业务时间的**唯一**格式化入口。
 *
 * 用户口径（2026-09-23，逐条）：
 * - 「这是资产评估审核、复核和交付留痕系统……如果省略年份，非常容易造成误判」；
 * - 禁止相对时间：`今天` / `昨天` / `09-20 18:15` / `3 天前`；
 * - 有时间的写 `YYYY-MM-DD HH:mm`，只有日期的写 `YYYY-MM-DD`，默认不显示秒；
 * - 完整原值（含秒与 ±HH:mm 偏移）留在 `title` 或技术详情里。
 *
 * 唯一的例外是 DeepSeek Harness 侧栏的**会话活跃时间**（那表达的是活跃程度，不是业务留痕），
 * 它不经过本模块。
 *
 * ## 两条实现取舍（都不是随手写的）
 *
 * 1. **不做时区换算**：`auditTime` 这类字段是引擎按**当地时间**写进 JSON 的墙钟值。
 *    把它当 UTC 再转本地，会让 `2026-09-20T17:40:00+0800` 在别的时区变成另一天 —— 审计留痕宁可
 *    显示"记录里写的那一刻"，也不要显示"换算后的另一刻"。所以这里只**取字面量**，offset 原样留在
 *    原始值里（`title` / 技术详情）。
 * 2. **认不出的形状原样返回**，不猜、不补零、不取子串。外部数据改形状时界面显示原值，
 *    而不是显示一个看起来正确的错时间。
 */

/** 墙钟时间的识别：`YYYY-MM-DD`，可选 `T`/空格 + `HH:mm[:ss[.sss]]`，可选 `Z`/`±HH:mm`/`±HHmm`。 */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

interface Stamp {
  day: string
  clock: string
}

/** 拆出「日期 + 时刻」两个字面量；认不出返回 null（调用方原样展示）。 */
export function parseStamp(value: string): Stamp | null {
  const matched = STAMP.exec(value.trim())
  if (matched === null) return null
  const [, year, month, day, hour, minute] = matched
  return {
    day: `${year}-${month}-${day}`,
    clock: hour === undefined || minute === undefined ? '' : `${hour}:${minute}`,
  }
}

/** 只有日期：`YYYY-MM-DD`。带时刻的也只取日期；认不出原样返回。 */
export function formatDate(value: string): string {
  const stamp = parseStamp(value)
  return stamp === null ? value : stamp.day
}

/**
 * 业务日期时间：`YYYY-MM-DD HH:mm`。
 *
 * 只有日期时给 `YYYY-MM-DD`（不补 `00:00` —— 那会凭空造出一个不存在的时刻）。
 */
export function formatDateTime(value: string): string {
  const stamp = parseStamp(value)
  if (stamp === null) return value
  return stamp.clock === '' ? stamp.day : `${stamp.day} ${stamp.clock}`
}

/** 值是不是"认得出来的时间"（用于决定要不要挂 title / 走格式化）。 */
export function isStamp(value: string): boolean {
  return parseStamp(value) !== null
}

/**
 * 把业务时间折算成**可比数值**（只用于"谁更晚"这类比较，不用于展示）。
 *
 * 与展示口径一致：取字面量的墙钟值，不做时区换算 —— 拿本地时区去解释一个已经带偏移的串，
 * 会在跨时区时把先后顺序判反。认不出的形状返回 null（调用方据此走"判别不了"的分支）。
 */
export function stampValue(value: string): number | null {
  const stamp = parseStamp(value)
  if (stamp === null) return null
  const [year, month, day] = stamp.day.split('-').map((part) => Number(part))
  const [hour, minute] = stamp.clock === '' ? [0, 0] : stamp.clock.split(':').map((part) => Number(part))
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}
