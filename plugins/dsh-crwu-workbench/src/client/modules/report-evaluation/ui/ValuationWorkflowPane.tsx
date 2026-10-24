import * as React from 'react'
import { Button } from '../../../ui/components/index.ts'
import { StructuredValue } from '../../../ui/workflow/StructuredValue.tsx'
import { WorkflowWorkspace, type WorkflowWorkspaceSelection } from '../../../ui/workflow/WorkflowWorkspace.tsx'
import type {
  ValuationWorkflowClarification,
  ValuationWorkflowGraphNodeView,
  ValuationWorkflowNodeFieldView,
  ValuationWorkflowNodeView,
  ValuationWorkflowProgressView,
} from '../../../../shared/contracts/valuation-workflow.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../styles/workflow.ts'
import {
  areaTextOf,
  currentNodeIdOf,
  outcomeLabelOf,
  stageLabelOf,
  statusLabelOf,
  unitPriceTextOf,
  type ValuationWorkflowRevisionSubmission,
} from './workflow/model.ts'
import { WorkflowGraph } from './workflow/WorkflowGraph.tsx'
import { NodeInspector } from './workflow/NodeInspector.tsx'
import { PlanPanel } from './workflow/PlanPanel.tsx'
import { ClarificationPanel } from './workflow/ClarificationPanel.tsx'
import type { ValuationQuestionEdit } from '../../../../shared/contracts/valuation-questionnaire.ts'
import type { ValuationLocalQuestionDraft } from '../workflow-controller.ts'

export type { ValuationWorkflowRevisionSubmission } from './workflow/model.ts'

/**
 * Host-projected valuation workflow workface.
 *
 * The graph is the primary full-width surface; the plan and pending decisions sit
 * above it. Node details open in the shared drawer with immediate loading, so the
 * page never reserves a permanent inspector column and never shows a previous
 * node's content as the newly selected one.
 *
 * Every fact comes from the Host snapshot; nothing here infers progress or business
 * steps. Global input edits are forwarded as revision submissions owned by the
 * earliest actual stage that declares a changed field.
 */
export interface ValuationWorkflowPaneProps {
  progress: ValuationWorkflowProgressView
  detail: ValuationWorkflowNodeView | null
  runPhase?: string
  busy?: boolean
  onSelectNode: (nodeId: string) => void
  onRefresh: () => void
  onSubmitRevision: (input: ValuationWorkflowRevisionSubmission) => void
  onAnswerClarification?: (input: { clarificationId: string; answers: Record<string, string> }) => void
  /** Binds acceptance to the exact displayed plan revision and digest. */
  onApprovePlan?: (input: { expectedRevision: number; planDigest: string }) => void
  /** Opens a closed native artifact kind; never an arbitrary caller path. */
  onOpenArtifact?: (kind: string) => void
  /** Opens the node's actual DSH session on an explicit employee click only. */
  onOpenSession?: (sessionId: string) => void
  onCancel?: () => void
  questionDrafts?: Record<string, ValuationLocalQuestionDraft>
  onSaveQuestionDraft?: (input: ValuationQuestionEdit) => Promise<boolean>
  onSubmitQuestions?: (input: ValuationQuestionEdit) => Promise<boolean>
  onReconcileQuestionDraft?: (nodeId: string) => Promise<boolean>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function updatedText(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function uniqueQuestionsOf(
  clarification: ValuationWorkflowClarification,
  nodeId: string,
): ValuationWorkflowClarification | null {
  const questions = Array.isArray(clarification.questions)
    ? clarification.questions.filter((question) => text(question.nodeId) === nodeId)
    : []
  if (questions.length === 0) return null
  return { ...clarification, questions }
}

export function ValuationWorkflowPane(props: ValuationWorkflowPaneProps): React.ReactElement {
  const { progress, detail } = props
  const [selection, setSelection] = React.useState<WorkflowWorkspaceSelection | null>(null)
  const [dismissedNodeId, setDismissedNodeId] = React.useState<string | null>(null)
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [retryAnswer, setRetryAnswer] = React.useState('')
  const [globalEditing, setGlobalEditing] = React.useState(false)
  const [globalDraft, setGlobalDraft] = React.useState<Record<string, string>>({})
  const focusRef = React.useRef<{ focus?: () => void } | null>(null)

  const runId = progress.runId
  const revision = progress.revision
  const detailNodeId = detail === null ? '' : detail.nodeId
  const detailRevision = detail === null ? -1 : detail.revision
  const clarification = progress.clarification ?? null
  const clarificationId = clarification === null ? '' : clarification.clarificationId
  const outcome = progress.outcome ?? null
  const deliveryKind = progress.deliveryKind ?? null

  // A different run, revision, node or clarification never inherits old edits.
  React.useEffect(() => { setRetryAnswer('') }, [runId, revision, detailNodeId, detailRevision])
  React.useEffect(() => { setAnswers({}) }, [clarificationId])
  React.useEffect(() => {
    setGlobalDraft({})
    setGlobalEditing(false)
  }, [runId, revision])
  // A replacement run must not keep the previous run's selected node. Polling the same
  // run keeps its selection untouched.
  React.useEffect(() => {
    setSelection(null)
    setDismissedNodeId(null)
  }, [runId])

  const stages = Array.isArray(progress.stages) ? progress.stages : []
  const graph = progress.graph
  const graphNodes: ValuationWorkflowGraphNodeView[] = Array.isArray(graph?.nodes) ? graph.nodes : []
  const hasGraph = graphNodes.length > 0
  const edges = hasGraph && Array.isArray(graph?.edges) ? graph.edges : []
  const nodes: ValuationWorkflowGraphNodeView[] = hasGraph
    ? graphNodes
    : stages.map((stage) => ({
      nodeId: stage.stage,
      label: stageLabelOf(stage.stage),
      state: stage.state,
      stage: stage.stage,
      gaps: Array.isArray(stage.gaps) ? stage.gaps : [],
    }))
  const graphId = hasGraph && text(graph?.graphId) !== '' ? text(graph?.graphId) : 'legacy-stages'
  const graphVersion = hasGraph ? text(graph?.version) : ''
  const plan = progress.plan ?? null
  const result = progress.result ?? null
  const currentStage = stages.find((stage) => stage.state === 'running' || stage.state === 'waiting') ?? null
  const currentNodeId = currentNodeIdOf(nodes)
  const currentNodeLabel = currentNodeId === null
    ? ''
    : (nodes.find((node) => node.nodeId === currentNodeId)?.label ?? currentNodeId)
  const unresolvedCount = nodes.reduce(
    (count, node) => count + (Array.isArray(node.gaps) ? node.gaps.length : 0),
    0,
  )
  const percentage = typeof progress.percentage === 'number' && progress.plannedTaskCount !== null
    ? progress.percentage
    : null
  const updatedAt = text(progress.updatedAt)

  // Drawer identity comes from the clicked node first; Host detail may only fill in a
  // node that was not explicitly dismissed. A detail for another node is never shown.
  const derivedSelection = detail !== null && detail.nodeId !== dismissedNodeId
    ? { nodeId: detail.nodeId, label: detail.label }
    : null
  const activeSelection = selection ?? derivedSelection
  const activeDetail = detail !== null && activeSelection !== null && detail.nodeId === activeSelection.nodeId
    ? detail
    : null
  const stale = activeDetail !== null
    && (activeDetail.current === false || progress.revision !== activeDetail.revision)

  const onSelect = (nodeId: string, target?: { focus?: () => void } | null): void => {
    focusRef.current = target ?? null
    const label = nodes.find((node) => node.nodeId === nodeId)?.label ?? nodeId
    setSelection({ nodeId, label })
    setDismissedNodeId(null)
    props.onSelectNode(nodeId)
  }
  const onClose = (): void => {
    setDismissedNodeId(activeSelection?.nodeId ?? null)
    setSelection(null)
  }

  const onAnswerChange = (field: string, value: string): void => {
    setAnswers((previous) => ({ ...previous, [field]: value }))
  }
  const submitAnswers = (id: string, payload: Record<string, string>): void => {
    props.onAnswerClarification?.({ clarificationId: id, answers: payload })
  }
  const nodeClarification = clarification !== null && activeDetail !== null
    ? uniqueQuestionsOf(clarification, activeDetail.nodeId)
    : null

  const canRetry = activeDetail !== null
    && !stale
    && props.busy !== true
    && retryAnswer.trim() !== ''
  const submitRetry = (): void => {
    if (activeDetail === null || !canRetry) return
    props.onSubmitRevision({
      nodeId: activeDetail.nodeId,
      expectedRevision: activeDetail.revision,
      changes: [{ field: 'promptSupplement', value: retryAnswer }],
      reason: '员工补充节点答案',
      source: '员工补充说明',
    })
    setRetryAnswer('')
  }

  const globalInputs: Array<ValuationWorkflowNodeFieldView & { nodeId: string }> =
    Array.isArray(progress.globalInputs) ? progress.globalInputs : []
  const editableGlobals = globalInputs.filter((field) => field.editable === true)
  const globalChanges = editableGlobals
    .map((field) => ({ nodeId: field.nodeId, field: field.field, value: globalDraft[field.field] ?? field.value }))
    .filter((change) => change.value !== (editableGlobals.find((field) => field.field === change.field)?.value ?? ''))
  const canSubmitGlobal = globalChanges.length > 0 && props.busy !== true
  const submitGlobal = (): void => {
    if (!canSubmitGlobal) return
    const order = new Map(nodes.map((node, index) => [node.nodeId, index]))
    let owner = globalChanges[0]
    for (const change of globalChanges) {
      const next = order.get(change.nodeId) ?? Number.POSITIVE_INFINITY
      const current = order.get(owner.nodeId) ?? Number.POSITIVE_INFINITY
      if (next < current) owner = change
    }
    props.onSubmitRevision({
      nodeId: owner.nodeId,
      expectedRevision: progress.revision,
      changes: globalChanges.map((change) => ({ field: change.field, value: change.value })),
      reason: '员工修改全局输入',
      source: '员工输入（全局参数）',
    })
    // Keep the editor until a revision actually advances, so a rejected save can be
    // corrected or retried without retyping. The revision effect closes it on success.
  }

  const drawerContent = activeDetail === null
    ? <div className={W.detailLoading} data-workflow-node-loading="true" role="status">
      <span className={W.loadingSpinner} aria-hidden="true" />
      <p className={W.hint}>正在读取节点详情…</p>
    </div>
    : <NodeInspector
      detail={activeDetail}
      market={progress.market}
      revisions={progress.revisions}
      onOpenArtifact={props.onOpenArtifact}
      stale={stale}
      busy={props.busy === true}
      retryAnswer={retryAnswer}
      canRetry={canRetry}
      onRetryAnswerChange={setRetryAnswer}
      onRetrySubmit={submitRetry}
      onRetryNode={activeDetail.stage === null && progress.market === undefined ? undefined : () => {
        if (stale || props.busy || ['preparing', 'awaiting-agent', 'running'].includes(props.runPhase ?? '') || progress.status === 'running') return
        props.onSubmitRevision({ nodeId: activeDetail.nodeId, expectedRevision: activeDetail.revision,
          changes: [{ field: 'promptSupplement', value: '员工请求在故障处理后重新执行本节点；保留并使用已有完整问答，不编造新答案。' }],
          reason: '员工重试执行故障节点', source: '员工显式重试' })
      }}
      onOpenSession={props.onOpenSession}
      clarification={nodeClarification}
      answers={answers}
      onAnswerChange={onAnswerChange}
      onSubmitClarification={submitAnswers}
      questionnaireProps={progress.questionnaire !== undefined && props.onSaveQuestionDraft !== undefined && props.onSubmitQuestions !== undefined ? {
        questionnaire: progress.questionnaire,
        candidates: progress.market?.candidates,
        candidateVersion: progress.market?.candidateVersion,
        nodeId: activeDetail.nodeId,
        revision: progress.revision,
        running: ['preparing', 'awaiting-agent', 'running'].includes(props.runPhase ?? '') || progress.status === 'running',
        busy: props.busy,
        stale,
        localDraft: props.questionDrafts?.[activeDetail.nodeId],
        onSave: props.onSaveQuestionDraft,
        onSubmit: props.onSubmitQuestions,
        onReconcile: () => props.onReconcileQuestionDraft?.(activeDetail.nodeId),
      } : undefined}
    />

  const summary = <header className={W.summary}>
    <span className={W.statusBadge} data-workflow-status={progress.status}>{statusLabelOf(progress.status)}</span>
    {outcome === null
      ? null
      : <span className={W.badge} data-workflow-outcome={outcome}>{outcomeLabelOf(outcome)}</span>}
    <span className={W.badge} data-workflow-waiting={String(progress.waiting === true)}>
      {progress.waiting === true ? '等待员工处理' : '无需员工处理'}
    </span>
    <span className={W.badge} data-workflow-graph-id={graphId}>
      流程 {graphId}{graphVersion === '' ? '' : ` · v${graphVersion}`}
    </span>
    <span className={W.badge} data-workflow-revision-badge={String(progress.revision)}>修订 {progress.revision}</span>
    {currentStage === null
      ? null
      : <span className={W.badge} data-workflow-current-stage={currentStage.stage}>当前阶段：{stageLabelOf(currentStage.stage)}</span>}
    <span className={W.badge} data-workflow-current-node={currentNodeId ?? ''}>
      {currentNodeLabel === '' ? '当前节点：暂无' : `当前节点：${currentNodeLabel}`}
    </span>
    <span className={W.badge} data-workflow-unresolved-count={String(unresolvedCount)}>
      未核缺口 {unresolvedCount}
    </span>
    {updatedAt === ''
      ? null
      : <span className={W.metaText} data-workflow-updated-at={updatedAt}>更新于 {updatedText(updatedAt)}</span>}
    {percentage === null
      ? null
      : <span className={W.badge} data-workflow-percentage={String(percentage)}>已验收 {percentage}%</span>}
    <Button variant="secondary" size="sm" className={W.refresh} onClick={props.onRefresh}>刷新状态</Button>
  </header>

  const decisions = <>
    {globalInputs.length === 0
      ? null
      : <section className={W.global} data-workflow-global-state={String(globalEditing)}
        data-workflow-global-count={String(globalInputs.length)}>
        <div className={W.globalHead}>
          <h3 className={W.panelTitle}>全局输入</h3>
          <span className={W.hint}>不选择节点也可以修改；提交后由 Host 计算重跑范围。</span>
          {globalEditing
            ? null
            : <Button variant="secondary" size="sm" data-workflow-global-edit="true"
              onClick={() => { setGlobalEditing(true) }}>编辑</Button>}
        </div>
        <ul className={W.globalList}>
          {globalInputs.map((field) => {
            const editable = globalEditing && field.editable === true
            const value = globalDraft[field.field] ?? field.value
            const inputId = `crwu-workflow-global-${field.field}`
            return <li className={W.globalItem} key={`${field.nodeId}:${field.field}`}>
              {editable
                ? <>
                  <label className={W.globalLabel} htmlFor={inputId}>{field.label}</label>
                  <input
                    id={inputId}
                    className={W.input}
                    data-workflow-global-input={field.field}
                    value={value}
                    onChange={(event) => {
                      const next = event.currentTarget.value
                      setGlobalDraft((previous) => ({ ...previous, [field.field]: next }))
                    }}
                  />
                </>
                : <>
                  <span className={W.globalLabel}>{field.label}</span>
                  <span className={W.globalValue} data-workflow-global-value={field.field}>
                    <StructuredValue value={field.rawValue === undefined ? field.value : field.rawValue} />
                  </span>
                </>}
              <span className={W.fieldSource}>{field.source}</span>
              {field.editable === true ? null : <span className={W.fieldKind}>只读</span>}
            </li>
          })}
        </ul>
        {globalEditing
          ? <div className={W.globalActions}>
            <Button variant="secondary" size="sm" data-workflow-global-cancel="true"
              onClick={() => { setGlobalEditing(false); setGlobalDraft({}) }}>取消</Button>
            <Button variant="primary" size="sm" data-workflow-global-submit="true"
              disabled={!canSubmitGlobal} onClick={submitGlobal}>提交全局修改</Button>
          </div>
          : null}
      </section>}

    {deliveryKind === null
      ? null
      : <section className={W.delivery} data-workflow-delivery={deliveryKind}
        data-workflow-reference-delivered={String(progress.referenceDelivered === true)}
        data-workflow-formal-complete={String(progress.formalComplete === true)}>
        <h3 className={W.panelTitle}>
          {progress.market ? '已填底稿已交付' : progress.formalComplete === true ? '正式成果已完成' : '参考成果已交付（非正式评估结论）'}
        </h3>
        {progress.market ? <>
          <p className={W.hint}>计算重算与专业复核尚未完成；请查看工作簿中的填表说明。</p>
          {progress.market.artifacts.map(file => <p className={W.hint} key={file.relativePath}>{file.relativePath}</p>)}
          {props.onOpenArtifact ? <div className={W.planActions}>
            {['candidates', 'workpaper', 'trace'].filter(kind => progress.market!.artifacts.some(a => a.kind === kind)).map(kind =>
              <Button key={kind} variant="secondary" size="sm" onClick={() => props.onOpenArtifact?.(kind)}>
                {kind === 'candidates' ? '打开候选案例表' : kind === 'workpaper' ? '打开原模板回填底稿' : '打开填表轨迹'}</Button>)}
          </div> : null}
        </> : null}
      </section>}

    {plan === null
      ? null
      : <PlanPanel plan={plan} progressRevision={progress.revision} busy={props.busy === true}
        onApprovePlan={props.onApprovePlan} onOpenArtifact={props.onOpenArtifact} />}

    {clarification === null || (progress.questionnaire !== undefined && props.onSubmitQuestions !== undefined)
      ? null
      : <ClarificationPanel clarification={clarification} answers={answers} busy={props.busy === true}
        onAnswerChange={onAnswerChange} onSubmit={submitAnswers} />}
  </>

  return <div className={W.root} data-valuation-workflow="true"
    data-workflow-run={progress.runId} data-workflow-revision={String(progress.revision)}>
    <WorkflowWorkspace
      graphId={graphId}
      graphVersion={graphVersion}
      summary={summary}
      decisions={decisions}
      graph={<WorkflowGraph graphId={graphId} nodes={nodes} edges={edges}
        running={(props.runPhase ?? progress.status) === 'running' && !progress.waiting}
        detailNodeId={activeSelection?.nodeId ?? null} onSelectNode={onSelect} />}
      selection={activeSelection}
      detail={drawerContent}
      onClose={onClose}
      returnFocusTo={focusRef}
    >
      {result === null
        ? null
        : <section className={W.result} data-workflow-result="true">
          <h3 className={W.panelTitle}>参考结果</h3>
          <dl className={W.planList}>
            <div className={W.planItem}><dt className={W.planLabel}>对象</dt><dd className={W.planValue}>{result.useLabel}</dd></div>
            <div className={W.planItem}><dt className={W.planLabel}>面积</dt><dd className={W.planValue}>{areaTextOf(result.areaSqm)}</dd></div>
            <div className={W.planItem}><dt className={W.planLabel}>单价</dt><dd className={W.planValue}>{unitPriceTextOf(result.unitPrice)}</dd></div>
            <div className={W.planItem}><dt className={W.planLabel}>总价</dt><dd className={W.planValue}>{`${String(result.totalPrice)} ${result.currency}`}</dd></div>
          </dl>
        </section>}
    </WorkflowWorkspace>
  </div>
}
