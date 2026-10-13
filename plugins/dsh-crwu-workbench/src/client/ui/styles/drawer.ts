/**
 * 共享 UI：右侧抽屉（外壳 + 内容体 + 键值表）。
 *
 * 抽屉是 `position: fixed` 浮层：本仓不引 react-dom，定位由 `position: fixed` 自己保证
 *（祖先里没有 transform / filter 就不会被拽偏）。
 */

export const CRWU_DRAWER_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   17. 「审核信息」右侧抽屉
   ────────────────────────────────────────────────────────────────────
   固定定位贴着视口右侧：抽屉属于「页面级」的临时面板，不该被面板自己的滚动容器裁掉。
   z-index 要高过面板内容，遮罩再低一层。

   用户 2026-09-23 口径：
   - 宽度 520–560（**不再加宽**），浅深两套色板都复用工作台 token，不在抽屉里另立一套；
   - 遮罩只 rgba(0,0,0,.32) + blur(2px)：关闭之后用户还要看得出自己是**从哪一行**打开的；
   - 开：translateX(20px) → 0 / opacity .85 → 1（200ms）；关：150ms，由父层延迟卸载（见 WorkbenchPanel）。
   ──────────────────────────────────────────────────────────────────── */
[data-crwu-scope="workbench"].crwu-audit-side-drawer-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: var(--crwu-scrim);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  animation: crwu-audit-scrim-in 160ms var(--crwu-ease) both;
}
[data-crwu-scope="workbench"].crwu-audit-side-drawer-backdrop-out { animation: crwu-audit-scrim-out 150ms var(--crwu-ease) both; }
@keyframes crwu-audit-scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes crwu-audit-scrim-out { from { opacity: 1; } to { opacity: 0; } }
[data-crwu-scope="workbench"].crwu-audit-side-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 901;
  box-sizing: border-box; width: min(var(--crwu-drawer-w), 92vw); max-width: var(--crwu-drawer-w);
  display: flex; flex-direction: column;
  background: var(--crwu-surface);
  border-left: 1px solid var(--crwu-border);
  box-shadow: none;
  animation: crwu-audit-drawer-in 200ms var(--crwu-ease) both;
}
[data-crwu-scope="workbench"].crwu-audit-side-drawer-out { animation: crwu-audit-drawer-out 150ms var(--crwu-ease) both; pointer-events: none; }
@keyframes crwu-audit-drawer-in {
  from { transform: translateX(20px); opacity: 0.85; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes crwu-audit-drawer-out {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(16px); opacity: 0.9; }
}
@media (prefers-reduced-motion: reduce) {
  /* 这四个类都长在**作用域节点自身**上：选择器必须写成"作用域在自身上"。
     写成后代形式（作用域前缀 + 类名）永远不命中 —— 需要这条规则的用户反而还会看到动画。
     （注意：本文件是 CSS-in-TS 模板字符串，注释里**不能**出现反引号。） */
  [data-crwu-scope="workbench"].crwu-audit-side-drawer,
  [data-crwu-scope="workbench"].crwu-audit-side-drawer-out,
  [data-crwu-scope="workbench"].crwu-audit-side-drawer-backdrop,
  [data-crwu-scope="workbench"].crwu-audit-side-drawer-backdrop-out { animation: none; }
}
@keyframes crwu-audit-rise {
  from { transform: translateY(8px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
/* 头部：标题 16/600 + 下面一行等宽流水号 + 右侧 ×（不再有「关闭」文字按钮）。 */
.crwu-audit-side-drawer-head {
  flex: none; display: flex; align-items: flex-start; gap: 12px;
  padding: 16px 16px 12px 20px;
  background: var(--crwu-surface);
  border-bottom: 1px solid var(--crwu-border);
}
.crwu-audit-side-drawer-title {
  margin-right: auto; min-width: 0;
  display: flex; flex-direction: column; gap: 3px;
  font-size: 16px; font-weight: 600; line-height: 22px; color: var(--crwu-text-primary);
}
.crwu-audit-side-drawer-sub {
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 16px;
  color: var(--crwu-text-tertiary);
  overflow-wrap: anywhere;
}
/* × ：透明底 + 悬停一层中性底，32×32（用户口径：删除「关闭」文字按钮，改成标准 Icon Button）。 */
.crwu-audit-side-drawer-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: transparent; color: var(--crwu-control-text);
  font-family: inherit; font-size: 18px; line-height: 1; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-side-drawer-close:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-side-drawer-close:active { background: var(--crwu-control-active); }
.crwu-audit-side-drawer-close:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-side-drawer-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 20px 20px 28px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l2)) transparent;
}

/* ── Drawer 内容：核心指标 → 已提未改 → AI 问题列表 → 报告信息 → 技术详情 ──────
   2026-09-23 第二轮：抽屉的定位是「AI 审核质量与问题摘要」，不是「审核状态详情」。
   所以第一屏没有结论大卡，最大的字是**复核命中率**，下面是两个同级小指标（AI 检出 / 已提未改），
   然后直接进问题清单。主要靠 Spacing 分层（小节间距 24、内容间距 10–12）。 */
.crwu-audit-sec { margin-top: var(--crwu-space-6); }
.crwu-audit-sec:first-child { margin-top: 0; }
.crwu-audit-sec-title {
  margin-bottom: var(--crwu-space-3);
  font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--crwu-text-tertiary);
}
/* 核心指标：一块轻量 Surface（不画明显边框、不做三个 Dashboard 卡）。 */
.crwu-audit-km {
  box-sizing: border-box; padding: var(--crwu-space-4);
  border: 1px solid var(--crwu-border); border-radius: 12px;
  background: var(--crwu-sum-bg);
}
.crwu-audit-rate-label { font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); }
/* 命中率是整个抽屉的**第一视觉重点**：30–34px / 600；不按高低给红黄绿（命中率不是考试成绩）。 */
.crwu-audit-rate-value {
  margin-top: 2px;
  font-size: 32px; font-weight: 600; line-height: 38px; letter-spacing: -0.02em;
  color: var(--crwu-text-primary); font-variant-numeric: tabular-nums;
}
.crwu-audit-rate-meta { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); }
.crwu-audit-km-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  margin-top: var(--crwu-space-4); padding-top: var(--crwu-space-3);
  border-top: 1px solid var(--crwu-border);
}
.crwu-audit-km-label { font-size: 12px; line-height: 16px; color: var(--crwu-text-tertiary); }
.crwu-audit-km-value {
  margin-top: 2px; font-size: 20px; font-weight: 600; line-height: 26px;
  color: var(--crwu-text-primary); font-variant-numeric: tabular-nums;
}
.crwu-audit-km-hint { margin-top: 3px; font-size: 12px; line-height: 17px; color: var(--crwu-text-tertiary); }

/* 「已提出但仍未整改」：业务上比 AI 新发现问题更值得注意，但**不做大红警告** ——
   左侧 3px 琥珀强调条 + 数量 badge（低浓度红底红字）。 */
.crwu-audit-raised {
  box-sizing: border-box; margin-top: var(--crwu-space-5);
  padding: 0 var(--crwu-space-3) 0 var(--crwu-space-3);
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-b);
  border-radius: 10px; background: transparent;
}
.crwu-audit-raised-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 11px 0; border: none; background: transparent;
  font-family: inherit; text-align: left; cursor: pointer;
  transition: background 160ms var(--crwu-ease);
}
.crwu-audit-raised-head:hover { background: var(--crwu-tech-hover); }
.crwu-audit-raised-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-raised-title { display: block; font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-raised-sub {
  display: block; margin-top: 2px;
  font-size: 12px; line-height: 17px; color: var(--crwu-text-secondary);
}
.crwu-audit-raised-count {
  flex: none; margin-left: auto; padding: 0 8px; height: 20px; box-sizing: border-box;
  display: inline-flex; align-items: center; border-radius: 999px;
  background: color-mix(in srgb, var(--crwu-risk-a) 10%, transparent);
  color: var(--crwu-risk-a); font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.crwu-audit-raised .crwu-audit-issue-row:first-child { border-top: none; }
.crwu-audit-raised .crwu-audit-issue-row { padding-left: 0; padding-right: 0; }

/* 通用折叠（已提未改 / AI 问题 / 报告信息 / 技术详情）：grid-rows 0fr→1fr 拿到 170ms 高度动画，
   不需要测量高度，也不会在数据变化时跳。 */
.crwu-audit-acc-body {
  display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 170ms var(--crwu-ease);
}
.crwu-audit-acc[data-open="true"] .crwu-audit-acc-body { grid-template-rows: 1fr; }
.crwu-audit-acc-inner { overflow: hidden; min-height: 0; }
.crwu-audit-acc-chevron {
  flex: none; margin-left: auto; font-size: 13px; line-height: 1;
  color: var(--crwu-text-tertiary);
  transition: transform 170ms var(--crwu-ease);
}
.crwu-audit-acc[data-open="true"] .crwu-audit-acc-chevron { transform: rotate(90deg); }
/* 折叠小节（报告信息 / 其他事项 / 技术详情同一形态）：顶部发丝线 + 40px 折叠头。 */
.crwu-audit-fold { margin-top: var(--crwu-space-6); border-top: 1px solid var(--crwu-border); }
.crwu-audit-fold .crwu-audit-acc-inner { padding-top: var(--crwu-space-3); }
.crwu-audit-fold-head {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 40px;
  padding: 0; border: none; background: transparent;
  color: var(--crwu-text-tertiary); font-family: inherit; font-size: 12px; font-weight: 600;
  letter-spacing: 0.02em; text-align: left; cursor: pointer;
  transition: background 160ms var(--crwu-ease), color 160ms var(--crwu-ease);
}
.crwu-audit-fold-head:hover { background: var(--crwu-tech-hover); color: var(--crwu-text-secondary); }
.crwu-audit-fold-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }
.crwu-audit-fold-title { min-width: 0; }

/* AI 检出问题：一条一行（不是 Card）；严重程度 + 标题 + 简述，点开才给位置与建议。 */
.crwu-audit-issue-list { display: flex; flex-direction: column; }
.crwu-audit-issue-row { border-top: 1px solid var(--crwu-border); }
.crwu-audit-issue-list > .crwu-audit-issue-row:first-child { border-top: none; }
.crwu-audit-issue-head {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 11px 0; border: none; background: transparent;
  font-family: inherit; text-align: left; cursor: pointer;
  transition: background 120ms var(--crwu-ease);
}
.crwu-audit-issue-head:hover { background: var(--crwu-tech-hover); }
.crwu-audit-issue-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-issue-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-issue-severity {
  display: inline-flex; align-items: center; gap: 6px; margin-bottom: 3px;
  font-size: 12px; font-weight: 600; color: var(--crwu-risk-text);
}
.crwu-audit-issue-title {
  font-size: 13px; font-weight: 600; line-height: 19px; color: var(--crwu-text-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-issue-brief {
  margin-top: 3px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-issue-detail { padding: 0 0 12px; }
.crwu-audit-issue-field { display: flex; gap: 10px; margin-top: 8px; }
.crwu-audit-issue-field-label {
  flex: 0 0 62px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary);
}
.crwu-audit-issue-field-value {
  flex: 1 1 auto; min-width: 0; font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere; white-space: pre-wrap;
}
.crwu-audit-issue-link {
  display: inline-flex; align-items: center; gap: 4px; margin-top: 10px; padding: 0;
  border: none; background: transparent; cursor: pointer;
  color: var(--crwu-text-secondary); font-family: inherit; font-size: 12px; font-weight: 500;
  transition: color 120ms var(--crwu-ease);
}
.crwu-audit-issue-link:hover { color: var(--crwu-text-primary); }
.crwu-audit-issue-link:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; border-radius: 4px; }
/* 二级小结（高/中/低 · 待确认/未检查 · 三条带）：一条轻文案，不占块。 */
.crwu-audit-summary-line {
  margin-top: 10px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
}
.crwu-audit-sec .crwu-audit-summary-line { margin-top: 0; margin-bottom: 6px; }
/* 报告信息：值允许换行（报告版本可能是很长的一行原文，**不解析、只换行**）。 */
.crwu-audit-info-value-wrap { line-height: 1.55; overflow-wrap: anywhere; max-width: 46ch; }

/* ── 技术详情里的原始值 ──────────────────────────────────────────────────
   （折叠机制与 fold 共用；这里只管原始值的排版：等宽、允许换行、可复制。） */
.crwu-audit-tech-row { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--crwu-border); }
.crwu-audit-tech-row:first-child { border-top: none; }
.crwu-audit-tech-key { flex: 0 0 42%; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); overflow-wrap: anywhere; }
.crwu-audit-tech-value {
  flex: 1 1 auto; min-width: 0; font-family: var(--crwu-font-mono); font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere; white-space: pre-wrap;
}
.crwu-audit-tech-json {
  box-sizing: border-box; margin: 8px 0 0; padding: 10px 12px; max-height: 240px; overflow: auto;
  border: 1px solid var(--crwu-border); border-radius: 8px; background: var(--crwu-surface-subtle);
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.crwu-audit-tech-copy {
  display: inline-flex; align-items: center; height: 24px; padding: 0 9px; margin-top: 8px;
  border: none; border-radius: 6px; background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 12px; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-tech-copy:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-tech-hint { margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); }
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-acc-body, .crwu-audit-acc-chevron { transition: none; }
}
.crwu-audit-gate {
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 14px; padding: 16px 18px; margin-bottom: 14px;
}
.crwu-audit-gate-title { font-weight: 600; color: var(--dsw-alias-state-warn-primary); }

/* 抽屉与键值表（审核信息的内容体；外壳见 §17）。 */
.crwu-audit-drawer { padding: 2px 0; }
.crwu-audit-drawer-head { font-weight: 600; margin-bottom: 8px; }
.crwu-audit-kv { display: grid; grid-template-columns: 150px 1fr; gap: 9px 14px; align-items: baseline; }
.crwu-audit-kv-key { color: var(--crwu-text-tertiary); font-size: 12px; }
.crwu-audit-kv-value { overflow-wrap: anywhere; color: var(--crwu-text-primary); }
`
