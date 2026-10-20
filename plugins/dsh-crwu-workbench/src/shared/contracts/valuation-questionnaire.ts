import type { ValuationWorkflowQuestion } from './valuation-workflow.ts'

export interface ValuationQuestionAnswer {
  value: string
  unknown?: boolean
  reason?: string
}

export interface ValuationStoredQuestion extends ValuationWorkflowQuestion {
  nodeId: string
  version: number
  definitionVersion?: number
  applicable: boolean
  inapplicabilityReason?: string
  needsConfirmation: boolean
  answer: ValuationQuestionAnswer | null
}

export interface ValuationQuestionNote {
  noteId: string
  nodeId: string
  text: string
  history: string[]
}

export interface ValuationQuestionDraft {
  nodeId: string
  answers: Record<string, ValuationQuestionAnswer>
  supplement: string
  noteEdits: Record<string, string>
  updatedAt: string
}

export interface ValuationQuestionSubmission {
  submissionId: string
  nodeId: string
  version: number
  answers: Record<string, ValuationQuestionAnswer>
  notes: ValuationQuestionNote[]
  questions?: ValuationWorkflowQuestion[]
  updatedAt: string
}

export interface ValuationWorkflowQuestionnaire {
  version: number
  questions: ValuationStoredQuestion[]
  drafts: ValuationQuestionDraft[]
  notes: ValuationQuestionNote[]
  submissions: ValuationQuestionSubmission[]
  legacy: Array<{ nodeId: string; text: string; revision: number }>
}

export interface ValuationQuestionEdit {
  nodeId: string
  expectedRevision: number
  expectedQuestionVersion: number
  answers: Record<string, ValuationQuestionAnswer>
  supplement: string
  noteEdits: Record<string, string>
}

export interface ValuationQuestionSubmit extends ValuationQuestionEdit {
  submissionId: string
}
