import type { BaseCheckpointSaver } from '@langchain/langgraph'

/**
 * One current business task per (workspaceId, stepId).
 *
 * `runId` is the LangGraph `thread_id`. `state` carries the business state plus
 * per-node provenance; the store treats it as plain JSON and returns it
 * unchanged apart from a structural clone.
 */
export interface WorkflowCurrentRecord {
  workspaceId: string
  stepId: string
  runId: string
  graphId: string
  graphVersion: string
  revision: number
  status: string
  state: Record<string, unknown>
  files: unknown[]
  [key: string]: unknown
}

/** Identity a loader must prove before an imported bundle replaces a task. */
export interface WorkflowImportIdentity {
  workspaceId: string
  stepId: string
  graphId: string
  graphVersion: string
}

/** Broker decision. A non-`ok` result fails the operation closed. */
export interface WorkflowAuthorizeResult {
  ok: boolean
  error?: string
}

export type WorkflowAuthorize = () => WorkflowAuthorizeResult

export interface OpenWorkflowStoreOptions {
  /** Host-derived absolute path of the SQLite file. */
  path: string
  /** Named-broker authorization; called before every read and write. */
  authorize: WorkflowAuthorize
  /** Optional diagnostic note persisted beside the store. */
  note?: string
}

export interface WorkflowStore {
  /** Real LangGraph saver persisting serialized checkpoints and writes. */
  readonly checkpointer: BaseCheckpointSaver
  saveCurrent(record: WorkflowCurrentRecord, expectedRevision?: number): Promise<void>
  getCurrent(workspaceId: string, stepId: string): Promise<WorkflowCurrentRecord | null>
  exportCurrent(workspaceId: string, stepId: string): Promise<string>
  importCurrent(serialized: string, identity: WorkflowImportIdentity): Promise<void>
  clearCurrent(workspaceId: string, stepId: string, expectedRunId: string): Promise<boolean>
  close(): Promise<void>
}

/** One serialized checkpoint plus its pending writes inside an export bundle. */
export interface WorkflowBundleCheckpoint {
  threadId: string
  checkpointNs: string
  checkpointId: string
  parentCheckpointId: string | null
  checkpointType: string
  checkpointBytes: string
  metadataType: string
  metadataBytes: string
  writes: WorkflowBundleWrite[]
}

export interface WorkflowBundleWrite {
  taskId: string
  idx: number
  taskPath: string
  channel: string
  valueType: string
  valueBytes: string
}

/** Self-describing export envelope. Exported bytes stay base64 so serde bytes survive JSON. */
export interface WorkflowBundleV1 {
  format: 'crwu.workflow.bundle.v1'
  workspaceId: string
  stepId: string
  runId: string
  graphId: string
  graphVersion: string
  revision: number
  current: WorkflowCurrentRecord
  checkpoints: WorkflowBundleCheckpoint[]
}

export const WORKFLOW_BUNDLE_FORMAT = 'crwu.workflow.bundle.v1' as const
