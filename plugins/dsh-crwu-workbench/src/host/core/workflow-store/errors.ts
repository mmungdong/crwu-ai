/**
 * Structured failures for the local workflow store.
 *
 * Capability states stay distinct: a missing native SQLite, a failed probe, and
 * a failed execution are different operational facts and must not collapse into
 * one "unavailable" message. Messages never embed SQL, absolute paths, or the
 * caller-supplied authorization detail.
 */
export type WorkflowStoreErrorCode =
  | 'E_SQLITE_MISSING'
  | 'E_SQLITE_PROBE_FAILED'
  | 'E_SQLITE_EXEC_FAILED'
  | 'E_STORE_CLOSED'
  | 'E_AUTH_REVOKED'
  | 'E_ARGUMENT_INVALID'
  | 'E_RECORD_INVALID'
  | 'E_REVISION_CONFLICT'
  | 'E_ACTIVE_TASK'
  | 'E_RUN_ALIAS'
  | 'E_GRAPH_MISMATCH'
  | 'E_NOT_FOUND'
  | 'E_BUNDLE_INVALID'

export class WorkflowStoreError extends Error {
  readonly code: WorkflowStoreErrorCode

  constructor(code: WorkflowStoreErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowStoreError'
    this.code = code
  }
}

/** Keep a domain error intact; fold unknown backend failures into a safe execution error. */
export function asWorkflowStoreError(error: unknown, fallback: string): WorkflowStoreError {
  if (error instanceof WorkflowStoreError) return error
  return new WorkflowStoreError('E_SQLITE_EXEC_FAILED', fallback)
}
