/**
 * 本地审核（协议 28）的**样式文本**（类名常量在 `../consts.ts`）。
 *
 * 与其它业务同一套视觉语言：颜色 / 圆角 / 阴影只用 `styles/tokens.ts` 里已经定义过的
 * `--crwu-*` 语义 token，这里不新增 CSS 变量、不用 emoji、也不用大面积红底。
 *
 * 作用域由 `styles/bundle.ts` 统一加（`scopeCss`）。一级 / 二级目录的规则**不在这里** ——
 * 那是 shell 的导航控件，见 `shell/styles/navigation.ts`。
 *
 * 过渡只碰 background / border-color / color / box-shadow / opacity（不动宽高，避免重排抖动），
 * 并在 `prefers-reduced-motion: reduce` 下全部关掉。
 */

export const LOCAL_AUDIT_STYLE_TEXT = `

/* ════════════════════════════════════════════════════════════════════
   23. 页签条（报告审核 / 本地审核）
   ────────────────────────────────────────────────────────────────────
   ⚠️ 页签本身的样式**不在这里**：一级 / 二级目录是 shell 的导航控件，不是本地审核的私有
   控件（评估页、审核页、以后新增的业务页共用同一条目录条）。规则见
   shell/styles/navigation.ts。这里只保留本页自己的东西 —— 模块不得通过重定义共享
   控件的类来改别的业务的外观。
   ──────────────────────────────────────────────────────────────────── */

/* ════════════════════════════════════════════════════════════════════
   24. 本地审核页
   ────────────────────────────────────────────────────────────────────
   结构：三张卡（已选择内容 / 选择操作 / 补充提示词）+ 底部主操作。
   卡片沿用既有的卡片类（card / card-title / card-body）；这里只补卡片内部的排版与语气色。
   状态一律「图标 + 文字 + 颜色」三重表达，绝不允许只靠颜色。
   ──────────────────────────────────────────────────────────────────── */
/* 本地审核的正文：**滚动在这一层**（页签条常驻在上方，不跟着内容滚走）。
   与报告审核那一页的 pane-main 同一档留白，并补上页面头占位。 */
.crwu-audit-local {
  box-sizing: border-box; flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: var(--crwu-space-4) var(--crwu-pad-x) var(--crwu-space-6);
  background: var(--crwu-surface);
}
/* 本页没有 24px 的页头（身份由上一行的页签直接说明），正文顶部留白与报告审核那一页
   （.crwu-audit-pane-main）**同档**，两页切换时内容起始位置不跳。 */
.crwu-audit-local-card-title-text { min-width: 0; }
.crwu-audit-local-card-hint { color: var(--crwu-text-tertiary); font-size: 12px; }
.crwu-audit-local-card-actions { display: flex; align-items: center; gap: var(--crwu-space-2); flex-wrap: wrap; margin-top: var(--crwu-space-3); }

/* 页面顶部说明：副标题 13px 正文色、辅助说明 12px 次级色；两行都**不是**警告块。 */
.crwu-audit-local-intro { display: flex; flex-direction: column; gap: 2px; margin: 0 0 var(--crwu-space-3); }
.crwu-audit-local-intro-lead { color: var(--crwu-text-body); font-size: 13px; }
.crwu-audit-local-intro-note { color: var(--crwu-text-tertiary); font-size: 12px; }

/* 空态：一枚线性文件夹图标 + 一行主文案 + 两行说明；不画插画、不放按钮。 */
.crwu-audit-local-empty { text-align: center; padding: var(--crwu-space-4) 0; }
.crwu-audit-local-empty-mark {
  display: flex; align-items: center; justify-content: center;
  color: var(--crwu-text-tertiary); margin-bottom: var(--crwu-space-2);
}
.crwu-audit-local-empty-mark svg { width: 40px; height: 40px; }

/* ── 已选择内容：语义化列表，一行一个入口 ─────────────────────────────── */
.crwu-audit-local-list { list-style: none; margin: 0; padding: 0; }
.crwu-audit-local-list-row {
  display: flex; align-items: flex-start; gap: var(--crwu-space-3);
  padding: 10px 0;
  border-top: 1px solid var(--crwu-border);
}
.crwu-audit-local-list-row:first-child { border-top: none; }
.crwu-audit-local-row-icon { flex: none; display: inline-flex; align-items: center; color: var(--crwu-text-tertiary); padding-top: 2px; }
.crwu-audit-local-row-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-local-row-name {
  font-size: 13px; color: var(--crwu-text-primary);
  overflow-wrap: anywhere;
}
.crwu-audit-local-row-meta { color: var(--crwu-text-secondary); font-size: 12px; line-height: 20px; }
.crwu-audit-local-row-reason { color: var(--crwu-text-tertiary); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.crwu-audit-local-row-status {
  flex: none; display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; line-height: 20px; white-space: nowrap;
}
.crwu-audit-local-row-status svg { width: 14px; height: 14px; }
/* 移除：一枚 24×24 的图标按钮（用户 2026-10-11 口径：右侧有个 X 的 icon）。
   视觉上是"次要控件"，但**命中区不小于 24px**，并且必须带具体文件名的可访问名。 */
.crwu-audit-local-row-remove {
  position: relative; flex: none; width: 28px; height: 28px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--crwu-control-text);
  font-family: inherit; cursor: pointer;
  transition: background 140ms var(--crwu-ease), color 140ms var(--crwu-ease), border-color 140ms var(--crwu-ease);
}
.crwu-audit-local-row-remove svg { width: 14px; height: 14px; }
/* 命中区 44×44（视觉仍是 28×28）：用一层不可见的 ::after 往外扩 8px。
   触屏与手上不准的鼠标都点得到，但不会把列表撑高。 */
.crwu-audit-local-row-remove::after { content: ''; position: absolute; inset: -8px; }

/* 文件夹那一行：本身就是个小标题，文件行挂在它下面（缩进一档、去掉上边框）。 */
.crwu-audit-local-row-group { padding: 10px 0; border-top: 1px solid var(--crwu-border); }
.crwu-audit-local-row-group:first-child { border-top: none; }
.crwu-audit-local-row-head { display: flex; align-items: flex-start; gap: var(--crwu-space-3); }
.crwu-audit-local-list-nested {
  list-style: none; margin: 4px 0 0; padding: 0 0 0 26px;
  display: flex; flex-direction: column;
}
.crwu-audit-local-list-row-file {
  padding: 4px 0; border-top: none; gap: var(--crwu-space-2);
  align-items: baseline;
}
/* 文件行里名字**不许截断**：完整展示（长名换行），这是用户口径里的"完整展示文件名称"。 */
.crwu-audit-local-list-row-file .crwu-audit-local-row-name { font-size: 12px; }
.crwu-audit-local-row-remove:hover { background: var(--crwu-control); color: var(--crwu-text-primary); }
.crwu-audit-local-row-remove:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 1px; }

.crwu-audit-local-summary { margin-top: var(--crwu-space-2); padding-top: 10px; border-top: 1px solid var(--crwu-border); color: var(--crwu-text-secondary); font-size: 12px; }
.crwu-audit-local-skipped-note { margin-top: 4px; color: var(--crwu-text-tertiary); font-size: 12px; }
.crwu-audit-local-skipped-details { margin-top: 2px; }
.crwu-audit-local-skipped-summary {
  cursor: pointer; color: var(--crwu-text-secondary); font-size: 12px; line-height: 20px;
  border-radius: var(--crwu-radius-sm);
}
.crwu-audit-local-skipped-summary:hover { color: var(--crwu-text-primary); }
.crwu-audit-local-skipped-summary:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-local-skipped-hint { margin-left: var(--crwu-space-2); color: var(--crwu-text-tertiary); }

/* 扫描骨架：三行浅灰条 + 一句状态。不做渐变动画，只做很轻的呼吸（reduced-motion 下关闭）。 */
.crwu-audit-local-skeleton { display: flex; flex-direction: column; gap: var(--crwu-space-2); padding: var(--crwu-space-2) 0; }
.crwu-audit-local-skeleton-line {
  height: 14px; border-radius: 999px; background: var(--crwu-control);
  animation: crwu-audit-local-breath 1.4s var(--crwu-ease) infinite;
}
.crwu-audit-local-skeleton-line:nth-child(2) { width: 82%; }
.crwu-audit-local-skeleton-line:nth-child(3) { width: 64%; }
@keyframes crwu-audit-local-breath { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

/* 桌面双栏（>=1024px）：左 = 选择资料 + 已选择内容；右 = 补充提示词与说明。
   小屏回到单栏，顺序仍是 头部 → 选择 → 已选择 → 提示词 → 操作。
   两列都用 minmax(0, …)，避免长文件名把列撑出横向滚动。 */
.crwu-audit-local-columns { display: flex; flex-direction: column; gap: var(--crwu-space-4); min-width: 0; }
.crwu-audit-local-column { display: flex; flex-direction: column; gap: var(--crwu-space-4); min-width: 0; }
@media (min-width: 1024px) {
  .crwu-audit-local-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); align-items: start; }
}
/* 超限是**明确阻止**，不是警告色的小提示：左缘一条琥珀强调边，正文仍用主文字色。 */
.crwu-audit-local-over-limit {
  margin-top: var(--crwu-space-3); padding: 8px 12px;
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-b);
  border-radius: 8px; background: var(--crwu-sum-bg);
  color: var(--crwu-text-primary); font-size: 12px; line-height: 20px;
}

/* 语气：色相 + 文案 + 图标三样一起给，色弱也能读。 */
.crwu-audit-local-tone-ok { color: var(--crwu-risk-pass); }
.crwu-audit-local-tone-warn { color: var(--crwu-risk-b); }
.crwu-audit-local-tone-error { color: var(--crwu-risk-a); }
.crwu-audit-local-tone-muted { color: var(--crwu-text-tertiary); }

/* ── 补充提示词：label + 占满宽度的 textarea + 两行说明 ─────────────────── */
.crwu-audit-local-field { display: flex; flex-direction: column; gap: 6px; }
.crwu-audit-local-field-label { color: var(--crwu-text-primary); font-size: 13px; font-weight: 500; }
.crwu-audit-local-textarea {
  box-sizing: border-box; width: 100%; min-height: 108px;
  padding: 10px 12px;
  border: 1px solid var(--crwu-border); border-radius: 9px;
  background: var(--crwu-input-bg); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 13px; line-height: 20px;
  resize: vertical;
  transition: background 140ms var(--crwu-ease), border-color 140ms var(--crwu-ease), box-shadow 140ms var(--crwu-ease);
}
.crwu-audit-local-textarea::placeholder { color: var(--crwu-text-tertiary); }
.crwu-audit-local-textarea:focus-visible {
  outline: none; background: var(--crwu-surface);
  border-color: var(--crwu-border-strong);
  box-shadow: 0 0 0 3px var(--crwu-focus-ring);
}
.crwu-audit-local-field-hint { color: var(--crwu-text-tertiary); font-size: 12px; line-height: 20px; }

/* ── 准备阶段条：✓ 已完成 / ● 进行中（转圈）/ ○ 未开始 ───────────────────── */
.crwu-audit-local-stages { display: flex; flex-direction: column; gap: 6px; margin-top: var(--crwu-space-3); }
.crwu-audit-local-stage { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 20px; }
.crwu-audit-local-stage-done { color: var(--crwu-text-secondary); }
.crwu-audit-local-stage-active { color: var(--crwu-text-primary); font-weight: 500; }
.crwu-audit-local-stage-todo { color: var(--crwu-text-tertiary); }
.crwu-audit-local-stage-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
.crwu-audit-local-stage-mark-busy {
  width: 11px; height: 11px; border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, var(--crwu-brand) 30%, transparent);
  border-top-color: var(--crwu-brand);
  animation: crwu-audit-spin 0.8s linear infinite;
}

/* ── 成功态 / 失败兜底卡 ──────────────────────────────────────────────── */
.crwu-audit-local-done { display: flex; gap: 12px; align-items: flex-start; }
.crwu-audit-local-done-mark { flex: none; color: var(--crwu-risk-pass); padding-top: 2px; }
.crwu-audit-local-done-title { font-size: 14px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-local-done-meta { color: var(--crwu-text-secondary); font-size: 12px; line-height: 20px; }
.crwu-audit-local-done-hint { color: var(--crwu-text-tertiary); font-size: 12px; line-height: 20px; }

.crwu-audit-local-handoff { display: flex; gap: 12px; align-items: flex-start; }
.crwu-audit-local-handoff-mark { flex: none; color: var(--crwu-risk-b); padding-top: 2px; }
.crwu-audit-local-handoff-title { font-size: 14px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-local-handoff-lead { color: var(--crwu-text-secondary); font-size: 12px; line-height: 20px; margin-top: 2px; }
.crwu-audit-local-handoff-steps { margin: var(--crwu-space-2) 0 0; padding-left: 18px; color: var(--crwu-text-body); font-size: 12px; line-height: 20px; }
.crwu-audit-local-handoff-actions { display: flex; gap: var(--crwu-space-2); flex-wrap: wrap; margin-top: var(--crwu-space-3); }
.crwu-audit-local-handoff-copied { color: var(--crwu-text-secondary); font-size: 12px; line-height: 20px; margin-top: 6px; }
.crwu-audit-local-handoff-prompt {
  box-sizing: border-box; width: 100%; min-height: 120px; margin-top: var(--crwu-space-3);
  padding: 10px 12px;
  border: 1px solid var(--crwu-border); border-radius: 9px;
  background: var(--crwu-input-bg); color: var(--crwu-text-body);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 18px;
  white-space: pre-wrap; overflow-wrap: anywhere; resize: vertical;
}

/* ── 底部主操作 ───────────────────────────────────────────────────────── */
.crwu-audit-local-action {
  display: flex; align-items: center; gap: var(--crwu-space-3); flex-wrap: wrap;
  margin-top: var(--crwu-space-4);
}
.crwu-audit-local-action-reason { color: var(--crwu-text-tertiary); font-size: 12px; line-height: 20px; }
.crwu-audit-local-fatal { color: var(--crwu-risk-a); font-size: 12px; line-height: 20px; margin-top: var(--crwu-space-3); }

@media (prefers-reduced-motion: reduce) {
  .crwu-audit-tab, .crwu-audit-tab::after, .crwu-audit-local-row-remove, .crwu-audit-local-textarea { transition: none; }
  .crwu-audit-local-stage-mark-busy { animation: none; }
  .crwu-audit-local-skeleton-line { animation: none; }
}

`
