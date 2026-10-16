/**
 * Shared form field / input / textarea styles. Colours come only from `--crwu-*` tokens.
 * The input wrap owns the 42px field border; the input and its adornments sit inside it.
 */

export const CRWU_FIELD_STYLE_TEXT = `
.crwu-ui-field {
  display: flex; flex-direction: column; gap: var(--crwu-space-2); min-width: 0;
}
.crwu-ui-field-label {
  display: inline-flex; align-items: baseline; gap: 4px; min-width: 0;
  color: var(--crwu-text-primary); font-size: 13px; font-weight: 600; line-height: 18px;
}
.crwu-ui-field-required { color: var(--crwu-brand); }
.crwu-ui-field-required-text {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.crwu-ui-field-hint { margin: 0; color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px; }
.crwu-ui-field-error { margin: 0; color: var(--crwu-error-text); font-size: 12px; line-height: 18px; }

.crwu-ui-input-wrap {
  position: relative; display: flex; align-items: center; gap: 6px;
  box-sizing: border-box; width: 100%; min-width: 0; height: 42px; padding: 0 4px 0 0;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-field-bg);
  transition: border-color 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-ui-input-wrap:hover:not(:focus-within) { border-color: var(--crwu-field-border-hover); }
.crwu-ui-input-wrap:focus-within {
  border-color: var(--crwu-interactive); box-shadow: 0 0 0 3px var(--crwu-interactive-soft);
}
.crwu-ui-input-wrap[data-invalid="true"] { border-color: var(--crwu-risk-a); }
/* Start adornment: 12px inner inset and an 8px glyph-to-text gap. The input drops its own left
   padding so the wrapper gap is not doubled (12px padding + 6px gap reads as 18px). */
.crwu-ui-input-wrap[data-start-adorned="true"] { gap: 8px; padding-left: 12px; }
.crwu-ui-input-wrap[data-start-adorned="true"] > .crwu-ui-input { padding-left: 0; }
/* End adornment keeps the same 12px inner inset on the trailing edge. */
.crwu-ui-input-wrap[data-end-adorned="true"] { padding-right: 12px; }
.crwu-ui-input {
  box-sizing: border-box; flex: 1 1 auto; width: 100%; min-width: 0; height: 100%; padding: 0 12px;
  border: none; border-radius: var(--crwu-radius-md); background: transparent;
  color: var(--crwu-text-primary); font-family: inherit; font-size: 14px; line-height: 20px; outline: none;
}
.crwu-ui-input::placeholder { color: var(--crwu-field-placeholder); }
.crwu-ui-input:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-input:read-only { color: var(--crwu-text-secondary); }
.crwu-ui-input-adornment { display: inline-flex; align-items: center; flex: none; color: var(--crwu-text-secondary); }
.crwu-ui-input-clear {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%;
  background: transparent; color: var(--crwu-text-secondary); cursor: pointer;
}
.crwu-ui-input-clear:hover { background: var(--crwu-hover); color: var(--crwu-text-primary); }
.crwu-ui-input-clear:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--crwu-interactive); }

.crwu-ui-textarea-wrap {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  box-sizing: border-box; width: 100%; min-width: 0;
}
.crwu-ui-textarea {
  box-sizing: border-box; width: 100%; min-width: 0; min-height: 84px; padding: 10px 12px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 14px; line-height: 20px; outline: none; resize: vertical; overflow-y: auto;
  transition: border-color 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-ui-textarea::placeholder { color: var(--crwu-field-placeholder); }
.crwu-ui-textarea:hover:not(:disabled):not(:read-only) { border-color: var(--crwu-field-border-hover); }
.crwu-ui-textarea:focus-visible {
  border-color: var(--crwu-interactive); box-shadow: 0 0 0 3px var(--crwu-interactive-soft);
}
.crwu-ui-textarea[aria-invalid="true"] { border-color: var(--crwu-risk-a); }
.crwu-ui-textarea:disabled { color: var(--crwu-text-tertiary); cursor: not-allowed; }
.crwu-ui-textarea:read-only { background: var(--crwu-surface-subtle); }
.crwu-ui-textarea-count { color: var(--crwu-text-secondary); font-size: 12px; }
@media (pointer: coarse) {
  .crwu-ui-input-wrap { height: 44px; }
}
@media (max-width: 560px) {
  .crwu-ui-input,
  .crwu-ui-textarea { font-size: 16px; }
}
/* The valuation workface can be narrow inside a wide window; match its container too. */
@container crwu-valuation (max-width: 559px) {
  .crwu-ui-input,
  .crwu-ui-textarea { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-ui-input-wrap,
  .crwu-ui-textarea { transition: none; }
}
`
