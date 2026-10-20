import * as React from 'react'
import type {
  ValuationWorkflowClarification,
  ValuationWorkflowQuestion,
  ValuationWorkflowQuestionControl,
  ValuationWorkflowQuestionOption,
} from '../../../../../shared/contracts/valuation-workflow.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import { CLARIFICATION_MODE_FIELD, CLARIFICATION_MODE_OPTIONS } from './model.ts'

export interface ClarificationPanelProps {
  clarification: ValuationWorkflowClarification
  answers: Record<string, string>
  busy: boolean
  onAnswerChange: (field: string, value: string) => void
  onSubmit: (clarificationId: string, answers: Record<string, string>) => void
}

const CONTROLS = new Set<ValuationWorkflowQuestionControl>([
  'text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect',
])

function controlOf(question: ValuationWorkflowQuestion): ValuationWorkflowQuestionControl {
  const control = question.control
  if (control !== undefined && CONTROLS.has(control)) return control
  // The known Host mode decision stays a closed choice even without explicit metadata.
  if (question.field === CLARIFICATION_MODE_FIELD) return 'select'
  return 'text'
}

function optionsOf(question: ValuationWorkflowQuestion): ValuationWorkflowQuestionOption[] {
  const declared = Array.isArray(question.options)
    ? question.options.filter((option) => typeof option?.value === 'string' && typeof option?.label === 'string')
    : []
  if (declared.length > 0) return declared
  if (question.field === CLARIFICATION_MODE_FIELD) return [...CLARIFICATION_MODE_OPTIONS]
  return []
}

function answerOf(question: ValuationWorkflowQuestion, answers: Record<string, string>): string {
  const direct = answers[question.field]
  if (typeof direct === 'string') return direct
  return typeof question.knownValue === 'string' ? question.knownValue : ''
}

function selectedValues(raw: string): string[] {
  if (raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function hasAnswer(question: ValuationWorkflowQuestion, raw: string): boolean {
  if (controlOf(question) === 'multiselect') return selectedValues(raw).length > 0
  return raw.trim() !== ''
}

function isRequired(question: ValuationWorkflowQuestion): boolean {
  return question.required !== false
}

/**
 * Host clarification questions with native labeled controls.
 *
 * Every mandatory question must be answered before submit (a single answer no longer
 * unlocks the form). Multiselect answers stay in the wire `Record<string,string>` as a
 * JSON string array so the Host can validate the real option values.
 */
export function ClarificationPanel(props: ClarificationPanelProps): React.ReactElement {
  const { clarification } = props
  const questions = Array.isArray(clarification.questions) ? clarification.questions : []
  const payload: Record<string, string> = {}
  for (const question of questions) {
    const raw = answerOf(question, props.answers)
    if (!hasAnswer(question, raw)) continue
    payload[question.field] = controlOf(question) === 'multiselect'
      ? JSON.stringify(selectedValues(raw))
      : raw
  }
  const missingRequired = questions.some((question) => isRequired(question)
    && !hasAnswer(question, answerOf(question, props.answers)))
  const canSubmit = props.busy !== true && !missingRequired && Object.keys(payload).length > 0

  const submit = (): void => {
    if (!canSubmit) return
    props.onSubmit(clarification.clarificationId, payload)
  }

  return <section className={W.clarify} data-workflow-clarification="true"
    data-workflow-clarification-id={clarification.clarificationId}>
    <h3 className={W.panelTitle}>需要确认</h3>
    <ul className={W.clarifyList}>
      {questions.map((question) => {
        const value = answerOf(question, props.answers)
        const control = controlOf(question)
        const options = optionsOf(question)
        const inputId = `crwu-workflow-${clarification.clarificationId}-${question.questionId}`
        const labelId = `${inputId}-label`
        const change = (next: string): void => { props.onAnswerChange(question.field, next) }
        const grouped = control === 'radio' || control === 'multiselect'
        return <li className={W.clarifyQuestion} key={question.questionId}
          data-workflow-question={question.questionId}>
          {grouped
            ? <span className={W.clarifyPrompt} id={labelId}>{question.prompt}</span>
            : <label className={W.clarifyPrompt} htmlFor={inputId}>{question.prompt}</label>}
          <span className={W.fieldSource}>{question.source}{isRequired(question) ? ' · 必填' : ' · 选填'}</span>
          <div className={W.clarifyRow}>
            {control === 'select'
              ? <select
                id={inputId}
                className={W.answerSelect}
                data-workflow-answer={question.field}
                value={value}
                disabled={props.busy === true}
                onChange={(event) => { change(event.currentTarget.value) }}
              >
                <option value="">请选择</option>
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              : control === 'textarea'
                ? <textarea
                  id={inputId}
                  className={W.answerInput}
                  data-workflow-answer={question.field}
                  rows={3}
                  value={value}
                  disabled={props.busy === true}
                  onChange={(event) => { change(event.currentTarget.value) }}
                />
                : control === 'radio'
                  ? <div className={W.answerGroup} role="radiogroup" aria-labelledby={labelId}>
                    {options.map((option) => <label className={W.answerOption} key={option.value}
                      htmlFor={`${inputId}-${option.value}`}>
                      <input
                        id={`${inputId}-${option.value}`}
                        type="radio"
                        name={inputId}
                        value={option.value}
                        checked={value === option.value}
                        disabled={props.busy === true}
                        data-workflow-answer={question.field}
                        onChange={() => { change(option.value) }}
                      />
                      <span>{option.label}</span>
                    </label>)}
                  </div>
                  : control === 'multiselect'
                    ? <div className={W.answerGroup} role="group" aria-labelledby={labelId}>
                      {options.map((option) => {
                        const selected = selectedValues(value).includes(option.value)
                        return <label className={W.answerOption} key={option.value}
                          htmlFor={`${inputId}-${option.value}`}>
                          <input
                            id={`${inputId}-${option.value}`}
                            type="checkbox"
                            value={option.value}
                            checked={selected}
                            disabled={props.busy === true}
                            data-workflow-answer={question.field}
                            onChange={() => {
                              const next = selected
                                ? selectedValues(value).filter((item) => item !== option.value)
                                : [...selectedValues(value), option.value]
                              change(JSON.stringify(next))
                            }}
                          />
                          <span>{option.label}</span>
                        </label>
                      })}
                    </div>
                    : <input
                      id={inputId}
                      className={W.answerInput}
                      data-workflow-answer={question.field}
                      type={control === 'number' ? 'number' : control === 'date' ? 'date' : 'text'}
                      value={value}
                      disabled={props.busy === true}
                      onChange={(event) => { change(event.currentTarget.value) }}
                    />}
            {typeof question.knownValue === 'string' && question.knownValue.trim() !== ''
              ? <span className={W.fieldKind}>已知 {question.knownValue}</span>
              : null}
          </div>
        </li>
      })}
    </ul>
    <div className={W.clarifyActions}>
      <button
        type="button"
        className={`${W.answerSubmit} crwu-ui-btn crwu-ui-btn-primary crwu-ui-btn-sm`}
        data-workflow-answer-submit="true"
        disabled={!canSubmit}
        onClick={submit}
      >提交确认</button>
    </div>
    {props.busy === true ? <p className={W.hint}>正在提交确认…</p> : null}
    {props.busy !== true && missingRequired ? <p className={W.hint}>请先填写全部必填项。</p> : null}
  </section>
}
