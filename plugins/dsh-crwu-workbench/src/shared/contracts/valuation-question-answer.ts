import type { ValuationWorkflowQuestion } from './valuation-workflow.ts'
import type { ValuationQuestionAnswer, ValuationLegacyQuestionAnswer } from './valuation-questionnaire.ts'

export const QUESTION_OTHER_OPTION = '__other__'
export const QUESTION_OTHER_LABEL = '以上都不是，补充说明'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 20000
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const choiceControl = (control: string | undefined): boolean => ['radio', 'select', 'multiselect'].includes(control ?? '')

export function parseLegacyQuestionAnswer(value: unknown): ValuationLegacyQuestionAnswer | null {
  if (!record(value) || !Object.hasOwn(value, 'value') || !text(value.value)
    || Object.keys(value).some(key => !['value', 'unknown', 'reason'].includes(key))
    || (Object.hasOwn(value, 'unknown') && typeof value.unknown !== 'boolean')
    || (Object.hasOwn(value, 'reason') && !text(value.reason))) return null
  return value as unknown as ValuationLegacyQuestionAnswer
}

export function isQuestionAnswerShape(value: unknown): value is ValuationQuestionAnswer {
  if (!record(value)) return false
  if (!Object.hasOwn(value, 'kind')) return parseLegacyQuestionAnswer(value) !== null
  switch (value.kind) {
    case 'choice': return exact(value, ['kind', 'values', 'supplement']) && Array.isArray(value.values)
      && value.values.length <= 1000 && value.values.every(item => text(item) && item.length <= 512) && text(value.supplement)
    case 'other': return exact(value, ['kind', 'text']) && text(value.text)
    case 'value': return exact(value, ['kind', 'value', 'supplement']) && text(value.value) && text(value.supplement)
    case 'defer': return exact(value, ['kind', 'reason']) && text(value.reason)
    default: return false
  }
}
export function questionAnswerValue(answer: ValuationQuestionAnswer | null | undefined): string {
  if (!answer) return ''
  if (answer.kind === 'choice') return answer.values.join('、')
  if (answer.kind === 'other') return answer.text
  if (answer.kind === 'defer') return answer.reason
  return answer.value
}
export function isUnknownQuestionAnswer(answer: ValuationQuestionAnswer | null | undefined): boolean {
  return answer?.kind === undefined && answer?.unknown === true
}
export function normalizeQuestionAnswer(answer: ValuationQuestionAnswer, trim = true): ValuationQuestionAnswer {
  const clean = (value: string): string => trim ? value.trim() : value
  switch (answer.kind) {
    case 'choice': return { kind: 'choice', values: [...answer.values].sort(), supplement: clean(answer.supplement) }
    case 'other': return { kind: 'other', text: clean(answer.text) }
    case 'value': return { kind: 'value', value: clean(answer.value), supplement: clean(answer.supplement) }
    case 'defer': return { kind: 'defer', reason: clean(answer.reason) }
    default: return { value: clean(answer.value), ...(answer.unknown === true ? { unknown: true, reason: clean(answer.reason ?? '') } : {}) }
  }
}
function validValue(question: ValuationWorkflowQuestion, raw: string): boolean {
  const value = raw.trim()
  if (value === '') return question.required === false
  switch (question.control) {
    case 'number': return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))
    case 'boolean': return value === 'true' || value === 'false'
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const date = new Date(`${value}T00:00:00.000Z`)
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    }
    default: return true
  }
}
function validChoices(question: ValuationWorkflowQuestion, values: string[]): boolean {
  return (question.required === false || values.length > 0) && (question.control === 'multiselect' || values.length <= 1)
    && new Set(values).size === values.length && values.every(value => value !== QUESTION_OTHER_OPTION
      && question.options?.some(option => option.value === value))
}
export function validateQuestionAnswer(question: ValuationWorkflowQuestion, answer: unknown): answer is ValuationQuestionAnswer {
  if (!isQuestionAnswerShape(answer)) return false
  if (question.answerProtocol === 2) {
    switch (answer.kind) {
      case 'other': return choiceControl(question.control) && answer.text.trim() !== ''
      case 'defer': return question.allowDefer === true && answer.reason.trim() !== ''
      case 'choice': return choiceControl(question.control) && validChoices(question, answer.values)
      case 'value': return !choiceControl(question.control) && validValue(question, answer.value)
      default: return false
    }
  }
  if (answer.kind !== undefined) return false
  if (answer.unknown === true) return Boolean(answer.reason?.trim())
  if (choiceControl(question.control)) {
    if (answer.value.trim() === '') return question.required === false
    if (question.control !== 'multiselect') return validChoices(question, [answer.value])
    try {
      const values: unknown = JSON.parse(answer.value)
      return Array.isArray(values) && values.every(item => typeof item === 'string') && validChoices(question, values)
    } catch { return false }
  }
  return validValue(question, answer.value)
}
export function formatQuestionAnswer(question: ValuationWorkflowQuestion, answer: ValuationQuestionAnswer): string {
  const label = (value: string): string => question.options?.find(option => option.value === value)?.label ?? value
  switch (answer.kind) {
    case 'choice': return [answer.values.map(label).join('、'), answer.supplement].filter(Boolean).join('；')
    case 'other': return `${QUESTION_OTHER_LABEL}：${answer.text}`
    case 'value': return [answer.value, answer.supplement].filter(Boolean).join('；')
    case 'defer': return `暂不处理：${answer.reason}`
    default:
      if (answer.unknown === true) return `无法确认：${answer.reason ?? ''}`
      if (question.control === 'multiselect') {
        try { const values: unknown = JSON.parse(answer.value); if (Array.isArray(values)) return values.map(value => label(String(value))).join('、') } catch { /* Preserve legacy text. */ }
      }
      return choiceControl(question.control) ? label(answer.value) : answer.value
  }
}
