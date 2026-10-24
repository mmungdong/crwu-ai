/**
 * Redesigned valuation experience styles (prototype baseline 2026-10-23).
 *
 * Uses the approved market-workface palette tokens (--mv-*) so light and dark both work,
 * and keeps all rules module-scoped under the workbench scope.
 */
export const VALUATION_EXPERIENCE_STYLE_TEXT = `
[data-crwu-scope="workbench"].ve-experience-root {
  width: 100%;
  height: 100%; min-height: 0; display: flex; flex-direction: column;
  color: var(--mv-fg); background: var(--mv-bg);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13.5px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}
.ve-experience-root *, .ve-experience-root *::before, .ve-experience-root *::after { box-sizing: border-box; }
.ve-experience-root button, .ve-experience-root input, .ve-experience-root select, .ve-experience-root textarea { font: inherit; color: inherit; }
.ve-experience-root button { cursor: pointer; }
.ve-overview, .ve-stage, .ve-center, .ve-infoBody, .ve-docList, .ve-rail { overscroll-behavior: contain; }
.ve-overview::-webkit-scrollbar, .ve-stage::-webkit-scrollbar, .ve-center::-webkit-scrollbar, .ve-infoBody::-webkit-scrollbar, .ve-docList::-webkit-scrollbar, .ve-rail::-webkit-scrollbar { width: 8px; height: 8px; }
.ve-overview::-webkit-scrollbar-thumb, .ve-stage::-webkit-scrollbar-thumb, .ve-center::-webkit-scrollbar-thumb, .ve-infoBody::-webkit-scrollbar-thumb, .ve-docList::-webkit-scrollbar-thumb, .ve-rail::-webkit-scrollbar-thumb { background: var(--mv-control); border: 2px solid transparent; border-radius: 999px; background-clip: content-box; }
.ve-overview::-webkit-scrollbar-thumb:hover, .ve-stage::-webkit-scrollbar-thumb:hover, .ve-center::-webkit-scrollbar-thumb:hover, .ve-infoBody::-webkit-scrollbar-thumb:hover, .ve-docList::-webkit-scrollbar-thumb:hover, .ve-rail::-webkit-scrollbar-thumb:hover { background: var(--mv-line-strong); background-clip: content-box; }
.ve-overview::-webkit-scrollbar-track, .ve-stage::-webkit-scrollbar-track, .ve-center::-webkit-scrollbar-track, .ve-infoBody::-webkit-scrollbar-track, .ve-docList::-webkit-scrollbar-track, .ve-rail::-webkit-scrollbar-track { background: transparent; }
.ve-experience-root [disabled] { cursor: not-allowed; }
.ve-experience-root ::selection { background: var(--mv-accent-soft); color: var(--mv-fg); }
.ve-experience-root svg { flex: none; }
.ve-muted { color: var(--mv-muted); font-weight: 400; }
.ve-faint { color: var(--mv-muted); }
.ve-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--crwu-brand); opacity: .75; flex: none; }

/* ---------- buttons ---------- */
.ve-btn {
  min-height: 36px; padding: 0 14px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  border: 1px solid transparent; border-radius: 8px; font-family: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.25;
  white-space: nowrap; transition: background .14s var(--crwu-ease), border-color .14s var(--crwu-ease), color .14s var(--crwu-ease);
}
.ve-btnPrimary { background: var(--mv-accent); border-color: var(--mv-accent); color: var(--mv-on-accent); }
.ve-btnPrimary:hover:not(:disabled) { background: var(--mv-accent-hover); border-color: var(--mv-accent-hover); }
.ve-btnSecondary { background: var(--mv-surface); border-color: var(--mv-line-strong); color: var(--mv-fg); }
.ve-btnSecondary:hover:not(:disabled) { background: var(--mv-hover); }
.ve-btn:disabled { opacity: .45; }
.ve-btnSm { min-height: 30px; padding: 0 10px; font-size: 11.5px; font-weight: 500; border-radius: 7px; }
.ve-btn:focus-visible, .ve-textBtn:focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 2px; }
.ve-btn.is-block { width: 100%; margin-top: 10px; }
.ve-textBtn {
  min-height: 26px; padding: 0; border: 0; background: transparent; color: var(--mv-accent);
  display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 500; border-radius: 4px;
}
.ve-textBtn:hover:not(:disabled) { color: var(--mv-accent-hover); text-decoration: underline; text-underline-offset: 3px; }
.ve-textBtn.is-muted { color: var(--mv-muted); }
.ve-textBtn.is-muted:hover:not(:disabled) { color: var(--mv-fg); }
.ve-textBtn.is-block { width: 100%; justify-content: center; margin-top: 8px; }
.ve-textBtn:disabled { opacity: .45; }
.ve-iconBtn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--mv-muted); }
.ve-iconBtn:hover { background: var(--mv-hover); color: var(--mv-fg); }
.ve-experience-root :where(button, a, input, select, textarea, summary):focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 2px; border-radius: 6px; }

/* ---------- panels / pills / banners ---------- */
.ve-panel { background: var(--mv-surface); border: 1px solid var(--mv-line); border-radius: 12px; box-shadow: var(--mv-shadow); overflow: hidden; }
.ve-panelHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 14px 16px 12px; border-bottom: 1px solid var(--mv-line); }
.ve-panelHead.is-sub { border-top: 1px solid var(--mv-line); }
.ve-panelHead h2 { margin: 0; color: var(--mv-fg); font-size: 14px; font-weight: 600; line-height: 1.4; }
.ve-panelHead p { margin: 3px 0 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.5; }
.ve-panelSide { display: flex; align-items: center; gap: 6px; flex: none; padding-top: 1px; }
.ve-panelPad { padding: 14px 16px 16px; }
.ve-panelPad.is-tight { padding-top: 10px; }
.ve-pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid var(--mv-line); border-radius: 999px; background: var(--mv-soft); color: var(--mv-muted); font-size: 10.5px; font-weight: 500; line-height: 1; white-space: nowrap; }
.ve-pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .75; }
.ve-pill.is-accent { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-pill.is-success { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-pill.is-warn { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-pill.is-muted { background: var(--mv-soft); color: var(--mv-muted); }
.ve-chip { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 7px; border: 1px solid var(--mv-line); border-radius: 5px; background: var(--mv-soft); color: var(--mv-muted); font-size: 10px; white-space: nowrap; }
.ve-chip.is-demo { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.ve-miniTag { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border-radius: 4px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9.5px; line-height: 1; white-space: nowrap; }
.ve-miniTag.is-warn { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-miniTag.is-ok { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-banner { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--mv-line); border-radius: 9px; background: var(--mv-soft); color: var(--mv-muted); font-size: 11.5px; line-height: 1.65; }
.ve-banner > svg { margin-top: 2px; color: var(--mv-muted); }
.ve-banner strong { color: var(--mv-fg); font-weight: 600; }
.ve-banner.is-accent { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-text); }
.ve-banner.is-accent > svg { color: var(--mv-accent); }
.ve-banner.is-warn { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-banner.is-warn > svg { color: var(--mv-warn); }
.ve-banner.is-success { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-banner.is-success > svg { color: var(--mv-success); }
.ve-banner .ve-textBtn { margin-left: auto; white-space: nowrap; }
.ve-note { margin: 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.6; }
.ve-note.is-padded { margin: 12px 4px 0; }
.ve-calcNote { margin: 7px 0 0; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-calcNote.is-padded { padding: 0 16px 10px; }
.ve-emptyInline { padding: 24px 16px; text-align: center; color: var(--mv-muted); font-size: 10.5px; line-height: 1.6; }
.ve-spacer { flex: 1; }
.ve-stack { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.ve-stack.is-top { margin-top: 12px; }
.ve-actionsLeft { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }

/* ---------- summary strips ---------- */
.ve-summaryStrip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--mv-line); border-radius: 10px; background: var(--mv-surface); box-shadow: var(--mv-shadow); overflow: hidden; margin-bottom: 12px; }
.ve-summaryStrip > div { padding: 10px 12px 11px; border-right: 1px solid var(--mv-line); min-width: 0; }
.ve-summaryStrip > div:last-child { border-right: 0; }
.ve-summaryStrip span { display: block; color: var(--mv-muted); font-size: 9.5px; }
.ve-summaryStrip strong { display: block; margin-top: 1px; color: var(--mv-fg); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-summaryStrip.is-five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.ve-summaryStrip em { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 9px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-statStrip { display: flex; align-items: stretch; margin-bottom: 12px; border: 1px solid var(--mv-line); border-radius: 10px; background: var(--mv-surface); box-shadow: var(--mv-shadow); overflow: hidden; }
.ve-stat { flex: 1; padding: 10px 14px; border-right: 1px solid var(--mv-line); }
.ve-stat:last-child { border-right: 0; }
.ve-stat strong { display: block; color: var(--mv-fg); font-size: 17px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }
.ve-stat span { display: block; color: var(--mv-muted); font-size: 9.5px; margin-top: 1px; }

[data-crwu-scope="workbench"].ve-asset-workflow-root { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ve-asset-workflow-root > .ve-experience-root { flex: 1 1 auto; min-height: 0; }

/* ---------- overview ---------- */
.ve-overview { flex: 1 1 auto; min-height: 0; overflow-y: auto; container-type: inline-size; container-name: ve-overview; padding: clamp(28px, 5vh, 56px) 32px 32px; background: var(--mv-bg); }
.ve-overview > * { width: min(1120px, 100%); margin-left: auto; margin-right: auto; }
.ve-eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 11px; color: var(--mv-muted); font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
.ve-titleRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.ve-titleMain { min-width: 0; }
.ve-projectTitle { margin: 0; color: var(--mv-fg); font-size: clamp(26px, 3vw, 34px); font-weight: 600; line-height: 1.35; }
.ve-projectLede { margin: 8px 0 0; max-width: 620px; color: var(--mv-muted); font-size: 13px; line-height: 1.75; }
.ve-projectStatus { margin-top: 7px; display: inline-flex; align-items: center; gap: 7px; height: 27px; padding: 0 10px; border: 1px solid var(--mv-accent-line); border-radius: 6px; background: var(--mv-accent-soft); color: var(--mv-accent); font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.ve-projectStatus.is-demo, .ve-projectStatus.is-draft { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.ve-projectStatus.is-empty { border-color: var(--mv-line-strong); background: var(--mv-soft); color: var(--mv-muted); }
.ve-ring { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid currentColor; }
.ve-summary { margin: 24px 0 18px; display: grid; grid-template-columns: 1.2fr 1fr 1fr; background: var(--mv-surface); border: 1px solid var(--mv-line); border-radius: 10px; box-shadow: var(--mv-shadow); overflow: hidden; }
.ve-summaryItem { padding: 12px 16px; min-width: 0; }
.ve-summaryItem + .ve-summaryItem { border-left: 1px solid var(--mv-line); }
.ve-summaryLabel { display: block; color: var(--mv-muted); font-size: 9.5px; letter-spacing: .04em; margin-bottom: 3px; }
.ve-summaryValue { display: block; color: var(--mv-fg); font-size: 12.5px; font-weight: 500; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-stageCard { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(260px, .72fr); background: var(--mv-surface); border: 1px solid var(--mv-line); border-radius: 14px; box-shadow: var(--mv-shadow); overflow: hidden; }
.ve-stageMain { padding: 30px 34px 28px 35px; min-width: 0; }
.ve-stageMeta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ve-stageNo { font-size: 12px; font-weight: 600; color: var(--mv-accent); letter-spacing: .04em; }
.ve-stageTag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 1px solid var(--mv-accent-line); border-radius: 5px; background: var(--mv-accent-soft); color: var(--mv-accent); font-size: 9.5px; font-weight: 500; }
.ve-stageTitle { margin: 0; color: var(--mv-fg); font-size: 30px; font-weight: 600; line-height: 1.4; }
.ve-stageLede { margin: 9px 0 0; max-width: 540px; color: var(--mv-muted); font-size: 13px; line-height: 1.8; }
.ve-scope { display: flex; flex-wrap: wrap; gap: 7px 16px; margin: 20px 0 0; padding: 0; list-style: none; }
.ve-scope li { display: inline-flex; align-items: center; gap: 6px; color: var(--mv-text); font-size: 11.5px; }
.ve-scope li::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--mv-control); }
.ve-stageActions { display: flex; align-items: center; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
.ve-actionHint { color: var(--mv-muted); font-size: 10.5px; line-height: 1.5; }
.ve-stageSide { padding: 27px 26px 26px; border-left: 1px solid var(--mv-line); background: var(--mv-soft); display: flex; flex-direction: column; }
.ve-sideLabel { margin: 0 0 12px; color: var(--mv-muted); font-size: 9.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.ve-deliverables { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
.ve-deliverables li { display: flex; align-items: flex-start; gap: 9px; color: var(--mv-text); font-size: 11.5px; line-height: 1.62; }
.ve-mark { width: 15px; height: 15px; margin-top: 1px; flex: none; display: grid; place-items: center; border: 1px solid var(--mv-line-strong); border-radius: 50%; color: var(--mv-success); background: var(--mv-surface); }
.ve-sideNote { margin: 18px 0 0; padding-top: 14px; border-top: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 10.5px; line-height: 1.7; }
.ve-pageFoot { margin-top: 26px; padding-top: 22px; display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; color: var(--mv-muted); font-size: 10.5px; line-height: 1.7; }
.ve-pageFoot p { margin: 0; max-width: 760px; }
.ve-level { flex: none; display: inline-flex; align-items: center; gap: 6px; color: var(--mv-muted); }
.ve-level b { color: var(--mv-fg); font-weight: 600; }

/* ---------- intake shell ---------- */
.ve-intake { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--mv-bg); container-type: inline-size; container-name: ve-intake; }
.ve-top { flex: none; border-bottom: 1px solid var(--mv-line); background: var(--mv-surface); }
.ve-topInner { width: min(1320px, calc(100% - 48px)); height: 52px; margin: 0 auto; display: flex; align-items: center; gap: 14px; }
.ve-crumb { display: flex; align-items: center; gap: 7px; color: var(--mv-muted); font-size: 11px; white-space: nowrap; flex: none; }
.ve-crumbLink { padding: 0; border: 0; background: transparent; color: var(--mv-muted); font: inherit; border-radius: 3px; }
.ve-crumbLink:hover { color: var(--mv-fg); text-decoration: underline; text-underline-offset: 3px; }
.ve-sep { opacity: .55; }
.ve-crumbCur { color: var(--mv-fg); font-weight: 500; }
.ve-topTitle { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ve-topTitle h1 { margin: 0; color: var(--mv-fg); font-size: 15px; font-weight: 600; white-space: nowrap; }
.ve-topRight { margin-left: auto; display: flex; align-items: center; gap: 12px; flex: none; }
.ve-saveState { display: inline-flex; align-items: center; gap: 6px; color: var(--mv-muted); font-size: 10.5px; white-space: nowrap; }
.ve-saveDot { width: 5px; height: 5px; border-radius: 50%; background: var(--mv-success); opacity: .8; }
.ve-saveState.is-warn .ve-saveDot { background: var(--mv-warn); }
.ve-stepper { flex: none; height: 64px; border-bottom: 1px solid var(--mv-line); background: var(--mv-soft); }
.ve-stepperInner { width: min(940px, calc(100% - 48px)); height: 100%; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); position: relative; }
.ve-stepperInner::before { content: ""; position: absolute; left: 12%; right: 12%; top: 19px; height: 1px; background: var(--mv-line-strong); }
.ve-step { position: relative; z-index: 1; border: 0; background: transparent; color: var(--mv-muted); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 5px 8px 4px; border-radius: 8px; }
.ve-step:hover:not(:disabled) { background: var(--mv-hover); color: var(--mv-fg); }
.ve-step:disabled { opacity: .55; }
.ve-stepDot { width: 25px; height: 25px; display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--mv-line-strong); background: var(--mv-surface); color: var(--mv-muted); font-size: 10px; font-weight: 500; line-height: 1; }
.ve-stepLabel { font-size: 11px; line-height: 1.35; white-space: nowrap; }
.ve-step.is-active { color: var(--mv-accent); }
.ve-step.is-active .ve-stepDot { background: var(--mv-accent); border-color: var(--mv-accent); color: var(--mv-on-accent); box-shadow: 0 0 0 4px var(--mv-accent-soft); }
.ve-step.is-active .ve-stepLabel { color: var(--mv-fg); font-weight: 600; }
.ve-step.is-done .ve-stepDot { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success); }
.ve-stage { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.ve-canvas { width: min(1320px, calc(100% - 48px)); margin: 0 auto; padding: 22px 0 30px; }
.ve-actionbar { flex: none; height: 72px; border-top: 1px solid var(--mv-line); background: var(--mv-surface); box-shadow: var(--crwu-shadow-footer); }
.ve-actionbarInner { width: min(1320px, calc(100% - 48px)); height: 100%; margin: 0 auto; display: flex; align-items: center; gap: 16px; }
.ve-actionSummary { min-width: 0; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; color: var(--mv-muted); font-size: 10.5px; }
.ve-actionSummary span { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.ve-actionSummary strong { color: var(--mv-fg); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ve-actionSep { width: 1px; height: 13px; background: var(--mv-line-strong); display: inline-block; }
.ve-actionRight { margin-left: auto; display: flex; align-items: center; gap: 9px; flex: none; }
.ve-gateHint { color: var(--mv-warn-text); font-size: 10px; line-height: 1.4; max-width: 220px; text-align: right; }

/* ---------- intake pages ---------- */
.ve-pageHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.ve-pageKicker { display: flex; align-items: center; gap: 8px; margin: 0 0 5px; color: var(--mv-muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; }
.ve-pageKicker .ve-pill { letter-spacing: 0; }
.ve-pageTitle { margin: 0; color: var(--mv-fg); font-size: 25px; font-weight: 600; line-height: 1.3; }
.ve-pageLede { margin: 5px 0 0; max-width: 760px; color: var(--mv-muted); font-size: 12.5px; line-height: 1.65; }
.ve-pageActions { display: flex; align-items: center; gap: 8px; flex: none; padding-top: 4px; flex-wrap: wrap; }
.ve-pageActions.is-end { justify-content: flex-end; margin-top: 12px; }
.ve-objectWrap { max-width: 980px; margin: 8px auto 0; }
.ve-objectHero { margin-bottom: 20px; }
.ve-objectHero h2 { margin: 0; color: var(--mv-fg); font-size: 27px; font-weight: 600; line-height: 1.4; }
.ve-objectHero p { margin: 7px 0 0; max-width: 720px; color: var(--mv-muted); font-size: 13px; line-height: 1.75; }
.ve-objectGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.ve-objectCard { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-height: 112px; padding: 16px; border: 1px solid var(--mv-line); border-radius: 12px; background: var(--mv-surface); text-align: left; }
.ve-objectCard:hover:not(:disabled) { border-color: var(--mv-line-strong); box-shadow: var(--mv-shadow); }
.ve-objectCard.is-selected { border-color: var(--mv-accent); box-shadow: 0 0 0 3px var(--mv-accent-soft); background: var(--mv-accent-soft); }
.ve-objectCard:disabled { opacity: .62; background: var(--mv-soft); }
.ve-objectIcon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); margin-bottom: 5px; }
.ve-objectCard.is-selected .ve-objectIcon { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-objectCard strong { color: var(--mv-fg); font-size: 14px; font-weight: 600; }
.ve-objectCard > span:last-child { color: var(--mv-muted); font-size: 11px; line-height: 1.5; }
.ve-objectState { position: absolute; top: 14px; right: 14px; display: inline-flex; align-items: center; gap: 4px; height: 21px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 9.5px; }
.ve-objectCard.is-selected .ve-objectState { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-objectNote { margin-top: 16px; padding: 13px 15px; display: flex; align-items: flex-start; gap: 9px; color: var(--mv-muted); font-size: 11.5px; line-height: 1.65; border-radius: 10px; }
.ve-objectNote > svg { color: var(--mv-accent); margin-top: 1px; }
.ve-workGrid { display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 16px; align-items: start; }
.ve-colMain, .ve-colSide { min-width: 0; display: flex; flex-direction: column; gap: 14px; }

/* ---------- docs ---------- */
.ve-docToolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 11px 14px; border-bottom: 1px solid var(--mv-line); }
.ve-docStats { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ve-statChip { display: inline-flex; align-items: baseline; gap: 4px; height: 23px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 10px; line-height: 1; }
.ve-statChip strong { color: var(--mv-fg); font-size: 11.5px; font-weight: 600; }
.ve-statChip.is-in { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-statChip.is-in strong { color: var(--mv-success-text); }
.ve-statChip.is-dup { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-statChip.is-dup strong { color: var(--mv-warn-text); }
.ve-docList { max-height: 505px; overflow-y: auto; padding: 4px 8px 8px; }
.ve-docList.is-plain { max-height: none; padding: 0; }
.ve-docSource { padding: 7px 0 6px; border-bottom: 1px solid var(--mv-line); }
.ve-docSource:last-child { border-bottom: 0; }
.ve-docSourceHead { display: flex; align-items: center; gap: 7px; padding: 3px 7px 5px; }
.ve-docSourceKind { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border-radius: 4px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9px; }
.ve-docSourceHead strong { color: var(--mv-fg); font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-docSourceCount { color: var(--mv-muted); font-size: 10px; white-space: nowrap; }
.ve-remove { margin-left: auto; }
.ve-tree { padding-left: 2px; }
.ve-treeFolder { margin: 1px 0; }
.ve-treeFolder > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 5px 7px; border-radius: 6px; color: var(--mv-muted); font-size: 11.5px; cursor: pointer; user-select: none; }
.ve-treeFolder > summary::-webkit-details-marker { display: none; }
.ve-treeFolder > summary:hover { background: var(--mv-soft); color: var(--mv-fg); }
.ve-chev { transition: transform .14s var(--crwu-ease); color: var(--mv-muted); }
.ve-treeFolder[open] > summary .ve-chev { transform: rotate(90deg); }
.ve-folderCount { margin-left: auto; color: var(--mv-muted); font-size: 9.5px; }
.ve-treeChildren { margin-left: 13px; padding-left: 9px; border-left: 1px solid var(--mv-line); }
.ve-fileRow { display: flex; align-items: flex-start; gap: 9px; padding: 7px; border-radius: 7px; }
.ve-fileRow:hover { background: var(--mv-soft); }
.ve-fileRow.is-off { background: transparent; }
.ve-fileType { width: 31px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 5px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 8.5px; font-weight: 700; letter-spacing: .06em; }
.ve-fileType.is-pdf { color: var(--mv-danger-text); background: var(--mv-danger-soft); border-color: var(--mv-danger-line); }
.ve-fileType.is-img { color: var(--mv-success-text); background: var(--mv-success-soft); border-color: var(--mv-success-line); }
.ve-fileType.is-doc { color: var(--mv-accent); background: var(--mv-accent-soft); border-color: var(--mv-accent-line); }
.ve-fileType.is-other { color: var(--mv-muted); }
.ve-fileMain { min-width: 0; flex: 1; }
.ve-fileTitle { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ve-fileName { color: var(--mv-fg); font-size: 11.5px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.ve-fileRow.is-off .ve-fileName { color: var(--mv-muted); }
.ve-fileMeta { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; overflow-wrap: anywhere; }
.ve-fileReason { display: block; margin-top: 2px; color: var(--mv-warn-text); font-size: 9.5px; line-height: 1.5; }
.ve-fileSide { display: flex; align-items: center; gap: 6px; flex: none; padding-top: 2px; }
.ve-fileState { height: 19px; display: inline-flex; align-items: center; padding: 0 6px; border-radius: 4px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 9px; white-space: nowrap; }
.ve-fileState.is-in { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-fileState.is-dup { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-fileToggle { min-height: 26px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent; color: var(--mv-accent); font-size: 10.5px; font-weight: 500; }
.ve-fileToggle:hover { background: var(--mv-accent-soft); }
.ve-fileToggle.is-muted { color: var(--mv-muted); }
.ve-docEmpty { padding: 30px 22px 32px; text-align: center; }
.ve-docEmptyIcon { width: 42px; height: 42px; margin: 0 auto 10px; display: grid; place-items: center; border-radius: 11px; background: var(--mv-accent-soft); border: 1px solid var(--mv-accent-line); color: var(--mv-accent); }
.ve-docEmpty h3 { margin: 0; color: var(--mv-fg); font-size: 14px; font-weight: 600; }
.ve-docEmpty p { max-width: 54ch; margin: 5px auto 14px; color: var(--mv-muted); font-size: 11.5px; line-height: 1.65; }
.ve-docEmptyActions { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; }
.ve-listFoot { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 10px; line-height: 1.55; }
.ve-docRow2 { width: 100%; display: flex; align-items: center; gap: 11px; padding: 12px 15px; border: 0; border-bottom: 1px solid var(--mv-line); background: transparent; text-align: left; }
.ve-docRow2:last-child { border-bottom: 0; }
.ve-docRow2:hover { background: var(--mv-soft); }
.ve-docIcon { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); }
.ve-docMain { flex: 1; min-width: 0; }
.ve-docName { display: block; color: var(--mv-fg); font-size: 11.5px; font-weight: 500; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-docMeta { display: block; margin-top: 2px; color: var(--mv-muted); font-size: 9.5px; line-height: 1.45; }
.ve-docSide { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.ve-docFields { color: var(--mv-muted); font-size: 9.5px; white-space: nowrap; }

/* ---------- template / form ---------- */
.ve-templatePanel .ve-panelPad { padding-top: 12px; }
.ve-templateFile { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid var(--mv-line); border-radius: 9px; background: var(--mv-soft); }
.ve-templateMain { min-width: 0; flex: 1; }
.ve-templateMain strong { display: block; color: var(--mv-fg); font-size: 11.5px; font-weight: 600; overflow-wrap: anywhere; }
.ve-templateMain span { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 9.5px; }
.ve-templateActions { display: flex; align-items: center; gap: 4px; flex: none; }
.ve-templateEmpty { display: flex; align-items: center; gap: 12px; }
.ve-templateEmpty p { margin: 0; flex: 1; color: var(--mv-muted); font-size: 11px; line-height: 1.6; }
.ve-templateNote { margin: 8px 0 0; color: var(--mv-muted); font-size: 9.5px; line-height: 1.55; }
.ve-templateName { color: var(--mv-fg); font-size: 13px; font-weight: 600; line-height: 1.45; }
.ve-formPanel .ve-panelPad { padding-top: 13px; }
.ve-field { margin-bottom: 12px; }
.ve-field.is-full { grid-column: 1 / -1; }
.ve-fieldHead { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.ve-fieldHead label, .ve-fieldHead > span:first-child { color: var(--mv-fg); font-size: 11.5px; font-weight: 500; }
.ve-fieldSrc { margin-left: auto; display: inline-flex; align-items: center; height: 17px; padding: 0 5px; border-radius: 4px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 8.5px; white-space: nowrap; }
.ve-fieldSrc.is-user { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-fieldSrc.is-pending { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-input, .ve-select, .ve-textarea { width: 100%; min-height: 38px; border: 1px solid var(--crwu-field-border); border-radius: 8px; background: var(--crwu-field-bg); padding: 0 10px; font-size: 13px; line-height: 1.5; }
.ve-textarea { min-height: 64px; padding: 8px 10px; resize: vertical; }
.ve-input::placeholder, .ve-textarea::placeholder { color: var(--crwu-field-placeholder); }
.ve-input:focus, .ve-select:focus, .ve-textarea:focus { border-color: var(--mv-accent); box-shadow: 0 0 0 3px var(--mv-accent-soft); outline: none; }
.ve-fieldRow { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.ve-infoField { padding: 6px 0; border-radius: 7px; }
.ve-infoField.is-missing .ve-fieldInput { background: var(--mv-warn-soft); }
.ve-infoField.is-hint { border-radius: 7px; }
.ve-methodGroup { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.ve-methodOption { position: relative; min-height: 50px; padding: 7px 8px; border: 1px solid var(--mv-line); border-radius: 8px; background: var(--mv-surface); color: var(--mv-muted); display: flex; flex-direction: column; gap: 1px; cursor: pointer; }
.ve-methodOption input { position: absolute; opacity: 0; pointer-events: none; }
.ve-methodOption strong { color: var(--mv-fg); font-size: 11px; font-weight: 600; line-height: 1.4; }
.ve-methodOption span { color: var(--mv-muted); font-size: 8.5px; line-height: 1.4; }
.ve-methodOption.is-on { border-color: var(--mv-accent); background: var(--mv-accent-soft); box-shadow: 0 0 0 2px var(--mv-accent-soft); }
.ve-methodOption.is-on strong { color: var(--mv-accent); }
.ve-methodOption.is-off { background: var(--mv-soft); opacity: .66; cursor: not-allowed; }
.ve-formNote { margin: 12px 0 0; padding: 9px 10px; border-radius: 8px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 10px; line-height: 1.6; }
.ve-formNote strong { color: var(--mv-fg); }
.ve-sideSummary { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--mv-line); }
.ve-sideSummary div { padding: 10px 8px 11px; text-align: center; border-right: 1px solid var(--mv-line); }
.ve-sideSummary div:last-child { border-right: 0; }
.ve-sideSummary span { display: block; color: var(--mv-muted); font-size: 9px; }
.ve-sideSummary strong { display: block; margin-top: 1px; color: var(--mv-fg); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* ---------- review ---------- */
.ve-reviewGrid { display: grid; grid-template-columns: minmax(0, 1fr) 424px; gap: 16px; align-items: start; }
.ve-reviewMain, .ve-reviewSide { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.ve-reviewSection { margin-bottom: 14px; }
.ve-reviewSection:last-child { margin-bottom: 0; }
.ve-reviewList { padding: 4px 8px 6px; }
.ve-reviewDoc { display: flex; align-items: flex-start; gap: 9px; padding: 8px 7px; border-bottom: 1px solid var(--mv-line); }
.ve-reviewDoc:last-child { border-bottom: 0; }
.ve-reviewDocMain { min-width: 0; flex: 1; }
.ve-reviewDocMain strong { display: block; color: var(--mv-fg); font-size: 11px; font-weight: 500; overflow-wrap: anywhere; }
.ve-reviewDocMain span { display: block; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-reviewDocSide { flex: none; }
.ve-metaList { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 16px; padding: 12px 16px; }
.ve-metaList div { min-width: 0; padding: 4px 0; border-bottom: 1px dashed var(--mv-line); }
.ve-metaList .is-wide { grid-column: 1 / -1; }
.ve-metaList span { display: block; color: var(--mv-muted); font-size: 9px; }
.ve-metaList strong { display: block; color: var(--mv-fg); font-size: 11px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
.ve-compareWrap { overflow: hidden; }
.ve-compare { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ve-compare th { padding: 7px 9px; border-bottom: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 9px; font-weight: 600; text-align: left; letter-spacing: .03em; }
.ve-compare td { padding: 9px; border-bottom: 1px solid var(--mv-line); vertical-align: top; color: var(--mv-muted); font-size: 10.5px; line-height: 1.55; overflow-wrap: anywhere; }
.ve-compare tr:last-child td { border-bottom: 0; }
.ve-cField { width: 15%; color: var(--mv-fg); font-weight: 500; }
.ve-cSource { width: 38%; }
.ve-cUser { width: 27%; }
.ve-cUse { width: 20%; }
.ve-value { color: var(--mv-fg); font-size: 11px; font-weight: 500; }
.ve-quote { display: block; margin-top: 2px; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-srcMeta { display: block; margin-top: 3px; color: var(--mv-muted); font-size: 9px; }
.ve-none { color: var(--mv-muted); font-size: 10px; }
.ve-use { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 9px; }
.ve-use.is-conflict { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-conflictCard { border-color: var(--mv-warn-line); box-shadow: 0 0 0 3px var(--mv-warn-soft), var(--mv-shadow); margin-bottom: 14px; }
.ve-conflictHead { display: flex; align-items: flex-start; gap: 11px; padding: 14px 16px 10px; }
.ve-conflictIcon { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--mv-warn-soft); border: 1px solid var(--mv-warn-line); color: var(--mv-warn); }
.ve-conflictHead h2 { margin: 0; color: var(--mv-fg); font-size: 14px; font-weight: 600; }
.ve-conflictHead p { margin: 3px 0 0; color: var(--mv-muted); font-size: 11px; line-height: 1.65; }
.ve-conflictOptions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding: 0 16px 11px; }
.ve-conflictOpt { position: relative; display: flex; align-items: flex-start; gap: 9px; padding: 10px 11px; border: 1px solid var(--mv-line); border-radius: 9px; background: var(--mv-surface); cursor: pointer; }
.ve-conflictOpt:hover { border-color: var(--mv-line-strong); }
.ve-conflictOpt.is-on { border-color: var(--mv-warn); background: var(--mv-warn-soft); box-shadow: 0 0 0 2px var(--mv-warn-soft); }
.ve-conflictOpt input { margin: 2px 0 0; accent-color: var(--mv-warn); flex: none; }
.ve-conflictOptMain { min-width: 0; display: flex; flex-direction: column; }
.ve-conflictOptMain em { color: var(--mv-muted); font-size: 9px; font-style: normal; }
.ve-conflictOptMain strong { color: var(--mv-fg); font-size: 16px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }
.ve-conflictOptMain small { margin-top: 2px; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-conflictOptMain q { display: block; margin-top: 4px; color: var(--mv-muted); font-size: 9px; line-height: 1.5; }
.ve-conflictFoot { padding: 0 16px 13px; color: var(--mv-muted); font-size: 9.5px; line-height: 1.6; }
.ve-coverage { padding: 5px 10px 9px; }
.ve-coverageLegend { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 5px 4px 8px; color: var(--mv-muted); font-size: 8.5px; }
.ve-coverageLegend span { display: inline-flex; align-items: center; gap: 3px; }
.ve-legendDot { width: 6px; height: 6px; border-radius: 50%; background: var(--mv-control); }
.ve-legendDot.is-read { background: var(--mv-success); }
.ve-legendDot.is-blank { background: var(--mv-line-strong); }
.ve-legendDot.is-unread { background: var(--mv-warn); }
.ve-legendDot.is-reg { background: var(--mv-accent); }
.ve-coverageRow { padding: 8px 4px 9px; border-bottom: 1px solid var(--mv-line); }
.ve-coverageRow:last-child { border-bottom: 0; }
.ve-coverageTop { display: flex; align-items: baseline; gap: 8px; }
.ve-coverageTop strong { min-width: 0; color: var(--mv-fg); font-size: 10.5px; font-weight: 500; overflow-wrap: anywhere; }
.ve-coverageTop span { margin-left: auto; flex: none; color: var(--mv-muted); font-size: 8.5px; }
.ve-pageChips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
.ve-pageChip { min-width: 22px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--mv-line); border-radius: 4px; background: var(--mv-soft); color: var(--mv-muted); font-size: 8px; line-height: 1; }
.ve-pageChip.is-read { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success-text); }
.ve-pageChip.is-blank { background: var(--mv-soft); color: var(--mv-muted); }
.ve-pageChip.is-unread { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-pageChip.is-reg { background: var(--mv-accent-soft); border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-coverageNote { margin: 4px 0 0; color: var(--mv-muted); font-size: 8.5px; line-height: 1.5; }
.ve-readingBadge { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--mv-success-line); background: var(--mv-success-soft); color: var(--mv-success-text); font-size: 9px; }
.ve-readingBadge.is-pending { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.ve-handoffNote { padding: 11px 14px; border-top: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9.5px; line-height: 1.6; }
.ve-postNote { padding-top: 12px; color: var(--mv-muted); font-size: 11px; line-height: 1.7; }
.ve-postNote strong { color: var(--mv-fg); }

/* ---------- workspace shell ---------- */
.ve-workspace { flex: 1 1 auto; min-height: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--mv-bg); container-type: inline-size; container-name: ve-workspace; }
.ve-wsTop { flex: none; height: 54px; display: flex; align-items: center; gap: 14px; padding: 0 18px; border-bottom: 1px solid var(--mv-line); background: var(--mv-surface); }
.ve-tbProject { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--mv-muted); }
.ve-tbProject > svg { color: var(--mv-muted); }
.ve-tbProjectName { color: var(--mv-fg); font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
.ve-tbProjectChip { height: 20px; display: inline-flex; align-items: center; padding: 0 7px; border: 1px solid var(--mv-line); border-radius: 5px; background: var(--mv-soft); color: var(--mv-muted); font-size: 10.5px; white-space: nowrap; flex: none; }
.ve-infoToggle { display: none; height: 28px; align-items: center; gap: 6px; padding: 0 9px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-surface); color: var(--mv-muted); font-size: 11.5px; }
.ve-modeChip { height: 28px; display: inline-flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid var(--mv-line); border-radius: 999px; background: var(--mv-surface); color: var(--mv-muted); font-size: 11px; line-height: 1; }
.ve-modeChip[data-workspace-mode-chip="demo"] { border-color: var(--mv-warn-line); background: var(--mv-warn-soft); color: var(--mv-warn-text); }
.ve-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 224px minmax(0, 1fr) 344px; }
.ve-rail { border-right: 1px solid var(--mv-line); background: var(--mv-soft); overflow-y: auto; padding: 16px 12px 14px; display: flex; flex-direction: column; min-height: 0; }
.ve-railLabel { padding: 0 8px; margin: 0 0 8px; color: var(--mv-muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; }
.ve-railProject { margin: 0 3px 16px; padding: 9px 10px; border: 1px solid var(--mv-line); border-radius: 9px; background: var(--mv-surface); box-shadow: var(--mv-shadow); }
.ve-rpAddr { color: var(--mv-fg); font-size: 11.5px; font-weight: 600; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ve-rpMeta { display: flex; flex-wrap: wrap; gap: 4px 7px; margin-top: 4px; color: var(--mv-muted); font-size: 10px; line-height: 1.5; }
.ve-rpMeta span + span::before { content: "·"; margin-right: 7px; }
.ve-steps { position: relative; display: flex; flex-direction: column; gap: 1px; }
.ve-steps::before { content: ""; position: absolute; left: 19px; top: 20px; bottom: 24px; width: 1px; background: var(--mv-line-strong); }
.ve-navStep { width: 100%; display: flex; align-items: flex-start; gap: 9px; padding: 7px 8px 8px; border: 0; border-radius: 8px; background: transparent; text-align: left; color: var(--mv-muted); position: relative; }
.ve-navStep:hover { background: var(--mv-hover); }
.ve-navStep.is-active { background: var(--mv-surface); box-shadow: 0 0 0 1px var(--mv-line), var(--mv-shadow); }
.ve-navDot { position: relative; z-index: 1; width: 23px; height: 23px; flex: none; display: grid; place-items: center; border: 1px solid var(--mv-line-strong); border-radius: 50%; background: var(--mv-surface); color: var(--mv-muted); font-size: 10px; font-weight: 500; line-height: 1; }
.ve-navStep.is-active .ve-navDot { background: var(--mv-accent); border-color: var(--mv-accent); color: var(--mv-on-accent); box-shadow: 0 0 0 3px var(--mv-accent-soft); }
.ve-navStep.is-done .ve-navDot { background: var(--mv-success-soft); border-color: var(--mv-success-line); color: var(--mv-success); }
.ve-navStep.is-warn .ve-navDot { background: var(--mv-warn-soft); border-color: var(--mv-warn-line); color: var(--mv-warn); }
.ve-navText { min-width: 0; padding-top: 1px; }
.ve-navLabel { display: block; color: var(--mv-fg); font-size: 12px; font-weight: 500; line-height: 1.4; }
.ve-navStep.is-active .ve-navLabel { font-weight: 600; }
.ve-navState { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 10px; line-height: 1.45; }
.ve-navStep.is-warn .ve-navState { color: var(--mv-warn-text); }
.ve-navStep.is-done .ve-navState { color: var(--mv-success-text); }
.ve-navStep.is-active .ve-navState { color: var(--mv-accent); }
.ve-railFoot { margin-top: auto; padding: 14px 3px 0; border-top: 1px solid var(--mv-line); }
.ve-railAction { width: 100%; display: flex; align-items: center; gap: 7px; padding: 8px 9px; border: 1px dashed var(--mv-line-strong); border-radius: 8px; background: transparent; color: var(--mv-muted); font-size: 11px; line-height: 1.4; text-align: left; }
.ve-railAction:hover { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); color: var(--mv-accent); }
.ve-railNote { margin: 9px 4px 0; color: var(--mv-muted); font-size: 9.5px; line-height: 1.6; }
.ve-center { min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative; }
.ve-page { max-width: 900px; margin: 0 auto; padding: 22px 30px 56px; }

/* ---------- workspace docs / check ---------- */
.ve-docsGrid { display: grid; grid-template-columns: minmax(0, 1fr) 268px; gap: 13px; align-items: start; margin-top: 12px; }
.ve-dataRows { display: flex; flex-direction: column; }
.ve-dataRow { width: 100%; display: grid; grid-template-columns: 148px minmax(0, 1fr) 82px; align-items: center; gap: 12px; padding: 10px 16px; border: 0; border-bottom: 1px solid var(--mv-line); background: transparent; text-align: left; }
.ve-dataRow:last-child { border-bottom: 0; }
.ve-dataRow:hover { background: var(--mv-soft); }
.ve-drLabel { color: var(--mv-muted); font-size: 11px; line-height: 1.4; }
.ve-drValue { color: var(--mv-fg); font-size: 11.5px; line-height: 1.45; overflow-wrap: anywhere; }
.ve-drValue.is-missing { color: var(--mv-warn-text); font-style: italic; }
.ve-drSide { display: flex; justify-content: flex-end; }
.ve-dataNote { padding: 10px 16px; border-top: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9.5px; line-height: 1.6; background: var(--mv-soft); }
.ve-srcTag { padding: 1px 0; border: 0; background: transparent; color: var(--mv-muted); font-size: 9.5px; line-height: 1.4; display: inline-flex; align-items: center; gap: 2px; border-bottom: 1px dotted transparent; white-space: nowrap; }
.ve-srcTag:hover { border-bottom-color: currentColor; }
.ve-srcTag.is-material { color: var(--mv-accent); }
.ve-srcTag.is-user { color: var(--mv-muted); }
.ve-srcTag.is-corrected { color: var(--mv-warn-text); }
.ve-srcTag.is-pending { color: var(--mv-warn-text); font-weight: 500; }

/* ---------- plan ---------- */
.ve-planGrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 13px; align-items: start; }
.ve-planGrid.is-single { grid-template-columns: minmax(0, 1fr); }
.ve-planMain { min-width: 0; }
.ve-planCols { display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(0, .82fr); gap: 0 22px; }
.ve-planCol { min-width: 0; }
.ve-planCol .ve-planSection:last-child { border-bottom: 0; }
.ve-planHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 15px 18px 13px; border-bottom: 1px solid var(--mv-line); }
.ve-planMethod { display: flex; align-items: center; gap: 8px; color: var(--mv-fg); font-size: 13px; font-weight: 600; }
.ve-planSub { margin: 3px 0 0; color: var(--mv-muted); font-size: 10px; line-height: 1.5; }
.ve-planBody { padding: 2px 18px 17px; }
.ve-planBody.is-tight { padding-top: 10px; }
.ve-scopeStrip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 12px 0 2px; border: 1px solid var(--mv-line); border-radius: 9px; overflow: hidden; background: var(--mv-line); }
.ve-scopeCell { min-width: 0; padding: 9px 11px; background: var(--mv-soft); }
.ve-scopeCell span { display: block; color: var(--mv-muted); font-size: 9px; line-height: 1.4; }
.ve-scopeCell strong { display: block; margin-top: 2px; color: var(--mv-fg); font-size: 11px; font-weight: 600; line-height: 1.4; }
.ve-scopeCell em { display: block; margin-top: 1px; color: var(--mv-muted); font-size: 9px; font-style: normal; line-height: 1.4; }
.ve-planSection { padding: 13px 0; border-bottom: 1px solid var(--mv-line); }
.ve-planSection:last-of-type { border-bottom: 0; }
.ve-planSectionHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.ve-planSectionHead h3 { margin: 0; color: var(--mv-fg); font-size: 12px; font-weight: 600; line-height: 1.4; }
.ve-planSectionHead p { margin: 2px 0 0; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-inputLine { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
.ve-tin { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; font-size: 10px; line-height: 1.55; }
.ve-tin.is-wide { flex-basis: 100%; }
.ve-tin em { flex: none; color: var(--mv-muted); font-style: normal; font-size: 9px; }
.ve-tin strong { color: var(--mv-fg); font-weight: 500; overflow-wrap: anywhere; }
.ve-tplSatisfied { display: flex; align-items: baseline; gap: 9px; padding: 6px 9px; border: 1px solid var(--mv-line); border-radius: 6px; background: var(--mv-soft); }
.ve-tplSatisfied span { flex: none; color: var(--mv-success-text); font-size: 9px; font-weight: 600; }
.ve-tplSatisfied strong { color: var(--mv-muted); font-size: 10px; font-weight: 500; line-height: 1.5; }
.ve-tplGapList { margin-top: 4px; }
.ve-tplGapRow { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; align-items: start; gap: 9px; padding: 5px 0; border-bottom: 1px dashed var(--mv-line); }
.ve-tplGapRow:last-child { border-bottom: 0; }
.ve-tplGapLabel { color: var(--mv-fg); font-size: 10px; font-weight: 500; line-height: 1.5; }
.ve-tplGapRow p { margin: 0; color: var(--mv-muted); font-size: 9.5px; line-height: 1.5; }
.ve-tplGapRow .ve-miniTag { white-space: nowrap; }
.ve-condGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 16px; }
.ve-condItem { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ve-condItem.is-wide { grid-column: 1 / -1; }
.ve-condItem span { color: var(--mv-muted); font-size: 9px; line-height: 1.45; }
.ve-condItem strong { color: var(--mv-fg); font-size: 10.5px; font-weight: 500; line-height: 1.55; overflow-wrap: anywhere; }
.ve-planEditor { padding: 11px; border: 1px solid var(--mv-accent-line); border-radius: 9px; background: var(--mv-accent-soft); }
.ve-editorRow { margin-bottom: 9px; }
.ve-editorLabel { display: block; margin-bottom: 5px; color: var(--mv-muted); font-size: 9.5px; font-weight: 500; }
.ve-channelChecks, .ve-verifyOptions { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.ve-channelCheck, .ve-verifyOption { display: inline-flex; align-items: center; gap: 5px; color: var(--mv-fg); font-size: 10.5px; cursor: pointer; }
.ve-channelCheck input, .ve-verifyOption input { width: 14px; height: 14px; margin: 0; accent-color: var(--mv-accent); }
.ve-editorGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 9px; }
.ve-editorField { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; min-width: 0; }
.ve-editorGrid .ve-editorField { margin-bottom: 0; }
.ve-editorField > span { color: var(--mv-muted); font-size: 9.5px; font-weight: 500; }
.ve-planInput { width: 100%; min-height: 30px; padding: 5px 8px; border: 1px solid var(--crwu-field-border); border-radius: 6px; background: var(--crwu-field-bg); color: var(--mv-fg); font-size: 11px; line-height: 1.5; outline: 0; }
.ve-planInput:focus { border-color: var(--mv-accent); box-shadow: 0 0 0 3px var(--mv-accent-soft); }
.ve-planTextarea { min-height: 46px; resize: vertical; }
.ve-editorFoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 2px; padding-top: 9px; border-top: 1px dashed var(--mv-accent-line); }
.ve-editorActions { display: inline-flex; align-items: center; gap: 11px; flex: none; }
.ve-flow { display: flex; flex-direction: column; }
.ve-flowStep { display: flex; align-items: flex-start; gap: 9px; padding: 5px 0; }
.ve-flowNum { width: 18px; height: 18px; flex: none; display: grid; place-items: center; margin-top: 1px; border: 1px solid var(--mv-line-strong); border-radius: 50%; color: var(--mv-muted); font-size: 9px; font-weight: 600; }
.ve-flowMain { display: flex; align-items: baseline; gap: 7px; min-width: 0; flex-wrap: wrap; }
.ve-flowMain strong { color: var(--mv-fg); font-size: 10.5px; font-weight: 600; }
.ve-flowMain span { color: var(--mv-muted); font-size: 10px; line-height: 1.55; }
.ve-planBoundary { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 9px 10px; border-radius: 7px; background: var(--mv-warn-soft); border: 1px solid var(--mv-warn-line); color: var(--mv-warn-text); }
.ve-planBoundary > svg { margin-top: 1px; }
.ve-planBoundary p { margin: 0; font-size: 9.5px; line-height: 1.6; }
.ve-planBoundary strong { font-weight: 600; }

/* ---------- confirm ---------- */
.ve-confirmGrid { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 13px; align-items: start; margin-top: 13px; }
.ve-reviewList2 { display: flex; flex-direction: column; }
.ve-reviewRow { display: flex; align-items: flex-start; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--mv-line); }
.ve-reviewRow:last-child { border-bottom: 0; }
.ve-reviewMark { width: 18px; height: 18px; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--mv-success-soft); color: var(--mv-success); margin-top: 1px; }
.ve-reviewMark.is-warn { background: var(--mv-warn-soft); color: var(--mv-warn); }
.ve-reviewMain { min-width: 0; }
.ve-reviewTitle { color: var(--mv-fg); font-size: 11.5px; font-weight: 500; line-height: 1.45; }
.ve-reviewText { margin-top: 1px; color: var(--mv-muted); font-size: 10px; line-height: 1.55; }
.ve-confirmBox { padding: 15px 16px; }
.ve-confirmBox h3 { margin: 0; color: var(--mv-fg); font-size: 13px; font-weight: 600; }
.ve-confirmBox p { margin: 5px 0 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.6; }
.ve-ackRow { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 9px 0; border: 0; background: transparent; text-align: left; margin-top: 6px; }
.ve-ackMark { width: 17px; height: 17px; flex: none; display: grid; place-items: center; border: 1px solid var(--mv-line-strong); border-radius: 4px; background: var(--mv-surface); color: transparent; margin-top: 1px; }
.ve-ackMark.is-on { background: var(--mv-accent); border-color: var(--mv-accent); color: var(--mv-on-accent); }
.ve-ackText { color: var(--mv-muted); font-size: 10.5px; line-height: 1.55; }
.ve-confirmMeta { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; color: var(--mv-muted); font-size: 10px; border-bottom: 1px dashed var(--mv-line); }
.ve-confirmMeta:last-of-type { border-bottom: 0; }
.ve-confirmMeta strong { color: var(--mv-fg); font-weight: 500; }
.ve-successPanel { padding: 28px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.ve-successIcon { width: 46px; height: 46px; border-radius: 50%; background: var(--mv-success-soft); border: 1px solid var(--mv-success-line); display: grid; place-items: center; color: var(--mv-success); margin-bottom: 10px; }
.ve-successTitle { margin: 0; color: var(--mv-fg); font-size: 16px; font-weight: 600; }
.ve-successText { margin: 4px 0 0; color: var(--mv-muted); font-size: 11.5px; line-height: 1.65; max-width: 46ch; }
.ve-successMeta { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 12px; }
.ve-successActions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.ve-calcRow { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 5px 0; color: var(--mv-muted); font-size: 11px; line-height: 1.5; }
.ve-calcVal { color: var(--mv-fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ve-calcVal.is-wrap { white-space: normal; text-align: right; max-width: 62%; }

/* ---------- cases ---------- */
.ve-criteria { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 11px 16px 0; }
.ve-criterion { display: inline-flex; align-items: center; gap: 4px; height: 23px; padding: 0 8px; border-radius: 6px; background: var(--mv-soft); border: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 10px; }
.ve-criterion strong { color: var(--mv-fg); font-weight: 500; }
.ve-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 15px; border-bottom: 1px solid var(--mv-line); flex-wrap: wrap; margin-top: 8px; }
.ve-seg { display: inline-flex; align-items: center; padding: 2px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-soft); }
.ve-seg button { height: 25px; padding: 0 9px; border: 0; border-radius: 5px; background: transparent; color: var(--mv-muted); font-size: 10.5px; white-space: nowrap; }
.ve-seg button:hover { color: var(--mv-fg); }
.ve-seg button.is-active { background: var(--mv-surface); color: var(--mv-fg); font-weight: 500; box-shadow: var(--crwu-shadow-tab); }
.ve-tableWrap { overflow-x: auto; }
.ve-tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
.ve-tbl th { text-align: left; padding: 8px 9px; border-bottom: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9.5px; font-weight: 500; letter-spacing: .03em; white-space: nowrap; background: var(--mv-surface); }
.ve-tbl td { padding: 9px; border-bottom: 1px solid var(--mv-line); vertical-align: middle; color: var(--mv-muted); }
.ve-tbl tr:last-child td { border-bottom: 0; }
.ve-tbl tbody tr:hover td { background: var(--mv-soft); }
.ve-tbl tbody tr.is-adopted td { background: var(--mv-accent-soft); }
.ve-caseName { color: var(--mv-fg); font-size: 11.5px; font-weight: 500; line-height: 1.45; }
.ve-caseSub { color: var(--mv-muted); font-size: 9.5px; line-height: 1.45; margin-top: 1px; }
.ve-adoptBtn { height: 24px; padding: 0 8px; border: 1px solid var(--mv-line-strong); border-radius: 6px; background: var(--mv-surface); color: var(--mv-muted); font-size: 10px; font-weight: 500; white-space: nowrap; }
.ve-adoptBtn:hover { border-color: var(--mv-accent-line); color: var(--mv-accent); }
.ve-adoptBtn.is-on { background: var(--mv-accent); border-color: var(--mv-accent); color: var(--mv-on-accent); }
.ve-num { font-variant-numeric: tabular-nums; }
.ve-cellNote { display: block; color: var(--mv-muted); font-size: 9px; }
.ve-caseMissing { display: block; margin-top: 3px; color: var(--mv-warn-text); font-size: 9px; line-height: 1.4; }
.ve-caseFoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 15px; border-top: 1px solid var(--mv-line); background: var(--mv-soft); }
.ve-caseFootNote { color: var(--mv-muted); font-size: 10px; line-height: 1.45; }
.ve-caseFootNote strong { color: var(--mv-fg); font-weight: 600; }
.ve-ccard { padding: 14px 16px; border-bottom: 1px solid var(--mv-line); }
.ve-ccard:last-child { border-bottom: 0; }
.ve-ccard.is-flagged { box-shadow: inset 3px 0 0 var(--mv-warn); }
.ve-ccardTop { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ve-ccardTitle { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; color: var(--mv-fg); font-size: 12.5px; font-weight: 600; }
.ve-ccardMeta { margin-top: 3px; color: var(--mv-muted); font-size: 10px; line-height: 1.55; }
.ve-ccardPrice { text-align: right; color: var(--mv-fg); font-size: 11.5px; font-variant-numeric: tabular-nums; font-weight: 500; flex: none; }
.ve-ccardPrice span { display: block; color: var(--mv-muted); font-size: 9.5px; font-weight: 400; }
.ve-ccardChecks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; margin-top: 11px; }
.ve-ccheck { display: flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid var(--mv-line); border-radius: 7px; background: var(--mv-soft); color: var(--mv-muted); font-size: 10.5px; text-align: left; }
.ve-ccheck:hover:not(:disabled) { border-color: var(--mv-line-strong); background: var(--mv-surface); }
.ve-ccheck:disabled { opacity: .55; }
.ve-ccheck.is-on { border-color: var(--mv-success-line); background: var(--mv-success-soft); color: var(--mv-success-text); }
.ve-ccheckMark { width: 15px; height: 15px; flex: none; display: grid; place-items: center; border: 1px solid var(--mv-line-strong); border-radius: 50%; background: var(--mv-surface); color: transparent; }
.ve-ccheck.is-on .ve-ccheckMark { background: var(--mv-success); border-color: var(--mv-success); color: var(--mv-on-accent); }
.ve-ccardNote { margin-top: 9px; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; color: var(--mv-muted); font-size: 10px; line-height: 1.55; }
.ve-ccardNote strong { color: var(--mv-muted); font-weight: 500; }
.ve-ccardActions { display: flex; align-items: center; gap: 12px; flex: none; }
.ve-checkFoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--mv-line); background: var(--mv-soft); }
.ve-checkFootText { color: var(--mv-muted); font-size: 10px; line-height: 1.5; }
.ve-checkFootText strong { color: var(--mv-fg); font-weight: 600; }

/* ---------- info panel ---------- */
.ve-infoPanel { border-left: 1px solid var(--mv-line); background: var(--mv-surface); display: flex; flex-direction: column; min-height: 0; position: relative; z-index: 30; }
.ve-infoHead { padding: 14px 16px 0; border-bottom: 1px solid var(--mv-line); flex: none; }
.ve-infoTitleRow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ve-infoTitleRight { display: flex; align-items: center; gap: 6px; }
.ve-infoTitleRow h2 { margin: 0; color: var(--mv-fg); font-size: 14px; font-weight: 600; }
.ve-verChip { display: inline-flex; align-items: center; height: 21px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); font-size: 10px; font-weight: 500; white-space: nowrap; }
.ve-verChip.is-new { border-color: var(--mv-accent-line); background: var(--mv-accent-soft); color: var(--mv-accent); }
.ve-infoSub { margin: 3px 0 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.5; }
.ve-infoClose { display: none; }
.ve-tabs { display: flex; gap: 2px; margin-top: 11px; }
.ve-tab { padding: 8px 8px 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--mv-muted); font-size: 11.5px; font-weight: 500; line-height: 1; white-space: nowrap; }
.ve-tab:hover { color: var(--mv-fg); }
.ve-tab.is-active { color: var(--mv-fg); border-color: var(--mv-accent); font-weight: 600; }
.ve-infoBody { flex: 1; min-height: 0; overflow-y: auto; padding: 13px 16px 24px; }
.ve-fieldGroup { padding: 0 0 4px; }
.ve-fieldGroup + .ve-fieldGroup { margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--mv-line); }
.ve-fieldGroupTitle { margin: 0 0 6px; color: var(--mv-muted); font-size: 9.5px; font-weight: 600; letter-spacing: .08em; }
.ve-fieldHeadInPanel { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ve-fieldLabel { color: var(--mv-muted); font-size: 10.5px; line-height: 1.4; display: flex; align-items: center; gap: 4px; }
.ve-fieldUnit { color: var(--mv-muted); font-size: 9.5px; }
.ve-fieldInput { width: 100%; height: 34px; margin-top: 4px; padding: 0 9px; border: 1px solid var(--crwu-field-border); border-radius: 7px; background: var(--crwu-field-bg); color: var(--mv-fg); font-size: 12.5px; line-height: 1.4; outline: 0; }
.ve-fieldInput:hover { border-color: var(--crwu-field-border-hover); }
.ve-fieldInput:focus { border-color: var(--mv-accent); background: var(--mv-surface); box-shadow: 0 0 0 3px var(--mv-accent-soft); }
.ve-fieldInput:disabled { background: var(--mv-soft); border-color: var(--mv-line); color: var(--mv-muted); opacity: 1; }
.ve-fieldInput::placeholder { color: var(--mv-muted); font-size: 11px; }
.ve-fieldTextarea { height: auto; min-height: 52px; padding: 7px 9px; resize: none; line-height: 1.55; }
.ve-infoField.is-flash { animation: ve-flash 1.1s var(--crwu-ease); }
@keyframes ve-flash { 0% { background: var(--mv-accent-soft); } 100% { background: transparent; } }
.ve-fieldHint { margin: 3px 0 0; color: var(--mv-warn-text); font-size: 9.5px; line-height: 1.45; }
.ve-fieldNote { margin: 3px 0 0; color: var(--mv-muted); font-size: 9px; line-height: 1.45; }
.ve-lastSaved { margin: 0 0 12px; padding: 9px 10px; border: 1px solid var(--mv-accent-line); background: var(--mv-accent-soft); border-radius: 8px; }
.ve-lastSavedTitle { color: var(--mv-accent); font-size: 10px; font-weight: 600; letter-spacing: .04em; }
.ve-lastSavedText { margin: 3px 0 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.55; }
.ve-lastSavedText strong { color: var(--mv-fg); font-weight: 500; }
.ve-infoFoot { flex: none; border-top: 1px solid var(--mv-line); padding: 10px 16px 11px; background: var(--mv-surface); }
.ve-infoFootTop { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ve-infoFootNote { color: var(--mv-muted); font-size: 9.5px; line-height: 1.45; }
.ve-dirtyLine { display: flex; align-items: center; gap: 6px; color: var(--mv-accent); font-size: 10.5px; font-weight: 500; }
.ve-dirtyDot { width: 5px; height: 5px; border-radius: 50%; background: var(--mv-accent); }
.ve-infoFootActions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.ve-infoFootActions.is-end { justify-content: flex-end; }
.ve-infoFootActions .ve-btn { flex: 1; }
.ve-infoHint { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--mv-line); color: var(--mv-muted); font-size: 9.5px; line-height: 1.6; }
.ve-hist { position: relative; padding-left: 2px; }
.ve-histItem { position: relative; padding: 0 0 16px 17px; border-left: 1px solid var(--mv-line); margin-left: 4px; }
.ve-histItem:last-child { padding-bottom: 0; border-left-color: transparent; }
.ve-histItem::before { content: ""; position: absolute; left: -4px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--mv-line-strong); }
.ve-histItem:first-child::before { background: var(--mv-accent); }
.ve-histTop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ve-histVer { color: var(--mv-fg); font-size: 11.5px; font-weight: 600; }
.ve-histTime { color: var(--mv-muted); font-size: 9.5px; white-space: nowrap; }
.ve-histNote { margin: 2px 0 0; color: var(--mv-muted); font-size: 10px; }
.ve-histChanges { margin-top: 5px; display: flex; flex-direction: column; gap: 3px; }
.ve-histChange { color: var(--mv-muted); font-size: 10px; line-height: 1.5; }
.ve-histChange .ve-old { color: var(--mv-muted); text-decoration: line-through; text-decoration-color: var(--mv-line-strong); }
.ve-histChange .ve-new { color: var(--mv-fg); font-weight: 500; }
.ve-basisBlock { padding: 11px 0; border-bottom: 1px solid var(--mv-line); }
.ve-basisBlock:last-child { border-bottom: 0; }
.ve-basisTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ve-basisTitle { margin: 0; color: var(--mv-fg); font-size: 11px; font-weight: 600; }
.ve-basisText { margin: 3px 0 0; color: var(--mv-muted); font-size: 10.5px; line-height: 1.55; }
.ve-basisList { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.ve-basisList li { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; color: var(--mv-muted); font-size: 10.5px; line-height: 1.45; }
.ve-basisList strong { color: var(--mv-fg); font-weight: 500; }
.ve-basisList strong.is-warn { color: var(--mv-warn-text); }
.ve-basisList strong.is-ok { color: var(--mv-success-text); }
.ve-basisList strong.is-muted { color: var(--mv-muted); }
.ve-basisEmpty { margin: 7px 0 0; color: var(--mv-muted); font-size: 10.5px; }

/* ---------- locked / modal / toast ---------- */
.ve-locked { padding: 48px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.ve-lockedIcon { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 12px; border: 1px solid var(--mv-line); background: var(--mv-soft); color: var(--mv-muted); margin-bottom: 10px; }
.ve-lockedTitle { margin: 0; color: var(--mv-fg); font-size: 14px; font-weight: 600; }
.ve-lockedText { margin: 4px 0 0; max-width: 52ch; color: var(--mv-muted); font-size: 11.5px; line-height: 1.7; }
.ve-lockedActions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.ve-modalLayer { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: var(--crwu-scrim); backdrop-filter: blur(2px); }
.ve-modal { width: min(500px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; background: var(--mv-surface); border: 1px solid var(--mv-line); border-radius: 14px; box-shadow: var(--crwu-shadow-dialog); }
.ve-modal.is-wide { width: min(620px, 100%); }
.ve-modalHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 17px 19px 12px; border-bottom: 1px solid var(--mv-line); }
.ve-modalKicker { margin: 0 0 2px; color: var(--mv-muted); font-size: 9.5px; font-weight: 600; letter-spacing: .08em; }
.ve-modalTitle { margin: 0; color: var(--mv-fg); font-size: 15px; font-weight: 600; line-height: 1.4; }
.ve-modalBody { padding: 14px 19px 16px; color: var(--mv-muted); font-size: 11.5px; line-height: 1.7; }
.ve-modalBody p { margin: 0 0 9px; }
.ve-modalBody p:last-child { margin-bottom: 0; }
.ve-modalFoot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 19px 14px; border-top: 1px solid var(--mv-line); background: var(--mv-soft); border-radius: 0 0 14px 14px; }
.ve-modalList { margin: 10px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.ve-modalList li { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px dashed var(--mv-line); color: var(--mv-muted); font-size: 10.5px; line-height: 1.5; }
.ve-modalList li:last-child { border-bottom: 0; }
.ve-modalList strong { color: var(--mv-fg); font-weight: 500; text-align: right; }
.ve-sheetMeta { margin: 0 0 8px; color: var(--mv-muted); font-size: 10.5px; }
.ve-sheetQuote { margin: 10px 0; padding: 10px 12px; border-left: 3px solid var(--mv-accent-line); background: var(--mv-soft); border-radius: 0 7px 7px 0; color: var(--mv-fg); font-size: 12px; line-height: 1.75; }
.ve-sheetCurrent { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 0 0; border-top: 1px solid var(--mv-line); }
.ve-sheetCurrent span { color: var(--mv-muted); font-size: 10px; }
.ve-sheetCurrent strong { color: var(--mv-fg); font-size: 11.5px; font-weight: 500; text-align: right; }
.ve-sheetNote { margin-top: 10px; padding: 8px 10px; border-radius: 7px; background: var(--mv-warn-soft); border: 1px solid var(--mv-warn-line); color: var(--mv-warn-text); font-size: 10px; line-height: 1.6; }
.ve-textarea { width: 100%; min-height: 92px; resize: vertical; padding: 8px 10px; border: 1px solid var(--crwu-field-border); border-radius: 7px; background: var(--crwu-field-bg); color: var(--mv-fg); font-size: 11.5px; line-height: 1.6; outline: 0; }
.ve-textarea:focus { border-color: var(--mv-accent); box-shadow: 0 0 0 3px var(--mv-accent-soft); }
.ve-handoffModal { width: min(460px, 100%); }
.ve-handoffSteps { margin: 12px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
.ve-handoffSteps li { display: flex; align-items: center; gap: 8px; color: var(--mv-muted); font-size: 11px; }
.ve-handoffSteps li > span { width: 17px; height: 17px; display: grid; place-items: center; border: 1px solid var(--mv-line-strong); border-radius: 50%; color: transparent; }
.ve-handoffSteps li.is-done { color: var(--mv-fg); }
.ve-handoffSteps li.is-done > span { background: var(--mv-success); border-color: var(--mv-success); color: var(--mv-on-accent); }
.ve-toast { position: fixed; left: 50%; bottom: 24px; z-index: 120; max-width: min(520px, calc(100vw - 40px)); transform: translateX(-50%) translateY(8px); opacity: 0; pointer-events: none; padding: 9px 14px; border-radius: 8px; background: var(--crwu-tip-bg); color: var(--crwu-tip-text); font-size: 11.5px; line-height: 1.5; text-align: center; box-shadow: var(--crwu-shadow-tip); transition: opacity .18s var(--crwu-ease), transform .18s var(--crwu-ease); }
.ve-toast.is-on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ---------- responsive (panel container) ---------- */
@container ve-intake (max-width: 560px) {
  .ve-input, .ve-select, .ve-textarea, .ve-fieldInput, .ve-planInput { font-size: 16px; }
  .ve-input, .ve-select { min-height: 42px; }
}
@container ve-workspace (max-width: 560px) {
  .ve-input, .ve-select, .ve-textarea, .ve-fieldInput, .ve-planInput { font-size: 16px; }
  .ve-input, .ve-select { min-height: 42px; }
}
@container ve-workspace (max-width: 1180px) {
  .ve-shell { grid-template-columns: 224px minmax(0, 1fr); }
  .ve-infoPanel { position: fixed; top: 54px; right: 0; bottom: 0; width: min(370px, calc(100vw - 40px)); transform: translateX(102%); transition: transform .2s var(--crwu-ease); box-shadow: var(--mv-shadow); z-index: 70; }
  .ve-infoPanel.is-open { transform: none; }
  .ve-infoClose { display: grid; }
  .ve-infoToggle { display: inline-flex; }
  .ve-planGrid { grid-template-columns: 1fr; }
}
@container ve-workspace (max-width: 1040px) {
  .ve-shell { grid-template-columns: 200px minmax(0, 1fr); }
  .ve-page { padding: 20px 22px 52px; }
  .ve-docsGrid { grid-template-columns: 1fr; }
  .ve-confirmGrid { grid-template-columns: 1fr; }
  .ve-tbProjectName { max-width: 260px; }
}
@container ve-workspace (max-width: 900px) {
  .ve-shell { grid-template-columns: 184px minmax(0, 1fr); }
  .ve-wsTop { padding: 0 13px; gap: 10px; }
  .ve-tbProjectChip { display: none; }
  .ve-page { padding: 18px 16px 48px; }
  .ve-pageTitle { font-size: 22px; }
  .ve-pageLede { font-size: 12px; }
  .ve-pageHead { gap: 14px; }
  .ve-summaryStrip, .ve-summaryStrip.is-five { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ve-scopeStrip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ve-planCols { grid-template-columns: 1fr; gap: 0; }
  .ve-editorGrid { grid-template-columns: 1fr; }
  .ve-condGrid { grid-template-columns: 1fr; }
  .ve-ccardChecks { grid-template-columns: 1fr; }
  .ve-statStrip { flex-wrap: wrap; }
  .ve-stat { min-width: 33.33%; }
}
@container ve-workspace (max-width: 720px) {
  .ve-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .ve-rail { border-right: 0; border-bottom: 1px solid var(--mv-line); padding: 8px 10px; overflow: visible; }
  .ve-railLabel, .ve-railProject, .ve-railFoot { display: none; }
  .ve-steps { flex-direction: row; overflow-x: auto; gap: 4px; }
  .ve-steps::before { display: none; }
  .ve-navStep { min-width: 132px; padding: 6px; }
  .ve-navDot { width: 20px; height: 20px; font-size: 9px; }
  .ve-navLabel { font-size: 11px; white-space: nowrap; }
  .ve-navState { font-size: 9px; white-space: nowrap; }
  .ve-infoPanel { top: 0; width: min(340px, calc(100vw - 24px)); }
  .ve-topTitle { display: none; }
  .ve-modeChip { display: none; }
  .ve-topRight .ve-textBtn { display: inline-flex; }
}
@container ve-overview (max-width: 900px) {
  .ve-titleRow { flex-direction: column; gap: 10px; }
  .ve-projectStatus { margin-top: 0; }
  .ve-summary { grid-template-columns: 1fr; margin: 20px 0 14px; }
  .ve-summaryItem + .ve-summaryItem { border-left: 0; border-top: 1px solid var(--mv-line); }
  .ve-stageCard { grid-template-columns: 1fr; }
  .ve-stageSide { border-left: 0; border-top: 1px solid var(--mv-line); }
  .ve-stageTitle { font-size: 26px; }
  .ve-pageFoot { margin-top: 0; flex-direction: column; gap: 6px; }
  .ve-overview { padding: 24px 18px; }
}
@container ve-intake (max-width: 900px) {
  .ve-canvas, .ve-actionbarInner, .ve-topInner, .ve-stepperInner { width: calc(100% - 32px); }
  .ve-workGrid, .ve-reviewGrid { grid-template-columns: 1fr; }
  .ve-colSide, .ve-reviewSide { order: 2; }
  .ve-objectGrid { grid-template-columns: 1fr; }
  .ve-summaryStrip { grid-template-columns: repeat(2, 1fr); }
  .ve-summaryStrip > div:nth-child(2) { border-right: 0; }
  .ve-summaryStrip > div:nth-child(3), .ve-summaryStrip > div:nth-child(4) { border-top: 1px solid var(--mv-line); }
  .ve-conflictOptions { grid-template-columns: 1fr; }
  .ve-metaList { grid-template-columns: 1fr; }
  .ve-actionSummary, .ve-gateHint { display: none; }
  .ve-compareWrap { overflow-x: auto; }
  .ve-compare { min-width: 620px; }
}
@container ve-intake (max-width: 760px) {
  .ve-formPanel .ve-panelPad { display: block; }
  .ve-fieldRow { grid-template-columns: 1fr; }
  .ve-topTitle { display: none; }
  .ve-saveState { display: none; }
  .ve-pageActions { padding-top: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ve-infoField.is-flash { animation: none; }
  .ve-infoPanel, .ve-toast { transition: none; }
}
`
