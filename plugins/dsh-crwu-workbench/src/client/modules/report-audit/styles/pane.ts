/**
 * 报告审核页：列表工具条 / 表格 / 操作列 / AI 审核结果 / 空态 / 分页 / 滚动条。
 *
 * 这一页自己带一层 Workspace Surface（`.crwu-audit-surface`），嵌进内容区的"一张纸"里时
 * 描边由 shell 的 `.crwu-audit-page-paper > .crwu-audit-surface` 撤掉。
 */

export const REPORT_AUDIT_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   8. 表格
   ────────────────────────────────────────────────────────────────────
   列宽用固定布局 + 百分比，不是 auto：
   auto 布局下浏览器把多出来的宽度全给最宽的那一列 —— 实测 1920px 视口时「报告名称」涨到 696px、
   2560px 时涨到 1149px，而「操作」那列几乎没有变化，于是右边一直很挤（用户报的「撑不满/很挤」）。
   fixed 布局让整张表严格等于容器宽度、各列按这里的分工分配。
   min-width 是下限：视口太窄时宁可让面板横向滚动，也不要把某一列压到内容折断。
   （注意：这段注释在模板字符串里，**不能出现反引号**，否则会把样式文本截断。）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-table {
  width: 100%; min-width: 1040px;
  border-collapse: collapse; table-layout: fixed;
}
/* The table card is the local container for width decisions (panel width, not viewport). */
.crwu-audit-report-card {
  container-type: inline-size; container-name: crwu-audit-report;
  border: 1px solid var(--crwu-border); border-radius: 14px;
  background: var(--crwu-surface); box-shadow: var(--crwu-shadow-surface);
  overflow: hidden; min-width: 0;
}
.crwu-audit-report-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 16px 18px 10px; min-width: 0; }
.crwu-audit-report-heading { font-size: 15px; line-height: 22px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-report-meta { font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
.crwu-audit-report-card .crwu-audit-toolbar { margin: 0; padding: 0 18px 12px; }
.crwu-audit-report-list { padding: 0 18px 14px; }
/* Seven columns share the page width; identifiers and dates stay unwrapped.
   min-width is the intrinsic floor for the widest table. Narrower report containers drop it
   (see the container queries below) so controls wrap instead of forcing horizontal scroll. */
.crwu-audit-col-name { width: 16%; }
.crwu-audit-col-seq-no { width: 23%; }
.crwu-audit-col-risk { width: 6%; }
.crwu-audit-col-review { width: 10%; }
.crwu-audit-col-ai { width: 15%; }
.crwu-audit-col-modified { width: 14%; }
.crwu-audit-col-action { width: 16%; }
/* 表格自己横向滚动，而不是被卡片裁掉：表有 min-width，视口够窄时宁可滚动也不要把列切掉。 */
.crwu-audit-table-wrap { overflow-x: auto; }
.crwu-audit-th {
  text-align: left; font-weight: 500; height: 39px; padding: 0 12px; font-size: 12px;
  border-bottom: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle);
  color: var(--crwu-th-text);
  /* 表头不换行：否则窄列会把「人工复核」竖着拆成三行，列宽也会跟着被压成一团。 */
  white-space: nowrap;
}
.crwu-audit-tbody-row { height: 82px; }
.crwu-audit-td {
  padding: 12px; vertical-align: middle;
  border-bottom: 1px solid var(--crwu-border);
  overflow-wrap: anywhere;
}
/* 行悬停给一点点底：一屏十几行时，眼睛不容易串行（办公场景的刚需）。
   菜单开着的那一行停在与悬停同一档、略深一档的选中底上（见 §20 的 selected）。 */
.crwu-audit-tbody-row:hover .crwu-audit-td { background: var(--crwu-hover); }
/* 列宽是"分工"而不是"抢"：报告名列表头最宽并吸收剩余宽度，窄列一律不换行，
   否则流水号/时间会被从中间折断、几列挤成一团（用户报的「列挤在一起」）。 */
.crwu-audit-td-name { min-width: 240px; }
.crwu-audit-td-nowrap {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 「初审 · 审核中」这行必须待在一行里；底下的复核节点名才可以换行。 */
.crwu-audit-td-review { min-width: 112px; }
.crwu-audit-td-action { min-width: 232px; }
.crwu-audit-td-action .crwu-audit-btn { margin: 2px 4px 2px 0; }

/* 单元格内部的三层排版：主行（报告名 14px/600，最多两行）、次行（副名/状态）、
   等宽辅助行（hash / 流水号 / 时间）。hash 只是辅助信息，不抢视觉（12px / 更浅一档色）。 */
.crwu-audit-cell-title {
  font-size: 14px; font-weight: 600; line-height: 1.45; letter-spacing: -0.01em;
  color: var(--crwu-text-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.crwu-audit-cell-sub {
  margin-top: 4px; color: var(--crwu-text-secondary); font-size: 12px; line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-cell-nowrap { white-space: nowrap; }
.crwu-audit-cell-mono {
  margin-top: 5px; color: var(--crwu-text-hash);
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 1.4;
}

/* ── 列表工具条：搜索 + 刷新同属一行（刷新不再挂页面右上角）──────────────── */
.crwu-audit-toolbar { display: flex; align-items: center; gap: var(--crwu-space-2); margin: 0 0 var(--crwu-space-3); }
.crwu-audit-search {
  position: relative; display: inline-flex; align-items: center;
  width: 400px; max-width: 100%; flex: 0 1 auto; min-width: 0;
}
.crwu-audit-search .crwu-audit-input { width: 100%; }
.crwu-audit-search-glyph { display: inline-flex; align-items: center; color: var(--crwu-text-tertiary); }
.crwu-audit-search-clear { display: inline-flex; align-items: center; justify-content: center; }
.crwu-audit-search-action { display: inline-flex; align-items: center; }
/* The refresh control sits next to the 42px shared field; match it on desktop (the shared coarse
   min-height: 44px still wins on touch pointers). */
.crwu-audit-search-action .crwu-ui-btn { height: 42px; }
/* Search input, glyph and clear colour/fill/focus are owned by the shared TextInput family. */

/* ── 列表：表头 39px / 行 82px / 发丝分隔 / 只在行上 hover ─────────────────── */
.crwu-audit-table-wrap { overflow-x: auto; }
.crwu-audit-tbody-row { transition: background 120ms var(--crwu-ease); }
.crwu-audit-tbody-row-on .crwu-audit-td { background: var(--crwu-selected); }
/* 列宽是"分工"而不是"抢"：报告名列最宽并吸收剩余宽度，窄列一律不换行。 */
.crwu-audit-td-name { min-width: 220px; }
.crwu-audit-td-nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crwu-audit-td-review { min-width: 108px; }
.crwu-audit-td-action { min-width: 200px; }
.crwu-audit-td-action .crwu-audit-btn { margin: 0; }
/* 人工复核：主状态 13px + 处理节点 12px（两级字重与色阶都不同），间距 4px。
   **不新增任何业务枚举**：显示的还是氚云给的那两个字段，只是排版分开。 */
.crwu-audit-review-main { font-size: 13px; color: var(--crwu-text-body); white-space: nowrap; }

/* 流水号：13px 等宽；复制图标**只在悬停/聚焦时浮出**，不一直占位。 */
/* 风险等级：**扫描信息**，不是装饰 —— 6px 圆点 + 等级字母，没有底色、没有描边、不是彩色 Tag。 */
.crwu-audit-risk {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 500; color: var(--crwu-risk-text);
}
.crwu-audit-risk-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--crwu-risk-c); }
.crwu-audit-risk-dot-high { background: var(--crwu-risk-a); }
.crwu-audit-risk-dot-medium { background: var(--crwu-risk-b); }
.crwu-audit-risk-dot-low { background: var(--crwu-risk-c); }
.crwu-audit-risk-dot-ok { background: var(--crwu-risk-c); }

/* ── 操作列：一个主操作 + 小鲸鱼 + 必要时一个 •••，水平排列，永不纵向堆叠 ────── */
.crwu-audit-row-actions { display: flex; align-items: center; gap: var(--crwu-space-2); flex-wrap: nowrap; min-width: max-content; }
/* The row keeps its intrinsic width; a too-narrow table scrolls in the wrap instead of squeezing
   the whale / ••• into 25.8px slivers. */
.crwu-audit-row-actions > * { flex: none; }
/* 「审核中」不是可点的任务按钮：它只是主位上的一个状态（避免重复触发）。 */
.crwu-audit-progress-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: var(--crwu-radius-sm); border: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle); color: var(--crwu-text-secondary);
  font-size: 13px; font-weight: 500;
}
.crwu-audit-progress-chip::before {
  content: ''; width: 6px; height: 6px; border-radius: 999px;
  background: var(--crwu-brand); animation: crwu-audit-pulse 1.8s ease-in-out infinite;
}
@keyframes crwu-audit-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .crwu-audit-progress-chip::before { animation: none; } }
/* 小鲸鱼：与「刷新 / •••」**同一套中性底**（--crwu-control*），不是第二个实心按钮。 */
.crwu-audit-ai-row-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  cursor: pointer; vertical-align: middle;
  transition: background 110ms var(--crwu-ease), color 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-audit-ai-row-btn:hover { background: var(--crwu-control-hover); color: var(--crwu-interactive); transform: translateY(-1px); }
.crwu-audit-ai-row-btn:active { background: var(--crwu-control-active); transform: scale(0.94); }
.crwu-audit-ai-row-btn:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-audit-ai-row-btn:disabled { opacity: 0.5; cursor: default; }
.crwu-audit-ai-row-btn-on { background: var(--crwu-control-hover); color: var(--crwu-interactive); }
/* •••：与刷新 / 小鲸鱼**同一套中性底**；菜单打开时换到 active 那一格
   （不再有"实心反色"或"完全透明"这两种被用户指出不一致的形态）。 */
.crwu-audit-menu {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 15px; line-height: 1; letter-spacing: 1px; cursor: pointer;
  transition: background 110ms var(--crwu-ease), color 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-audit-menu:hover { background: var(--crwu-control-hover); color: var(--crwu-interactive); }
.crwu-audit-menu:active { background: var(--crwu-control-active); transform: scale(0.94); }
.crwu-audit-menu:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-audit-menu-open, .crwu-audit-menu-open:hover { background: var(--crwu-control-active); color: var(--crwu-interactive); }

/* ── AI 审核结果：默认只给数量，悬停/聚焦信息图标再展开交付件明细 ── */
.crwu-audit-result-files { display: inline-flex; align-items: center; gap: 7px; }
.crwu-audit-result-count { font-size: 13px; color: var(--crwu-text-secondary); white-space: nowrap; }
.crwu-audit-result-empty {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
  border: 1px solid var(--crwu-border); border-radius: 999px;
  background: var(--crwu-surface-subtle); color: var(--crwu-text-tertiary);
  font-size: 12px; line-height: 1;
}
.crwu-audit-result-info {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border: 1px solid var(--crwu-border);
  border-radius: 999px; background: transparent; color: var(--crwu-text-secondary); font-size: 12px; font-weight: 600;
  padding: 0;
  cursor: help; outline: none;
}
/* 18px 的视觉对表格密度是对的，但命中区太小：用一层不可见 ::after 往外扩到 44×44。 */
.crwu-audit-result-info::after { content: ''; position: absolute; inset: -13px; }
.crwu-audit-result-info:hover, .crwu-audit-result-info:focus-visible { color: var(--crwu-interactive); border-color: var(--crwu-interactive); }
.crwu-audit-result-info:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-audit-result-loading { display: inline-flex; align-items: center; height: 22px; color: var(--crwu-text-tertiary); }
.crwu-audit-result-spinner {
  width: 14px; height: 14px; border: 2px solid var(--crwu-border);
  border-top-color: var(--crwu-brand); border-radius: 999px; animation: crwu-audit-spin 0.8s linear infinite;
}
@keyframes crwu-audit-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .crwu-audit-result-spinner { animation: none; } }

/* ── 空态：一行主文案 + 一行轻量说明，不画插画、不留表格骨架 ──────────────── */
.crwu-audit-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; min-height: 220px; padding: 48px 16px; text-align: center;
  color: var(--crwu-text-secondary); font-size: 13px;
}
.crwu-audit-empty-hint { color: var(--crwu-text-tertiary); font-size: 12.5px; }

/* ── 分页：‹ 页码 › + 跳至 [n] 页（总数已经在页签上，不再重复「共 N 条」）────── */
.crwu-audit-pager {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: var(--crwu-space-4) 0 var(--crwu-space-1);
  font-size: 12px; color: var(--crwu-text-secondary);
}
/* Layout only: the shared text/soft button variants own colour, hover and disabled. */
.crwu-audit-pager-nav, .crwu-audit-pager-page {
  box-sizing: border-box; min-width: 28px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; cursor: pointer; font-variant-numeric: tabular-nums;
}
.crwu-audit-pager-nav { font-size: 14px; line-height: 1; }
.crwu-audit-pager-nav:disabled, .crwu-audit-pager-page:disabled { cursor: not-allowed; }
/* Active page: solid blue with paired white text. */
.crwu-audit-pager-page.crwu-audit-pager-page-on {
  background: var(--crwu-interactive); color: var(--crwu-primary-text); font-weight: 600;
}
.crwu-audit-pager-gap { padding: 0 2px; color: var(--crwu-text-tertiary); }
.crwu-audit-pager-jump {
  display: inline-flex; align-items: center; gap: 6px;
  margin-left: var(--crwu-space-2); white-space: nowrap;
}
.crwu-audit-pager-jump .crwu-audit-muted { white-space: nowrap; }
/* Jump field: compact fixed wrapper; owning ancestor beats the shared width:100% (equal specificity). */
.crwu-audit-pager-jump .crwu-audit-pager-jump-input { box-sizing: border-box; width: 60px; flex: none; }
.crwu-audit-pager-jump .crwu-audit-pager-jump-input .crwu-ui-input { width: 100%; text-align: center; }

/* ── 滚动条美化（报告审核正文的横向 + 纵向）────────────────────────────────
   走 DSH 自带的滚动条 token（--dsh-scrollbar-thumb 由侧栏那种容器注入，
   取不到时退回 --dsw-alias-scrollbar-bg-l2），所以一样跟着主题走、深浅都成立。 */
/* ⚠️ 这里**故意不写** scrollbar-width / scrollbar-color（2026-10-11 无头实测后去掉）：
   Chromium 里只要设了这两个标准属性，下面的 ::-webkit-scrollbar 规则就**整段失效**，
   滚动条退回**平台样式** —— macOS 默认是 overlay（不滚就不画），于是用户看到的就是
   「滚动条没了」（内容其实滚得动）。两套都写等于白写：本插件只跑在 Chromium 里，
   所以留 ::-webkit-scrollbar（10px、始终画出来、跟主题 token 走）。
   实测：带这两个属性时 offsetWidth - clientWidth = 0，去掉后 = 10。
   （这段注释在模板字符串里，**不能**出现反引号 —— 一个反引号就会把样式字符串截断。） */
.crwu-audit-pane-main { scrollbar-gutter: stable; }
/* 页面内容区是切换目录时**不重建**的那个滚动容器：留出滚动条槽位，避免出现/消失时正文横向跳动。 */
.crwu-audit-tab-panel { scrollbar-gutter: stable; }
.crwu-audit-pane-main::-webkit-scrollbar,
.crwu-audit-table-wrap::-webkit-scrollbar,
.crwu-audit-tab-panel::-webkit-scrollbar { width: 10px; height: 10px; }
.crwu-audit-pane-main::-webkit-scrollbar-track,
.crwu-audit-table-wrap::-webkit-scrollbar-track,
.crwu-audit-tab-panel::-webkit-scrollbar-track { background: transparent; }
.crwu-audit-pane-main::-webkit-scrollbar-thumb,
.crwu-audit-table-wrap::-webkit-scrollbar-thumb,
.crwu-audit-tab-panel::-webkit-scrollbar-thumb {
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
  background-color: var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l2));
}
.crwu-audit-pane-main::-webkit-scrollbar-thumb:hover,
.crwu-audit-table-wrap::-webkit-scrollbar-thumb:hover,
.crwu-audit-tab-panel::-webkit-scrollbar-thumb:hover {
  background-color: var(--dsh-scrollbar-thumb-hover, var(--dsw-alias-scrollbar-hover-l2));
}
.crwu-audit-pane-main::-webkit-scrollbar-corner,
.crwu-audit-table-wrap::-webkit-scrollbar-corner { background: transparent; }

/* ── Current audit task card (outside the list, independent of search/paging) ───── */
.crwu-audit-current { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.crwu-audit-current-head { align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.crwu-audit-current-title { font-size: 13px; line-height: 20px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-current-id {
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere;
}
.crwu-audit-current-meta {
  margin-top: 2px; display: block; overflow: visible;
  white-space: normal; overflow-wrap: anywhere;
  -webkit-line-clamp: unset; -webkit-box-orient: initial;
}
.crwu-audit-current-controls { align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.crwu-audit-current-controls .crwu-ui-btn { flex: 0 0 auto; }

/* Fluid seven-column table before the card breakpoint: keep controls usable by wrapping. */
@container crwu-audit-report (max-width: 1180px) {
  .crwu-audit-table { min-width: 0; }
  .crwu-audit-col-name { width: 19%; }
  .crwu-audit-col-seq-no { width: 20%; }
  .crwu-audit-col-risk { width: 7%; }
  .crwu-audit-col-review { width: 12%; }
  .crwu-audit-col-ai { width: 14%; }
  .crwu-audit-col-modified { width: 14%; }
  .crwu-audit-col-action { width: 14%; }
  .crwu-audit-td-name, .crwu-audit-td-review, .crwu-audit-td-action { min-width: 0; }
  .crwu-audit-row-actions { flex-wrap: wrap; min-width: 0; justify-content: flex-end; }
}

/* Narrow panels become per-report cards: no 1200px table forcing horizontal scroll. */
@container crwu-audit-report (max-width: 760px) {
  .crwu-audit-report-head { padding: 14px 14px 8px; }
  .crwu-audit-report-card .crwu-audit-toolbar { padding: 0 14px 10px; flex-wrap: wrap; }
  .crwu-audit-report-list { padding: 0 14px 12px; }
  .crwu-audit-table-wrap { overflow: visible; }
  .crwu-audit-table { display: block; min-width: 0; }
  .crwu-audit-table colgroup, .crwu-audit-table thead { display: none; }
  .crwu-audit-table tbody { display: grid; gap: 10px; }
  .crwu-audit-tbody-row {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px; height: auto; padding: 12px;
    border: 1px solid var(--crwu-border); border-radius: 10px;
    background: var(--crwu-surface);
  }
  .crwu-audit-tbody-row:hover .crwu-audit-td { background: transparent; }
  .crwu-audit-td {
    display: block; min-width: 0; padding: 0; border: 0;
    white-space: normal; overflow: visible; overflow-wrap: anywhere;
  }
  .crwu-audit-td::before {
    content: attr(data-label); display: block; margin-bottom: 2px;
    font-size: 11px; line-height: 15px; color: var(--crwu-text-tertiary);
  }
  .crwu-audit-td-name, .crwu-audit-td-action { grid-column: 1 / -1; }
  .crwu-audit-td-name::before, .crwu-audit-td-action::before { display: none; }
  .crwu-audit-td-action {
    padding-top: 8px; margin-top: 2px; border-top: 1px solid var(--crwu-border);
  }
  .crwu-audit-row-actions { flex-wrap: wrap; min-width: 0; justify-content: flex-start; }
  .crwu-audit-cell-title { font-size: 13px; }
  .crwu-audit-pager { padding-bottom: 5px; }
}

/* ── Audit info drawer: quieter rhythm for the existing real content ───────────── */
.crwu-audit-drawer .crwu-audit-km { padding: 16px; border-radius: 12px; }
.crwu-audit-drawer .crwu-audit-sec { margin-top: 20px; }
.crwu-audit-drawer .crwu-audit-sec-title { font-size: 13px; }
.crwu-audit-drawer .crwu-audit-fold-head { height: 42px; }
.crwu-audit-drawer .crwu-audit-kv { grid-template-columns: 132px 1fr; gap: 8px 12px; }
.crwu-audit-drawer .crwu-audit-issue-row { padding-left: 0; padding-right: 0; }
`
