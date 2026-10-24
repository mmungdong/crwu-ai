import * as React from 'react'
import type { ValuationQuestionAnswer, ValuationStoredQuestion } from '../../../../shared/contracts/valuation-questionnaire.ts'
import { QUESTION_OTHER_LABEL, QUESTION_OTHER_OPTION } from '../../../../shared/contracts/valuation-question-answer.ts'
import { WarnIcon } from '../../../ui/icons.tsx'

export interface MarketAnswerEditorProps {
  question: ValuationStoredQuestion
  answer: ValuationQuestionAnswer | undefined
  disabled?: boolean
  invalid?: boolean
  onChange: (answer: ValuationQuestionAnswer) => void
}

function isChoice(control: string | undefined): boolean {
  return control === 'radio' || control === 'select' || control === 'multiselect'
}

function hasAnswer(answer: ValuationQuestionAnswer | undefined): boolean {
  if (answer === undefined) return false
  if (answer.kind === 'choice') return answer.values.length > 0
  if (answer.kind === 'other') return answer.text.trim() !== ''
  if (answer.kind === 'value') return answer.value.trim() !== ''
  return (answer.reason ?? '').trim() !== ''
}

export function answerIsUsable(question: ValuationStoredQuestion, answer: ValuationQuestionAnswer | undefined): boolean {
  if (question.applicable === false || question.required === false) return true
  if (!hasAnswer(answer)) return false
  if (answer?.kind === 'other') return answer.text.trim().length >= 2
  if (answer?.kind === 'defer') return question.allowDefer === true && (answer.reason ?? '').trim().length >= 2
  return true
}

/**
 * Typed answer control used by the market drawer.
 *
 * `choice` and `other` are mutually exclusive; switching keeps both drafts so the
 * employee can move back without retyping. A defer is a separate answer kind and
 * never masquerades as a normal choice.
 */
export function MarketAnswerEditor(props: MarketAnswerEditorProps): React.ReactElement {
  const { question, answer, disabled } = props
  const id = `mv-q-${question.nodeId}-${question.questionId}`
  const choice = isChoice(question.control)
  const stash = React.useRef({
    choice: { kind: 'choice' as const, values: [] as string[], supplement: '' },
    other: '',
    value: '',
    reason: '',
  })
  if (answer?.kind === 'choice') stash.current.choice = answer
  if (answer?.kind === 'other') stash.current.other = answer.text
  if (answer?.kind === 'value') stash.current.value = answer.value
  if (answer?.kind === 'defer') stash.current.reason = answer.reason
  const deferred = answer?.kind === 'defer'
  const locked = disabled === true || deferred
  const values = answer?.kind === 'choice' ? answer.values : []
  const options = question.options ?? []

  const pick = (value: string): void => {
    if (value === QUESTION_OTHER_OPTION) {
      props.onChange({ kind: 'other', text: stash.current.other })
      return
    }
    const previous = stash.current.choice
    const baseValues = answer?.kind === 'choice' ? values : previous.values
    const next = question.control === 'multiselect'
      ? (baseValues.includes(value) ? baseValues.filter((item) => item !== value) : [...baseValues, value])
      : (value === '' ? [] : [value])
    props.onChange({ kind: 'choice', values: next, supplement: previous.supplement })
  }

  if (!choice) {
    const value = answer?.kind === 'value' ? answer.value : ''
    const type = question.control === 'number' ? 'number' : question.control === 'date' ? 'date' : 'text'
    return <div className="mv-answer" data-market-question-type={question.control ?? 'text'}>
      <input
        id={id}
        className="mv-input"
        type={type}
        step={question.control === 'number' ? 'any' : undefined}
        value={value}
        disabled={locked}
        aria-invalid={props.invalid === true}
        data-market-question-answer={question.questionId}
        onChange={(event) => { props.onChange({ kind: 'value', value: event.currentTarget.value, supplement: '' }) }}
      />
      {question.allowDefer === true
        ? <>
          <label className={`mv-defer ${deferred ? 'checked' : ''}`}>
            <input type="checkbox" checked={deferred} disabled={disabled}
              data-market-defer={question.questionId}
              onChange={(event) => { props.onChange(event.currentTarget.checked
                ? { kind: 'defer', reason: stash.current.reason }
                : { kind: 'value', value: stash.current.value, supplement: '' }) }} />
            <span><span className="mv-defer-title">暂不处理，带限制继续</span><span className="mv-defer-desc">需说明原因；保留为待核项，不当作已核实事实。</span></span>
          </label>
          {deferred
            ? <div className="mv-other-panel">
              <label className="mv-field" htmlFor={`${id}-reason`}><span>暂不处理的原因 <span className="mv-req">必填</span></span>
                <textarea id={`${id}-reason`} className="mv-textarea" rows={2} value={answer.reason} disabled={disabled}
                  data-market-defer-reason={question.questionId}
                  onChange={(event) => { props.onChange({ kind: 'defer', reason: event.currentTarget.value }) }} />
              </label>
            </div>
            : null}
        </>
        : null}
    </div>
  }

  return <div className="mv-answer" data-market-question-type={question.control ?? 'radio'}>
    <div className="mv-opt-list" role={question.control === 'multiselect' ? 'group' : 'radiogroup'} aria-labelledby={`${id}-label`}>
      {options.map((option) => {
        const selected = values.includes(option.value)
        return <label key={option.value} className={`mv-opt ${selected ? 'selected' : ''}`}>
          <input
            type={question.control === 'multiselect' ? 'checkbox' : 'radio'}
            name={id}
            value={option.value}
            checked={selected}
            disabled={locked}
            data-market-choice={option.value}
            onChange={() => { pick(option.value) }}
          />
          <span className="mv-opt-text"><span className="mv-opt-title">{option.label}</span></span>
        </label>
      })}
      <label className={`mv-other-row ${answer?.kind === 'other' ? 'selected' : ''}`}>
        <input
          type={question.control === 'multiselect' ? 'checkbox' : 'radio'}
          name={id}
          value={QUESTION_OTHER_OPTION}
          checked={answer?.kind === 'other'}
          disabled={locked}
          data-market-other={question.questionId}
          onChange={() => { pick(QUESTION_OTHER_OPTION) }}
        />
        <span>{QUESTION_OTHER_LABEL}<span className="mv-hint">与上方正常选项互斥；切换时保留已填文字。</span></span>
      </label>
    </div>
    {answer?.kind === 'other'
      ? <div className="mv-other-panel">
        <label className="mv-field" htmlFor={`${id}-other`}><span>请补充说明 <span className="mv-req">必填</span></span>
          <textarea id={`${id}-other`} className="mv-textarea" value={answer.text} disabled={locked}
            data-market-other-text={question.questionId}
            onChange={(event) => { props.onChange({ kind: 'other', text: event.currentTarget.value }) }} />
          <span className="mv-help">至少 2 个字；提交后作为本次处理授权的一部分。</span>
        </label>
      </div>
      : null}
    {props.invalid === true
      ? <p className="mv-error" role="alert"><WarnIcon size={13} /> 请完成本题：选择正常选项，或选“以上都不是”并填写说明。</p>
      : null}
    {question.allowDefer === true
      ? <>
        <label className={`mv-defer ${deferred ? 'checked' : ''}`}>
          <input type="checkbox" checked={deferred} disabled={disabled}
            data-market-defer={question.questionId}
            onChange={(event) => { props.onChange(event.currentTarget.checked
              ? { kind: 'defer', reason: stash.current.reason }
              : stash.current.choice) }} />
          <span><span className="mv-defer-title">暂不处理，保留待核</span><span className="mv-defer-desc">本次不核实，也不重复追问；以受限底稿继续，并在成果中保留待核说明。</span></span>
        </label>
        {deferred
          ? <div className="mv-other-panel">
            <label className="mv-field" htmlFor={`${id}-defer`}><span>暂不处理的原因 <span className="mv-req">必填</span></span>
              <textarea id={`${id}-defer`} className="mv-textarea" rows={2} value={answer.reason} disabled={disabled}
                data-market-defer-reason={question.questionId}
                onChange={(event) => { props.onChange({ kind: 'defer', reason: event.currentTarget.value }) }} />
            </label>
          </div>
          : null}
      </>
      : null}
  </div>
}
