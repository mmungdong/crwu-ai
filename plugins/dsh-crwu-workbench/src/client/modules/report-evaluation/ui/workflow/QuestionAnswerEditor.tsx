import * as React from 'react'
import type { ValuationQuestionAnswer, ValuationStoredQuestion } from '../../../../../shared/contracts/valuation-questionnaire.ts'
import type { TemplateMarketCandidate } from '../../../../../shared/contracts/valuation-template-market.ts'
import { QUESTION_OTHER_LABEL, QUESTION_OTHER_OPTION } from '../../../../../shared/contracts/valuation-question-answer.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import { CandidateSelection } from './CandidateSelection.tsx'

export interface QuestionAnswerEditorProps {
  question: ValuationStoredQuestion
  answer?: ValuationQuestionAnswer
  disabled?: boolean
  candidates?: TemplateMarketCandidate[]
  candidateVersion?: number
  onChange: (answer: ValuationQuestionAnswer) => void
}

export function QuestionAnswerEditor(props: QuestionAnswerEditorProps): React.ReactElement {
  const { question, answer, onChange } = props
  const choice = ['radio', 'select', 'multiselect'].includes(question.control ?? '')
  const stash = React.useRef<{ choice: { kind: 'choice'; values: string[]; supplement: string }; other: string; value: string; reason: string }>({
    choice: { kind: 'choice', values: [], supplement: '' }, other: '', value: '', reason: '',
  })
  if (answer?.kind === 'choice') stash.current.choice = answer
  if (answer?.kind === 'other') stash.current.other = answer.text
  if (answer?.kind === 'value') stash.current.value = answer.value
  if (answer?.kind === 'defer') stash.current.reason = answer.reason
  const id = `crwu-question-${question.nodeId}-${question.questionId}`
  const deferred = answer?.kind === 'defer'
  const locked = props.disabled || deferred
  const values = answer?.kind === 'choice' ? answer.values : []
  const options = question.options ?? []
  const select = (value: string): void => {
    if (value === QUESTION_OTHER_OPTION) { onChange({ kind: 'other', text: stash.current.other }); return }
    const previous = stash.current.choice
    const next = question.control === 'multiselect' && answer?.kind === 'choice'
      ? values.includes(value) ? values.filter(v => v !== value) : [...values, value]
      : value ? [value] : []
    onChange({ ...previous, values: next })
  }
  const field = { id, className: W.answerInput, disabled: locked, 'data-workflow-question-answer': question.questionId,
    value: answer?.kind === 'value' ? answer.value : '', onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      onChange({ kind: 'value', value: event.currentTarget.value, supplement: answer?.kind === 'value' ? answer.supplement : '' })
    } }
  return <div className={W.modernAnswer} data-workflow-question-type={question.control ?? 'text'}>
    {choice ? <>
      {question.control === 'select' ? <select id={id} className={W.answerSelect} disabled={locked}
        data-workflow-question-answer={question.questionId} value={answer?.kind === 'other' ? QUESTION_OTHER_OPTION : values[0] ?? ''}
        onChange={event => select(event.currentTarget.value)}>
        <option value="">请选择</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        <option value={QUESTION_OTHER_OPTION}>{QUESTION_OTHER_LABEL}</option>
      </select> : <div id={id} className={W.answerGroup} role={question.control === 'radio' ? 'radiogroup' : 'group'} aria-labelledby={`${id}-label`}>
        {props.candidates && question.field === 'caseIds' ? <CandidateSelection candidates={props.candidates}
          version={props.candidateVersion ?? 0} options={options} selected={values} disabled={locked} onToggle={select} />
          : options.map(option => <label key={option.value} className={W.answerOption}>
            <input type={question.control === 'multiselect' ? 'checkbox' : 'radio'} name={id} value={option.value}
              checked={values.includes(option.value)} disabled={locked} data-workflow-choice={option.value} onChange={() => select(option.value)} />
            {option.label}
          </label>)}
        <label className={W.answerOption}>
          <input type={question.control === 'multiselect' ? 'checkbox' : 'radio'} name={id} value={QUESTION_OTHER_OPTION}
            checked={answer?.kind === 'other'} disabled={locked} data-workflow-choice={QUESTION_OTHER_OPTION}
            onChange={() => select(QUESTION_OTHER_OPTION)} />{QUESTION_OTHER_LABEL}
        </label>
      </div>}
      {answer?.kind === 'other' ? <label className={W.retryField}>请补充说明（必填）
        <textarea className={W.answerInput} rows={3} value={answer.text} disabled={locked} required
          data-workflow-other={question.questionId} onChange={event => onChange({ kind: 'other', text: event.currentTarget.value })} />
      </label> : <label className={W.retryField}>补充说明（选填）
        <textarea className={W.answerInput} rows={2} disabled={locked} value={answer?.kind === 'choice' ? answer.supplement : stash.current.choice.supplement}
          data-workflow-choice-supplement={question.questionId}
          onChange={event => onChange({ ...stash.current.choice, supplement: event.currentTarget.value })} />
      </label>}
    </> : question.control === 'textarea' ? <textarea {...field} rows={3} />
      : question.control === 'boolean' ? <select {...field} className={W.answerSelect}>
        <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
      </select> : <input {...field} type={question.control === 'number' || question.control === 'date' ? question.control : 'text'}
        step={question.control === 'number' ? 'any' : undefined} />}
    {question.allowDefer ? <>
      <label className={W.answerOption}><input type="checkbox" checked={deferred} disabled={props.disabled}
        data-workflow-defer={question.questionId} onChange={event => onChange(event.currentTarget.checked
          ? { kind: 'defer', reason: stash.current.reason } : choice ? stash.current.choice : { kind: 'value', value: stash.current.value, supplement: '' })} />
        暂不处理，带限制继续（需说明原因）</label>
      {deferred ? <textarea className={W.answerInput} rows={2} value={answer.reason} disabled={props.disabled}
        aria-label={`${question.prompt}：暂不处理的原因`} data-workflow-defer-reason={question.questionId}
        onChange={event => onChange({ kind: 'defer', reason: event.currentTarget.value })} /> : null}
    </> : null}
  </div>
}
