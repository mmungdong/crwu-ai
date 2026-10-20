import * as React from 'react'
import { Button } from '../../../ui/components/index.ts'
import { FileIcon } from '../../../ui/icons.tsx'
import { ASSET_WORKFLOW_CLASSES as W } from '../styles/workflow.ts'
import { ReportEvaluationPane, type ReportEvaluationController } from './ReportEvaluationPane.tsx'
import { ValuationCapabilityArea } from './ValuationCapabilityArea.tsx'
import {
  ValuationWorkflowPane,
  type ValuationWorkflowRevisionSubmission,
} from './ValuationWorkflowPane.tsx'
import { WorkflowGraph } from './workflow/WorkflowGraph.tsx'
import type {
  ValuationWorkflowController,
  ValuationWorkflowControllerState,
} from '../workflow-controller.ts'
import type {
  ValuationWorkflowGraphEdgeView,
  ValuationWorkflowGraphNodeView,
  ValuationWorkflowGraphView,
  ValuationWorkflowProgressView,
} from '../../../../shared/contracts/valuation-workflow.ts'

/**
 * Asset-assessment entry and graph workface (protocol 43).
 *
 * The overview lists real business steps only. The graph is rendered only from a Host
 * snapshot; the legacy intake is rendered only when the Host explicitly confirms an empty,
 * parent-less current task. Otherwise the page shows a concise service status.
 */

export type AssetWorkflowStep = 'overview' | 'valuation'

export interface AssetAssessmentWorkflowProps {
  workflow: ValuationWorkflowController
  evaluation: ReportEvaluationController
  step: AssetWorkflowStep
  onStep: (step: AssetWorkflowStep) => void
  /** Opens the real parent session on an employee click; never automatic. */
  onOpenParentSession: (sessionId: string) => void
}

/** Native phases that report real work before the first business snapshot exists. */
const PENDING_PHASES = new Set(['preparing', 'awaiting-agent'])

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function progressOf(current: ValuationWorkflowControllerState['current']): ValuationWorkflowProgressView | null {
  if (current === null || current.empty === true) return null
  const progress = isRecord(current.progress) ? current.progress : null
  if (progress === null || !Array.isArray(progress.stages)) return null
  return progress as unknown as ValuationWorkflowProgressView
}

/**
 * A real parent waiting for its first snapshot, or a known pre-business failure.
 * `snapshot`/`progress` are both absent, but identity and phase are explicit.
 */
export function isPendingCurrent(current: ValuationWorkflowControllerState['current']): boolean {
  if (current === null || current.empty === true) return false
  const snapshot = isRecord(current.snapshot) ? current.snapshot : null
  const progress = isRecord(current.progress) ? current.progress : null
  if (snapshot !== null && progress !== null) return false
  const phase = text(current.phase)
  const known = PENDING_PHASES.has(phase) || phase === 'blocked' || phase === 'failed'
  return known && text(current.parentSessionId) !== ''
}

/** The actual Host graph descriptor, used read-only while material is still being read. */
export function graphOf(current: ValuationWorkflowControllerState['current']): ValuationWorkflowGraphView | null {
  if (current === null || current.empty === true) return null
  const graph = isRecord(current.graph) ? current.graph : null
  if (graph === null || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null
  return graph as unknown as ValuationWorkflowGraphView
}

function statusLabelOf(status: string): string {
  switch (status) {
    case 'preparing': return '正在准备资料'
    case 'awaiting-agent': return '等待模型处理'
    case 'running': return '正在执行'
    case 'waiting-user': return '等待员工处理'
    case 'completed': return '已完成'
    case 'partial': return '参考成果已交付'
    case 'blocked': return '受阻'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return '尚未开始'
  }
}

/** Closed Host artifact kinds; the Host refuses raw filenames and any path-like argument. */
const ARTIFACT_ALIASES: Record<string, string> = {
  '估值底稿.xlsx': 'workbook',
  '估值底稿.xls': 'workbook',
  '估值报告.html': 'report',
  '估值报告.htm': 'report',
  '计算轨迹.json': 'trace',
  '估值报告数据.json': 'data',
}

const ARTIFACT_LABELS: Record<string, string> = {
  workbook: '估值底稿',
  report: '估值报告',
  trace: '计算轨迹',
  data: '估值报告数据',
}

/** Stable, readable order for the four real calculated deliverables. */
const ARTIFACT_ORDER: readonly string[] = ['workbook', 'report', 'trace', 'data']

function artifactLabelOf(kind: string): string {
  return ARTIFACT_LABELS[kind] ?? kind
}

function basenameOfPath(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * Map the recorded delivery filenames (by basename) onto the closed native kinds.
 * Unknown names are omitted rather than forwarded as a filename or case path.
 */
function artifactKindsOf(current: ValuationWorkflowControllerState['current']): string[] {
  if (current === null || !isRecord(current.snapshot)) return []
  const delivery = isRecord(current.snapshot.delivery) ? current.snapshot.delivery : null
  const artifacts = delivery !== null && Array.isArray(delivery.artifacts) ? delivery.artifacts : []
  const found = new Set<string>()
  for (const item of artifacts) {
    if (typeof item !== 'string') continue
    const kind = ARTIFACT_ALIASES[basenameOfPath(item.trim())]
    if (kind !== undefined) found.add(kind)
  }
  return ARTIFACT_ORDER.filter((kind) => found.has(kind))
}

/** Fall back to a one-shot read when the renderer has no `useSyncExternalStore`. */
function useWorkflowState(controller: ValuationWorkflowController): ValuationWorkflowControllerState {
  if (React.useSyncExternalStore) {
    return React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  }
  return useFallbackState(controller)
}

function useFallbackState(controller: ValuationWorkflowController): ValuationWorkflowControllerState {
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}

function useEvaluationState(controller: ReportEvaluationController) {
  if (React.useSyncExternalStore) {
    return React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  }
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}

function Toolbar(props: {
  state: ValuationWorkflowControllerState
  workflow: ValuationWorkflowController
  parentSessionId: string
  onOpenParentSession: (sessionId: string) => void
  artifactKinds: string[]
  confirmingClear: boolean
  showCancel: boolean
  onCancel: () => void
  onAskClear: () => void
  onConfirmClear: () => void
}): React.ReactElement {
  const busy = props.state.busy
  return <div className={W.toolbar} data-asset-workflow-toolbar="true">
    <div className={W.toolbarGroup}>
      <Button variant="secondary" size="sm" disabled={props.state.loading} onClick={() => { void props.workflow.refresh() }}>
        刷新
      </Button>
      {/* Cancel stays in the toolbar so a running/queued task can always be stopped. */}
      {props.showCancel
        ? <Button variant="danger" size="sm" disabled={busy} onClick={props.onCancel} data-asset-workflow-cancel="true">取消任务</Button>
        : null}
      {/* Clear stays visible in every state (loading/empty/error/pending); the two-click
          confirmation only guards the action itself, never hides the entry. */}
      {(props.confirmingClear
          ? <Button variant="danger" size="sm" disabled={busy} onClick={props.onConfirmClear} data-asset-workflow-clear-confirm="true">确认清空</Button>
          : <Button variant="secondary" size="sm" disabled={busy} onClick={props.onAskClear} data-asset-workflow-clear="true">清空</Button>)}
      {props.confirmingClear ? <p className={W.error} data-asset-workflow-clear-warning="true">确认后将永久删除当前任务在 SQLite 中保存的草稿、问题、答案和全部历史记录。</p> : null}
    </div>
    <div className={W.toolbarGroup}>
      {props.artifactKinds.map((kind) => <Button
        key={kind}
        variant="secondary"
        size="sm"
        onClick={() => { void props.workflow.openArtifact(kind) }}
        data-asset-workflow-artifact={kind}
      >{artifactLabelOf(kind)}</Button>)}
      {props.parentSessionId === ''
        ? null
        : <Button
          variant="primary"
          size="sm"
          onClick={() => { props.onOpenParentSession(props.parentSessionId) }}
          data-asset-workflow-open-session="true"
        >打开估值会话</Button>}
    </div>
  </div>
}

function StatusBlock(props: { state: ValuationWorkflowControllerState }): React.ReactElement {
  const { state } = props
  if (state.error !== '') {
    return <div className={W.status} role="alert" data-asset-workflow-error="true">
      <p className={W.statusTitle}>估值服务暂时不可用</p>
      <p className={W.error}>{state.error}</p>
      <p className={W.hint}>请稍后重试或重启应用。</p>
    </div>
  }
  if (state.loading && state.current === null) {
    return <div className={W.status} role="status" data-asset-workflow-loading="true">
      <p className={W.statusTitle}>正在读取估值进度…</p>
    </div>
  }
  if (state.current === null) {
    return <div className={W.status} role="status" data-asset-workflow-empty="true">
      <p className={W.statusTitle}>暂时读不到估值进度</p>
      <p className={W.hint}>请点击刷新重试。</p>
    </div>
  }
  if (state.current.empty === true) {
    return <div className={W.status} role="status" data-asset-workflow-empty="true">
      <p className={W.statusTitle}>还没有估值记录</p>
      <p className={W.hint}>完成资料核对并开始估值后，这里会显示实际进度。</p>
    </div>
  }
  return <div className={W.status} role="status" data-asset-workflow-empty="true">
    <p className={W.statusTitle}>暂时没有可显示的进度</p>
    <p className={W.hint}>请点击刷新重试。</p>
  </div>
}

/**
 * Pre-snapshot workface: the run exists but its first business snapshot has not arrived.
 *
 * When the Host already published the real graph descriptor it is shown read-only, so the
 * employee is not staring at a blank page through PDF visual reading. No stage, progress
 * percentage or model result is invented.
 */
function PreparingBlock(props: {
  state: ValuationWorkflowControllerState
  graph: ValuationWorkflowGraphView | null
}): React.ReactElement {
  const { state } = props
  const phase = text(state.current?.phase)
  const hostError = text(state.current?.error)
  const parentSessionId = text(state.current?.parentSessionId)
  const lead = phase === 'awaiting-agent'
    ? '正在等待模型处理：估值会话已建立，正在按本批资料推进。'
    : phase === 'preparing'
      ? '正在读取本批资料：估值会话已建立，正在识别资料内容。'
      : '估值会话已建立，但本轮准备没有完成。'
  const nodes = props.graph === null ? [] : props.graph.nodes as ValuationWorkflowGraphNodeView[]
  const edges = props.graph === null
    ? []
    : (Array.isArray(props.graph.edges) ? props.graph.edges as ValuationWorkflowGraphEdgeView[] : [])
  return <section className={W.status} role="status" data-asset-workflow-preparing="true"
    data-asset-workflow-preparing-phase={phase}>
    <p className={W.statusTitle}>{lead}</p>
    {hostError === '' ? null : <p className={W.error} role="alert">{hostError}</p>}
    {parentSessionId === '' ? null : (PENDING_PHASES.has(phase)
      ? <p className={W.hint}>本次估值会话已经建立，可用上方的「打开估值会话」进入，不影响后台准备。</p>
      : <p className={W.hint}>本次估值会话已经建立，请用上方的「打开估值会话」查看会话中的实际错误和处理情况。</p>)}
    {props.graph === null
      ? <div className={W.preparingSkeleton} role="status" data-asset-workflow-graph-skeleton="true">
        <p className={W.hint}>正在同步流程结构…</p>
        <span className={W.skeletonLine} aria-hidden="true" />
        <span className={W.skeletonLine} aria-hidden="true" />
        <span className={W.skeletonLine} aria-hidden="true" />
      </div>
      : <div className={W.preparingGraph}>
        <p className={W.hint}>实际流程结构（首个业务快照到达前只读展示）：</p>
        <WorkflowGraph graphId={text(props.graph.graphId) || 'host-graph'} nodes={nodes} edges={edges}
          detailNodeId={null} onSelectNode={() => {}} readOnly />
      </div>}
  </section>
}

export function AssetAssessmentWorkflow(props: AssetAssessmentWorkflowProps): React.ReactElement {
  const state = useWorkflowState(props.workflow)
  const evaluationState = useEvaluationState(props.evaluation)
  const [confirmingClear, setConfirmingClear] = React.useState(false)

  const current = state.current
  const progress = progressOf(current)
  const pending = isPendingCurrent(current)
  const hostGraph = graphOf(current)
  const projectId = text(current?.projectId)
  const currentParentSessionId = text(current?.parentSessionId)
  const liveParentSessionId = currentParentSessionId || text(evaluationState.parentSessionId)
  const parentSessionId = liveParentSessionId || text(evaluationState.recentSessionId)
  const rawStatus = text(progress?.status)
  const statusLabel = rawStatus === '' ? statusLabelOf(text(current?.phase)) : statusLabelOf(rawStatus)
  const artifactKinds = artifactKindsOf(current)
  /**
   * The native Host phase is authoritative for decisions: while it still reports a queued
   * or running task, the previous snapshot may look approvable but must not be submitted
   * again. Reads, refresh and the toolbar cancel stay available.
   */
  const activeRunPhase = text(current?.phase)
  const decisionsPending = activeRunPhase === 'preparing' || activeRunPhase === 'awaiting-agent' || activeRunPhase === 'running'
  const decisionBusy = state.busy || decisionsPending
  /**
   * Legacy intake is exposed only for an explicitly validated empty, parent-less current.
   * A neutral recent-session shortcut must not block a genuine fresh draft.
   */
  const canStartIntake = state.error === ''
    && current !== null
    && current.ok === true
    && current.empty === true
    && text(current.error) === ''
    && currentParentSessionId === ''
    && projectId === ''
    && liveParentSessionId === ''

  return <section className={W.root} data-asset-assessment-workflow="true">
    {props.step === 'overview'
      ? <div className={W.overview} data-asset-workflow-overview="true">
        <header className={W.hero}>
          <p className={W.eyebrow}>资产评估</p>
          <h2 className={W.title}>选择业务步骤</h2>
          <p className={W.lead}>
            从估值开始：先核对本轮资料与业务条件，再查看方案、节点与交付成果。
          </p>
        </header>
        <ol className={W.steps}>
          <li className={W.step} data-business-step-card="valuation">
            <span className={W.stepIndex} aria-hidden="true">01</span>
            <div className={W.stepBody}>
              <h3 className={W.stepName}>估值</h3>
              <p className={W.stepText}>
                核对资产与资料，确认评估方案，并在同一工作面查看实际节点状态与参考成果。
              </p>
            </div>
            <Button
              variant="primary"
              className={W.stepAction}
              data-business-step="valuation"
              onClick={() => { props.onStep('valuation') }}
            >进入估值</Button>
          </li>
        </ol>
      </div>
      : <div className={W.workspace} data-workflow-step="valuation">
        <header className={W.head}>
          <button type="button" className={W.breadcrumb} onClick={() => { props.onStep('overview') }}>
            资产评估
          </button>
          <h2 className={W.workspaceTitle}>估值</h2>
          <span className={W.badge} data-asset-workflow-status={statusLabel}>{statusLabel}</span>
        </header>

        <Toolbar
          state={state}
          workflow={props.workflow}
          parentSessionId={parentSessionId}
          onOpenParentSession={props.onOpenParentSession}
          artifactKinds={artifactKinds}
          confirmingClear={confirmingClear}
          showCancel={progress !== null && activeRunPhase === 'running'}
          onCancel={() => { void props.workflow.cancel() }}
          onAskClear={() => { setConfirmingClear(true) }}
          onConfirmClear={() => {
            setConfirmingClear(false)
            void props.workflow.clear().then((cleared) => {
              if (!cleared) return
              // A confirmed clear starts a genuinely fresh local intake; a failed clear
              // preserves every input and the known identity.
              props.evaluation.resetDraft?.()
              props.onStep('overview')
            })
          }}
        />

        <div className={W.content}>
          <div className={W.graph}>
            {progress !== null
              ? <>
                {state.detail === null && text(current?.error) !== ''
                  ? <p className={W.error} role="alert" data-asset-workflow-run-error="true">
                    {text(current?.error)}
                  </p>
                  : null}
                <ValuationWorkflowPane
                  progress={progress}
                  detail={state.detail}
                  runPhase={activeRunPhase}
                  busy={decisionBusy}
                  questionDrafts={state.questionDrafts}
                  onSaveQuestionDraft={props.workflow.saveQuestionDraft}
                  onSubmitQuestions={props.workflow.submitQuestions}
                  onReconcileQuestionDraft={props.workflow.reconcileQuestionDraft}
                  onSelectNode={(nodeId) => { void props.workflow.selectNode(nodeId) }}
                  onRefresh={() => { void props.workflow.refresh() }}
                  onSubmitRevision={(input: ValuationWorkflowRevisionSubmission) => {
                    void props.workflow.revise(input)
                  }}
                  onAnswerClarification={(input) => {
                    const clarification = progress.clarification
                    void props.workflow.answer({
                      clarificationId: input.clarificationId,
                      expectedRevision: clarification?.revision ?? progress.revision,
                      answers: input.answers,
                    })
                  }}
                  onApprovePlan={(input) => { void props.workflow.approvePlan(input) }}
                  onOpenArtifact={(kind) => { void props.workflow.openArtifact(kind) }}
                  onOpenSession={(sessionId) => { props.onOpenParentSession(sessionId) }}
                  onCancel={() => { void props.workflow.cancel() }}
                />
              </>
              : pending
                ? <PreparingBlock state={state} graph={hostGraph} />
                : <StatusBlock state={state} />}

            {canStartIntake
              ? <div className={W.intake} data-asset-workflow-intake="true">
                <ReportEvaluationPane controller={props.evaluation} />
              </div>
              : null}
          </div>

          <aside className={W.aside}>
            <section className={W.capability} data-asset-workflow-capability="true">
              <h3 className={W.sectionTitle}>
                信息获取辅助
                <span className={W.hint}> · 可选</span>
              </h3>
              <ValuationCapabilityArea
                state={evaluationState}
                locked={state.busy}
                onRecheck={props.evaluation.recheckAuth}
                onLogin={props.evaluation.login}
                onCancelLogin={props.evaluation.cancelLogin}
                onVerify={props.evaluation.openVerification}
              />
            </section>
            {artifactKinds.length === 0
              ? null
              : <section className={W.capability} data-asset-workflow-artifacts-section="true">
                <h3 className={W.sectionTitle}>交付件</h3>
                <p className={W.hint}>交付件只按种类打开。</p>
                <div className={W.artifacts}>
                  {artifactKinds.map((kind) => <Button
                    key={kind}
                    variant="secondary"
                    size="sm"
                    onClick={() => { void props.workflow.openArtifact(kind) }}
                    data-asset-workflow-artifact={kind}
                  ><FileIcon size={14} /> {artifactLabelOf(kind)}</Button>)}
                </div>
              </section>}
          </aside>
        </div>
      </div>}
  </section>
}
