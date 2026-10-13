/**
 * 自助更新：可点的版本徽标 + 更新面板。
 *
 * 语气一律写成**双类**（`.crwu-audit-version.crwu-audit-update-badge-*`）：单类会被
 * 共享按钮那一层吃掉。更新面板是 `position: fixed` 浮层，遮罩 940 / 面板 941（高过抽屉的 900/901）。
 */

export const UPDATE_STYLE_TEXT = `
/* ────────────────────────────────────────────────────────────────────────────
   21. 自助更新：可点的版本徽标 + 更新面板（Task 6）

   徽标沿用 §… 的 .crwu-audit-version（10px 等宽小标签），这里只加"可点"的语气与三种状态色；
   语气一律写成**双类**（.crwu-audit-version.crwu-audit-update-badge-*），理由见 §3.5：
   单类会被 §20 的覆盖层吃掉。

   更新面板是 position: fixed 浮层：遮罩 940 / 面板 941（高过抽屉的 900/901，
   低于授权那类真正的阻塞层）。整块都长在 .crwu-audit-root 里，所以 --crwu-* 照常继承。
   ──────────────────────────────────────────────────────────────────────────── */
.crwu-audit-update-badge { cursor: pointer; font-family: inherit; }
.crwu-audit-update-badge:hover { background: var(--crwu-hover); border-color: var(--crwu-border-strong); }
.crwu-audit-update-badge:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-version.crwu-audit-update-badge-accent {
  color: var(--crwu-brand);
  border-color: color-mix(in srgb, var(--crwu-brand) 45%, transparent);
  background: color-mix(in srgb, var(--crwu-brand) 10%, transparent);
}
.crwu-audit-version.crwu-audit-update-badge-ok {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
}
.crwu-audit-version.crwu-audit-update-badge-warn {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}

.crwu-audit-update-dialog-backdrop {
  position: fixed; inset: 0; z-index: 940;
  background: var(--crwu-scrim);
  animation: crwu-audit-scrim-in 140ms var(--crwu-ease) both;
}
.crwu-audit-update-dialog {
  position: fixed; z-index: 941; top: 50%; left: 50%; transform: translate(-50%, -50%);
  box-sizing: border-box; width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px);
  display: flex; flex-direction: column;
  padding: var(--crwu-space-5); border-radius: var(--crwu-radius-lg);
  border: 1px solid var(--crwu-border-strong); background: var(--crwu-surface);
  box-shadow: var(--crwu-shadow-dialog);
  animation: crwu-audit-float-in 160ms var(--crwu-ease) both;
}
.crwu-audit-update-dialog-head { display: flex; align-items: center; gap: var(--crwu-space-3); }
.crwu-audit-update-dialog-title {
  flex: 1 1 auto; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--crwu-text-primary);
}
.crwu-audit-update-dialog-body { margin-top: var(--crwu-space-3); overflow: auto; min-height: 0; }
.crwu-audit-update-dialog-notice {
  margin-bottom: var(--crwu-space-3); padding: var(--crwu-space-3);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);
  border-left-width: 3px; border-radius: var(--crwu-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color: var(--crwu-text-primary); font-size: 13px; line-height: 20px;
}
.crwu-audit-update-dialog-notice-hint { margin-top: var(--crwu-space-2); color: var(--crwu-text-secondary); }
.crwu-audit-update-dialog-stages { display: flex; align-items: center; gap: var(--crwu-space-2); margin-top: var(--crwu-space-3); }
.crwu-audit-update-dialog-stage {
  display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--crwu-border); background: var(--crwu-surface-subtle);
  color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px;
}
.crwu-audit-update-dialog-stage-on {
  border-color: color-mix(in srgb, var(--crwu-brand) 40%, transparent);
  background: color-mix(in srgb, var(--crwu-brand) 10%, transparent);
  color: var(--crwu-text-primary); font-weight: 600;
}
.crwu-audit-update-dialog-reason { margin-top: var(--crwu-space-3); color: var(--crwu-text-secondary); font-size: 12.5px; line-height: 19px; }
.crwu-audit-update-dialog-error { margin-top: var(--crwu-space-3); color: var(--dsw-alias-state-error-primary); font-size: 12.5px; line-height: 19px; }
.crwu-audit-update-dialog-actions { display: flex; justify-content: flex-end; gap: var(--crwu-space-2); margin-top: var(--crwu-space-4); }
.crwu-audit-update-dialog-diag { margin-top: var(--crwu-space-4); border-top: 1px solid var(--crwu-border); padding-top: var(--crwu-space-3); }
.crwu-audit-update-dialog-diag-row { display: flex; gap: var(--crwu-space-3); padding: 2px 0; align-items: baseline; }

@media (prefers-reduced-motion: reduce) {
  .crwu-audit-update-dialog-backdrop, .crwu-audit-update-dialog { animation: none; }
}

/* ⚠️ 第 22 节「氚云内置浏览器登录（访客区）」的 crwu-audit-login-stage 规则已删除
   （2026-09-30）：内置浏览器登录整体下掉，样式与类名常量同批移除，不留死代码。
   —— 样式文本是模板字符串，注释里**不许出现反引号**（踩过两次，第一次就是在这里）。 */
`
