/**
 * 两级目录（一级 = 业务大类，二级 = 该业务下的功能页面）。
 *
 * ⚠️ 这些规则**属于 shell**：一级 / 二级目录不是本地审核模块的私有控件，评估页、
 * 审核页、以后新增的业务页共用同一条目录条。它们以前长在本地审核的样式文本里，
 * 结果是"本地审核模块改了页签样式，别的模块跟着变"。
 *
 * 一级目录：44px 命中高度 + 选中项底部 3px 强调线（形状本身就区分得出来，不只靠颜色）。
 * 二级目录：更小一号的浅色胶囊，子项多时横向滚动。
 */

export const CRWU_NAVIGATION_STYLE_TEXT = `
/* ── 两级目录（一级 = 业务大类，二级 = 该业务下的功能页面）───────────────────
   一级目录沿用既有报告审核页那套页签形态（.crwu-audit-tablist / .crwu-audit-tab：
   44px 命中高度 + 选中项底部 3px 强调线，样式在 §23 里）——需求原话就是"整体交互参考
   现有报告审核页面"。这里只加二级目录那一条：更小一号的浅色胶囊，子项多时横向滚动。 */
.crwu-audit-nav { flex: none; padding: 4px var(--crwu-pad-x) 0; }
.crwu-audit-nav-children {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 0 12px; overflow-x: auto; overflow-y: hidden;
}
.crwu-audit-nav-children::-webkit-scrollbar { height: 0; }
.crwu-audit-nav-child {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  box-sizing: border-box; height: 30px; padding: 0 12px;
  border: 1px solid transparent; border-radius: 999px;
  background: transparent; color: var(--crwu-text-secondary);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1;
  white-space: nowrap; cursor: pointer;
  transition: background 160ms var(--crwu-ease), color 160ms var(--crwu-ease);
}
.crwu-audit-nav-child:hover { background: var(--crwu-control); color: var(--crwu-text-primary); }
.crwu-audit-nav-child:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: -2px; }
/* 选中：浅蓝底 + 操作蓝描边 + 加粗 —— 形状与字重一起变，不只靠颜色表达状态。 */
.crwu-audit-nav-child-on,
.crwu-audit-nav-child-on:hover {
  background: var(--crwu-interactive-soft); border-color: var(--crwu-interactive);
  color: var(--crwu-text-primary); font-weight: 600;
}
/* 开发中：灰态、不可进入（disabled 属性另外挡住点击）。 */
.crwu-audit-nav-child-off { color: var(--crwu-text-hash); cursor: default; }
.crwu-audit-nav-child-off:hover { background: transparent; color: var(--crwu-text-hash); }
.crwu-audit-nav-child-tag { font-size: 11px; font-weight: 400; opacity: .85; }

/* 一级目录下没有可用页面时的正文（不空白、也不假装有内容）。 */
.crwu-audit-nav-empty {
  display: flex; align-items: center; justify-content: center;
  min-height: 220px; color: var(--crwu-text-secondary); font-size: 14px;
}

/* 页面标题区：标题来自**导航元数据**（估值 / 房地产 → 「房地产估值」），随二级目录变化。
   它长在页面内容区里，所以切换目录时高度由内容决定，容器本身（.crwu-audit-tab-panel）不变。 */
.crwu-audit-nav-page-head { flex: none; padding: var(--crwu-space-2) 0 var(--crwu-space-4); }
.crwu-audit-nav-page-title {
  margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em;
  color: var(--crwu-text-primary);
}
.crwu-audit-nav-page-lead { margin: 6px 0 0; font-size: 13px; color: var(--crwu-text-secondary); }
.crwu-audit-nav-page-note { margin: 2px 0 0; font-size: 12px; color: var(--crwu-text-secondary); opacity: .8; }
.crwu-audit-tablist { display: flex; align-items: flex-end; gap: var(--crwu-space-1); }
.crwu-audit-tab {
  position: relative; box-sizing: border-box;
  padding: 0 var(--crwu-space-4); height: 44px;
  border: 0; border-radius: var(--crwu-radius-sm);
  background: transparent; color: var(--crwu-text-secondary);
  font-family: inherit; font-size: 14px; font-weight: 500; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background 160ms var(--crwu-ease), color 160ms var(--crwu-ease);
}
/* 底部强调线：未选中透明（占位但不画），选中才着色 —— 切换时不会因为插入元素而跳动。 */
.crwu-audit-tab::after {
  content: ''; position: absolute; left: var(--crwu-space-3); right: var(--crwu-space-3); bottom: 0;
  height: 3px; border-radius: 3px 3px 0 0; background: transparent;
  transition: background 200ms var(--crwu-ease);
}
.crwu-audit-tab:hover { background: var(--crwu-control); color: var(--crwu-text-primary); }
.crwu-audit-tab:active { background: var(--crwu-control-active); }
.crwu-audit-tab:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: -2px; }
.crwu-audit-tab-on,
.crwu-audit-tab-on:hover {
  background: transparent; color: var(--crwu-text-primary); font-weight: 600;
}
.crwu-audit-tab-on::after { background: var(--crwu-interactive); }
`
