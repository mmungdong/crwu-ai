import * as React from 'react'
import { CheckIcon, FileIcon, InfoIcon, RefreshIcon } from '../../../ui/icons.tsx'
import type {
  ValuationWorkflowNodeView,
  ValuationWorkflowProgressView,
  ValuationWorkflowQuestion,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationQuestionEdit } from '../../../../shared/contracts/valuation-questionnaire.ts'
import type { ValuationLocalQuestionDraft } from '../workflow-controller.ts'
import { deriveMarketView, nodeIndexText, type MarketNodeView, type MarketView } from './model.ts'
import { CRWU_SCOPE_PROPS } from '../../../styles/scope.ts'
import { MarketDrawer } from './MarketDrawer.tsx'

export interface MarketWorkflowProps {
  progress: ValuationWorkflowProgressView
  detail: ValuationWorkflowNodeView | null
  busy?: boolean
  questionDrafts?: Record<string, ValuationLocalQuestionDraft>
  onSelectNode: (nodeId: string) => void
  onRefresh: () => void
  onSaveQuestionDraft: (edit: ValuationQuestionEdit) => unknown
  onSubmitQuestions: (edit: ValuationQuestionEdit) => unknown
  onApprovePlan?: (input: { expectedRevision: number; planDigest: string; submissionId: string }) => void
  onOpenArtifact?: (kind: string) => void
  onRetry?: (nodeId: string) => void
  onCancel?: () => void
  /** Optional only for the explicit fixture page; production never passes it. */
  fixture?: boolean
  initialNodeId?: string
}

function nodeDot(node: MarketNodeView): string {
  if (node.state === 'done') return '✓'
  if (node.state === 'current') return '?'
  if (node.state === 'failed') return '!'
  if (node.state === 'restricted') return '!'
  if (node.state === 'executing') return '·'
  if (node.state === 'skipped') return '–'
  return nodeIndexText(node.index)
}

function railClass(node: MarketNodeView): string {
  return node.state
}

function chipClass(node: MarketNodeView): string {
  if (node.state === 'done') return 'done'
  if (node.state === 'current' || node.state === 'executing') return 'waiting'
  if (node.state === 'restricted') return 'restricted'
  if (node.state === 'failed') return 'failed'
  return ''
}

function NodeCard(props: { node: MarketNodeView; compact?: boolean; current: boolean; onOpen: (target: { focus?: () => void } | null) => void }): React.ReactElement {
  const { node } = props
  return <button
    type="button"
    className={`mv-node ${node.state} ${props.current ? 'current' : ''}`}
    data-market-node={node.id}
    data-market-node-state={node.state}
    aria-current={props.current ? 'step' : undefined}
    aria-label={`节点 ${nodeIndexText(node.index)} ${node.label}，${node.stateLabel}`}
    onClick={(event) => { props.onOpen(event.currentTarget) }}
  >
    <span className="mv-node-body">
      <span className="mv-node-title-row">
        <span className="mv-index">{nodeIndexText(node.index)}</span>
        <span className="mv-node-title">{node.label}</span>
        {node.index === 2 ? <span className="mv-chip edge">并行</span> : null}
        {node.edge === undefined ? null : <span className="mv-chip edge">{node.edge}</span>}
        {node.conditional ? <span className="mv-chip edge">条件</span> : null}
        <span className={`mv-chip ${chipClass(node)}`} data-market-node-chip={node.id}>{node.stateLabel}</span>
      </span>
      <span className="mv-node-desc" data-market-node-desc={node.id}>{node.description}</span>
    </span>
    {props.compact === true
      ? null
      : <span className="mv-node-end"><span className="mv-node-meta">{node.meta}</span><span className="mv-chev">›</span></span>}
  </button>
}

function PageHeader(props: { view: MarketView; current: MarketNodeView | null; onCurrent: () => void; onRefresh: () => void; onCancel?: () => void; showCancel?: boolean }): React.ReactElement {
  return <>
    <header className="mv-head">
      <div className="mv-head-main">
        <div className="mv-title-line">
          <h1 className="mv-title">{props.view.title}</h1>
          <span className="mv-status" data-tone={props.view.status.tone} role="status" data-market-status={props.view.status.tone}>{props.view.status.text}</span>
        </div>
        <p className="mv-sub">{props.view.subtitle}</p>
        <div className="mv-meta">
          <span>{props.view.project}</span><span className="mv-meta-sep" aria-hidden="true" />
          <span>{props.view.task}</span><span className="mv-meta-sep" aria-hidden="true" />
          <span>编号 {props.view.code || '未登记'}</span><span className="mv-meta-sep" aria-hidden="true" />
          <span>最后更新 {props.view.updatedAt === '' ? '--:--' : new Date(props.view.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        </div>
      </div>
      <div className="mv-head-actions">
        <button type="button" className="mv-btn small" onClick={props.onRefresh} title="刷新节点状态" aria-label="刷新节点状态"><RefreshIcon size={14} /></button>
        {props.showCancel === true ? <button type="button" className="mv-btn small danger" data-market-cancel="true" onClick={props.onCancel}>停止任务</button> : null}
        <button type="button" className="mv-action" data-market-page-action="true" onClick={props.onCurrent}>
          {props.current === null ? '查看流程' : props.current.state === 'failed' ? '处理失败节点' : props.current.state === 'done' ? '查看当前结果' : '处理当前问题'}
        </button>
      </div>
    </header>
    <section className="mv-summary" aria-label="任务摘要">
      <div className="mv-summary-item">
        <div className="mv-summary-label"><FileIcon size={13} />输入资料</div>
        <div className="mv-summary-value" data-market-summary="materials">{props.view.summary.materials.value}</div>
        <div className="mv-summary-sub">{props.view.summary.materials.sub}</div>
      </div>
      <div className="mv-summary-item">
        <div className="mv-summary-label"><InfoIcon size={13} />市场法模板</div>
        <div className="mv-summary-value" data-market-summary="template">{props.view.summary.template.value}</div>
        <div className="mv-summary-sub">{props.view.summary.template.sub}</div>
      </div>
      <div className="mv-summary-item">
        <div className="mv-summary-label"><CheckIcon size={13} />当前进度</div>
        <div className="mv-summary-value" data-market-summary="progress">{props.view.summary.progress.value}</div>
        <div className="mv-summary-sub">{props.view.summary.progress.sub}</div>
      </div>
    </section>
  </>
}

function Graph(props: { view: MarketView; onOpen: (node: MarketNodeView, target?: { focus?: () => void } | null) => void }): React.ReactElement {
  const [first, second, ...rest] = props.view.nodes
  if (first === undefined || second === undefined) return <div className="mv-empty">尚未读取流程节点。</div>
  return <section className="mv-panel" aria-labelledby="mv-graph-title" data-market-graph="true">
    <div className="mv-panel-head">
      <div><h2 className="mv-panel-title" id="mv-graph-title">业务节点<span className="mv-panel-sub">11 个节点 · 按依赖顺序</span></h2></div>
      <div className="mv-legend" aria-label="节点状态图例">
        <span className="mv-legend-item"><span className="mv-legend-dot done" />已完成</span>
        <span className="mv-legend-item"><span className="mv-legend-dot current" />等待回答</span>
        <span className="mv-legend-item"><span className="mv-legend-dot pending" />待执行</span>
        <span className="mv-legend-item"><span className="mv-legend-dot restricted" />受限完成</span>
      </div>
    </div>
    <div className="mv-flow">
      <div className="mv-row mv-parallel" data-market-row="parallel">
        <div className="mv-rail"><span className={`mv-rail-dot ${railClass(first)}`} aria-hidden="true">{nodeDot(first)}</span></div>
        <div className="mv-cards"><div className="mv-parallel-grid">
          <NodeCard node={first} compact current={props.view.currentNodeId === first.id} onOpen={(target) => { props.onOpen(first, target) }} />
          <NodeCard node={second} compact current={props.view.currentNodeId === second.id} onOpen={(target) => { props.onOpen(second, target) }} />
        </div></div>
      </div>
      {rest.map((node) => <div className={`mv-row ${node.conditional ? 'mv-conditional' : ''}`} key={node.id} data-market-row={node.id}>
        <div className="mv-rail"><span className={`mv-rail-dot ${railClass(node)}`} aria-hidden="true">{nodeDot(node)}</span></div>
        <div className="mv-cards"><NodeCard node={node} current={props.view.currentNodeId === node.id} onOpen={(target) => { props.onOpen(node, target) }} /></div>
      </div>)}
    </div>
    <div className="mv-graph-foot">实线表示顺序依赖，虚线表示条件节点；节点 01 与 02 并行执行，汇合后进入采集方案。点击任意节点查看处理结果或回答当前问题。</div>
  </section>
}

export function MarketWorkflowView(props: {
  view: MarketView
  detail: ValuationWorkflowNodeView | null
  progress: ValuationWorkflowProgressView
  activeNode: MarketNodeView | null
  busy: boolean
  localDraft?: ValuationLocalQuestionDraft
  onOpen: (node: MarketNodeView, target?: { focus?: () => void } | null) => void
  onClose: () => void
  onRefresh: () => void
  onSaveQuestionDraft: (edit: ValuationQuestionEdit) => unknown
  onSubmitQuestions: (edit: ValuationQuestionEdit) => unknown
  onApprovePlan?: (input: { expectedRevision: number; planDigest: string; submissionId: string }) => void
  onOpenArtifact?: (kind: string) => void
  onRetry?: (nodeId: string) => void
  onCancel?: () => void
  onNext?: (node: MarketNodeView) => void
  returnFocusTo?: { current: { focus?: () => void } | null } | null
  fixture?: boolean
}): React.ReactElement {
  const current = props.view.nodes.find((node) => node.id === props.view.currentNodeId) ?? null
  const active = props.activeNode
  const graphNodeId = active === null ? '' : (props.progress.graph.nodes.find((node) => node.templateMarketNodeId === active.id)?.nodeId ?? active.id)
  return <div {...CRWU_SCOPE_PROPS} className="mv-root" data-market-workflow="true" data-market-fixture={props.fixture === true ? 'true' : 'false'}>
    <div className="mv-page">
      <PageHeader view={props.view} current={current} onRefresh={props.onRefresh}
        showCancel={props.progress.status === 'running'} onCancel={props.onCancel}
        onCurrent={() => { if (current !== null) props.onOpen(current) }} />
      <Graph view={props.view} onOpen={props.onOpen} />
      <p className="mv-note">节点状态来自 Host 回执；点击节点查看处理结果或回答当前问题。{props.fixture === true ? ' 当前页面为明确标注的交互夹具，不代表真实业务成果。' : ''}</p>
    </div>
    {active === null
      ? null
      : <MarketDrawer
        view={props.view}
        node={active}
        graphNodeId={graphNodeId}
        progress={props.progress}
        detail={props.detail}
        busy={props.busy}
        localDraft={props.localDraft}
        onSaveDraft={props.onSaveQuestionDraft}
        onSubmit={props.onSubmitQuestions}
        onApprovePlan={props.onApprovePlan}
        onOpenArtifact={props.onOpenArtifact}
        onRetry={props.onRetry === undefined ? undefined : () => props.onRetry?.(graphNodeId)}
        onNext={props.onNext === undefined ? undefined : () => {
          const next = props.view.nodes.find((item) => item.index === active.index + 1 && (item.state === 'current' || item.state === 'pending'))
            ?? props.view.nodes.find((item) => item.index === active.index + 1)
          if (next !== undefined) props.onNext?.(next)
        }}
        onClose={props.onClose}
        returnFocusTo={props.returnFocusTo}
        fixture={props.fixture}
      />}
  </div>
}

/**
 * Production adapter: observes the live Host snapshot, keeps only the selected node id
 * and focus return target, and never mutates progress locally.
 */
export function MarketWorkflow(props: MarketWorkflowProps): React.ReactElement {
  const currentDraft = Object.values(props.questionDrafts ?? {}).find((draft) => draft.status === 'queued' || draft.status === 'submitted')
  const view = React.useMemo(() => deriveMarketView(props.progress, props.detail, { queued: currentDraft !== undefined }), [props.progress, props.detail, currentDraft])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const focusRef = React.useRef<{ focus?: () => void } | null>(null)
  const autoOpened = React.useRef('')
  const graphNodeIdOf = React.useCallback((id: string): string => {
    return props.progress.graph.nodes.find((node) => node.templateMarketNodeId === id)?.nodeId ?? id
  }, [props.progress.graph.nodes])
  const open = React.useCallback((node: MarketNodeView, target?: { focus?: () => void } | null): void => {
    focusRef.current = target ?? null
    setActiveId(node.id)
    props.onSelectNode(graphNodeIdOf(node.id))
  }, [graphNodeIdOf, props])
  const openFromKeyboard = React.useCallback((node: MarketNodeView, event: React.MouseEvent<HTMLButtonElement>): void => {
    open(node, event.currentTarget)
  }, [open])
  React.useEffect(() => {
    if (!props.progress.waiting || view.currentNodeId === null) return
    const key = `${props.progress.runId}:${props.progress.revision}:${view.currentNodeId}`
    if (autoOpened.current === key) return
    if (view.pendingQuestionCount === 0) return
    autoOpened.current = key
    const node = view.nodes.find((item) => item.id === view.currentNodeId)
    if (node !== undefined) open(node)
  }, [open, props.progress.revision, props.progress.runId, props.progress.waiting, view.currentNodeId, view.nodes, view.pendingQuestionCount])
  const activeNode = activeId === null ? null : view.nodes.find((node) => node.id === activeId) ?? null
  const activeGraphNodeId = activeNode === null ? '' : graphNodeIdOf(activeNode.id)
  const detail = props.detail !== null && props.detail.nodeId === activeGraphNodeId ? props.detail : null
  const draft = activeGraphNodeId === '' ? undefined : props.questionDrafts?.[activeGraphNodeId]
  const retry = props.onRetry
  return <MarketWorkflowView
    view={view}
    detail={detail}
    progress={props.progress}
    activeNode={activeNode}
    busy={props.busy === true}
    localDraft={draft}
    onOpen={(node, target) => { open(node, target) }}
    onClose={() => { setActiveId(null) }}
    onRefresh={props.onRefresh}
    onSaveQuestionDraft={props.onSaveQuestionDraft}
    onSubmitQuestions={props.onSubmitQuestions}
    onApprovePlan={props.onApprovePlan}
    onOpenArtifact={props.onOpenArtifact}
    onRetry={retry}
    onCancel={props.onCancel}
    onNext={(node) => { open(node) }}
    returnFocusTo={focusRef}
  />
}
