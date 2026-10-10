import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 「报告审核 / 本地审核」两个页签的稳定取值与键盘规则。
 *
 * 单独一个模块的理由：页签状态是**组件内的 `useState`**（不往 `module-store` 里放 ——
 * 那是侧栏模块的状态，一个模块内部的两页不该污染它），但"下一个页签是哪个"是个纯函数，
 * 可以脱开渲染直接测（左右方向键循环、Home / End 直达两端）。
 */

export const LOCAL_AUDIT_TABS = ['report', 'local'] as const
export type LocalAuditTab = typeof LOCAL_AUDIT_TABS[number]

export function localAuditTabLabel(tab: LocalAuditTab): string {
  return tab === 'local' ? zhCN.localAuditTab : zhCN.auditPageTitle
}

/** 左右方向键在两项之间循环；Home / End 直达两端；别的键不动。 */
export function nextTabKey(current: LocalAuditTab, key: string, tabs: readonly LocalAuditTab[] = LOCAL_AUDIT_TABS): LocalAuditTab {
  if (tabs.length === 0) return current
  const index = Math.max(0, tabs.indexOf(current))
  if (key === 'ArrowRight' || key === 'ArrowDown') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return tabs[(index - 1 + tabs.length) % tabs.length]
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  return current
}
