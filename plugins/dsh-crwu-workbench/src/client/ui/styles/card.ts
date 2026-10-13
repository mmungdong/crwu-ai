/**
 * 共享 UI：卡片 / 分区 / 提示条 / 徽章与胶囊 / 状态圆点。
 *
 * 只被共享组件（`ui/primitives.tsx`）使用；业务模块不得重定义这些类来改别的业务的外观。
 */

export const CRWU_CARD_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   5. 卡片与分区
   ────────────────────────────────────────────────────────────────────
   办公风格的关键是「一眼能扫」：卡片只靠 1px 描边 + 最浅一档投影分层，
   标题条去掉整块底色、改成一条发丝线，避免页面被切成一格格的表格感。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-card {
  border: 1px solid var(--crwu-border); border-radius: 14px;
  background: var(--crwu-surface-subtle); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 14px; overflow: hidden;
}
.crwu-audit-card-title {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 16px; font-weight: 600; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-card-title-text { min-width: 0; }
.crwu-audit-card-extra { margin-left: auto; font-weight: 400; color: var(--dsw-alias-label-caption); font-size: 12px; }
.crwu-audit-card-body { padding: 14px 16px; }

.crwu-audit-section {
  border: 1px solid var(--crwu-border); border-radius: 14px;
  background: var(--crwu-surface-subtle); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 14px; overflow: hidden;
}
.crwu-audit-section-head {
  display: flex; align-items: center; gap: 8px; padding: 11px 16px;
  background: transparent;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-section-title { font-weight: 600; font-size: 13px; }
.crwu-audit-section-count { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; }
.crwu-audit-section-body { padding: 6px 16px 12px; }

/* ════════════════════════════════════════════════════════════════════
   6. 提示条
   ────────────────────────────────────────────────────────────────────
   左缘一条 3px 色边 + 极浅底色：比整块染色克制，也不会和卡片描边打架。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-notice {
  border-radius: 10px; padding: 10px 14px; margin-bottom: 12px;
  border: 1px solid var(--crwu-border); border-left-width: 3px;
  background: var(--crwu-surface-subtle);
  color: var(--dsw-alias-label-primary);
}
.crwu-audit-notice-warn {
  border-left-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
}
.crwu-audit-notice-ok {
  border-left-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-label-primary);
}

/* ════════════════════════════════════════════════════════════════════
   9. 徽章与胶囊
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-badge {
  display: inline-block; border-radius: 6px; padding: 0 7px; margin-right: 4px;
  font-size: 11px; line-height: 18px;
  border: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle); color: var(--crwu-text-secondary);
}
.crwu-audit-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-badge-medium { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-badge-high { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-badge-low { color: var(--dsw-alias-label-caption); }

.crwu-audit-chip {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  border-radius: 999px; padding: 0 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle);
  color: var(--crwu-text-secondary);
}
.crwu-audit-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-chip-muted { color: var(--dsw-alias-label-caption); }

/* ════════════════════════════════════════════════════════════════════
   10. 状态圆点
   ────────────────────────────────────────────────────────────────────
   内圈实心 + 外圈一圈同色半透明光晕：小尺寸下比纯实心更容易在密集列表里被看见。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block;
  background: var(--dsw-alias-label-caption);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-caption) 16%, transparent);
}
.crwu-audit-dot-ok {
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
}
.crwu-audit-dot-bad {
  background: var(--dsw-alias-state-error-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent);
}
.crwu-audit-dot-busy {
  background: var(--dsw-alias-state-warn-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
}
.crwu-audit-dot-idle {
  background: var(--dsw-alias-label-caption);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-caption) 16%, transparent);
}
`
