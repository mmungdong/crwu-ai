/**
 * 环境信息页（配置工作区）与插件级授权门槛。
 *
 * 环境信息不是目录树里的一页（用户 2026-10-13 口径）：环境没就绪时所有入口统一落到它，
 * 员工也可以自己进来改配置。它永远可进 —— 它就是修复入口。
 */

export const ENVIRONMENT_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   11. 自检结论（hero）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-hero {
  display: flex; gap: 14px; align-items: flex-start;
  padding: 16px; margin-bottom: 14px; border-radius: 14px;
  border: 1px solid var(--crwu-border); border-left-width: 3px;
  background: var(--crwu-surface-subtle); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-hero-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-hero-bad { border-left-color: var(--dsw-alias-state-error-primary); }
/* 结论图标：圆角方块 + 同色浅底。比一颗裸圆点更"像一个结论"，也和卡片圆角语言一致。 */
.crwu-audit-hero-mark {
  flex: none; width: 40px; height: 40px; border-radius: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-hero-mark-ok {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent);
}
.crwu-audit-hero-mark-bad {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
}
.crwu-audit-hero-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-hero-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.crwu-audit-hero-sub { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.crwu-audit-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }

/* ════════════════════════════════════════════════════════════════════
   环境页（2026-09-26 重排）：紧凑状态摘要 + 引导式配置工作区
   ────────────────────────────────────────────────────────────────────
   办公 + Apple 设置页的层级感：
   - 顶部摘要**一条带**（不罗列全部阻塞项，不给「进入报告审核」按钮）；
   - 工作区是**一个** surface，左 260px 步骤导航（发丝分隔线分区，不各自套卡片），
     右侧当前步骤；窄屏（<=860px）改成顶部横向步骤条 + 下方详情，绝不横向溢出；
   - 分层只靠 1px 发丝线、留白与最轻一档阴影；状态色只出现在小图标 / 状态点 / 短标签上。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-status {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; margin-bottom: 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-status-ok { border-left: 3px solid var(--dsw-alias-state-success-primary); }
.crwu-audit-status-bad { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.crwu-audit-status-mark {
  flex: none; width: 32px; height: 32px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
}
.crwu-audit-status-mark-ok {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.crwu-audit-status-mark-bad {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
}
.crwu-audit-status-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-status-title { font-size: 15px; font-weight: 600; line-height: 22px; color: var(--crwu-text-primary); }
.crwu-audit-status-sub { margin-top: 2px; font-size: 13px; line-height: 19px; color: var(--crwu-text-secondary); }
.crwu-audit-status-note {
  display: flex; align-items: center; gap: 6px;
  margin-top: 6px; padding: 6px 10px; border-radius: 8px;
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.crwu-audit-status-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.crwu-audit-status-dot {
  width: 3px; height: 3px; border-radius: 50%; flex: none;
  background: var(--crwu-text-tertiary);
}
.crwu-audit-status-action { flex: none; display: flex; align-items: flex-start; padding-top: 2px; }

.crwu-audit-workspace {
  display: grid; grid-template-columns: 260px minmax(0, 1fr);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
  overflow: hidden;
}
.crwu-audit-steps { min-width: 0; border-right: 1px solid var(--crwu-border); background: var(--crwu-surface-subtle); }
.crwu-audit-steps-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.crwu-audit-step {
  display: flex; align-items: center; gap: 10px; width: 100%;
  min-height: 44px; padding: 6px 10px; border: none; border-radius: 10px;
  background: transparent; color: var(--crwu-text-secondary);
  font-family: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer;
  transition: background 140ms var(--crwu-ease), color 140ms var(--crwu-ease);
}
.crwu-audit-step:hover { background: var(--crwu-hover); color: var(--crwu-text-primary); }
.crwu-audit-step:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }
.crwu-audit-step-on, .crwu-audit-step-on:hover {
  background: var(--crwu-surface); color: var(--crwu-text-primary); font-weight: 600;
  box-shadow: var(--crwu-shadow-tab);
}
.crwu-audit-step-index {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--crwu-text-tertiary);
  border: 1px solid var(--crwu-border-strong); background: var(--crwu-surface);
}
/* 已完成：实心绿点（状态色只出现在这枚小图标上，不铺底）。 */
.crwu-audit-step-index-done {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.crwu-audit-step-text { min-width: 0; display: flex; flex-direction: column; }
.crwu-audit-step-title { font-size: 13px; line-height: 18px; }
/* 基础必检项的红色星号：颜色用主题的错误语义色，不用硬编码红色。 */
.crwu-audit-step-required { margin-left: 3px; color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.crwu-audit-step-legend {
  padding: 8px 10px 2px; font-size: 11px; line-height: 16px; color: var(--crwu-text-tertiary);
  border-top: 1px solid var(--crwu-border);
}
.crwu-audit-step-state { font-size: 11px; line-height: 16px; color: var(--crwu-text-tertiary); font-weight: 400; }
.crwu-audit-step-panel { min-width: 0; padding: 16px 18px; }
.crwu-audit-step-panel-head {
  display: flex; align-items: center; gap: 10px;
  padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--crwu-border);
}
.crwu-audit-step-panel-title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; }
.crwu-audit-step-lead { margin: 0 0 12px; font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
/* 步骤内的表单块：与「一行配置项」同一套语言，但自带一段引导文案。 */
.crwu-audit-step-card { display: block; }
.crwu-audit-step-card-head { display: flex; align-items: center; gap: 10px; }
.crwu-audit-fields { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.crwu-audit-field { display: flex; flex-direction: column; gap: 4px; }
.crwu-audit-field-label { font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); }
/* 窄屏：左侧导航变成顶部横向步骤条，绝不横向溢出。 */
@media (max-width: 860px) {
  .crwu-audit-workspace { grid-template-columns: minmax(0, 1fr); }
  .crwu-audit-steps { border-right: none; border-bottom: 1px solid var(--crwu-border); }
  .crwu-audit-steps-list { flex-direction: row; overflow-x: auto; }
  .crwu-audit-step { width: auto; flex: none; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-step, .crwu-audit-step:hover { transition: none; }
}

.crwu-audit-meter {
  height: 6px; border-radius: 999px; overflow: hidden; margin-top: 12px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-meter-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.crwu-audit-meter-fill-bad { background: var(--dsw-alias-state-warn-primary); }

.crwu-audit-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(116px, 1fr)); gap: 10px; margin-top: 14px; }
.crwu-audit-metric {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--crwu-surface-subtle); padding: 8px 11px;
}
.crwu-audit-metric-value {
  font-size: 16px; font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.crwu-audit-metric-label { color: var(--dsw-alias-label-caption); font-size: 11px; }

/* ════════════════════════════════════════════════════════════════════
   12. 环境自检的五层（插件内置组件 / DSH 脚本运行时 / 登录与凭据授权 / OSS 交付配置 / 外部数据）
   ────────────────────────────────────────────────────────────────────
   每层一张卡：标题 + x/y 已就绪 + 层级色；**没就绪的层默认展开**，全部就绪的收成一行。
   层级色只用在左边框上（不整块染色）：一页五层时整块染色会喧宾夺主，左边一条足够分层次。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-layer {
  border: 1px solid var(--crwu-border); border-left-width: 3px; border-radius: 14px;
  background: var(--crwu-surface-subtle); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 12px; overflow: hidden;
}
.crwu-audit-layer-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-layer-bad { border-left-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-layer-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 11px 14px; border: none; font-family: inherit; font-size: 13px; text-align: left;
  background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer;
  transition: background 0.14s ease;
}
.crwu-audit-layer-head:hover { background: var(--crwu-hover); }
.crwu-audit-layer-title { font-weight: 600; }
.crwu-audit-layer-count { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; }
.crwu-audit-layer-toggle { color: var(--dsw-alias-link); font-size: 11.5px; white-space: nowrap; }
.crwu-audit-layer-body { padding: 6px 14px 12px; }
.crwu-audit-layer-head-extra {
  padding: 7px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary);
  background: transparent; border-top: 1px solid var(--crwu-border);
}
.crwu-audit-layer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 层里嵌的"怎么办"块（例如 ④ 的 AK 表单）：左侧一条竖线 + 去掉内层卡片的重复边框感。 */
.crwu-audit-layer-fix { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--dsw-alias-border-l2); }
.crwu-audit-layer-fix .crwu-audit-card { margin-bottom: 0; box-shadow: none; }

/* ════════════════════════════════════════════════════════════════════
   13. 开发者诊断
   ────────────────────────────────────────────────────────────────────
   默认收起在内容区右下角：sha256、清单来源、会话 id 这些是开发信息，普通员工不需要注意。
   展开内容保持全宽并排在入口上方，入口本身不悬浮、不遮挡员工表单。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-details {
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  margin-top: 4px;
}
.crwu-audit-details-head {
  display: flex; align-items: center; gap: 8px; width: auto; min-height: 34px;
  padding: 6px 9px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.crwu-audit-details-head:hover {
  background: var(--crwu-hover);
  color: var(--dsw-alias-label-secondary);
}
.crwu-audit-details-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.crwu-audit-details-title svg { flex: 0 0 auto; color: currentColor; }
.crwu-audit-details-toggle { margin-left: auto; color: currentColor; font-size: 11.5px; white-space: nowrap; }
.crwu-audit-details-contact {
  padding: 0 9px 4px; color: var(--dsw-alias-label-secondary); font-size: 12px;
  text-decoration: none; text-underline-offset: 3px;
}
.crwu-audit-details-contact:hover { color: var(--dsw-alias-link); text-decoration: underline; }
.crwu-audit-details-contact:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.crwu-audit-details-body {
  align-self: stretch; order: -1; width: 100%; box-sizing: border-box;
  padding: 16px 18px 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-details-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-details-panel-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.crwu-audit-details-copy-error { margin: -4px 0 10px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.crwu-audit-details-body .crwu-audit-kv { margin-top: 0; }
.crwu-audit-hero-todo { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }

/* ════════════════════════════════════════════════════════════════════
   14. 单条检查项 / 阻塞清单
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-item {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-item:last-child { border-bottom: none; }
.crwu-audit-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.crwu-audit-item-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-item-name { font-weight: 600; }
.crwu-audit-item-note { color: var(--dsw-alias-label-caption); }
.crwu-audit-item-meta { margin-top: 3px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.crwu-audit-item-fix { margin-top: 4px; color: var(--dsw-alias-state-warn-primary); overflow-wrap: anywhere; }

.crwu-audit-blockers { list-style: none; margin: 8px 0 0; padding: 0; }
.crwu-audit-blocker {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 7px 0; background: var(--crwu-surface-subtle); border-bottom: 1px solid var(--crwu-border);
}
.crwu-audit-blocker:last-child { border-bottom: none; }
.crwu-audit-blocker-index {
  flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

/* ════════════════════════════════════════════════════════════════════
   15. 加载态与门禁
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-spinner {
  width: 14px; height: 14px; flex: none; display: inline-block; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: crwu-audit-spin 0.9s linear infinite;
}
.crwu-audit-spinner-large { width: 26px; height: 26px; border-width: 3px; }
@keyframes crwu-audit-spin { to { transform: rotate(360deg); } }

.crwu-audit-loading {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 64px 12px; color: var(--crwu-text-secondary);
}
.crwu-audit-loading-inline {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 0 12px; color: var(--crwu-text-secondary);
}

/* 不确定进度条：翻页 / 重新自检 / 刷新列表时，让「正在加载」有一个看得见的落点。
   只压暗正文而不拦按钮的部分不放这里 —— 被 dim 包住的区域连点击一起停掉，防手快连点。 */
/* ════════════════════════════════════════════════════════════════════
   16. 插件级授权门槛（弹框 / 拒绝屏）
   ────────────────────────────────────────────────────────────────────
   授权是本插件的硬前置：没有它取不到氚云待办、发不出钉钉回传，所以未授权时
   直接把整个面板挡住（Host 侧另有一条 blocked 兜底，防止绕过 UI 调操作）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-auth-granted { color: var(--dsw-alias-label-caption); }
`
