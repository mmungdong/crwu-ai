import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 面板头部右侧那句问候。
 *
 * **数据来自环境自检**（`env.me.name`，钉钉 CLI 在同一次自检里取回本人姓名），所以这里只有
 * 纯函数、没有 store：用户口径（2026-09-22）「这个钉钉 cli 环境监测一遍就可以了，不需要每次
 * 切换页面都去调，本质就是从环境信息把这个人的信息拿到」。
 *
 * 拿不到姓名（没授权 / 没登录 / 命令没跑起来）时 `greetingLine` 返回**空串**：
 * 界面整句不展示，既不显示「晚上好，」这种半句，也不编造「同事」之类的占位。
 */

/**
 * 一天里的问候语（纯函数，按小时分档，可单测）。
 *
 * 分档按中国职场的习惯来：凌晨（0–5）/ 早上好（5–9）/ 上午好（9–11）/ 中午好（11–14）/
 * 下午好（14–18）/ 晚上好（18–24）。用户 2026-09-22 点名的就是「下午好 / 中午好」。
 */
export function greetingOf(hour: number): string {
  if (!Number.isFinite(hour)) return zhCN.greetingMorning
  const h = Math.floor(hour)
  if (h < 5) return zhCN.greetingNight
  if (h < 9) return zhCN.greetingMorning
  if (h < 11) return zhCN.greetingForenoon
  if (h < 14) return zhCN.greetingNoon
  if (h < 18) return zhCN.greetingAfternoon
  return zhCN.greetingEvening
}

/**
 * 头部右侧那一整句：`下午好，杨凡宾`。
 *
 * **姓名拿不到就返回空串**（整句不展示）—— 不显示「下午好，」这种半句，也不编造占位姓名。
 */
export function greetingLine(hour: number, name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return ''
  return `${greetingOf(hour)}，${trimmed}`
}
