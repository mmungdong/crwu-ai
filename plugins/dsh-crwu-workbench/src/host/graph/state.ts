/**
 * Shared state and callback contracts for the host-neutral valuation graphs.
 *
 * Graph modules import only this state, LangGraph and wire-level shared types.
 * DSH, Cordis, Tools, filesystem and provider code stay in outer adapters.
 */
import { Annotation } from '@langchain/langgraph'
import type {
  ValuationWorkflowInitialInput,
  ValuationWorkflowStage,
} from '../../shared/contracts/valuation-workflow.ts'

export interface WorkflowMaterial {
  materialId: string
  fileName: string
  digest: string
  text: string
}

export interface WorkflowInput {
  text: string
  materials: WorkflowMaterial[]
  /** Canonical first-submitted choices; null/absent stays unknown. */
  initialInput?: ValuationWorkflowInitialInput | null
}

export type IntentBusiness = 'valuation' | 'unknown'
export type IntentStatus = 'resolved' | 'needs-clarification' | 'unsupported'

export interface ValuationIntentObject {
  objectId: string
  materialIds: string[]
}

export interface MaterialEvidence {
  materialId: string
  quote: string
}

export interface UserInputEvidence {
  source: 'user-input'
  quote: string
}

export type IntentEvidence = MaterialEvidence | UserInputEvidence

export interface ValuationIntent {
  business: IntentBusiness
  assetType: string | null
  status: IntentStatus
  objects: ValuationIntentObject[]
  evidence: IntentEvidence[]
  questions: string[]
}

export type GraphDriveStatus =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface StageRunResult {
  status: GraphDriveStatus
  /** Stage-keyed output fragments merged into the shared outputs map. */
  outputs?: Record<string, Record<string, unknown>>
}

export type InferIntentResult =
  | { ok: true; sessionId: string; intent: unknown }
  | { ok: false; error?: string; errorKind?: string; sessionId?: string }

export type InferIntent = (
  input: WorkflowInput,
  registeredAssetIds: readonly string[],
) => Promise<InferIntentResult>

export const WorkflowState = Annotation.Root({
  input: Annotation<WorkflowInput>({
    reducer: (_left, right) => right,
    default: () => ({ text: '', materials: [], initialInput: null }),
  }),
  entry: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => 'elements',
  }),
  stage: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  status: Annotation<GraphDriveStatus>({
    reducer: (_left, right) => right,
    default: () => 'running',
  }),
  intent: Annotation<ValuationIntent | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  intentSessionId: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  route: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  outputs: Annotation<Record<string, Record<string, unknown>>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  marketOutcomes: Annotation<Record<string, GraphDriveStatus>>({
    reducer: (left, right) => ({ ...left, ...right }), default: () => ({}),
  }),
  marketNext: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  error: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  errorKind: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
})

export type WorkflowGraphState = typeof WorkflowState.State
export type WorkflowGraphUpdate = typeof WorkflowState.Update
export type WorkflowStageRunner = (
  stage: ValuationWorkflowStage,
  state: WorkflowGraphState,
) => Promise<StageRunResult>
