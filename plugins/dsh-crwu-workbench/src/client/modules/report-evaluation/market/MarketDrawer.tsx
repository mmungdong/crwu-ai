import * as React from 'react'
import { SideDrawer } from '../../../ui/SideDrawer.tsx'
import { CheckIcon, FileIcon, InfoIcon, WarnIcon } from '../../../ui/icons.tsx'
import type {
  ValuationWorkflowNodeView,
  ValuationWorkflowProgressView,
  ValuationWorkflowQuestion,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type {
  ValuationQuestionAnswer,
  ValuationQuestionEdit,
  ValuationStoredQuestion,
  ValuationWorkflowQuestionnaire,
} from '../../../../shared/contracts/valuation-questionnaire.ts'
import { formatQuestionAnswer } from '../../../../shared/contracts/valuation-question-answer.ts'
import type { MarketNodeView, MarketView } from './model.ts'
import { filterRangeText, planProviderLabels, priceBasisLabelOf } from './model.ts'
import { MarketAnswerEditor, answerIsUsable } from './MarketAnswerEditor.tsx'
import { MarketCaseList } from './MarketCaseList.tsx'
import type { ValuationLocalQuestionDraft } from '../workflow-controller.ts'

export interface MarketDrawerProps {
  view: MarketView
  node: MarketNodeView
  graphNodeId: string
  progress: ValuationWorkflowProgressView
  detail: ValuationWorkflowNodeView | null
  busy: boolean
  localDraft?: ValuationLocalQuestionDraft
  onSaveDraft: (edit: ValuationQuestionEdit) => unknown
  onSubmit: (edit: ValuationQuestionEdit) => unknown
  onApprovePlan?: (input: { expectedRevision: number; planDigest: string; submissionId: string }) => void
  onOpenArtifact?: (kind: string) => void
  onRetry?: () => void
  onNext?: () => void
  onClose: () => void
  returnFocusTo?: { current: { focus?: () => void } | null } | null
  fixture?: boolean
}

function timeText(value: string): string {
  if (value === '') return '--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function questionsFor(questionnaire: ValuationWorkflowQuestionnaire | undefined, stage: string): ValuationStoredQuestion[] {
  if (questionnaire === undefined) return []
  return questionnaire.questions.filter((question) => question.nodeId === stage
    || question.nodeId.endsWith(`:${stage}`)
    || question.nodeId.endsWith(`:template-market:${stage}`))
}

function answersOf(questions: ValuationStoredQuestion[], stored: Record<string, ValuationQuestionAnswer>): Record<string, ValuationQuestionAnswer> {
  const out: Record<string, ValuationQuestionAnswer> = {}
  for (const question of questions) {
    const value = stored[question.questionId] ?? question.answer
    if (value !== null && value !== undefined) out[question.questionId] = value
  }
  return out
}

function editOf(nodeId: string, progress: ValuationWorkflowProgressView, answers: Record<string, ValuationQuestionAnswer>, supplement: string): ValuationQuestionEdit {
  return {
    nodeId,
    expectedRevision: progress.revision,
    expectedQuestionVersion: progress.questionnaire?.version ?? 1,
    answers,
    supplement,
    noteEdits: {},
  }
}

function stateChip(node: MarketNodeView): string {
  if (node.state === 'done') return 'done'
  if (node.state === 'restricted') return 'restricted'
  if (node.state === 'failed') return 'failed'
  return ''
}

function useAnswerForm(props: {
  questions: ValuationStoredQuestion[]
  progress: ValuationWorkflowProgressView
  graphNodeId: string
  nodeId: string
  localDraft?: ValuationLocalQuestionDraft
  onSaveDraft: (edit: ValuationQuestionEdit) => unknown
  onSubmit: (edit: ValuationQuestionEdit) => unknown
}) {
  const [answers, setAnswers] = React.useState<Record<string, ValuationQuestionAnswer>>(
    () => answersOf(props.questions, props.localDraft?.edit.answers ?? {}),
  )
  const [invalid, setInvalid] = React.useState<Record<string, boolean>>({})
  const [error, setError] = React.useState('')
  const [supplement, setSupplement] = React.useState(props.localDraft?.edit.supplement ?? '')
  React.useEffect(() => {
    setAnswers(answersOf(props.questions, props.localDraft?.edit.answers ?? {}))
    setSupplement(props.localDraft?.edit.supplement ?? '')
    setInvalid({})
    setError('')
  }, [props.nodeId, props.progress.revision, props.progress.runId])
  const change = (question: ValuationWorkflowQuestion, answer: ValuationQuestionAnswer): void => {
    const next = { ...answers, [question.questionId]: answer }
    setAnswers(next)
    setError('')
    setInvalid((previous) => ({ ...previous, [question.questionId]: false }))
    props.onSaveDraft(editOf(props.graphNodeId, props.progress, next, supplement))
  }
  const changeSupplement = (value: string): void => {
    setSupplement(value)
    props.onSaveDraft(editOf(props.graphNodeId, props.progress, answers, value))
  }
  const submit = (): boolean => {
    const problems: Record<string, boolean> = {}
    for (const question of props.questions) {
      if (!answerIsUsable(question, answers[question.questionId])) problems[question.questionId] = true
    }
    setInvalid(problems)
    if (Object.keys(problems).length > 0) {
      setError('还有题目未完成：请选择正常选项，或选“以上都不是”并填写说明。')
      return false
    }
    setError('')
    props.onSubmit(editOf(props.graphNodeId, props.progress, answers, supplement))
    return true
  }
  return {
    answers, invalid, error, supplement, change, changeSupplement, submit,
    pending: props.questions.filter((question) => !answerIsUsable(question, answers[question.questionId])).length,
  }
}

type AnswerForm = ReturnType<typeof useAnswerForm>

function DrawerFooter(props: {
  progress: ValuationWorkflowProgressView
  localDraft?: ValuationLocalQuestionDraft
  busy: boolean
  pending: number
  submit: () => void
  onClose: () => void
  queued: boolean
}): React.ReactElement {
  const status = props.localDraft?.status
  const saving = status === 'saving' || status === 'unsaved'
  const label = saving ? '正在保存草稿…' : props.queued ? '答案已接收 · 等待执行' : status === 'error'
    ? `草稿未保存${props.localDraft?.error ? `：${props.localDraft.error}` : ''}`
    : `草稿已自动保存 · ${timeText(props.progress.updatedAt)}`
  return <div className="mv-foot">
    <div className="mv-foot-left">
      <span className="mv-foot-status" data-market-draft-status={status ?? 'restored'}>
        {saving ? <span className="mv-spinner" /> : <CheckIcon size={12} />}{label}
      </span>
      <span className="mv-foot-pending">{props.queued ? '排队等待执行' : props.pending > 0 ? `${props.pending} 项待答` : '题目已答 · 可以提交'}</span>
    </div>
    <div className="mv-foot-actions">
      <button type="button" className="mv-link" data-market-save-exit="true" onClick={props.onClose}>暂存退出</button>
      <button type="button" className="mv-btn primary" disabled={props.busy || props.pending > 0 || props.queued}
        data-market-submit="true" onClick={props.submit}>{props.busy ? <><span className="mv-spinner" />正在提交…</> : props.queued ? '已提交 · 等待执行' : '确认并继续'}</button>
    </div>
  </div>
}

function Details(props: { detail: ValuationWorkflowNodeView | null; progress: ValuationWorkflowProgressView }): React.ReactElement {
  const { detail, progress } = props
  const fields = detail?.outputs ?? []
  const inputs = detail?.inputs ?? []
  const knowledge = detail?.knowledge ?? []
  const history = progress.revisions ?? []
  return <div className="mv-details">
    <details className="mv-acc">
      <summary>本次输入</summary>
      <div className="mv-acc-body">
        {inputs.length === 0
          ? <p className="mv-hint">当前节点没有可展示的输入字段；以 Host 回执为准。</p>
          : <dl className="mv-kv">{inputs.map((field) => <div key={field.field}><dt>{field.label}</dt><dd>{field.value || '—'}</dd></div>)}</dl>}
      </div>
    </details>
    <details className="mv-acc">
      <summary>本次输出</summary>
      <div className="mv-acc-body">
        {fields.length === 0
          ? <p className="mv-hint">节点尚未产生可展示的输出。</p>
          : <dl className="mv-kv">{fields.map((field) => <div key={field.field}><dt>{field.label}</dt><dd>{field.value || '—'}</dd></div>)}</dl>}
      </div>
    </details>
    <details className="mv-acc">
      <summary>采用知识</summary>
      <div className="mv-acc-body">
        {knowledge.length === 0
          ? <p className="mv-hint">当前节点没有登记采用的知识条款。</p>
          : knowledge.slice(0, 8).map((item, index) => <p key={`${item.sourceId}-${index}`}><strong>{item.section || '知识条款'}</strong>：{item.quote || item.path || item.sourceId}</p>)}
      </div>
    </details>
    <details className="mv-acc">
      <summary>历次问答</summary>
      <div className="mv-acc-body">
        {history.length === 0
          ? <p className="mv-hint">暂无历次修订记录。</p>
          : <div className="mv-history">{history.slice(0, 5).map((item) => <div className="mv-history-item" key={String(item.revision)}>
            <div className="mv-history-head"><span>修订 {item.revision}</span><span>{item.updatedAt === undefined ? '' : timeText(item.updatedAt)}</span></div>
            <div className="mv-history-main">{item.reason || '已保存的决定'}{item.source === '' ? '' : ` · ${item.source}`}</div>
          </div>)}</div>}
      </div>
    </details>
    <details className="mv-acc">
      <summary>技术记录</summary>
      <div className="mv-acc-body"><pre className="mv-json">{JSON.stringify({
        node: detail?.label ?? '', nodeId: detail?.nodeId ?? '', revision: progress.revision,
        state: detail?.current === true ? 'current' : 'recorded', gaps: detail?.gaps ?? [],
      }, null, 2)}</pre></div>
    </details>
  </div>
}


function AnswerSnapshot(props: { progress: ValuationWorkflowProgressView; stage: string }): React.ReactElement | null {
  const questionnaire = props.progress.questionnaire
  if (questionnaire === undefined) return null
  const submissions = questionnaire.submissions.filter((item) => item.nodeId === props.stage
    || item.nodeId.endsWith(`:${props.stage}`) || item.nodeId.endsWith(`:template-market:${props.stage}`))
  const latest = submissions[submissions.length - 1]
  const questions = latest?.questions ?? questionnaire.questions.filter((item) => item.nodeId === props.stage
    || item.nodeId.endsWith(`:${props.stage}`) || item.nodeId.endsWith(`:template-market:${props.stage}`))
  if (latest === undefined && questions.length === 0) return null
  const answers = latest?.answers ?? {}
  return <section className="mv-result" data-market-answer-snapshot="true">
    <div className="mv-result-title">已提交答案{latest === undefined ? '' : ` · ${timeText(latest.updatedAt)}`}</div>
    <div className="mv-result-sub">按当时的问题定义回显；修改需要重新提交后生效。</div>
    <dl className="mv-kv">
      {questions.filter((question) => answers[question.questionId] !== undefined).map((question) => <div key={question.questionId}>
        <dt>{question.prompt}</dt><dd>{formatQuestionAnswer(question, answers[question.questionId])}</dd>
      </div>)}
      {(latest?.notes ?? []).map((note) => <div key={note.noteId}><dt>补充说明</dt><dd>{note.text}</dd></div>)}
    </dl>
  </section>
}

function PlanCard(props: { view: MarketView }): React.ReactElement {
  const plan = props.view.plan
  if (plan === null) return <div className="mv-empty">还没有可确认的采集方案。</div>
  const budget = plan.budget
  return <section className="mv-issues" data-market-plan={plan.digest}>
    <div className="mv-issues-head"><span>本轮采集方案</span><span className="mv-issues-count">{plan.digest.slice(0, 18)}…</span></div>
    <dl className="mv-kv">
      <div><dt>计算表</dt><dd>{plan.template.relativePath}</dd></div>
      <div><dt>适用性</dt><dd>{plan.filters.propertyType || '案例类型待确认'} · {priceBasisLabelOf(plan)}</dd></div>
      <div><dt>筛选范围</dt><dd>{[plan.filters.city, plan.filters.district, plan.filters.community].filter(Boolean).join(' · ') || '待确认'} · {filterRangeText(plan)}</dd></div>
      <div><dt>来源</dt><dd>{planProviderLabels(plan).join('、') || '待确认'}</dd></div>
      <div><dt>预算</dt><dd>最多 {budget.maxPages ?? '待定'} 页、{budget.maxCandidates ?? '待定'} 条、{budget.maxDurationMs === null ? '待定' : `${Math.ceil(budget.maxDurationMs / 1000)} 秒`}</dd></div>
    </dl>
    {plan.stopRules.map((rule, index) => <p className="mv-help" key={index}>停止条件：{rule}</p>)}
    {plan.proposedDispositions.length > 0
      ? <div className="mv-caveat"><WarnIcon size={14} /><div><strong>需要你确认的缺口处置</strong>
        {plan.proposedDispositions.map((item) => <p key={item.dispositionId}>{item.reason}{item.assumption === null ? '' : ` · 情景假设 ${String(item.assumption.value)} ${item.assumption.unit}`}</p>)}
      </div></div>
      : null}
  </section>
}

function CaseForm(props: {
  view: MarketView
  form: AnswerForm
  questions: ValuationStoredQuestion[]
  busy: boolean
}): React.ReactElement {
  const caseQuestion = props.questions.find((question) => question.field === 'caseIds')
  const decisionQuestion = props.questions.find((question) => question.field !== 'caseIds')
  const caseAnswer = caseQuestion === undefined ? undefined : props.form.answers[caseQuestion.questionId]
  const selected = caseAnswer?.kind === 'choice' ? caseAnswer.values : []
  const [noteOpen, setNoteOpen] = React.useState(false)
  const stash = React.useRef({ cases: [] as string[], other: '' })
  if (caseAnswer?.kind === 'other') stash.current.other = caseAnswer.text
  const toggleCase = (caseId: string): void => {
    if (caseQuestion === undefined) return
    const values = caseAnswer?.kind === 'choice' ? caseAnswer.values : []
    const next = values.includes(caseId) ? values.filter((id) => id !== caseId) : [...values, caseId]
    props.form.change(caseQuestion, { kind: 'choice', values: next, supplement: caseAnswer?.kind === 'choice' ? caseAnswer.supplement : '' })
  }
  return <div data-market-questionnaire="select-cases">
    <p className="mv-lede">已整理候选案例，请选择需要核实详情的房源。你的选择会决定下一步读取哪些页面。</p>
    <div className="mv-mini-meta">
      <span>任务：{props.view.project}</span>
      <span>口径：{props.view.subtitle}</span>
      <span>候选：{props.view.candidates.length} 条</span>
    </div>
    <section className="mv-issues">
      <div className="mv-issues-head"><span>当前已知问题</span><span className="mv-issues-count">2 题 · 已答 {props.questions.filter((q) => answerIsUsable(q, props.form.answers[q.questionId])).length}</span></div>
      <div className="mv-issues-chips">
        <span className="mv-chip">01 · 多选</span><span className="mv-chip">02 · 单选</span><span className="mv-chip">草稿自动保存</span>
      </div>
      <p className="mv-rec-note"><InfoIcon size={13} /><span>推荐标记只说明相似度，不默认勾选，也不替你做选择；未选中的案例不会读取详情或截图。</span></p>
      <details className="mv-details"><summary>知识条款与推荐依据</summary>
        <p className="mv-help">比较案例应优先位于同一供需圈，并核实挂牌性质、权利状况与价格口径。推荐项来自候选表的真实相似点与待核字段。</p>
      </details>
    </section>
    {caseQuestion === undefined
      ? <p className="mv-hint">当前没有待答的案例选择题，请刷新后查看节点状态。</p>
      : <fieldset className="mv-q" data-market-question={caseQuestion.questionId}>
        <legend className="mv-sr-only">{caseQuestion.prompt}</legend>
        <div className="mv-q-head"><span className="mv-q-num">01</span><span className="mv-q-title">{caseQuestion.prompt}</span><span className="mv-q-type">多选</span>
          <span className="mv-q-state">{selected.length > 0 || caseAnswer?.kind === 'other' ? '已答' : '未答'}</span></div>
        <p className="mv-q-help">可多选，建议 2–3 条；仅所选案例会进入详情读取。点击整行或复选框均可选择。</p>
        <MarketCaseList candidates={props.view.candidates} options={caseQuestion.options ?? []} selected={selected}
          version={props.view.candidateVersion} disabled={props.busy} onToggle={toggleCase} />
        <label className="mv-other-row"><input type="checkbox" checked={caseAnswer?.kind === 'other'}
          data-market-other={caseQuestion.questionId} disabled={props.busy}
          onChange={() => {
            if (caseAnswer?.kind === 'other') {
              props.form.change(caseQuestion, { kind: 'choice', values: stash.current.cases, supplement: '' })
            } else {
              stash.current.cases = selected
              props.form.change(caseQuestion, { kind: 'other', text: stash.current.other })
            }
          }} />
          <span>以上都不是，补充说明<span className="mv-hint">与上方正常选项互斥；切换时会保留已填文字。</span></span></label>
        {caseAnswer?.kind === 'other'
          ? <div className="mv-other-panel"><label className="mv-field"><span>请说明你的处理方式 <span className="mv-req">必填</span></span>
            <textarea className="mv-textarea" rows={2} value={caseAnswer.text} disabled={props.busy}
              data-market-other-text={caseQuestion.questionId}
              onChange={(event) => { props.form.change(caseQuestion, { kind: 'other', text: event.currentTarget.value }) }} />
            <span className="mv-help">至少 2 个字；提交后作为本次处理授权的一部分。</span></label></div>
          : null}
        {props.form.invalid[caseQuestion.questionId] ? <p className="mv-error"><WarnIcon size={13} /> 请至少选择一条候选，或选择“以上都不是”并填写说明。</p> : null}
        <button type="button" className="mv-note-toggle" aria-expanded={noteOpen} onClick={() => { setNoteOpen(!noteOpen) }}>{noteOpen ? '收起补充说明（可选）' : '+ 补充说明（可选）'}</button>
        {noteOpen
          ? <div className="mv-note-panel"><label className="mv-field"><span>补充选择理由或核实优先级</span>
            <textarea className="mv-textarea" rows={2} value={props.form.supplement}
              onChange={(event) => { props.form.changeSupplement(event.currentTarget.value) }} />
          </label></div>
          : null}
      </fieldset>}
    {decisionQuestion === undefined
      ? null
      : <fieldset className="mv-q" data-market-question={decisionQuestion.questionId}>
        <legend className="mv-sr-only">{decisionQuestion.prompt}</legend>
        <div className="mv-q-head"><span className="mv-q-num">02</span><span className="mv-q-title">{decisionQuestion.prompt}</span><span className="mv-q-type">单选</span>
          <span className="mv-q-state">{answerIsUsable(decisionQuestion, props.form.answers[decisionQuestion.questionId]) ? '已答' : '未答'}</span></div>
        <p className="mv-q-help">单选。选择会决定是否进入详情读取，以及后续交付的范围。</p>
        <MarketAnswerEditor question={decisionQuestion} answer={props.form.answers[decisionQuestion.questionId]}
          disabled={props.busy} invalid={props.form.invalid[decisionQuestion.questionId] === true}
          onChange={(answer) => { props.form.change(decisionQuestion, answer) }} />
        {props.form.invalid[decisionQuestion.questionId] ? <p className="mv-error"><WarnIcon size={13} /> 请选择一种后续处理方式，或标记“暂不处理，保留待核”。</p> : null}
      </fieldset>}
    {props.form.error === '' ? null : <p className="mv-error" role="alert"><WarnIcon size={13} /> {props.form.error}</p>}
  </div>
}

function GenericForm(props: {
  form: AnswerForm
  questions: ValuationStoredQuestion[]
  busy: boolean
}): React.ReactElement | null {
  if (props.questions.length === 0) return null
  return <div data-market-questionnaire="generic">
    {props.questions.map((question, index) => <fieldset className="mv-q" key={question.questionId} data-market-question={question.questionId}>
      <legend className="mv-sr-only">{question.prompt}</legend>
      <div className="mv-q-head"><span className="mv-q-num">{String(index + 1).padStart(2, '0')}</span><span className="mv-q-title">{question.prompt}</span>
        <span className="mv-q-type">{question.control === 'multiselect' ? '多选' : question.control === 'radio' || question.control === 'select' ? '单选' : question.control === 'number' ? '数值' : question.control === 'date' ? '日期' : '填写'}</span>
        <span className="mv-q-state">{answerIsUsable(question, props.form.answers[question.questionId]) ? '已答' : '未答'}</span></div>
      {question.reason === undefined || question.reason === '' ? null : <p className="mv-q-help">{question.reason}</p>}
      <MarketAnswerEditor question={question} answer={props.form.answers[question.questionId]} disabled={props.busy}
        invalid={props.form.invalid[question.questionId] === true}
        onChange={(answer) => { props.form.change(question, answer) }} />
    </fieldset>)}
    {props.form.error === '' ? null : <p className="mv-error" role="alert"><WarnIcon size={13} /> {props.form.error}</p>}
  </div>
}

function Delivery(props: { view: MarketView; progress: ValuationWorkflowProgressView; onOpenArtifact?: (kind: string) => void }): React.ReactElement {
  const artifacts = props.progress.market?.artifacts ?? []
  return <div>
    <div className={`mv-result ${props.view.status.tone === 'restricted' ? 'warn' : ''}`}>
      <div className="mv-result-title">{props.view.status.tone === 'restricted' ? '受限交付已生成' : '交付件已生成'}</div>
      <div className="mv-result-sub">成果性质、公式状态与待核项以 Host 回执为准；未完成重算时不会表述为正式估值结论。</div>
    </div>
    <div className="mv-file-list">
      {artifacts.length === 0
        ? <p className="mv-hint">当前没有可打开的交付件。</p>
        : artifacts.map((artifact) => <button type="button" className="mv-file-row" key={artifact.relativePath}
          onClick={() => { props.onOpenArtifact?.(artifact.kind) }}>
          <span className="mv-file-icon"><FileIcon size={15} /></span>
          <span className="mv-file-text"><span className="mv-file-name">{artifact.relativePath.split('/').pop()}</span>
            <span className="mv-file-meta">{artifact.kind} · {artifact.bytes} bytes · {artifact.digest.slice(0, 18)}…</span></span>
          <span className="mv-file-open">打开</span>
        </button>)}
    </div>
    <p className="mv-caveat"><WarnIcon size={14} /><span>{props.view.deliveryKind === 'workpaper' ? '已填底稿：公式重算与正式结论尚未完成，待核项在底稿中保留。' : '交付范围以实际回执和限制说明为准。'}</span></p>
  </div>
}

export function MarketDrawer(props: MarketDrawerProps): React.ReactElement {
  const { node, progress, detail, busy } = props
  const [editing, setEditing] = React.useState(false)
  React.useEffect(() => { setEditing(false) }, [node.id, progress.revision])
  const questions = questionsFor(progress.questionnaire, node.id)
  const form = useAnswerForm({
    questions,
    progress,
    graphNodeId: props.graphNodeId,
    nodeId: node.id,
    localDraft: props.localDraft,
    onSaveDraft: props.onSaveDraft,
    onSubmit: (edit) => {
      if (node.id === 'confirm-plan' && props.view.plan !== null) {
        const approval = questions.find((question) => question.field === 'approval')
        const value = approval === undefined ? undefined : edit.answers[approval.questionId]
        if (value?.kind === 'choice' && value.values[0] === 'accept') {
          props.onApprovePlan?.({ expectedRevision: progress.revision, planDigest: props.view.plan.digest, submissionId: `mv-${progress.revision}-${Date.now()}` })
          return
        }
      }
      props.onSubmit(edit)
    },
  })
  const subtitle = node.id === 'select-cases'
    ? `节点 07 / 11 · 多选与单选 · ${questions.length} 题`
    : `节点 ${String(node.index).padStart(2, '0')} / 11 · 业务节点`
  const isCases = node.id === 'select-cases' && questions.length > 0
  const isPlan = node.id === 'confirm-plan' && props.view.plan !== null
  const isDelivery = node.id === 'validate-delivery' || node.id === 'fill-template'
  const isFailed = node.state === 'failed'
  const recovery = progress.market?.recovery
  const canRetry = isFailed && !busy && props.onRetry !== undefined
    && node.id === props.view.currentNodeId && recovery?.retryAllowed !== false
  const isDone = node.state === 'done' || node.state === 'restricted'
  const waitingForAnswer = questions.length > 0 && !isDone && !isFailed && node.state !== 'executing'
  const status = props.localDraft?.status
  const queued = status === 'queued' || status === 'submitted'
  const footer = isFailed
    ? <div className="mv-foot"><div className="mv-foot-left"><span className="mv-foot-status"><WarnIcon size={12} />执行失败 · 已保留已有输入与回执</span>
      <span className="mv-foot-pending">{recovery?.retryAllowed === false ? recovery.reason || '当前停止或保存状态需要核对，暂不能重试' : '修复原因后可恢复同一轮'}</span></div>
      <div className="mv-foot-actions"><button type="button" className="mv-btn" onClick={props.onClose}>关闭</button>
        <button type="button" className="mv-btn primary" data-market-retry={true} disabled={!canRetry} onClick={props.onRetry}>重试此节点</button></div></div>
    : isCases && isDone
      ? <div className="mv-foot"><div className="mv-foot-left"><span className="mv-foot-status"><CheckIcon size={12} />已提交 · 防重复提交已启用</span>
        <span className="mv-foot-pending">节点结果已生成</span></div>
        <div className="mv-foot-actions"><button type="button" className="mv-link" data-market-modify="true" onClick={() => { setEditing(true) }}>修改回答</button>
          <button type="button" className="mv-btn primary" data-market-next="true" onClick={props.onNext}>进入下一节点</button></div></div>
      : waitingForAnswer
      ? <DrawerFooter progress={progress} localDraft={props.localDraft} busy={busy}
        pending={form.pending} submit={() => { form.submit() }} onClose={props.onClose} queued={queued} />
      : isDone && isDelivery
        ? <div className="mv-foot"><div className="mv-foot-left"><span className="mv-foot-status"><CheckIcon size={12} />已提交 · 交付状态以 Host 回执为准</span></div>
          <div className="mv-foot-actions"><button type="button" className="mv-btn primary" onClick={props.onClose}>完成</button></div></div>
        : <div className="mv-foot"><div className="mv-foot-left"><span className="mv-foot-status"><InfoIcon size={12} />{node.state === 'executing' ? '正在执行当前节点' : node.state === 'pending' ? '前置节点尚未完成' : '节点记录'}</span></div>
          <div className="mv-foot-actions"><button type="button" className="mv-btn" onClick={props.onClose}>关闭</button></div></div>

  return <SideDrawer
    title={node.label}
    subtitle={subtitle}
    initialFocus="heading"
    returnFocusTo={props.returnFocusTo}
    onClose={props.onClose}
    footer={footer}
    dataAttributes={{ 'data-market-drawer': node.id }}
  >
    <div className="mv-drawer-top">
      <span className={`mv-drawer-chip ${stateChip(node)}`} data-market-drawer-state={node.state}>{node.stateLabel}</span>
      {props.fixture === true ? <span className="mv-drawer-kicker">夹具数据 · 非生产</span> : null}
    </div>
    {isCases
      ? isDone && !editing
        ? <AnswerSnapshot progress={progress} stage="select-cases" />
        : <CaseForm view={props.view} form={form} questions={questions} busy={busy} />
      : isPlan
        ? <>
          <p className="mv-lede">请核对模板、案例类型、价格性质、筛选范围、来源、预算和停止条件。未明确确认前，不会抓取列表。</p>
          <PlanCard view={props.view} />
          <GenericForm form={form} questions={questions} busy={busy} />
        </>
        : isDelivery
          ? <Delivery view={props.view} progress={progress} onOpenArtifact={props.onOpenArtifact} />
          : <div>
            <p className="mv-lede">{node.description}</p>
            <div className="mv-mini-meta"><span>状态：{node.stateLabel}</span><span>节点：{String(node.index).padStart(2, '0')} / 11</span>{node.gaps.length > 0 ? <span>待核：{node.gaps.length} 项</span> : null}</div>
            {isFailed
              ? <div className="mv-caveat"><WarnIcon size={14} /><div><strong>本节点执行失败</strong><p>{node.gaps[0] ?? 'Host 未返回更多错误细节，请保留资料后重试。'}</p></div></div>
              : null}
            {questions.length > 0 && !isCases && !isPlan
              ? <GenericForm form={form} questions={questions} busy={busy} />
              : <div className="mv-empty">{node.state === 'pending' ? '前置节点尚未完成，当前只展示实际回执。' : '本节点没有待答问题；处理结果与来源见下方折叠区。'}</div>}
          </div>}
    <Details detail={detail} progress={progress} />
  </SideDrawer>
}
