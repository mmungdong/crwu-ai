import type { DatabaseSync } from 'node:sqlite'
import { WorkflowStoreError } from './errors.ts'
import type { WorkflowAuthorize } from './types.ts'

/**
 * Shared handle for one open store.
 *
 * Every public read/write calls `guard()` first, so a revoked authorization
 * fails closed even though the SQLite handle stays open.
 */
export class WorkflowStoreRuntime {
  readonly #database: DatabaseSync
  readonly #authorize: WorkflowAuthorize
  #closed = false

  constructor(database: DatabaseSync, authorize: WorkflowAuthorize) {
    this.#database = database
    this.#authorize = authorize
  }

  get closed(): boolean {
    return this.#closed
  }

  guard(): void {
    if (this.#closed) throw new WorkflowStoreError('E_STORE_CLOSED', '工作流存储已关闭')
    let result: { ok?: boolean } | undefined
    try {
      result = this.#authorize()
    } catch {
      // A broker that throws is a denied operation, not a permitted one.
      result = undefined
    }
    if (result?.ok !== true) throw new WorkflowStoreError('E_AUTH_REVOKED', '工作流存储授权已失效')
  }

  database(): DatabaseSync {
    if (this.#closed) throw new WorkflowStoreError('E_STORE_CLOSED', '工作流存储已关闭')
    return this.#database
  }

  /** Idempotent: a second close is a no-op, and close is never authorization-gated. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#database.close()
    } catch {
      // Closing an already-broken handle must not surface a second failure.
    }
  }
}
