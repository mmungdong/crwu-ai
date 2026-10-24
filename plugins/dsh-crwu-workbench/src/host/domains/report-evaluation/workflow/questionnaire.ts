import type { ValuationWorkflowQuestion } from '../../../../shared/contracts/valuation-workflow.ts'
import { TEMPLATE_MARKET_NODES } from '../../../../shared/contracts/valuation-template-market.ts'
import { isQuestionAnswerShape, isUnknownQuestionAnswer, normalizeQuestionAnswer, validateQuestionAnswer } from '../../../../shared/contracts/valuation-question-answer.ts'
import type {
  ValuationQuestionAnswer, ValuationQuestionEdit, ValuationQuestionNote, ValuationQuestionSubmit,
  ValuationStoredQuestion, ValuationWorkflowQuestionnaire,
} from '../../../../shared/contracts/valuation-questionnaire.ts'

const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const CONTROLS = new Set(['text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect', 'boolean'])
const CHOICES = new Set(['select', 'radio', 'multiselect'])
const NODES = new Set<string>(['intent', 'elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery', ...TEMPLATE_MARKET_NODES])
const MAX_ITEMS = 10000
const MAX_TEXT = 100000
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT
const id = (value: unknown): value is string => text(value) && value.trim() !== ''
  && value.length <= 512 && !BAD_KEYS.has(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const list = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= MAX_ITEMS
const keys = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every(key => names.includes(key))

function safeJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 30) return false
  if (value === null || typeof value === 'boolean' || text(value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  seen.add(value)
  const entries = Object.entries(value)
  const valid = entries.length <= MAX_ITEMS && entries.every(([key, item]) => !BAD_KEYS.has(key) && safeJson(item, seen, depth + 1))
  seen.delete(value)
  return valid
}

function answerShape(value: unknown): value is ValuationQuestionAnswer {
  return isQuestionAnswerShape(value)
}

export function validateWorkflowQuestion(value: unknown): value is ValuationWorkflowQuestion {
  if (!record(value) || !safeJson(value)) return false
  if (!keys(value, ['questionId', 'field', 'prompt', 'knownValue', 'source', 'control', 'options',
    'required', 'nodeId', 'version', 'applicable', 'inapplicabilityReason', 'reason', 'answerProtocol', 'allowDefer'])) return false
  if (value.answerProtocol !== undefined && value.answerProtocol !== 2) return false
  if (value.allowDefer !== undefined && typeof value.allowDefer !== 'boolean') return false
  if (value.answerProtocol === 2 && (typeof value.control !== 'string' || typeof value.required !== 'boolean'
    || typeof value.applicable !== 'boolean' || !integer(value.version) || value.version === 0
    || typeof value.reason !== 'string' || !value.reason.trim() || typeof value.allowDefer !== 'boolean')) return false
  if (!id(value.questionId) || !id(value.field) || !text(value.prompt) || !text(value.knownValue) || !text(value.source)) return false
  if (value.control !== undefined && (typeof value.control !== 'string' || !CONTROLS.has(value.control))) return false
  if (value.required !== undefined && typeof value.required !== 'boolean') return false
  if (value.nodeId !== undefined && !id(value.nodeId)) return false
  if (value.version !== undefined && (!integer(value.version) || value.version === 0)) return false
  if (value.applicable !== undefined && typeof value.applicable !== 'boolean') return false
  if (value.reason !== undefined && !text(value.reason)) return false
  if (value.inapplicabilityReason !== undefined && !text(value.inapplicabilityReason)) return false
  if (value.applicable === false && (typeof value.inapplicabilityReason !== 'string' || value.inapplicabilityReason.trim() === '')) return false
  const choice = CHOICES.has(String(value.control))
  if (value.options !== undefined) {
    if (!choice || !list(value.options) || value.options.length > (value.answerProtocol === 2 ? 200 : 50) || value.options.length === 0) return false
    if (!value.options.every(option => record(option) && keys(option, ['value', 'label'])
      && id(option.value) && option.value !== '__other__' && text(option.label) && option.label.trim() !== '' && option.label.length <= 200)) return false
    if (new Set(value.options.map(option => (option as Record<string, unknown>).value)).size !== value.options.length) return false
  } else if (choice) return false
  return true
}

export function emptyQuestionnaire(): ValuationWorkflowQuestionnaire {
  return { version: 0, questions: [], drafts: [], notes: [], submissions: [], legacy: [] }
}

function semantic(question: ValuationWorkflowQuestion): string {
  return JSON.stringify([question.control ?? 'text', question.required !== false,
    question.answerProtocol ?? 1, question.allowDefer === true,
    question.options?.map(option => question.answerProtocol === 2 ? option.value : [option.value, option.label]) ?? []])
}

function answerMapIdentity(answers: Record<string, ValuationQuestionAnswer>): string {
  return JSON.stringify(Object.keys(answers).sort().map(key => [key, normalizeQuestionAnswer(answers[key], false)]))
}

export function admitQuestions(
  state: ValuationWorkflowQuestionnaire, nodeId: string, questions: ValuationWorkflowQuestion[],
): ValuationWorkflowQuestionnaire {
  if (!id(nodeId) || !list(questions) || !questions.every(validateWorkflowQuestion)) throw new Error('问题定义无效')
  if (new Set(questions.map(question => question.field)).size !== questions.length) throw new Error('问题字段重复')
  const next = clone(state)
  for (const incoming of questions) {
    const previous = next.questions.find(question => question.nodeId === nodeId && question.field === incoming.field)
    const definitionVersion = incoming.version ?? previous?.definitionVersion ?? 1
    const applicable = incoming.applicable !== false
    const changed = previous !== undefined && (semantic(previous) !== semantic(incoming)
      || (previous.definitionVersion ?? previous.version) !== definitionVersion)
    let questionId = previous?.questionId ?? incoming.questionId
    if (!previous && next.questions.some(question => question.questionId === questionId)) questionId = `${nodeId}:${incoming.field}`
    if (!id(questionId) || (!previous && next.questions.some(question => question.questionId === questionId))) throw new Error('问题标识重复')
    const stored: ValuationStoredQuestion = {
      ...clone(incoming), questionId, nodeId, definitionVersion,
      version: previous ? previous.version + (changed ? 1 : 0) : Math.max(1, definitionVersion),
      applicable,
      needsConfirmation: previous ? previous.needsConfirmation || changed || (!previous.applicable && applicable) : true,
      answer: previous?.answer ? clone(previous.answer) : null,
    }
    if (previous) next.questions[next.questions.indexOf(previous)] = stored
    else next.questions.push(stored)
  }
  if (next.questions.length > MAX_ITEMS) throw new Error('问题数量超出限制')
  if (JSON.stringify(next) !== JSON.stringify(state)) next.version += 1
  return next
}

const validAnswer = validateQuestionAnswer

function validateEdit(state: ValuationWorkflowQuestionnaire, input: ValuationQuestionEdit): string {
  if (!safeJson(input) || !id(input.nodeId) || !integer(input.expectedRevision) || !integer(input.expectedQuestionVersion)
    || !record(input.answers) || !record(input.noteEdits) || !text(input.supplement)) return '问卷输入无效'
  if (!NODES.has(input.nodeId)) return '问卷节点无效'
  if (input.expectedQuestionVersion !== state.version) return '问卷版本已变化，请保留本地修改并重新核对'
  for (const [questionId, answer] of Object.entries(input.answers)) {
    if (!answerShape(answer) || !state.questions.some(question => question.questionId === questionId && question.nodeId === input.nodeId)) return '答案不属于当前节点或格式无效'
  }
  for (const [noteId, value] of Object.entries(input.noteEdits)) {
    if (!text(value) || value.trim() === '' || !state.notes.some(note => note.noteId === noteId && note.nodeId === input.nodeId)) return '补充说明不属于当前节点或为空'
  }
  return ''
}

export function saveQuestionDraft(state: ValuationWorkflowQuestionnaire, input: ValuationQuestionEdit):
  { ok: true; state: ValuationWorkflowQuestionnaire } | { ok: false; error: string } {
  const error = validateEdit(state, input)
  if (error) return { ok: false, error }
  const next = clone(state)
  const previous = next.drafts.findIndex(draft => draft.nodeId === input.nodeId)
  const draft = { nodeId: input.nodeId, answers: clone(input.answers), supplement: input.supplement,
    noteEdits: clone(input.noteEdits), updatedAt: new Date().toISOString() }
  if (previous < 0) next.drafts.push(draft)
  else next.drafts[previous] = draft
  next.version += 1
  return { ok: true, state: next }
}

export function effectiveQuestionAnswers(state: ValuationWorkflowQuestionnaire, nodeId?: string): Record<string, ValuationQuestionAnswer> {
  const answers: Record<string, ValuationQuestionAnswer> = {}
  for (const question of state.questions) {
    if ((nodeId === undefined || question.nodeId === nodeId) && question.applicable && !question.needsConfirmation && question.answer) {
      answers[question.questionId] = clone(question.answer)
    }
  }
  return answers
}

type SubmitResult = { ok: true; state: ValuationWorkflowQuestionnaire; answers: Record<string, ValuationQuestionAnswer>; changed: boolean; unknown: boolean }
  | { ok: false; error: string }

export function submitQuestionAnswers(state: ValuationWorkflowQuestionnaire, input: ValuationQuestionSubmit): SubmitResult {
  if (!safeJson(input) || !id(input.submissionId)) return { ok: false, error: '提交标识无效' }
  const previousSubmission = state.submissions.find(submission => submission.submissionId === input.submissionId)
  if (previousSubmission) {
    const sameAnswers = record(input.answers) && Object.values(input.answers).every(answerShape)
      && answerMapIdentity(previousSubmission.answers) === answerMapIdentity(input.answers)
    const editedNotesMatch = record(input.noteEdits) && Object.entries(input.noteEdits)
      .every(([noteId, value]) => previousSubmission.notes.some(note => note.noteId === noteId && note.text === value))
    const supplementMatches = previousSubmission.notes.some(note => note.noteId === `note:${input.submissionId}` && note.text === input.supplement)
      || input.supplement === ''
    if (!sameAnswers || !editedNotesMatch || !supplementMatches || previousSubmission.nodeId !== input.nodeId) return { ok: false, error: '提交标识已用于其他内容' }
    return { ok: true, state: clone(state), answers: clone(previousSubmission.answers), changed: false,
      unknown: Object.values(previousSubmission.answers).some(isUnknownQuestionAnswer) }
  }
  const error = validateEdit(state, input)
  if (error) return { ok: false, error }
  const questions = state.questions.filter(question => question.nodeId === input.nodeId && question.applicable)
  for (const question of questions) {
    const answer = input.answers[question.questionId]
    if (!answer && question.required === false) continue
    if (!answer || !validAnswer(question, answer)) return { ok: false, error: `请完整填写并核对：${question.prompt}` }
  }
  const before = effectiveQuestionAnswers(state, input.nodeId)
  const next = clone(state)
  for (const question of next.questions.filter(question => question.nodeId === input.nodeId && question.applicable)) {
    question.answer = input.answers[question.questionId] ? clone(input.answers[question.questionId]) : null
    question.needsConfirmation = false
  }
  for (const [noteId, value] of Object.entries(input.noteEdits)) {
    const note = next.notes.find(note => note.noteId === noteId)!
    if (note.text !== value) { note.history.push(note.text); note.text = value }
  }
  if (input.supplement.trim() !== '') next.notes.push({ noteId: `note:${input.submissionId}`, nodeId: input.nodeId, text: input.supplement, history: [] })
  next.version += 1
  const answers = effectiveQuestionAnswers(next, input.nodeId)
  next.submissions.push({ submissionId: input.submissionId, nodeId: input.nodeId, version: next.version,
    answers: clone(answers), notes: clone(next.notes.filter(note => note.nodeId === input.nodeId)),
    questions: questions.map(question => {
      const { answer: _answer, needsConfirmation: _confirmation, definitionVersion: _version, ...definition } = question
      return clone(definition)
    }), updatedAt: new Date().toISOString() })
  next.drafts = next.drafts.filter(draft => draft.nodeId !== input.nodeId)
  return { ok: true, state: next, answers, changed: answerMapIdentity(before) !== answerMapIdentity(answers)
    || JSON.stringify(state.notes) !== JSON.stringify(next.notes), unknown: Object.values(answers).some(isUnknownQuestionAnswer) }
}

function noteShape(value: unknown): value is ValuationQuestionNote {
  return record(value) && keys(value, ['noteId', 'nodeId', 'text', 'history']) && id(value.noteId) && id(value.nodeId)
    && text(value.text) && value.text.trim() !== '' && list(value.history) && value.history.every(text)
}

export function restoreQuestionnaire(raw: unknown): ValuationWorkflowQuestionnaire | null {
  if (!record(raw) || !safeJson(raw) || !keys(raw, ['version', 'questions', 'drafts', 'notes', 'submissions', 'legacy'])
    || !integer(raw.version) || !list(raw.questions) || !list(raw.drafts) || !list(raw.notes) || !list(raw.submissions) || !list(raw.legacy)) return null
  const version = raw.version
  if (!raw.questions.every(item => {
    if (!record(item)) return false
    const { needsConfirmation, answer, definitionVersion, ...definition } = item
    return validateWorkflowQuestion(definition) && id(item.nodeId) && integer(item.version) && item.version > 0
      && (definitionVersion === undefined || (integer(definitionVersion) && definitionVersion > 0))
      && typeof item.applicable === 'boolean' && typeof needsConfirmation === 'boolean'
      && (answer === null || answerShape(answer))
      && (needsConfirmation || !item.applicable || item.required === false || answer !== null)
      && (answer === null || needsConfirmation || !item.applicable || validAnswer(definition, answer as ValuationQuestionAnswer))
  })) return null
  const questions = raw.questions as ValuationStoredQuestion[]
  if (new Set(questions.map(question => question.questionId)).size !== questions.length
    || new Set(questions.map(question => JSON.stringify([question.nodeId, question.field]))).size !== questions.length) return null
  const answersShape = (answers: unknown, nodeId: string): boolean => record(answers) && Object.entries(answers).every(([questionId, answer]) => answerShape(answer)
    && questions.some(question => question.questionId === questionId && question.nodeId === nodeId))
  if (!raw.notes.every(noteShape) || new Set(raw.notes.map(note => (note as ValuationQuestionNote).noteId)).size !== raw.notes.length) return null
  const notes = raw.notes as ValuationQuestionNote[]
  if (!raw.drafts.every(draft => record(draft) && keys(draft, ['nodeId', 'answers', 'supplement', 'noteEdits', 'updatedAt']) && id(draft.nodeId)
    && NODES.has(draft.nodeId)
    && answersShape(draft.answers, draft.nodeId) && text(draft.supplement) && timestamp(draft.updatedAt)
    && record(draft.noteEdits) && Object.entries(draft.noteEdits).every(([noteId, value]) => text(value)
      && notes.some(note => note.noteId === noteId && note.nodeId === draft.nodeId)))) return null
  if (new Set(raw.drafts.map(draft => (draft as { nodeId: string }).nodeId)).size !== raw.drafts.length) return null
  if (!raw.submissions.every(submission => record(submission) && keys(submission, ['submissionId', 'nodeId', 'version', 'answers', 'notes', 'questions', 'updatedAt'])
    && id(submission.submissionId) && id(submission.nodeId) && integer(submission.version) && submission.version > 0 && submission.version <= version
    && answersShape(submission.answers, submission.nodeId) && timestamp(submission.updatedAt) && list(submission.notes)
    && (submission.questions === undefined || (list(submission.questions) && submission.questions.every(question => validateWorkflowQuestion(question)
      && question.nodeId === submission.nodeId)))
    && submission.notes.every(note => noteShape(note) && note.nodeId === submission.nodeId))) return null
  if (new Set(raw.submissions.map(submission => (submission as { submissionId: string }).submissionId)).size !== raw.submissions.length) return null
  if (!raw.legacy.every(note => record(note) && keys(note, ['nodeId', 'text', 'revision']) && id(note.nodeId) && text(note.text) && integer(note.revision))) return null
  return clone(raw) as unknown as ValuationWorkflowQuestionnaire
}

export function legacyQuestionnaire(raw: unknown): ValuationWorkflowQuestionnaire {
  let state = emptyQuestionnaire()
  if (!record(raw)) return state
  const revision = integer(raw.revision) ? raw.revision : 0
  const preserve = (nodeId: unknown, value: unknown, atRevision: number): void => {
    if (id(nodeId) && text(value) && value.trim() !== '' && !state.legacy.some(note => note.nodeId === nodeId && note.text === value && note.revision === atRevision)) {
      state.legacy.push({ nodeId, text: value, revision: atRevision })
    }
  }
  if (record(raw.nodePrompts)) for (const [nodeId, value] of Object.entries(raw.nodePrompts)) preserve(nodeId, value, revision)
  if (list(raw.revisions)) for (const entry of raw.revisions) {
    if (!record(entry) || !list(entry.changes)) continue
    const atRevision = integer(entry.revision) ? entry.revision : revision
    for (const change of entry.changes) if (record(change) && change.field === 'promptSupplement') {
      preserve(change.nodeId, change.before, atRevision)
      preserve(change.nodeId, change.after, atRevision)
    }
  }
  if (record(raw.clarification) && list(raw.clarification.questions)) {
    for (const question of raw.clarification.questions) {
      if (!validateWorkflowQuestion(question)) continue
      const nodeId = question.nodeId ?? (['purpose', 'baseDate', 'mode', 'useLabel', 'areaSqm'].includes(question.field) ? 'elements'
        : /^intent-\d+$/.test(question.field) ? 'intent' : '')
      if (nodeId) state = admitQuestions(state, nodeId, [question])
    }
  }
  if (record(raw.stages)) for (const [nodeId, receipt] of Object.entries(raw.stages)) {
    if (!record(receipt) || !record(receipt.outputs) || !list(receipt.outputs.confirmedAnswers)) continue
    for (const confirmed of receipt.outputs.confirmedAnswers) {
      if (!record(confirmed) || !text(confirmed.answer)) continue
      let question = state.questions.find(question => question.nodeId === nodeId && question.field === confirmed.field)
      if (!question && id(confirmed.field) && text(confirmed.question)) {
        const controls: Record<string, ValuationWorkflowQuestion['control']> = {
          purpose: 'text', baseDate: 'date', mode: 'radio', useLabel: 'text', areaSqm: 'number',
        }
        const control = Object.hasOwn(controls, confirmed.field) ? controls[confirmed.field] : undefined
        if (control) {
          const definition: ValuationWorkflowQuestion = { questionId: `legacy:${nodeId}:${confirmed.field}`,
            field: confirmed.field, prompt: confirmed.question, knownValue: '', source: 'user-confirmation', control,
            ...(confirmed.field === 'mode' ? { options: [{ value: 'listing-reference', label: '挂牌参考' }, { value: 'formal', label: '正式评估' }] } : {}) }
          state = admitQuestions(state, nodeId, [definition])
          question = state.questions.find(question => question.nodeId === nodeId && question.field === confirmed.field)
        } else preserve(nodeId, `${confirmed.question}\n${confirmed.answer}`, revision)
      }
      const answer = { value: confirmed.answer }
      if (question && validAnswer(question, answer)) { question.answer = answer; question.needsConfirmation = false }
    }
  }
  return state
}
