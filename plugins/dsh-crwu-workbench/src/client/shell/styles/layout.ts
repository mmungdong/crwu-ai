/**
 * Workbench panel layout: app background -> Workspace Surface -> content, and scroll ownership.
 *
 * 滚动归属这一条是必须的，不是样式偏好：DSH 的主内容列（centerCol）是
 * `display:flex + overflow:hidden + height:100vh`，它**不滚动**，而是把滚动交给面板。
 * The tab panel (`.crwu-audit-tab-panel`) is the scrolling container for the audit page, so
 * directory switches keep a stable width/height and the tab row stays at the top. Valuation is the
 * exception: it is a fixed-height workface, the shell does not scroll, and scrolling belongs to the
 * workface body (see the `data-workbench-page` overrides).
 */

export const CRWU_LAYOUT_STYLE_TEXT = `
.crwu-audit-workspace-cleanup-entry {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;
  margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--crwu-border);
}
.crwu-audit-workspace-cleanup-hint {
  flex: 1 1 180px; min-width: 0; font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere;
}
/* ════════════════════════════════════════════════════════════════════
   20. Workspace Surface：报告审核页
   ────────────────────────────────────────────────────────────────────
   层级只有三层：**App 底（浅灰）→ Workspace Surface（白，14px 圆角 + 一层轻阴影）→ 内容**。
   它是"工作台里的一块纸"，不是 Dashboard 大卡：描边极浅、阴影极轻、半径克制。
   内容区只有一层框，框内靠发丝线与留白分格（不再嵌套 Card / Border / Header）。
   ──────────────────────────────────────────────────────────────────── */
[data-crwu-scope="workbench"].crwu-audit-root { background: var(--crwu-app-bg); color: var(--crwu-text-primary); }
.crwu-audit-body { padding: 0; overflow: hidden; }
.crwu-audit-header {
  height: 54px; padding: 0 var(--crwu-pad-x);
  background: var(--crwu-header-bg);
  border-bottom: 1px solid var(--crwu-border);
  -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
}

/* 环境信息（不是目录树里的一页）：自己一块，顶部那颗「返回工作台」只在环境已通过时给。
   Capped at the same width as the valuation workface and centered, so the back button and the
   cards below share one left edge. */
.crwu-audit-env-screen {
  box-sizing: border-box; flex: none; display: flex; flex-direction: column;
  gap: var(--crwu-space-3);
  width: 100%; max-width: 1120px; min-width: 0; margin-inline: auto;
}
.crwu-audit-surface {
  box-sizing: border-box; display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-xl);
  background: var(--crwu-surface); box-shadow: var(--crwu-shadow-surface);
}
.crwu-audit-page-head {
  flex: none; display: flex; align-items: center; gap: var(--crwu-space-3);
  min-height: 0; padding: var(--crwu-space-5) var(--crwu-pad-x) 0;
  background: transparent;
}
.crwu-audit-page-title {
  font-size: 24px; font-weight: 600; letter-spacing: -0.02em; line-height: 32px;
  color: var(--crwu-text-primary);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crwu-audit-page-meta { margin-left: auto; display: flex; align-items: center; gap: var(--crwu-space-2); }
/* 报告审核页自己那一行页头（工具条也在它下面）。 */
.crwu-audit-pane-head {
  flex: none; display: flex; align-items: center; gap: var(--crwu-space-3);
  /* 页签条：顶部 10px 起、左右与正文同一档 padding；**不画整条底边** ——
     选中态由页签自己的 3px 强调线表达，整条线会被误读成"内容框的上边"。 */
  padding: 10px var(--crwu-pad-x) 0; border-bottom: none;
}
/* 页面内容区：目录条下面那一块，**页面自己的滚动容器**（目录条在它外面，所以始终留在顶部）。
   ⚠️ 高度必须接下去：报告审核页自己的 .crwu-audit-surface 写的是 height: 100% ——
   父层没有确定高度时它会退化成 auto，.crwu-audit-pane-main 的 overflow: auto 就再也滚不起来
   （列表长的时候会被外层 overflow: hidden 直接裁掉）。
   （这段注释在模板字符串里，**不能**出现反引号 —— 一个反引号就会把样式字符串截断。） */
.crwu-audit-tab-panel {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  overflow: auto; padding: var(--crwu-space-3) var(--crwu-pad-x) var(--crwu-space-6);
}
/* 审核那两页（报告审核 / 本地审核）是"一张纸"：它们自带页头与内部滚动，
   所以在内容区里再给一层纸，页与页之间看起来是同一个容器。 */
.crwu-audit-page-paper {
  box-sizing: border-box; flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-xl);
  background: var(--crwu-surface); box-shadow: var(--crwu-shadow-surface);
}
/* Valuation is a fixed-height workface: the outer content area no longer scrolls (that would
   create two vertical scrollbars); scrolling belongs to the workface body only. The audit pages
   keep their existing scroll ownership. */
.crwu-audit-tab-panel[data-workbench-page="valuation"] { overflow: hidden; }
/* Valuation paper has **no padding of its own**: the workface is a fixed-height column whose
   body and footer own their insets. That is what lets the footer band reach the paper's own
   left / right / bottom edge (2026-10-16 user feedback: a white line under the band). Padding
   here would show up again as exactly that line, so keep it at 0 for the valuation page. */
.crwu-audit-page-paper[data-workbench-page="valuation"] { padding: 0; }
/* 纸里的子页面**只有一层框**：报告审核页自己也带一层 surface（它单独渲染时要用），
   在这里必须把那圈描边撤掉 —— 否则它正好落在页头下面，看起来就是"多了一条横线"
   （2026-10-11 用户实测反馈；样式判据见 client-local-audit 的结构用例）。 */
.crwu-audit-page-paper > .crwu-audit-surface {
  flex: 1 1 auto; min-height: 0; height: auto;
  border: 0; border-radius: 0; box-shadow: none;
}
.crwu-audit-pane-body { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; }
.crwu-audit-pane-main {
  position: relative; flex: 1 1 auto; min-width: 0; overflow: auto;
  padding: var(--crwu-space-4) var(--crwu-pad-x) var(--crwu-space-6);
}
`
