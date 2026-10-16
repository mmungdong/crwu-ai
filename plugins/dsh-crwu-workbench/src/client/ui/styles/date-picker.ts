/**
 * Shared date picker styles. Colours come only from `--crwu-*` tokens.
 * One enclosing control owns the 42px border/radius; the input, calendar trigger and clear
 * action sit inside it as borderless slots.
 */

export const CRWU_DATE_PICKER_STYLE_TEXT = `
.crwu-ui-datepicker { position: relative; width: 100%; min-width: 0; }
.crwu-ui-datepicker-control {
  display: flex; align-items: center; box-sizing: border-box; width: 100%; min-width: 0;
  height: 42px; padding: 0 4px 0 0;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-field-bg);
  transition: border-color 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-ui-datepicker-control:hover:not(:focus-within) { border-color: var(--crwu-field-border-hover); }
.crwu-ui-datepicker-control:focus-within {
  border-color: var(--crwu-interactive); box-shadow: 0 0 0 3px var(--crwu-interactive-soft);
}
.crwu-ui-datepicker-control[data-invalid="true"] { border-color: var(--crwu-risk-a); }
.crwu-ui-datepicker-input {
  box-sizing: border-box; flex: 1 1 auto; min-width: 0; height: 100%; padding: 0 12px;
  border: none; border-radius: var(--crwu-radius-md) 0 0 var(--crwu-radius-md);
  background: transparent; color: var(--crwu-text-primary);
  font-family: inherit; font-size: 14px; line-height: 20px; outline: none;
}
.crwu-ui-datepicker-input::placeholder { color: var(--crwu-field-placeholder); }
.crwu-ui-datepicker-input[aria-invalid="true"] { color: var(--crwu-error-text); }
.crwu-ui-datepicker-input:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-datepicker-input:read-only { color: var(--crwu-text-secondary); }
.crwu-ui-datepicker-trigger,
.crwu-ui-datepicker-clear {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  height: 100%; padding: 0; border: none; background: transparent;
  color: var(--crwu-text-secondary); cursor: pointer;
}
.crwu-ui-datepicker-trigger { width: 36px; }
.crwu-ui-datepicker-clear { width: 28px; }
.crwu-ui-datepicker-trigger:hover:not(:disabled),
.crwu-ui-datepicker-clear:hover:not(:disabled) { background: var(--crwu-hover); color: var(--crwu-text-primary); }
.crwu-ui-datepicker-trigger:focus-visible,
.crwu-ui-datepicker-clear:focus-visible {
  outline: none; box-shadow: inset 0 0 0 2px var(--crwu-interactive);
}
.crwu-ui-datepicker-trigger:disabled,
.crwu-ui-datepicker-clear:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-datepicker-dialog {
  width: 288px; max-width: calc(100vw - 16px); padding: 10px; box-sizing: border-box;
  border: 1px solid var(--crwu-popover-border); border-radius: var(--crwu-radius-lg);
  background: var(--crwu-popover-bg); box-shadow: var(--crwu-popover-shadow);
  transition: opacity 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-ui-datepicker-dialog-out { opacity: 0; transform: translateY(-2px); }
.crwu-ui-datepicker-head {
  display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 6px;
}
.crwu-ui-datepicker-title {
  flex: 1 1 auto; min-width: 0; padding: 0 4px; border: none; border-radius: var(--crwu-radius-sm);
  background: transparent; color: var(--crwu-text-primary); font-family: inherit;
  font-size: 13px; font-weight: 600; line-height: 28px; cursor: pointer;
}
.crwu-ui-datepicker-title:hover { background: var(--crwu-hover); }
.crwu-ui-datepicker-title:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--crwu-interactive-soft); }
.crwu-ui-datepicker-nav {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: none; border-radius: var(--crwu-radius-sm);
  background: transparent; color: var(--crwu-interactive); cursor: pointer;
}
.crwu-ui-datepicker-nav:hover { background: var(--crwu-interactive-soft); }
.crwu-ui-datepicker-nav:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--crwu-interactive-soft); }
.crwu-ui-datepicker-view-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
}
.crwu-ui-datepicker-view-option {
  display: inline-flex; align-items: center; justify-content: center; height: 32px;
  padding: 0; border: 1px solid transparent; border-radius: var(--crwu-radius-sm);
  background: transparent; color: var(--crwu-text-primary); font-family: inherit; font-size: 12px; cursor: pointer;
}
.crwu-ui-datepicker-view-option:hover { background: var(--crwu-day-hover-bg); color: var(--crwu-interactive); }
.crwu-ui-datepicker-view-option:focus-visible {
  outline: none; border-color: var(--crwu-interactive); box-shadow: 0 0 0 2px var(--crwu-interactive-soft);
}
.crwu-ui-datepicker-view-option-on { background: var(--crwu-interactive-soft); color: var(--crwu-interactive); }
.crwu-ui-datepicker-grid { display: flex; flex-direction: column; gap: 2px; }
.crwu-ui-datepicker-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.crwu-ui-datepicker-weekday {
  display: flex; align-items: center; justify-content: center;
  color: var(--crwu-text-secondary); font-size: 11px; line-height: 20px;
}
.crwu-ui-datepicker-cell { display: flex; align-items: center; justify-content: center; }
.crwu-ui-datepicker-blank { display: block; width: 100%; height: 28px; }
.crwu-ui-datepicker-day {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%; height: 28px; padding: 0; border: 1px solid transparent;
  border-radius: var(--crwu-radius-sm); background: transparent;
  color: var(--crwu-text-primary); font-family: inherit; font-size: 12px; cursor: pointer;
}
.crwu-ui-datepicker-day:hover:not(:disabled) { background: var(--crwu-day-hover-bg); color: var(--crwu-interactive); }
.crwu-ui-datepicker-day:focus-visible {
  outline: none; border-color: var(--crwu-interactive); box-shadow: 0 0 0 2px var(--crwu-interactive-soft);
}
.crwu-ui-datepicker-cell[aria-selected="true"] .crwu-ui-datepicker-day {
  background: var(--crwu-day-selected-bg); color: var(--crwu-day-selected-text);
}
.crwu-ui-datepicker-cell[aria-current="date"] .crwu-ui-datepicker-day { border-color: var(--crwu-day-today-border); }
.crwu-ui-datepicker-day:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-datepicker-footer { display: flex; justify-content: flex-end; gap: 4px; margin-top: 6px; }
.crwu-ui-datepicker-action {
  padding: 0 8px; height: 28px; border: none; border-radius: var(--crwu-radius-sm);
  background: transparent; color: var(--crwu-interactive); font-family: inherit; font-size: 13px; cursor: pointer;
}
.crwu-ui-datepicker-action:hover:not(:disabled) { background: var(--crwu-interactive-soft); }
.crwu-ui-datepicker-action:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-datepicker-error { margin: 6px 0 0; color: var(--crwu-error-text); font-size: 12px; line-height: 18px; }
@media (pointer: coarse) {
  .crwu-ui-datepicker-control { height: 44px; }
  .crwu-ui-datepicker-nav,
  .crwu-ui-datepicker-day,
  .crwu-ui-datepicker-view-option { min-height: 36px; }
}
@media (max-width: 560px) {
  .crwu-ui-datepicker-input { font-size: 16px; }
}
/* The valuation workface can be narrow inside a wide window; match its container too. */
@container crwu-valuation (max-width: 559px) {
  .crwu-ui-datepicker-input { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-ui-datepicker-control,
  .crwu-ui-datepicker-dialog,
  .crwu-ui-datepicker-input { transition: none; }
}
`
