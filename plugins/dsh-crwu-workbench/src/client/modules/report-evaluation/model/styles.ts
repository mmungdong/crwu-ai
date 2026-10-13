/**
 * 报告评估（房地产估值，协议 32）的**稳定类名**。
 *
 * 与本地审核同一条口径：类名常量留在模块的 model / consts 里（组件与测试共用），
 * 样式文本跟着所有者走 —— 见 `../styles/pane.ts`。
 */

/** 类名（组件与测试共用；改样式时两边一起改）。 */
export const VALUATION_CLASSES = {
  pane: 'crwu-valuation',
  drawer: 'crwu-valuation-drawer',
  drawerActions: 'crwu-valuation-drawer-actions',
  methodOn: 'crwu-valuation-method-on',
  btnPrimary: 'crwu-valuation-btn-primary',
} as const
