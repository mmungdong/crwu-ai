/**
 * Prototype-faithful market workface styles.
 *
 * The visual baseline is the approved HTML prototype: white/grey surfaces, operational
 * blue, compact node cards, a right-side questionnaire drawer with a fixed footer.
 * Class names are module-prefixed; the shared scoper prefixes them at install time.
 */
export const MARKET_WORKFACE_STYLE_TEXT = `
[data-crwu-scope="workbench"].mv-root {
  --crwu-drawer-w: 520px;
  box-sizing: border-box;
  min-height: 100%;
  padding: 22px 28px 40px;
  background: var(--mv-bg);
  color: var(--mv-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.mv-root *, .mv-root *::before, .mv-root *::after { box-sizing: border-box; }
.mv-page { width: min(1120px, 100%); margin: 0 auto; }
.mv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.mv-head-main { min-width: 0; }
.mv-title-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mv-title { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 600; letter-spacing: -.015em; color: var(--mv-fg); }
.mv-status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--mv-accent-line); border-radius: 999px; background: var(--mv-accent-soft); color: var(--mv-accent); font-size: 12px; font-weight: 500; white-space: nowrap; }
.mv-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mv-status[data-tone="queued"] { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); color: var(--mv-accent); }
.mv-status[data-tone="done"] { border-color: var(--mv-success-line); background: var(--mv-success-soft); color: var(--mv-success-text); }
.mv-status[data-tone="restricted"] { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.mv-status[data-tone="failed"] { border-color: var(--mv-danger-line); background: var(--mv-danger-soft); color: var(--mv-danger-text); }
.mv-status[data-tone="skipped"] { border-color: var(--mv-line-strong); background: var(--mv-soft); color: var(--mv-muted); }
.mv-sub { margin: 6px 0 0; font-size: 13px; color: var(--mv-muted); }
.mv-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--mv-muted); }
.mv-meta-sep { width: 1px; height: 10px; background: var(--mv-line-strong); }
.mv-action { flex: none; height: 32px; padding: 0 14px; border: 1px solid var(--mv-accent-line); border-radius: 7px; background: var(--mv-surface); color: var(--mv-accent); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.mv-action:hover { background: var(--mv-accent-soft); }
.mv-action:focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 2px; }
.mv-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; border: 1px solid var(--mv-line); border-radius: 8px; background: var(--mv-surface); box-shadow: var(--mv-shadow); overflow: hidden; }
.mv-summary-item { min-height: 72px; padding: 12px 18px; border-left: 1px solid var(--mv-line); }
.mv-summary-item:first-child { border-left: 0; }
.mv-summary-label { display: flex; align-items: center; gap: 6px; color: var(--mv-muted); font-size: 12px; }
.mv-summary-value { margin-top: 5px; color: var(--mv-fg); font-size: 13px; font-weight: 600; }
.mv-summary-sub { margin-top: 1px; color: var(--mv-muted); font-size: 12px; }
.mv-panel { margin-top: 12px; border: 1px solid var(--mv-line); border-radius: 8px; background: var(--mv-surface); box-shadow: var(--mv-shadow); overflow: hidden; }
.mv-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 18px; border-bottom: 1px solid var(--mv-line); }
.mv-panel-title { margin: 0; color: var(--mv-fg); font-size: 13px; font-weight: 600; }
.mv-panel-sub { margin-left: 8px; color: var(--mv-muted); font-size: 12px; font-weight: 400; }
.mv-legend { display: flex; align-items: center; gap: 12px; color: var(--mv-muted); font-size: 11px; }
.mv-legend-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.mv-legend-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--mv-control); }
.mv-legend-dot.done { background: var(--mv-success); }
.mv-legend-dot.current { background: var(--mv-accent); }
.mv-legend-dot.restricted { background: var(--mv-warn); }
.mv-flow { padding: 14px 18px 12px; }
.mv-row { position: relative; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; }
.mv-rail { position: relative; display: flex; justify-content: center; }
.mv-rail::after { content: ""; position: absolute; top: 22px; bottom: -8px; left: 50%; width: 1px; background: var(--mv-line-strong); transform: translateX(-50%); }
.mv-row:last-child .mv-rail::after { display: none; }
.mv-rail-dot { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin-top: 10px; border: 1px solid var(--mv-control); border-radius: 50%; background: var(--mv-surface); color: var(--mv-muted); font-size: 9px; font-weight: 600; line-height: 1; }
.mv-rail-dot.done { border-color: var(--mv-success); background: var(--mv-success); color: var(--mv-on-accent); }
.mv-rail-dot.current { border-color: var(--mv-accent); background: var(--mv-accent); color: var(--mv-on-accent); }
.mv-rail-dot.executing { border-color: var(--mv-accent); background: var(--mv-surface); color: var(--mv-accent); }
.mv-rail-dot.restricted { border-color: var(--mv-warn); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.mv-rail-dot.failed { border-color: var(--mv-danger); background: var(--mv-danger-soft); color: var(--mv-danger-text); }
.mv-rail-dot.skipped { border-style: dashed; }
.mv-cards { min-width: 0; }
.mv-parallel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mv-row + .mv-row { margin-top: 8px; }
.mv-row.mv-parallel { margin-bottom: 8px; }
.mv-row.mv-parallel .mv-rail::after { top: 22px; bottom: -18px; }
.mv-node { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 62px; padding: 9px 12px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-surface); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease; }
.mv-node:hover { background: var(--mv-hover); }
.mv-node:focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 1px; }
.mv-node.current { border-color: var(--mv-accent); background: var(--mv-accent-soft); box-shadow: 0 0 0 1px var(--mv-accent); }
.mv-node.executing { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); }
.mv-node.failed { border-color: var(--mv-danger-line); background: var(--mv-danger-soft); }
.mv-node.restricted { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); }
.mv-node.done { background: var(--mv-surface); }
.mv-node.skipped { border-style: dashed; opacity: .78; }
.mv-node-body { min-width: 0; flex: 1 1 auto; }
.mv-node-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.mv-index { flex: none; color: var(--mv-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; font-weight: 500; }
.mv-node-title { min-width: 0; color: var(--mv-fg); font-size: 13px; font-weight: 500; line-height: 1.4; }
.mv-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border: 1px solid var(--mv-line-strong); border-radius: 3px; background: var(--mv-surface); color: var(--mv-muted); font-size: 10px; line-height: 1; white-space: nowrap; }
.mv-chip.done { border-color: var(--mv-success-line); background: var(--mv-success-soft); color: var(--mv-success-text); }
.mv-chip.waiting { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); color: var(--mv-accent); }
.mv-chip.restricted { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.mv-chip.failed { border-color: var(--mv-danger-line); background: var(--mv-danger-soft); color: var(--mv-danger-text); }
.mv-chip.edge { border-color: transparent; background: transparent; color: var(--mv-muted); font-size: 10px; }
.mv-node-desc { display: block; margin-top: 2px; overflow: hidden; color: var(--mv-text); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.mv-node-end { flex: none; display: flex; align-items: center; gap: 8px; margin-left: auto; }
.mv-node-meta { color: var(--mv-muted); font-size: 11px; white-space: nowrap; }
.mv-chev { color: var(--mv-muted); }
.mv-graph-foot { padding: 0 18px 13px 54px; color: var(--mv-muted); font-size: 11px; line-height: 18px; }
.mv-note { margin: 14px 0 0; color: var(--mv-muted); font-size: 11px; text-align: center; }
.mv-empty { padding: 40px 20px; color: var(--mv-muted); text-align: center; }

/* Drawer body */
.mv-drawer-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.mv-drawer-kicker { color: var(--mv-muted); font-size: 11px; }
.mv-drawer-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 1px solid var(--mv-accent-line); border-radius: 4px; background: var(--mv-accent-soft); color: var(--mv-accent); font-size: 11px; }
.mv-drawer-chip.done { border-color: var(--mv-success-line); background: var(--mv-success-soft); color: var(--mv-success-text); }
.mv-drawer-chip.restricted { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.mv-drawer-chip.failed { border-color: var(--mv-danger-line); background: var(--mv-danger-soft); color: var(--mv-danger-text); }
.mv-lede { margin: 0 0 10px; color: var(--mv-text); font-size: 13px; line-height: 1.65; }
.mv-mini-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 12px; color: var(--mv-muted); font-size: 12px; }
.mv-issues { margin-bottom: 14px; padding: 12px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-soft); }
.mv-issues-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--mv-fg); font-size: 12px; font-weight: 600; }
.mv-issues-count { color: var(--mv-muted); font-weight: 400; }
.mv-issues-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.mv-rec-note { display: flex; gap: 6px; margin: 9px 0 0; color: var(--mv-muted); font-size: 12px; line-height: 1.55; }
.mv-rec-note svg { flex: none; margin-top: 2px; }
.mv-details { margin-top: 4px; }
.mv-details > summary { padding: 5px 0; color: var(--mv-muted); cursor: pointer; font-size: 12px; }
.mv-q { padding: 0; margin: 16px 0 0; border: 0; }
.mv-q + .mv-q { padding-top: 16px; border-top: 1px solid var(--mv-line); }
.mv-q-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mv-q-num { color: var(--mv-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; }
.mv-q-title { color: var(--mv-fg); font-size: 13px; font-weight: 600; }
.mv-q-type { padding: 1px 5px; border: 1px solid var(--mv-line-strong); border-radius: 3px; color: var(--mv-muted); font-size: 10px; }
.mv-q-state { margin-left: auto; color: var(--mv-muted); font-size: 11px; }
.mv-q-state.answered { color: var(--mv-success-text); }
.mv-q-state.warn { color: var(--mv-warn-text); }
.mv-q-help { margin: 4px 0 9px; color: var(--mv-muted); font-size: 12px; line-height: 1.55; }
.mv-case-list { overflow: hidden; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-surface); }
.mv-case-caption { display: flex; align-items: center; justify-content: space-between; padding: 7px 11px; border-bottom: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 11px; }
.mv-case { border-bottom: 1px solid var(--mv-line); }
.mv-case:last-child { border-bottom: 0; }
.mv-case-main { display: flex; align-items: flex-start; gap: 9px; padding: 10px 11px; cursor: pointer; }
.mv-case-main:hover { background: var(--mv-hover); }
.mv-case.checked { background: var(--mv-accent-soft); }
.mv-case.excluded { opacity: .55; }
.mv-case input[type="checkbox"], .mv-other-row input[type="checkbox"], .mv-opt input[type="radio"], .mv-defer input[type="checkbox"] { flex: none; width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--mv-accent); }
.mv-case-id { flex: none; width: 29px; color: var(--mv-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.mv-case-body { min-width: 0; flex: 1 1 auto; }
.mv-case-title { color: var(--mv-fg); font-size: 13px; font-weight: 500; }
.mv-case-area { color: var(--mv-muted); font-weight: 400; }
.mv-tag { display: inline-flex; height: 17px; align-items: center; padding: 0 4px; border-radius: 3px; font-size: 10px; font-weight: 400; vertical-align: 1px; }
.mv-tag.rec { background: var(--mv-accent-soft); color: var(--mv-accent); }
.mv-tag.excluded { background: var(--mv-soft); color: var(--mv-muted); }
.mv-case-meta { display: block; margin-top: 2px; color: var(--mv-muted); font-size: 11px; }
.mv-case-note { display: block; margin-top: 2px; color: var(--mv-muted); font-size: 11px; }
.mv-case-expand { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--mv-muted); cursor: pointer; }
.mv-case-expand:hover { background: var(--mv-hover); }
.mv-case-detail { padding: 0 11px 10px 53px; color: var(--mv-muted); font-size: 11px; }
.mv-case-detail dl { display: grid; gap: 3px; margin: 0; }
.mv-case-detail dl > div { display: flex; gap: 8px; }
.mv-case-detail dt { flex: none; width: 52px; color: var(--mv-muted); }
.mv-case-detail dd { margin: 0; color: var(--mv-text); }
.mv-case-reason { margin: 6px 0 0; }
.mv-case-actions { margin-top: 7px; }
.mv-other-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; padding: 9px 10px; border: 1px dashed var(--mv-line-strong); border-radius: 7px; color: var(--mv-text); font-size: 12px; cursor: pointer; }
.mv-other-row:hover { background: var(--mv-hover); }
.mv-hint { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 11px; }
.mv-other-panel { margin-top: 8px; padding: 10px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-soft); }
.mv-field { display: block; }
.mv-field label, .mv-field > span:first-child { display: block; margin-bottom: 5px; color: var(--mv-text); font-size: 12px; }
.mv-req { color: var(--mv-danger-text); font-size: 10px; }
.mv-textarea, .mv-input { width: 100%; padding: 7px 9px; border: 1px solid var(--mv-control); border-radius: 6px; background: var(--mv-surface); color: var(--mv-fg); font: inherit; font-size: 12px; line-height: 1.5; }
.mv-textarea { min-height: 66px; resize: vertical; }
.mv-textarea:focus, .mv-input:focus { border-color: var(--mv-accent); outline: 2px solid var(--mv-accent-soft); outline-offset: 0; }
.mv-textarea:disabled, .mv-input:disabled { opacity: .6; }
.mv-help { display: block; margin-top: 4px; color: var(--mv-muted); font-size: 11px; }
.mv-error { display: flex; align-items: flex-start; gap: 5px; margin-top: 5px; color: var(--mv-danger-text); font-size: 11px; }
.mv-note-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 7px; padding: 4px 0; border: 0; background: transparent; color: var(--mv-accent); font: inherit; font-size: 12px; cursor: pointer; }
.mv-note-panel { margin-top: 4px; }
.mv-opt-list { display: grid; gap: 6px; }
.mv-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-surface); cursor: pointer; }
.mv-opt:hover { background: var(--mv-hover); }
.mv-opt.selected { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); }
.mv-opt-text { min-width: 0; }
.mv-opt-title { display: block; color: var(--mv-fg); font-size: 12px; font-weight: 500; }
.mv-opt-desc { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 11px; line-height: 1.45; }
.mv-defer { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; padding: 9px 10px; border: 1px solid var(--mv-warn-line); border-radius: 7px; background: var(--mv-warn-soft); cursor: pointer; }
.mv-defer.checked { border-color: var(--mv-warn); }
.mv-defer-title { display: block; color: var(--mv-warn-text); font-size: 12px; font-weight: 500; }
.mv-defer-desc { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 11px; line-height: 1.45; }
.mv-input-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.mv-path-list { display: grid; gap: 6px; margin-top: 8px; }
.mv-path { display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px; border: 1px solid var(--mv-line); border-radius: 7px; cursor: pointer; }
.mv-path.selected { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); }
.mv-path input { margin-top: 2px; accent-color: var(--mv-accent); }
.mv-path-title { display: block; color: var(--mv-fg); font-size: 12px; font-weight: 500; }
.mv-path-desc { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 11px; line-height: 1.45; }
.mv-caveat { display: flex; gap: 8px; margin: 10px 0; padding: 10px; border: 1px solid var(--mv-warn-line); border-radius: 7px; background: var(--mv-warn-soft); color: var(--mv-warn-text); font-size: 12px; }
.mv-caveat strong { display: block; }
.mv-caveat p { margin: 2px 0 0; color: var(--mv-muted); font-size: 11px; }
.mv-result { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--mv-success-line); border-radius: 7px; background: var(--mv-success-soft); }
.mv-result.warn { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); }
.mv-result-title { color: var(--mv-fg); font-size: 12px; font-weight: 600; }
.mv-result-sub { margin-top: 2px; color: var(--mv-muted); font-size: 11px; }
.mv-kv { display: grid; gap: 4px; margin: 10px 0 0; }
.mv-kv > div { display: flex; gap: 10px; font-size: 12px; }
.mv-kv dt { flex: none; width: 76px; color: var(--mv-muted); }
.mv-kv dd { margin: 0; color: var(--mv-text); }
.mv-acc { margin-top: 6px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-surface); }
.mv-acc > summary { padding: 8px 11px; color: var(--mv-text); font-size: 12px; cursor: pointer; list-style: none; }
.mv-acc > summary::-webkit-details-marker { display: none; }
.mv-acc > summary::before { content: "›"; display: inline-block; width: 14px; color: var(--mv-muted); }
.mv-acc[open] > summary::before { content: "⌄"; }
.mv-acc-body { padding: 0 11px 10px 25px; color: var(--mv-text); font-size: 12px; }
.mv-acc-body p { margin: 3px 0; }
.mv-json { max-height: 220px; overflow: auto; margin: 0; padding: 8px; border-radius: 5px; background: var(--mv-soft); color: var(--mv-text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; line-height: 1.5; }
.mv-history { padding: 4px 0; }
.mv-history-item { padding: 7px 0; border-top: 1px solid var(--mv-line); }
.mv-history-item:first-child { border-top: 0; }
.mv-history-head { display: flex; justify-content: space-between; gap: 8px; color: var(--mv-muted); font-size: 10px; }
.mv-history-main { margin-top: 2px; color: var(--mv-text); font-size: 11px; }
.mv-file-list { display: grid; gap: 5px; margin-top: 8px; }
.mv-file-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 1px solid var(--mv-line); border-radius: 6px; background: var(--mv-surface); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mv-file-row:hover { background: var(--mv-hover); }
.mv-file-icon { color: var(--mv-muted); }
.mv-file-text { min-width: 0; flex: 1 1 auto; }
.mv-file-name { display: block; color: var(--mv-fg); font-size: 12px; }
.mv-file-meta { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 10px; }
.mv-file-open { color: var(--mv-accent); font-size: 11px; }
.mv-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.mv-foot-left { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mv-foot-status { display: flex; align-items: center; gap: 4px; color: var(--mv-muted); font-size: 11px; }
.mv-foot-pending { color: var(--mv-muted); font-size: 11px; }
.mv-foot-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.mv-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 13px; border: 1px solid var(--mv-control); border-radius: 6px; background: var(--mv-surface); color: var(--mv-text); font: inherit; font-size: 12px; cursor: pointer; }
.mv-btn:hover { border-color: var(--mv-accent-line); color: var(--mv-accent); }
.mv-btn:focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 2px; }
.mv-btn:disabled { opacity: .5; cursor: default; }
.mv-btn.primary { border-color: var(--mv-accent); background: var(--mv-accent); color: var(--mv-on-accent); }
.mv-btn.primary:hover { border-color: var(--mv-accent-hover); background: var(--mv-accent-hover); color: var(--mv-on-accent); }
.mv-btn.small { height: 28px; padding: 0 10px; }
.mv-btn.danger { border-color: var(--mv-danger-line); color: var(--mv-danger-text); }
.mv-btn.danger:hover { border-color: var(--mv-danger); background: var(--mv-danger-soft); }
.mv-link { padding: 0; border: 0; background: transparent; color: var(--mv-accent); font: inherit; font-size: 12px; cursor: pointer; }
.mv-link:hover { text-decoration: underline; }
.mv-spinner { width: 11px; height: 11px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: mv-spin .75s linear infinite; }
@keyframes mv-spin { to { transform: rotate(360deg); } }
.mv-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  .mv-root { padding: 16px 14px 28px; }
  .mv-head { gap: 10px; }
  .mv-title { font-size: 20px; }
  .mv-action { height: 30px; padding: 0 10px; }
  .mv-summary { grid-template-columns: 1fr; }
  .mv-summary-item { border-left: 0; border-top: 1px solid var(--mv-line); min-height: 60px; }
  .mv-summary-item:first-child { border-top: 0; }
  .mv-legend { display: none; }
  .mv-panel-head { padding: 10px 13px; }
  .mv-flow { padding: 12px 10px 10px; }
  .mv-row { grid-template-columns: 22px minmax(0, 1fr); gap: 7px; }
  .mv-parallel-grid { grid-template-columns: 1fr; gap: 6px; }
  .mv-row.mv-parallel .mv-rail::after { bottom: -12px; }
  .mv-node { min-height: 56px; padding: 8px 9px; }
  .mv-node-end { display: none; }
  .mv-graph-foot { padding-left: 39px; }
  .mv-input-grid { grid-template-columns: 1fr; }
  .mv-foot { flex-wrap: wrap; gap: 6px; }
  .mv-foot-left { flex: 1 1 100%; }
  .mv-foot-actions { width: 100%; justify-content: flex-end; gap: 5px; }
  .mv-btn { padding: 0 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .mv-node, .mv-spinner { transition: none; animation: none; }
}
`
