export const WORKSPACE_CLEANUP_STYLE_TEXT = `
.crwu-environment-cleanup-dialog {
  position: fixed; z-index: 11; inset: 50% auto auto 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; box-sizing: border-box;
  width: 560px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px);
  border: 1px solid var(--crwu-border-strong); border-radius: var(--crwu-radius-lg);
  background: var(--crwu-popover-bg); box-shadow: var(--crwu-shadow-dialog);
  color: var(--crwu-text-primary); color-scheme: var(--crwu-color-scheme); font-size: 13px; line-height: 20px;
  overflow: hidden; outline: none;
  animation: crwu-audit-float-in 160ms var(--crwu-ease) both;
}
.crwu-environment-cleanup-head { flex: none; padding: 20px 24px 16px; border-bottom: 1px solid var(--crwu-border); }
.crwu-environment-cleanup-title { display: flex; align-items: center; gap: 10px; }
.crwu-environment-cleanup-title h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 24px; }
.crwu-environment-cleanup-warning {
  display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0;
  color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px;
}
.crwu-environment-cleanup-warning svg { flex: none; margin-top: 1px; color: var(--crwu-danger-bg); }
.crwu-environment-cleanup-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 16px; padding: 18px 24px 20px;
  overflow-wrap: anywhere;
}
.crwu-environment-cleanup-section { flex: none; min-width: 0; }
.crwu-environment-cleanup-label { font-size: 12px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-environment-cleanup-path {
  display: flex; align-items: flex-start; gap: 8px; margin-top: 6px;
  font-size: 12px; line-height: 19px; color: var(--crwu-text-secondary);
}
.crwu-environment-cleanup-path svg { flex: none; margin-top: 1px; }
.crwu-environment-cleanup-path span { min-width: 0; overflow-wrap: anywhere; }
.crwu-environment-cleanup-stats {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 12px 0; border-top: 1px solid var(--crwu-border); font-size: 12px; color: var(--crwu-text-secondary);
}
.crwu-environment-cleanup-stats > div { min-width: 0; padding: 0 12px; border-left: 1px solid var(--crwu-border); }
.crwu-environment-cleanup-stats > div:first-child { padding-left: 0; border-left: 0; }
.crwu-environment-cleanup-stats strong { color: var(--crwu-text-primary); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.crwu-environment-cleanup-stats span { display: block; font-size: 11px; line-height: 16px; }
.crwu-environment-cleanup-entries {
  list-style: none; margin: 0; padding: 4px 10px; max-height: 144px; overflow-y: auto;
  border: 1px solid var(--crwu-border); border-radius: 8px; background: var(--crwu-surface-subtle);
}
.crwu-environment-cleanup-entries:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-environment-cleanup-entries li {
  display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 6px 0;
  font-size: 12px; line-height: 18px;
}
.crwu-environment-cleanup-entries li + li { border-top: 1px solid var(--crwu-border); }
.crwu-environment-cleanup-entries svg { flex: none; margin-top: 1px; color: var(--crwu-text-secondary); }
.crwu-environment-cleanup-entry-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.crwu-environment-cleanup-entry-meta { flex: none; color: var(--crwu-text-secondary); font-variant-numeric: tabular-nums; }
.crwu-environment-cleanup-session-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.crwu-environment-cleanup-hint { margin: 4px 0 0; color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px; }
.crwu-environment-cleanup-session-head .crwu-environment-cleanup-hint { margin: 0; }
.crwu-environment-cleanup-option {
  display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: start; gap: 9px;
  margin-top: 12px;
}
.crwu-environment-cleanup-option input[type="checkbox"] {
  box-sizing: border-box; width: 16px; height: 16px; min-width: 16px; margin: 2px 0 0;
  accent-color: var(--crwu-interactive); cursor: pointer;
}
.crwu-environment-cleanup-option input:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-environment-cleanup-option label { display: block; font-size: 13px; font-weight: 500; line-height: 20px; cursor: pointer; }
.crwu-environment-cleanup-option .crwu-environment-cleanup-hint { margin-top: 3px; }
.crwu-environment-cleanup-keep {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px;
  padding-top: 12px; border-top: 1px solid var(--crwu-border);
  color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px;
}
.crwu-environment-cleanup-keep > span:first-child { font-weight: 500; color: var(--crwu-text-primary); }
.crwu-environment-cleanup-details { margin-top: -8px; color: var(--crwu-text-secondary); font-size: 12px; line-height: 18px; }
.crwu-environment-cleanup-details summary { padding: 3px 0; cursor: pointer; }
.crwu-environment-cleanup-details summary:hover { color: var(--crwu-text-primary); }
.crwu-environment-cleanup-details summary:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-environment-cleanup-details ul { margin: 6px 0 0; padding-left: 18px; }
.crwu-environment-cleanup-details li + li { margin-top: 4px; }
.crwu-environment-cleanup-confirm { display: flex; flex: none; flex-direction: column; gap: 8px; }
.crwu-environment-cleanup-confirm > label { font-size: 12px; font-weight: 500; color: var(--crwu-text-primary); }
.crwu-environment-cleanup-footer {
  display: flex; flex: none; align-items: center; justify-content: space-between; gap: 8px;
  padding: 14px 24px; border-top: 1px solid var(--crwu-border); background: var(--crwu-surface-subtle);
}
.crwu-environment-cleanup-actions { display: flex; align-items: center; gap: 8px; }
@media (max-width: 420px) {
  .crwu-environment-cleanup-head { padding: 16px; }
  .crwu-environment-cleanup-body { padding: 16px; gap: 14px; }
  .crwu-environment-cleanup-footer { padding: 12px; flex-wrap: wrap; }
  .crwu-environment-cleanup-actions { margin-left: auto; }
  .crwu-environment-cleanup-stats > div { padding: 0 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-environment-cleanup-dialog { animation: none; }
}
`
