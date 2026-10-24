/**
 * Style text for the asset-assessment entry and the graph workface (protocol 43).
 *
 * Reuses the existing work paper: DSH semantic tokens, 14px radii, hairline dividers.
 * Responsive via container queries; narrow panels tighten insets before stacking.
 * Module-scoped classes only; no global token changes.
 */
export const ASSET_WORKFLOW_CLASSES = {
  root: 'crwu-asset-workflow',
  overview: 'crwu-asset-workflow-overview',
  hero: 'crwu-asset-workflow-hero',
  eyebrow: 'crwu-asset-workflow-eyebrow',
  title: 'crwu-asset-workflow-title',
  lead: 'crwu-asset-workflow-lead',
  steps: 'crwu-asset-workflow-steps',
  step: 'crwu-asset-workflow-step',
  stepIndex: 'crwu-asset-workflow-step-index',
  stepBody: 'crwu-asset-workflow-step-body',
  stepName: 'crwu-asset-workflow-step-name',
  stepText: 'crwu-asset-workflow-step-text',
  stepAction: 'crwu-asset-workflow-step-action',
  workspace: 'crwu-asset-workflow-workspace',
  head: 'crwu-asset-workflow-head',
  breadcrumb: 'crwu-asset-workflow-breadcrumb',
  workspaceTitle: 'crwu-asset-workflow-workspace-title',
  badge: 'crwu-asset-workflow-badge',
  toolbar: 'crwu-asset-workflow-toolbar',
  toolbarGroup: 'crwu-asset-workflow-toolbar-group',
  content: 'crwu-asset-workflow-content',
  graph: 'crwu-asset-workflow-graph',
  intake: 'crwu-asset-workflow-intake',
  aside: 'crwu-asset-workflow-aside',
  status: 'crwu-asset-workflow-status',
  statusTitle: 'crwu-asset-workflow-status-title',
  error: 'crwu-asset-workflow-error',
  hint: 'crwu-asset-workflow-hint',
  sectionTitle: 'crwu-asset-workflow-section-title',
  capability: 'crwu-asset-workflow-capability',
  preparingGraph: 'crwu-asset-workflow-preparing-graph',
  preparingSkeleton: 'crwu-asset-workflow-preparing-skeleton',
  skeletonLine: 'crwu-asset-workflow-skeleton-line',
  artifacts: 'crwu-asset-workflow-artifacts',
  fileInput: 'crwu-asset-workflow-file-input',
  visuallyHidden: 'crwu-asset-workflow-sr-only',
} as const

/** Stable class names for the Host-projected workflow workface (protocol 43). */
export const VALUATION_WORKFLOW_CLASSES = {
  root: 'crwu-valuation-workflow',
  summary: 'crwu-valuation-workflow-summary',
  statusBadge: 'crwu-valuation-workflow-status',
  badge: 'crwu-valuation-workflow-badge',
  refresh: 'crwu-valuation-workflow-refresh',
  delivery: 'crwu-valuation-workflow-delivery',
  body: 'crwu-valuation-workflow-body',
  main: 'crwu-valuation-workflow-main',
  aside: 'crwu-valuation-workflow-aside',
  panelTitle: 'crwu-valuation-workflow-panel-title',
  blockTitle: 'crwu-valuation-workflow-block-title',
  hint: 'crwu-valuation-workflow-hint',
  mono: 'crwu-valuation-workflow-mono',
  graphPanel: 'crwu-valuation-workflow-graph',
  graphHead: 'crwu-valuation-workflow-graph-head',
  graphSyncing: 'crwu-valuation-workflow-graph-syncing',
  graphNodes: 'crwu-valuation-workflow-graph-nodes',
  graphNodeItem: 'crwu-valuation-workflow-graph-node-item',
  graphNode: 'crwu-valuation-workflow-graph-node',
  graphNodeState: 'crwu-valuation-workflow-graph-node-state',
  graphNodeBody: 'crwu-valuation-workflow-graph-node-body',
  graphStateIcon: 'crwu-valuation-workflow-graph-state-icon',
  graphSpinner: 'crwu-valuation-workflow-graph-spinner',
  graphNodeLabel: 'crwu-valuation-workflow-graph-node-label',
  graphNodeMeta: 'crwu-valuation-workflow-graph-node-meta',
  graphStage: 'crwu-valuation-workflow-graph-stage',
  graphState: 'crwu-valuation-workflow-graph-state',
  graphEdge: 'crwu-valuation-workflow-graph-edge',
  graphEdgeLine: 'crwu-valuation-workflow-graph-edge-line',
  graphEdgeLabel: 'crwu-valuation-workflow-graph-edge-label',
  detail: 'crwu-valuation-workflow-detail',
  detailHead: 'crwu-valuation-workflow-detail-head',
  detailLoading: 'crwu-valuation-workflow-detail-loading',
  loadingSpinner: 'crwu-valuation-workflow-loading-spinner',
  metaText: 'crwu-valuation-workflow-meta',
  nodeId: 'crwu-valuation-workflow-node-id',
  session: 'crwu-valuation-workflow-session',
  block: 'crwu-valuation-workflow-block',
  fields: 'crwu-valuation-workflow-fields',
  fieldRow: 'crwu-valuation-workflow-field',
  fieldLabel: 'crwu-valuation-workflow-field-label',
  fieldValue: 'crwu-valuation-workflow-field-value',
  fieldKind: 'crwu-valuation-workflow-field-kind',
  fieldSource: 'crwu-valuation-workflow-field-source',
  input: 'crwu-valuation-workflow-input',
  sourceItem: 'crwu-valuation-workflow-source',
  sourcePath: 'crwu-valuation-workflow-source-path',
  knowledgeItem: 'crwu-valuation-workflow-knowledge',
  gapItem: 'crwu-valuation-workflow-gap',
  rawDetails: 'crwu-valuation-workflow-raw',
  rawPre: 'crwu-valuation-workflow-raw-pre',
  revision: 'crwu-valuation-workflow-revision',
  revisionField: 'crwu-valuation-workflow-revision-field',
  stale: 'crwu-valuation-workflow-stale',
  submit: 'crwu-valuation-workflow-submit',
  retry: 'crwu-valuation-workflow-retry',
  retryField: 'crwu-valuation-workflow-retry-field',
  retryInput: 'crwu-valuation-workflow-retry-input',
  global: 'crwu-valuation-workflow-global',
  globalHead: 'crwu-valuation-workflow-global-head',
  globalList: 'crwu-valuation-workflow-global-list',
  globalItem: 'crwu-valuation-workflow-global-item',
  globalLabel: 'crwu-valuation-workflow-global-label',
  globalValue: 'crwu-valuation-workflow-global-value',
  globalActions: 'crwu-valuation-workflow-global-actions',
  planPanel: 'crwu-valuation-workflow-plan',
  planMeta: 'crwu-valuation-workflow-plan-meta',
  planSources: 'crwu-valuation-workflow-plan-sources',
  planSource: 'crwu-valuation-workflow-plan-source',
  planSourceHead: 'crwu-valuation-workflow-plan-source-head',
  planSourceName: 'crwu-valuation-workflow-plan-source-name',
  planTemplate: 'crwu-valuation-workflow-plan-template',
  planList: 'crwu-valuation-workflow-plan-list',
  planItem: 'crwu-valuation-workflow-plan-item',
  planLabel: 'crwu-valuation-workflow-plan-label',
  planValue: 'crwu-valuation-workflow-plan-value',
  planLink: 'crwu-valuation-workflow-plan-link',
  planActions: 'crwu-valuation-workflow-plan-actions',
  confirm: 'crwu-valuation-workflow-plan-confirm',
  clarify: 'crwu-valuation-workflow-clarification',
  clarifyList: 'crwu-valuation-workflow-clarification-list',
  clarifyQuestion: 'crwu-valuation-workflow-question',
  clarifyPrompt: 'crwu-valuation-workflow-question-prompt',
  clarifyRow: 'crwu-valuation-workflow-answer',
  answerGroup: 'crwu-valuation-workflow-answer-group',
  answerOption: 'crwu-valuation-workflow-answer-option',
  answerInput: 'crwu-valuation-workflow-answer-input',
  answerSelect: 'crwu-valuation-workflow-answer-select',
  clarifyActions: 'crwu-valuation-workflow-clarification-actions',
  answerSubmit: 'crwu-valuation-workflow-answer-submit',
  modernAnswer: 'crwu-valuation-workflow-modern-answer',
  candidates: 'crwu-valuation-workflow-candidates',
  candidate: 'crwu-valuation-workflow-candidate',
  marketSummary: 'crwu-valuation-workflow-market-summary',
  questionBody: 'crwu-valuation-workflow-question-body',
  questionFooter: 'crwu-valuation-workflow-question-footer',
  result: 'crwu-valuation-workflow-result',
} as const

export const WORKFLOW_STYLE_TEXT = `
/* Entry shell */
.crwu-asset-workflow {
  display: flex; flex-direction: column; gap: 0;
  width: 100%; max-width: 1120px; margin: 0 auto;
  height: 100%; min-height: 0; box-sizing: border-box;
  container-type: inline-size; container-name: crwu-asset-workflow;
  color: var(--crwu-text-body);
  --crwu-asset-workflow-inset: 24px;
}
.crwu-asset-workflow [hidden] { display: none; }
.crwu-asset-workflow-sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* Business overview: only real business steps are listed */
.crwu-asset-workflow-overview {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 32px var(--crwu-asset-workflow-inset) 40px;
  display: flex; flex-direction: column; gap: var(--crwu-space-6, 24px);
}
.crwu-asset-workflow-hero { display: flex; flex-direction: column; gap: 6px; }
.crwu-asset-workflow-eyebrow {
  margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--crwu-text-secondary);
}
.crwu-asset-workflow-title { margin: 0; font-size: 22px; line-height: 30px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-asset-workflow-lead { margin: 0; font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); max-width: 640px; }
.crwu-asset-workflow-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.crwu-asset-workflow-step {
  display: flex; align-items: center; gap: 16px; min-width: 0;
  padding: 18px 20px; box-sizing: border-box;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-xl, 14px);
  background: var(--crwu-surface);
  box-shadow: var(--crwu-shadow-surface);
  transition: border-color 140ms var(--crwu-ease), background-color 140ms var(--crwu-ease);
}
.crwu-asset-workflow-step:hover { border-color: var(--crwu-border-strong); background: var(--crwu-surface); }
.crwu-asset-workflow-step-index {
  flex: none; font-family: var(--crwu-font-mono); font-size: 12px;
  color: var(--crwu-text-secondary); letter-spacing: 0.06em;
}
.crwu-asset-workflow-step-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.crwu-asset-workflow-step-name { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-asset-workflow-step-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
.crwu-asset-workflow-step-action { flex: none; }

/* Graph workface */
.crwu-asset-workflow-workspace {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
}
.crwu-asset-workflow-head {
  flex: none; display: flex; align-items: center; gap: 12px; min-width: 0;
  padding: 16px var(--crwu-asset-workflow-inset) 12px;
  border-bottom: 1px solid var(--crwu-border);
}
.crwu-asset-workflow-breadcrumb {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  padding: 4px 6px; margin-left: -6px; border-radius: var(--crwu-radius-sm, 8px);
  font: inherit; font-size: 13px; color: var(--crwu-text-secondary);
  transition: background-color 140ms var(--crwu-ease), color 140ms var(--crwu-ease);
}
.crwu-asset-workflow-breadcrumb:hover { background: var(--crwu-hover); color: var(--crwu-text-primary); }
.crwu-asset-workflow-breadcrumb:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-asset-workflow-workspace-title { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-asset-workflow-badge {
  margin-left: auto; flex: none; font-size: 12px; line-height: 18px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--crwu-border); background: var(--crwu-surface-subtle);
  color: var(--crwu-text-secondary);
}
.crwu-asset-workflow-toolbar {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 12px var(--crwu-asset-workflow-inset);
  border-bottom: 1px solid var(--crwu-border);
}
.crwu-asset-workflow-toolbar-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.crwu-asset-workflow-toolbar-group:last-child { margin-left: auto; }
.crwu-asset-workflow-content {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 16px var(--crwu-asset-workflow-inset) 28px;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px;
  align-content: start;
}
.crwu-asset-workflow-graph { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.crwu-asset-workflow-intake { min-width: 0; display: flex; flex-direction: column; min-height: 420px; }
.crwu-asset-workflow-aside { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.crwu-asset-workflow-section-title {
  margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--crwu-text-primary);
}
.crwu-asset-workflow-capability {
  padding: 14px 16px; box-sizing: border-box;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-lg, 12px);
  background: var(--crwu-surface-subtle);
}
.crwu-asset-workflow-status {
  display: flex; flex-direction: column; gap: 6px;
  padding: 20px; box-sizing: border-box;
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-lg, 12px);
  background: var(--crwu-surface-subtle);
}
.crwu-asset-workflow-status-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-asset-workflow-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
.crwu-asset-workflow-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--crwu-risk-a); overflow-wrap: anywhere; }
.crwu-asset-workflow-artifacts { display: flex; flex-wrap: wrap; gap: 8px; }
.crwu-asset-workflow-preparing-graph { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin-top: 4px; }
.crwu-asset-workflow-preparing-skeleton {
  display: flex; flex-direction: column; gap: 8px; min-width: 0; margin-top: 4px;
}
.crwu-asset-workflow-skeleton-line {
  display: block; height: 10px; box-sizing: border-box; border-radius: 999px;
  background: linear-gradient(90deg,
    var(--crwu-surface-subtle) 0%,
    var(--crwu-hover) 45%,
    var(--crwu-surface-subtle) 90%);
  background-size: 220% 100%;
  animation: crwu-workflow-shimmer 1.4s linear infinite;
}
.crwu-asset-workflow-skeleton-line:nth-child(2) { width: 86%; }
.crwu-asset-workflow-skeleton-line:nth-child(3) { width: 68%; }
.crwu-asset-workflow-skeleton-line:nth-child(4) { width: 78%; }
@keyframes crwu-workflow-shimmer {
  from { background-position: 120% 0; }
  to { background-position: -120% 0; }
}
.crwu-asset-workflow-file-input { display: none; }

/* Optional calculation-template role inside the conditions block */
.crwu-valuation-template {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 12px 14px; box-sizing: border-box; min-width: 0;
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-lg, 12px);
  background: var(--crwu-surface-subtle);
}
.crwu-valuation-template-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.crwu-valuation-template-title { font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-valuation-template-path {
  margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-text-primary);
  overflow-wrap: anywhere;
}
.crwu-valuation-template-dir { display: block; font-size: 11px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
.crwu-valuation-template-actions { flex: none; display: flex; align-items: center; gap: 6px; }

/* ── 估值流程工作面：真实图 + 节点回执（只渲染 Host 快照）──────────────── */
.crwu-valuation-workflow {
  display: flex; flex-direction: column; gap: 14px; min-width: 0;
  container-type: inline-size; container-name: crwu-valuation-workflow;
  color: var(--crwu-text-body);
}

/* Summary strip: status facts stay distinguishable, never a painted percentage. */
.crwu-valuation-workflow-summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
  padding: 10px 14px; box-sizing: border-box; min-width: 0;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-lg, 12px);
  background: var(--crwu-surface-subtle);
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-status {
  padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--crwu-interactive-border); background: var(--crwu-interactive-soft);
  font-size: 12px; font-weight: 600; color: var(--crwu-interactive);
}
.crwu-valuation-workflow-badge {
  padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--crwu-border); background: var(--crwu-surface); color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-refresh { margin-left: auto; }

.crwu-valuation-workflow-plan,
.crwu-valuation-workflow-clarification,
.crwu-valuation-workflow-delivery,
.crwu-valuation-workflow-global,
.crwu-valuation-workflow-graph,
.crwu-valuation-workflow-detail,
.crwu-valuation-workflow-result {
  display: flex; flex-direction: column; gap: 10px; min-width: 0;
  padding: 14px 16px; box-sizing: border-box;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-lg, 12px);
  background: var(--crwu-surface);
}
.crwu-valuation-workflow-panel-title {
  margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--crwu-text-primary);
  overflow-wrap: anywhere;
}
.crwu-valuation-workflow-block-title { margin: 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-mono { font-family: var(--crwu-font-mono); font-size: 12px; color: var(--crwu-text-mono); overflow-wrap: anywhere; }
.crwu-valuation-workflow-meta { font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); overflow-wrap: anywhere; }

/* Body: the graph is the only primary surface; there is no permanent inspector column. */
.crwu-valuation-workflow-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.crwu-valuation-workflow-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.crwu-valuation-workflow-aside { display: none; }

/* Generic workspace: the graph is the primary surface; decisions sit above it. */
.crwu-workflow-workspace { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.crwu-workflow-surface { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

/* Graph: exact Host ids and edges, ordered as compiled. */
.crwu-valuation-workflow-graph-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.crwu-valuation-workflow-graph-syncing {
  display: inline-flex; align-items: center; gap: 6px; margin-left: auto;
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-graph-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; min-width: 0; }
.crwu-valuation-workflow-graph-node-item { list-style: none; min-width: 0; }
.crwu-valuation-workflow-graph-node {
  width: 100%; box-sizing: border-box; text-align: left; cursor: pointer;
  display: flex; align-items: flex-start; gap: 10px; min-width: 0;
  padding: 10px 12px; border-radius: var(--crwu-radius-md, 10px);
  border: 1px solid var(--crwu-border); background: var(--crwu-surface);
  font: inherit; color: var(--crwu-text-primary);
  transition: background-color 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease),
    box-shadow 120ms var(--crwu-ease), transform 120ms var(--crwu-ease);
}
.crwu-valuation-workflow-graph-node:enabled:hover { background: var(--crwu-hover); border-color: var(--crwu-border-strong); }
.crwu-valuation-workflow-graph-node:enabled:active { transform: translateY(1px); }
.crwu-valuation-workflow-graph-node:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-valuation-workflow-graph-node-state {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; margin-top: 1px; border-radius: 999px;
  color: var(--crwu-text-tertiary);
}
.crwu-valuation-workflow-graph-state-icon { width: 14px; height: 14px; display: block; }
.crwu-valuation-workflow-graph-spinner {
  display: inline-block; width: 14px; height: 14px; box-sizing: border-box;
  border: 2px solid var(--crwu-interactive-border); border-top-color: var(--crwu-interactive);
  border-radius: 50%; animation: crwu-workflow-spin 900ms linear infinite;
}
.crwu-valuation-workflow-graph-node-body {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px;
}
.crwu-valuation-workflow-graph-node-label { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.crwu-valuation-workflow-graph-node-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.crwu-valuation-workflow-graph-stage {
  padding: 1px 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--crwu-border); color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-graph-state { font-size: 11px; color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-graph-node:disabled { cursor: default; opacity: 1; }
.crwu-valuation-workflow-graph-node[data-workflow-node-selected="true"] {
  border-color: var(--crwu-interactive); background: var(--crwu-interactive-soft);
  box-shadow: 0 0 0 1px var(--crwu-interactive-border);
}
.crwu-valuation-workflow-graph-node[data-workflow-node-current="true"] { box-shadow: inset 3px 0 0 var(--crwu-interactive); }
.crwu-valuation-workflow-graph-node[data-workflow-node-selected="true"][data-workflow-node-current="true"] {
  box-shadow: inset 3px 0 0 var(--crwu-interactive), 0 0 0 1px var(--crwu-interactive-border);
}
.crwu-valuation-workflow-graph-node[data-workflow-node-state="running"] {
  border-color: var(--crwu-interactive-border); animation: crwu-workflow-pulse 1.8s var(--crwu-ease) infinite;
}
.crwu-valuation-workflow-graph-node[data-workflow-node-state="running"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="running"] .crwu-valuation-workflow-graph-node-state { color: var(--crwu-interactive); }
.crwu-valuation-workflow-graph-node[data-workflow-node-state="waiting"],
.crwu-valuation-workflow-graph-node[data-workflow-node-state="partial"] { border-color: var(--crwu-risk-b); }
.crwu-valuation-workflow-graph-node[data-workflow-node-state="waiting"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="partial"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="waiting"] .crwu-valuation-workflow-graph-node-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="partial"] .crwu-valuation-workflow-graph-node-state { color: var(--crwu-risk-b); }
.crwu-valuation-workflow-graph-node[data-workflow-node-state="blocked"],
.crwu-valuation-workflow-graph-node[data-workflow-node-state="failed"],
.crwu-valuation-workflow-graph-node[data-workflow-node-state="cancelled"] { border-color: var(--crwu-risk-a); }
.crwu-valuation-workflow-graph-node[data-workflow-node-state="blocked"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="failed"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="cancelled"] .crwu-valuation-workflow-graph-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="blocked"] .crwu-valuation-workflow-graph-node-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="failed"] .crwu-valuation-workflow-graph-node-state,
.crwu-valuation-workflow-graph-node[data-workflow-node-state="cancelled"] .crwu-valuation-workflow-graph-node-state { color: var(--crwu-risk-a); }
.crwu-valuation-workflow-graph-node[data-workflow-node-state="passed"] .crwu-valuation-workflow-graph-node-state {
  color: var(--dsw-alias-state-success-primary);
}
/* Boundary sentinels read as flow edges, not business steps. */
.crwu-valuation-workflow-graph-node-item[data-workflow-node-boundary="true"] .crwu-valuation-workflow-graph-node {
  padding: 6px 10px; border-style: dashed; background: transparent;
}
.crwu-valuation-workflow-graph-node-item[data-workflow-node-boundary="true"] .crwu-valuation-workflow-graph-node-label {
  font-size: 12px; font-weight: 500; color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-graph-edge { list-style: none; display: flex; align-items: center; gap: 8px; min-height: 22px; min-width: 0; }
.crwu-valuation-workflow-graph-edge-line {
  width: 2px; height: 18px; margin-left: 9px; border-radius: 999px; background: var(--crwu-border-strong);
}
.crwu-valuation-workflow-graph-edge[data-workflow-edge-conditional="true"] .crwu-valuation-workflow-graph-edge-line {
  background: repeating-linear-gradient(180deg, var(--crwu-interactive-border) 0 4px, transparent 4px 7px);
}
.crwu-valuation-workflow-graph-edge-label { font-size: 11px; color: var(--crwu-text-tertiary); }
@keyframes crwu-workflow-spin { to { transform: rotate(360deg); } }
@keyframes crwu-workflow-pulse {
  0%, 100% { box-shadow: inset 3px 0 0 var(--crwu-interactive), 0 0 0 0 transparent; }
  50% { box-shadow: inset 3px 0 0 var(--crwu-interactive), 0 0 0 3px var(--crwu-interactive-soft); }
}

/* Inspector blocks: current session action, gaps, retry form, then read-only values. */
.crwu-valuation-workflow-detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-detail-loading {
  display: flex; align-items: center; gap: 10px; min-width: 0;
  padding: 6px 0 10px;
}
.crwu-valuation-workflow-loading-spinner {
  flex: none; width: 18px; height: 18px; box-sizing: border-box;
  border: 2px solid var(--crwu-border-strong); border-top-color: var(--crwu-interactive);
  border-radius: 50%; animation: crwu-workflow-spin 900ms linear infinite;
}
.crwu-valuation-workflow-node-id { font-family: var(--crwu-font-mono); font-size: 11px; color: var(--crwu-text-tertiary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-session {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0;
  padding: 8px 10px; box-sizing: border-box;
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-sm, 8px);
  background: var(--crwu-surface-subtle);
}
.crwu-valuation-workflow-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-block + .crwu-valuation-workflow-block { border-top: 1px solid var(--crwu-border); padding-top: 10px; }
.crwu-valuation-workflow-fields { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-field {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  font-size: 12px; line-height: 18px; min-width: 0;
}
.crwu-valuation-workflow-field-label { color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-field-value { color: var(--crwu-text-primary); overflow-wrap: anywhere; min-width: 0; }
.crwu-valuation-workflow-field-kind {
  padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--crwu-border); color: var(--crwu-text-secondary);
}
.crwu-valuation-workflow-field-source { color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-input {
  width: 100%; max-width: 100%; box-sizing: border-box; min-width: 0;
  font: inherit; font-size: 12px; padding: 5px 8px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-sm, 8px);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
}
.crwu-valuation-workflow-input:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 1px; }
.crwu-valuation-workflow-source,
.crwu-valuation-workflow-knowledge { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; min-width: 0; }
.crwu-valuation-workflow-source-path { font-family: var(--crwu-font-mono); font-size: 12px; color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-gap { font-size: 12px; line-height: 18px; color: var(--crwu-risk-b); overflow-wrap: anywhere; }

/* Structured values: real newlines, readable nested records and lists, no raw JSON panel. */
.crwu-workflow-value-text { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.crwu-workflow-value-empty { color: var(--crwu-text-tertiary); }
.crwu-workflow-value-list {
  list-style: none; margin: 2px 0 0; padding: 0 0 0 12px;
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  border-left: 2px solid var(--crwu-border);
}
.crwu-workflow-value-item { min-width: 0; }
.crwu-workflow-value-object { margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.crwu-workflow-value-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.crwu-workflow-value-key { font-family: var(--crwu-font-mono); font-size: 11px; color: var(--crwu-text-tertiary); overflow-wrap: anywhere; }
.crwu-workflow-value-field { margin: 0; min-width: 0; color: var(--crwu-text-primary); }
.crwu-valuation-workflow-raw summary { cursor: pointer; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-raw-pre {
  margin: 6px 0 0; padding: 10px; max-width: 100%; box-sizing: border-box;
  overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--crwu-font-mono); font-size: 11px; line-height: 16px;
  border-radius: var(--crwu-radius-sm, 8px); background: var(--crwu-surface-subtle); color: var(--crwu-text-mono);
}

/* Correction: reason and source are required, stale/busy block submission. */
.crwu-valuation-workflow-revision {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  border-top: 1px solid var(--crwu-border); padding-top: 12px;
}
.crwu-valuation-workflow-revision-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-revision-field input {
  width: 100%; box-sizing: border-box; min-width: 0;
  font: inherit; font-size: 13px; padding: 7px 9px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-sm, 8px);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
}
.crwu-valuation-workflow-stale { margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-risk-b); overflow-wrap: anywhere; }
.crwu-valuation-workflow-submit,
.crwu-valuation-workflow-plan-confirm,
.crwu-valuation-workflow-answer-submit { align-self: flex-start; }

/* Supplemental answer: one truthful reason/source is generated by the adapter. */
.crwu-valuation-workflow-retry {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  border-top: 1px solid var(--crwu-border); padding-top: 12px;
}
.crwu-valuation-workflow-retry-field { font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-retry-input {
  width: 100%; max-width: 100%; box-sizing: border-box; min-width: 0;
  min-height: 72px; resize: vertical;
  font: inherit; font-size: 13px; line-height: 20px; padding: 8px 10px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-sm, 8px);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
}
.crwu-valuation-workflow-retry-input:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 1px; }

/* Global inputs: editable without selecting a node; Host computes the rerun scope. */
.crwu-valuation-workflow-global-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-global-head .crwu-valuation-workflow-hint { flex: 1 1 auto; }
.crwu-valuation-workflow-global-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-global-item {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  font-size: 12px; line-height: 18px; min-width: 0;
}
.crwu-valuation-workflow-global-label { color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-global-value { color: var(--crwu-text-primary); overflow-wrap: anywhere; min-width: 0; }
.crwu-valuation-workflow-global-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }

/* Plan receipt. */
.crwu-valuation-workflow-plan-meta { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.crwu-valuation-workflow-plan-sources { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.crwu-valuation-workflow-plan-source {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  padding: 10px 12px; box-sizing: border-box;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md, 10px);
  background: var(--crwu-surface-subtle);
}
.crwu-valuation-workflow-plan-source-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.crwu-valuation-workflow-plan-source-name { font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-plan-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.crwu-valuation-workflow-plan-item {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  font-size: 12px; line-height: 18px; min-width: 0;
}
.crwu-valuation-workflow-plan-label { color: var(--crwu-text-secondary); }
.crwu-valuation-workflow-plan-value { margin: 0; color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-plan-link {
  color: var(--crwu-interactive); text-decoration: underline; text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
.crwu-valuation-workflow-plan-link:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-valuation-workflow-plan-template {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  padding: 10px 12px; box-sizing: border-box;
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-md, 10px);
  background: var(--crwu-surface-subtle);
}
.crwu-valuation-workflow-plan-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }

/* Clarification answers: real editable fields keyed by the Host question field. */
.crwu-valuation-workflow-clarification-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.crwu-valuation-workflow-question { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; }
.crwu-valuation-workflow-question-prompt { font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-workflow-answer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.crwu-valuation-workflow-answer-input,
.crwu-valuation-workflow-answer-select {
  max-width: 100%; box-sizing: border-box; min-width: 0;
  font: inherit; font-size: 13px; padding: 7px 9px;
  border: 1px solid var(--crwu-field-border); border-radius: var(--crwu-radius-sm, 8px);
  background: var(--crwu-field-bg); color: var(--crwu-text-primary);
}
.crwu-valuation-workflow-answer-input:focus-visible,
.crwu-valuation-workflow-answer-select:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 1px; }
.crwu-valuation-workflow-answer-group { display: flex; flex-wrap: wrap; gap: 6px 14px; min-width: 0; }
.crwu-valuation-workflow-answer-option {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; line-height: 20px; color: var(--crwu-text-primary); cursor: pointer;
}
.crwu-valuation-workflow-answer-option input { accent-color: var(--crwu-interactive); }
.crwu-valuation-workflow-modern-answer { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.crwu-valuation-workflow-modern-answer .crwu-valuation-workflow-answer-group { flex-direction: column; }
.crwu-valuation-workflow-modern-answer .crwu-valuation-workflow-answer-option { min-height: 44px; padding: 4px 10px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-sm, 8px); }
.crwu-valuation-workflow-modern-answer .crwu-valuation-workflow-answer-option:has(input:checked) { border-color: var(--crwu-interactive); background: var(--crwu-interactive-soft); }
.crwu-valuation-workflow-modern-answer .crwu-valuation-workflow-answer-input { width: 100%; min-height: 44px; }
.crwu-valuation-workflow-candidates { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.crwu-valuation-workflow-candidate { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md, 10px); background: var(--crwu-surface-subtle); min-width: 0; overflow-wrap: anywhere; }
.crwu-valuation-workflow-market-summary { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md, 10px); background: var(--crwu-surface-subtle); min-width: 0; }
.crwu-valuation-workflow-question-body, .crwu-valuation-workflow-question-footer { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
[data-workflow-questionnaire-modern="true"] { display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0; border: 0; }
[data-workflow-questionnaire-modern="true"] > .crwu-valuation-workflow-question-body { flex: 1; min-height: 0; overflow-y: auto; padding: 20px; }
[data-workflow-questionnaire-modern="true"] > .crwu-valuation-workflow-question-footer { flex: none; padding: 14px 20px; border-top: 1px solid var(--crwu-border); background: var(--crwu-surface); }
[data-workflow-questionnaire-modern="true"] .crwu-valuation-workflow-answer-submit { width: 100%; min-height: 44px; }
[data-workflow-glass="true"]:has([data-workflow-questionnaire-modern="true"]) { width: min(580px, 100vw); }
[data-workflow-glass="true"]:has([data-workflow-questionnaire-modern="true"]) .crwu-audit-side-drawer-body { display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding: 0; }
[data-workflow-glass="true"]:has([data-workflow-questionnaire-modern="true"]) .crwu-valuation-workflow-detail { flex: 1; min-height: 0; }
.crwu-valuation-workflow-clarification-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }

/*
 * Workflow drawer glass: only the drawer launched by the workflow workspace gets the
 * stronger blur. The shared audit drawer keeps its 2px scrim. The :has selector targets
 * backdrop that sits immediately before our workflow drawer, so unrelated drawers
 * are untouched.
 */
[data-crwu-scope="workbench"].crwu-audit-side-drawer-backdrop:has(+ [data-crwu-scope="workbench"].crwu-audit-side-drawer[data-workflow-glass="true"]) {
  background: color-mix(in srgb, var(--crwu-scrim) 66%, transparent);
  backdrop-filter: blur(12px) saturate(1.05);
  -webkit-backdrop-filter: blur(12px) saturate(1.05);
}

/* Wide panels: graph and aside side by side */
@container crwu-asset-workflow (min-width: 900px) {
  .crwu-asset-workflow-content {
    grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.55fr);
    align-items: start;
  }
}

/* Narrow panels: tighten insets, then stack */
@container crwu-asset-workflow (max-width: 559px) {
  .crwu-asset-workflow { --crwu-asset-workflow-inset: 16px; }
  .crwu-asset-workflow-overview { padding-top: 20px; }
  .crwu-asset-workflow-step { padding: 14px 16px; gap: 12px; }
  .crwu-asset-workflow-head { flex-wrap: wrap; }
  .crwu-asset-workflow-badge { margin-left: 0; }
  .crwu-valuation-template { flex-direction: column; }
  .crwu-valuation-workflow-global-item { align-items: stretch; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-asset-workflow-step,
  .crwu-asset-workflow-breadcrumb,
  .crwu-valuation-workflow-graph-node { transition: none; }
  .crwu-valuation-workflow-graph-node[data-workflow-node-state="running"],
  .crwu-valuation-workflow-graph-spinner,
  .crwu-valuation-workflow-loading-spinner,
  .crwu-asset-workflow-skeleton-line { animation: none; }
}
`
