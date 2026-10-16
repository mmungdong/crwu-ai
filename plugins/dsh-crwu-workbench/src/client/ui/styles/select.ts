/**
 * Shared select-only combobox styles. Colours come only from `--crwu-*` tokens.
 */

export const CRWU_SELECT_STYLE_TEXT = `
.crwu-ui-select { position: relative; width: 100%; min-width: 0; }
.crwu-ui-select-trigger {
  box-sizing: border-box; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; width: 100%; min-width: 0; height: 42px; padding: 0 12px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 14px; line-height: 20px; text-align: left; cursor: pointer;
  transition: border-color 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-ui-select-trigger:hover:not(:disabled) { border-color: var(--crwu-field-border-hover); }
.crwu-ui-select-trigger:focus-visible {
  border-color: var(--crwu-interactive); box-shadow: 0 0 0 3px var(--crwu-interactive-soft); outline: none;
}
.crwu-ui-select-trigger[aria-invalid="true"] { border-color: var(--crwu-risk-a); }
.crwu-ui-select-trigger:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-select-value {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crwu-ui-select-placeholder { color: var(--crwu-field-placeholder); }
.crwu-ui-select-chevron {
  display: inline-flex; align-items: center; flex: none; color: var(--crwu-text-secondary);
  transition: transform 140ms var(--crwu-ease);
}
.crwu-ui-select-trigger[aria-expanded="true"] .crwu-ui-select-chevron { transform: rotate(180deg); }
.crwu-ui-select-list {
  position: fixed; z-index: var(--crwu-z-popover); box-sizing: border-box;
  margin: 0; padding: 6px; overflow: auto; list-style: none;
  border: 1px solid var(--crwu-popover-border); border-radius: var(--crwu-radius-lg);
  background: var(--crwu-popover-bg); box-shadow: var(--crwu-popover-shadow);
  transition: opacity 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-ui-select-list-out { opacity: 0; transform: translateY(-2px); }
.crwu-ui-select-option {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px;
  border-radius: var(--crwu-radius-sm); color: var(--crwu-text-primary);
  font-size: 13px; line-height: 18px; cursor: pointer;
}
.crwu-ui-select-option-active { background: var(--crwu-hover); }
.crwu-ui-select-option[aria-selected="true"] { background: var(--crwu-interactive-soft); color: var(--crwu-interactive); }
.crwu-ui-select-option[aria-disabled="true"] { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-select-option-mark {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 16px; height: 18px; color: var(--crwu-interactive);
}
.crwu-ui-select-option-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.crwu-ui-select-option-label { display: inline-flex; align-items: center; gap: 6px; }
.crwu-ui-select-option-badge {
  padding: 0 6px; border-radius: 999px; background: var(--crwu-interactive-soft);
  color: var(--crwu-interactive); font-size: 11px; line-height: 16px;
}
.crwu-ui-select-option-hint { color: var(--crwu-text-secondary); font-size: 12px; line-height: 16px; }
@media (pointer: coarse) {
  .crwu-ui-select-trigger { height: 44px; }
}
@media (max-width: 560px) {
  .crwu-ui-select-trigger { font-size: 16px; }
}
/* The valuation workface can be narrow inside a wide window; match its container too. */
@container crwu-valuation (max-width: 559px) {
  .crwu-ui-select-trigger { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-ui-select-trigger,
  .crwu-ui-select-chevron,
  .crwu-ui-select-list { transition: none; }
}
`
