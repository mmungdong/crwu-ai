import * as React from 'react'
import type {
  ValuationQuestionAnswer, ValuationQuestionEdit, ValuationStoredQuestion, ValuationWorkflowQuestionnaire,
} from '../../../../../shared/contracts/valuation-questionnaire.ts'
import type { ValuationLocalQuestionDraft } from '../../workflow-controller.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'

export interface QuestionnairePanelProps {
  questionnaire: ValuationWorkflowQuestionnaire
  nodeId: string
  revision: number
  running: boolean
  busy?: boolean
  stale?: boolean
  executionBlocked?: boolean
  localDraft?: ValuationLocalQuestionDraft
  onSave: (edit: ValuationQuestionEdit) => unknown
  onSubmit: (edit: ValuationQuestionEdit) => unknown
  onReconcile?: () => unknown
}

function valuesOf(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
  } catch { return [] }
}

function validAnswer(question: ValuationStoredQuestion, answer?: ValuationQuestionAnswer): boolean {
  if (!question.applicable) return true
  if (answer?.unknown) return (answer.reason ?? '').trim() !== ''
  const value = (answer?.value ?? '').trim()
  if (value === '') return question.required === false
  const options = question.options ?? []
  switch (question.control) {
    case 'boolean': return value === 'true' || value === 'false'
    case 'number': return Number.isFinite(Number(value))
    case 'date': {
      const date = new Date(`${value}T00:00:00Z`)
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    }
    case 'radio': case 'select': return options.some((option) => option.value === value)
    case 'multiselect': {
      const values = valuesOf(value)
      return (question.required === false || values.length > 0) && new Set(values).size === values.length && values.every((item) => options.some((option) => option.value === item))
    }
    default: return true
  }
}

function restoredEdit(props: QuestionnairePanelProps): ValuationQuestionEdit {
  const answers: ValuationQuestionEdit['answers'] = {}
  for (const question of props.questionnaire.questions) {
    if (question.nodeId === props.nodeId && question.applicable && !question.needsConfirmation && question.answer !== null) {
      answers[question.questionId] = question.answer
    }
  }
  const draft = props.questionnaire.drafts.find((item) => item.nodeId === props.nodeId)
  return { nodeId: props.nodeId, expectedRevision: props.revision, expectedQuestionVersion: props.questionnaire.version,
    answers: { ...answers, ...draft?.answers }, supplement: draft?.supplement ?? '', noteEdits: { ...draft?.noteEdits } }
}

export function QuestionnairePanel(props: QuestionnairePanelProps): React.ReactElement {
  const [local, setLocal] = React.useState(() => restoredEdit(props))
  const dirty = React.useRef(false)
  const identity = React.useRef(props.nodeId)
  const edit = props.localDraft?.edit ?? local
  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!dirty.current || props.localDraft?.status === 'saved' || props.localDraft?.status === 'queued'
        || props.localDraft?.status === 'submitted') return
      event.preventDefault()
      event.returnValue = ''
    }
    globalThis.addEventListener?.('beforeunload', warn)
    return () => globalThis.removeEventListener?.('beforeunload', warn)
  }, [props.localDraft?.status])
  React.useEffect(() => {
    if (identity.current !== props.nodeId || (!dirty.current && props.localDraft === undefined)) {
      identity.current = props.nodeId
      dirty.current = false
      setLocal(restoredEdit(props))
    }
    if (props.localDraft?.status === 'saved' || props.localDraft?.status === 'submitted') dirty.current = false
  }, [props.nodeId, props.questionnaire.version, props.localDraft])

  const questions = props.questionnaire.questions.filter((question) => question.nodeId === props.nodeId)
  const notes = props.questionnaire.notes.filter((note) => note.nodeId === props.nodeId)
  const submissions = props.questionnaire.submissions.filter((submission) => submission.nodeId === props.nodeId)
  const legacy = props.questionnaire.legacy.filter((record) => record.nodeId === props.nodeId)
  const conflict = props.localDraft?.status === 'conflict'
  const disabled = props.stale === true
  const missing = questions.some((question) => !validAnswer(question, edit.answers[question.questionId]))
  const hasContent = questions.some((question) => question.applicable) || edit.supplement.trim() !== ''
    || notes.some((note) => edit.noteEdits[note.noteId] !== undefined && edit.noteEdits[note.noteId] !== note.text)
  const canSubmit = hasContent && !props.executionBlocked && !missing && !props.running && !props.busy && !disabled && !conflict
  const change = (patch: Partial<ValuationQuestionEdit>): void => {
    const next = { ...edit, ...patch }
    dirty.current = true
    setLocal(next)
    props.onSave(next)
  }
  const changeAnswer = (question: ValuationStoredQuestion, answer: ValuationQuestionAnswer): void => {
    change({ answers: { ...edit.answers, [question.questionId]: answer } })
  }

  return <section className={W.clarify} data-workflow-questionnaire={props.nodeId}>
    <h3 className={W.panelTitle}>节点问题与补充记录</h3>
    <ul className={W.clarifyList}>
      {questions.map((question) => {
        const answer = edit.answers[question.questionId] ?? { value: '' }
        const id = `crwu-question-${props.nodeId}-${question.questionId}`
        const label = `${id}-label`
        const control = question.control ?? 'text'
        const options = control === 'boolean'
          ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : question.options ?? []
        const locked = disabled || !question.applicable || answer.unknown === true
        const inputProps = { id, className: W.answerInput, 'data-workflow-question-answer': question.questionId,
          value: answer.value, disabled: locked, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
            changeAnswer(question, { value: event.currentTarget.value })
          } }
        return <li key={question.questionId} className={W.clarifyQuestion} data-workflow-stored-question={question.questionId}>
          <label className={W.clarifyPrompt} htmlFor={id} id={label}>{question.prompt}</label>
          <span className={W.fieldSource}>{question.source} · {question.required === false ? '选填' : '必填'}</span>
          {question.answer === null ? null : <p className={W.hint} data-workflow-saved-answer={question.questionId}>
            已提交答案：{question.answer.unknown ? `无法确认（${question.answer.reason ?? ''}）` : question.answer.value}
            {question.needsConfirmation ? ' · 需要按新定义重新确认' : ' · 是否通过以节点核验结果为准'}
          </p>}
          {!question.applicable
            ? <p className={W.hint}>不适用：{question.inapplicabilityReason ?? question.reason ?? '请查看节点记录'}{question.answer ? ` · 此前答案：${question.answer.value}` : ''}</p>
            : <>
              {question.needsConfirmation && edit.answers[question.questionId] === undefined
                ? <p className={W.stale} data-workflow-question-reconfirm={question.questionId}>
                  问题已更新，请按当前定义重新确认。{question.answer === null ? '' : `此前答案：${question.answer.unknown ? '未知' : question.answer.value}`}
                  {question.answer === null ? null : <button type="button" className="crwu-ui-btn crwu-ui-btn-secondary crwu-ui-btn-sm"
                    disabled={disabled} onClick={() => { changeAnswer(question, question.answer!) }}>确认此前答案</button>}
                </p> : null}
              {control === 'textarea' ? <textarea {...inputProps} rows={3} />
                : control === 'select' || control === 'boolean' ? <select {...inputProps} className={W.answerSelect}>
                  <option value="">请选择</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                  : control === 'radio' || control === 'multiselect' ? <div className={W.answerGroup} role={control === 'radio' ? 'radiogroup' : 'group'} aria-labelledby={label}>
                    {options.map((option) => {
                      const selected = valuesOf(answer.value)
                      return <label className={W.answerOption} key={option.value}>
                        <input type={control === 'radio' ? 'radio' : 'checkbox'} name={id} value={option.value}
                          disabled={locked} checked={control === 'radio' ? answer.value === option.value : selected.includes(option.value)}
                          data-workflow-question-answer={question.questionId}
                          onChange={() => { changeAnswer(question, { value: control === 'radio' ? option.value
                            : JSON.stringify(selected.includes(option.value) ? selected.filter((value) => value !== option.value) : [...selected, option.value]) }) }} />
                        {option.label}
                      </label>
                    })}
                  </div> : <input {...inputProps} type={control === 'date' || control === 'number' ? control : 'text'} step={control === 'number' ? 'any' : undefined} />}
              <label className={W.answerOption}>
                <input type="checkbox" checked={answer.unknown === true} disabled={disabled}
                  data-workflow-question-unknown={question.questionId}
                  onChange={(event) => { changeAnswer(question, { value: answer.value, ...(event.currentTarget.checked ? { unknown: true, reason: answer.reason ?? '' } : {}) }) }} />
                暂不清楚（需填写原因）
              </label>
              {answer.unknown ? <textarea rows={2} className={W.answerInput} aria-label={`${question.prompt}：未知原因`}
                data-workflow-question-reason={question.questionId} value={answer.reason ?? ''} disabled={disabled}
                onChange={(event) => { changeAnswer(question, { ...answer, reason: event.currentTarget.value }) }} /> : null}
            </>}
        </li>
      })}
    </ul>
    {notes.map((note) => <label className={W.retryField} key={note.noteId}>此前补充（可修改）
      <textarea className={W.answerInput} rows={2} value={edit.noteEdits[note.noteId] ?? note.text} disabled={disabled}
        data-workflow-note-edit={note.noteId} onChange={(event) => { change({ noteEdits: { ...edit.noteEdits, [note.noteId]: event.currentTarget.value } }) }} />
      {note.history.length > 0 ? <details><summary>查看补充修改历史</summary>{note.history.map((value, index) => <p className={W.hint} key={index}>{value}</p>)}</details> : null}
    </label>)}
    <label className={W.retryField}>本次新增补充（选填）
      <textarea className={W.answerInput} rows={3} value={edit.supplement} disabled={disabled}
        data-workflow-question-supplement="true" onChange={(event) => { change({ supplement: event.currentTarget.value }) }} />
    </label>
    {legacy.map((record, index) => <p className={W.hint} key={index} data-workflow-legacy-note="true">历史补充（修订 {record.revision}）：{record.text}</p>)}
    {submissions.length > 0 ? <details data-workflow-submission-history="true"><summary>查看历次提交（{submissions.length}）</summary>
      {submissions.map((submission) => <div key={submission.submissionId} className={W.block}>
        <p className={W.hint}>问卷版本 {submission.version} · {submission.updatedAt}</p>
        {Object.entries(submission.answers).map(([id, answer]) => <p key={id} className={W.hint}>
          {(submission.questions ?? questions).find((question) => question.questionId === id)?.prompt ?? id}：{answer.unknown ? `未知：${answer.reason ?? ''}` : answer.value}
        </p>)}
        {submission.notes.map((note) => <p key={note.noteId} className={W.hint}>{note.text}</p>)}
      </div>)}
    </details> : null}
    <p className={props.localDraft?.error ? W.stale : W.hint} role="status" data-workflow-draft-status={props.localDraft?.status ?? 'restored'}>
      {props.localDraft?.error || (props.localDraft?.status === 'saving' ? '正在保存草稿…'
        : props.localDraft?.status === 'saved' ? '草稿已保存，尚未提交执行。'
          : props.localDraft?.status === 'submitted' ? '答案已接收并保存，模型执行结果请查看节点状态。'
            : props.localDraft?.status === 'queued' ? '草稿已保存，提交已进入执行队列；正式答案保存结果等待状态刷新。'
            : props.localDraft?.status === 'unsaved' ? '本地修改待保存…' : '已恢复当前任务的问答记录。')}
    </p>
    {conflict ? <button type="button" className="crwu-ui-btn crwu-ui-btn-secondary crwu-ui-btn-sm"
      data-workflow-draft-reconcile="true" onClick={() => { props.onReconcile?.() }}>已核对最新问题，保留本地修改并重新保存</button> : null}
    {props.localDraft?.status === 'error' ? <button type="button" className="crwu-ui-btn crwu-ui-btn-secondary crwu-ui-btn-sm"
      data-workflow-draft-retry="true" onClick={() => { props.onSave(edit) }}>重试保存草稿</button> : null}
    {props.running ? <p className={W.hint}>节点正在执行，可以编辑并保存草稿；执行结束后才能正式提交。</p> : null}
    {missing ? <p className={W.hint}>请完整填写全部必填项，并核对数值、日期和选项；未知答案需说明原因。</p> : null}
    {props.stale ? <p className={W.stale}>节点版本已更新，请刷新后核对。</p> : null}
    {props.executionBlocked ? <p className={W.hint}>当前为执行故障。已保留问答，可继续保存草稿；请先按上方恢复要求处理。</p>
      : <button type="button" className={`${W.answerSubmit} crwu-ui-btn crwu-ui-btn-primary crwu-ui-btn-sm`}
        data-workflow-questions-submit="true" disabled={!canSubmit} onClick={() => { if (canSubmit) props.onSubmit(edit) }}>
        {questions.some((question) => question.applicable) ? '提交全部答案并执行' : '提交补充并执行'}</button>}
  </section>
}
