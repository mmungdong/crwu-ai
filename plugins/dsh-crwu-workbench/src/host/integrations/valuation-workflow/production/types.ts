/**
 * Plain wire types for the production valuation-workflow composition.
 *
 * Everything here is JSON-serializable: never an Agent, a session handle, a Tool
 * token or a raw infrastructure error. The runner, the three capability adapters
 * and their callbacks all speak these types so a Host can persist or forward them
 * without leaking identity material.
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { ValuationWorkflowStage } from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationScope } from '../../../domains/report-evaluation/scope.ts'
import type { ValuationWorkflowRunDTO } from '../../../domains/report-evaluation/workflow/persistence.ts'
import type { ValuationWorkflowRunner, ValuationWorkflowExecution } from '../runtime.ts'
import type { WorkflowMaterialsResult } from '../materials.ts'
import type { HostWorkflowServiceDeps } from '../services/deps.ts'

/** One archived file from the frozen live input snapshot (identity fields only). */
export interface WorkflowFrozenFile {
  fileId: string
  fileName: string
  relativePath?: string
  archiveRelativePath: string
  kind?: string
  sizeBytes: number
  sha256: string
  /** Actual verified readability of the archived copy; absent means unproven. */
  readable?: boolean
}

/**
 * The frozen input the Host confirmed. Optional fields stay optional so a legacy
 * or narrower snapshot is still accepted; a missing purpose or date is never
 * defaulted to a business value here.
 */
export interface WorkflowFrozenInput {
  schemaVersion?: string
  projectId: string
  assetType?: string
  methodRequest?: string
  baseDate?: string | null
  purpose?: string | null
  valueType?: string | null
  templateFileId?: string | null
  supplementalPrompt?: string
  files: WorkflowFrozenFile[]
  inputDigest?: string
}

/**
 * Safe identity of a freshly published workflow child. `sessionId` is always the
 * actual native session id returned by the subagent runtime, never the caller's
 * correlation key.
 */
export interface WorkflowJournalStartedEvent {
  sessionId: string
  kind: 'stage' | 'intent'
  nodeId: string
  stage?: ValuationWorkflowStage
  operation?: 'knowledge-selection' | 'page-reading' | 'planning-selection' | 'template-analysis' | 'template-market'
  runId: string
  revision: number
  correlationId: string
}

/**
 * Settlement of one published child after its adapter returned and bounded
 * disposal succeeded. A `stop-unknown` child never settles here.
 */
export interface WorkflowJournalSettledEvent {
  sessionId: string
  ok: boolean
  errorKind: string
}

/** One verified calculation artifact bound to its exact case-relative path. */
export interface WorkflowCalculationArtifact {
  name: string
  relativePath: string
  digest: string
  bytes: number
}

/** Plain durable receipt of one real listing-reference calculation. */
export interface WorkflowCalculationReceipt {
  planId: string
  /** Actual plan revision the artifacts were built at; never re-derived later. */
  revision: number
  /** Canonical digest of the exact fixed input that produced these artifacts. */
  inputDigest: string
  artifacts: WorkflowCalculationArtifact[]
  unitPrice: number | null
  totalPrice: number | null
  generatedAt: string
}

export interface WorkflowProductionRunnerOptions {
  graphVersion?: '1' | '2'
  /** v2 template-market runs read materials inside the observable `materials` node. */
  deferMaterialsToGraph?: boolean
  deps: HostWorkflowServiceDeps
  /** Live registered scope this runner is bound to. */
  scope: ValuationScope
  frozenInput: WorkflowFrozenInput
  /** Only the currently executing genuine ToolRunContext; never a stored one. */
  getExecution: () => ValuationWorkflowExecution | undefined
  /** Actual compiled-root saver lent to the graph. */
  checkpointer?: BaseCheckpointSaver
  /** Durable sink for the business service image. */
  saveRun?: (state: ValuationWorkflowRunDTO) => Promise<void>
  journalStarted?: (event: WorkflowJournalStartedEvent) => void | Promise<void>
  journalSettled?: (event: WorkflowJournalSettledEvent) => void | Promise<void>
  /** Verified prepared-material cache; undefined when this round has none yet. */
  getPrepared?: () => Promise<WorkflowMaterialsResult | undefined>
  savePrepared?: (result: WorkflowMaterialsResult) => Promise<void>
  getCalculationReceipt?: () => Promise<WorkflowCalculationReceipt | undefined>
  saveCalculationReceipt?: (receipt: WorkflowCalculationReceipt) => Promise<void>
  /** Stable Host plan id; derived from the project when omitted. */
  planId?: string
}

export type WorkflowProductionRunner = ValuationWorkflowRunner
