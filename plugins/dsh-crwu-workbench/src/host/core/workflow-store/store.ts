import type { DatabaseSync } from 'node:sqlite'
import { SqliteCheckpointSaver } from './checkpointer.ts'
import { WorkflowStoreError, asWorkflowStoreError } from './errors.ts'
import { WorkflowStoreRuntime } from './runtime.ts'
import {
  ensureParentDirectory,
  loadNativeSqlite,
  openSqliteDatabase,
  probeNativeSqlite,
  withTransaction,
  writeStoreNote,
} from './sqlite.ts'
import {
  assertCurrentRecord,
  assertIdentity,
  assertRevision,
  encodeBytes,
  isPlainObject,
  parseBundle,
} from './validate.ts'
import { WORKFLOW_BUNDLE_FORMAT } from './types.ts'
import type {
  OpenWorkflowStoreOptions,
  WorkflowAuthorize,
  WorkflowBundleCheckpoint,
  WorkflowBundleV1,
  WorkflowCurrentRecord,
  WorkflowImportIdentity,
  WorkflowStore,
} from './types.ts'

type SqlRow = Record<string, unknown>

/** Statuses that own a live runtime; replacing or clearing them needs an external stop first. */
const ACTIVE_STATUSES = new Set(['running'])

/**
 * A row stays occupied while its run is live or its child quiescence is unresolved.
 *
 * The flag survives a `failed` status so an unreconciled child cannot be dropped
 * by a replacement or import; only a resolved stop clears it.
 */
function occupied(row: SqlRow): boolean {
  if (ACTIVE_STATUSES.has(String(row.status))) return true
  let record: unknown
  try {
    record = JSON.parse(String(row.record_json))
  } catch {
    return false
  }
  if (!isPlainObject(record)) return false
  const state = record.state
  if (!isPlainObject(state)) return false
  const stopUnknown = state.stopUnknown
  if (stopUnknown === true) return true
  if (stopUnknown !== null && typeof stopUnknown === 'object') return true
  return false
}

const CHECKPOINT_COLUMNS =
  'thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, ' +
  'checkpoint_type, checkpoint_blob, metadata_type, metadata_blob'

const UPSERT_CURRENT =
  'INSERT INTO current_workflows (workspace_id, step_id, run_id, graph_id, graph_version, revision, status, ' +
  'record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (workspace_id, step_id) DO UPDATE SET run_id = excluded.run_id, graph_id = excluded.graph_id, ' +
  'graph_version = excluded.graph_version, revision = excluded.revision, status = excluded.status, ' +
  'record_json = excluded.record_json, updated_at = excluded.updated_at'

const UPSERT_CHECKPOINT =
  'INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, ' +
  'checkpoint_blob, metadata_type, metadata_blob, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET ' +
  'parent_checkpoint_id = excluded.parent_checkpoint_id, checkpoint_type = excluded.checkpoint_type, ' +
  'checkpoint_blob = excluded.checkpoint_blob, metadata_type = excluded.metadata_type, ' +
  'metadata_blob = excluded.metadata_blob, saved_at = excluded.saved_at'

const UPSERT_WRITE =
  'INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, task_path, channel, ' +
  'value_type, value_blob, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET ' +
  'task_path = excluded.task_path, channel = excluded.channel, value_type = excluded.value_type, ' +
  'value_blob = excluded.value_blob, saved_at = excluded.saved_at'

function authorizeOnce(authorize: WorkflowAuthorize): void {
  let result: { ok?: boolean } | undefined
  try {
    result = authorize()
  } catch {
    result = undefined
  }
  if (result?.ok !== true) throw new WorkflowStoreError('E_AUTH_REVOKED', '工作流存储授权已失效')
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new WorkflowStoreError('E_ARGUMENT_INVALID', `${label} 缺失`)
  }
  return value
}

/** Drop one run's checkpoints and writes; callers wrap this in their own transaction. */
function deleteRun(database: DatabaseSync, runId: string): void {
  database.prepare('DELETE FROM checkpoint_writes WHERE thread_id = ?').run(runId)
  database.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(runId)
}

function snapshotBundleCheckpoints(database: DatabaseSync, runId: string): WorkflowBundleCheckpoint[] {
  const checkpoints = database
    .prepare(
      `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE thread_id = ? ` +
        'ORDER BY checkpoint_ns ASC, checkpoint_id ASC',
    )
    .all(runId) as SqlRow[]
  const writeQuery = database.prepare(
    'SELECT task_id, idx, task_path, channel, value_type, value_blob FROM checkpoint_writes ' +
      'WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_path ASC, task_id ASC, idx ASC',
  )
  return checkpoints.map((row) => {
    const checkpointNs = String(row.checkpoint_ns ?? '')
    const checkpointId = String(row.checkpoint_id ?? '')
    const parent = row.parent_checkpoint_id
    const writes = (writeQuery.all(runId, checkpointNs, checkpointId) as SqlRow[]).map((write) => ({
      taskId: String(write.task_id ?? ''),
      idx: Number(write.idx ?? 0),
      taskPath: String(write.task_path ?? ''),
      channel: String(write.channel ?? ''),
      valueType: String(write.value_type ?? ''),
      valueBytes: encodeBytes(write.value_blob as Uint8Array),
    }))
    return {
      threadId: runId,
      checkpointNs,
      checkpointId,
      parentCheckpointId: parent === null || parent === undefined ? null : String(parent),
      checkpointType: String(row.checkpoint_type ?? ''),
      checkpointBytes: encodeBytes(row.checkpoint_blob as Uint8Array),
      metadataType: String(row.metadata_type ?? ''),
      metadataBytes: encodeBytes(row.metadata_blob as Uint8Array),
      writes,
    }
  })
}

class SqliteWorkflowStore implements WorkflowStore {
  readonly checkpointer: SqliteCheckpointSaver
  readonly #runtime: WorkflowStoreRuntime

  constructor(runtime: WorkflowStoreRuntime) {
    this.#runtime = runtime
    this.checkpointer = new SqliteCheckpointSaver(runtime)
  }

  async saveCurrent(record: WorkflowCurrentRecord, expectedRevision?: number): Promise<void> {
    this.#runtime.guard()
    const validated = assertCurrentRecord(record)
    if (expectedRevision !== undefined) assertRevision(expectedRevision, 'expectedRevision')
    const database = this.#runtime.database()
    try {
      withTransaction(database, () => {
        const owner = database
          .prepare('SELECT workspace_id, step_id FROM current_workflows WHERE run_id = ?')
          .get(validated.runId) as SqlRow | undefined
        if (
          owner !== undefined &&
          (String(owner.workspace_id) !== validated.workspaceId || String(owner.step_id) !== validated.stepId)
        ) {
          throw new WorkflowStoreError('E_RUN_ALIAS', '运行标识已被其他工作区任务占用')
        }
        const existing = database
          .prepare(
            'SELECT run_id, graph_id, graph_version, revision, status, record_json FROM current_workflows ' +
              'WHERE workspace_id = ? AND step_id = ?',
          )
          .get(validated.workspaceId, validated.stepId) as SqlRow | undefined
        if (existing === undefined) {
          if (expectedRevision !== undefined) {
            throw new WorkflowStoreError('E_REVISION_CONFLICT', '目标当前任务不存在')
          }
        } else {
          const existingRevision = Number(existing.revision)
          if (expectedRevision !== undefined && existingRevision !== expectedRevision) {
            throw new WorkflowStoreError('E_REVISION_CONFLICT', '工作流修订已被其他写入更新')
          }
          const sameRun = String(existing.run_id) === validated.runId
          if (!sameRun) {
            if (occupied(existing)) {
              throw new WorkflowStoreError('E_ACTIVE_TASK', '运行中的任务需先停止才能替换')
            }
          } else if (
            String(existing.graph_id) !== validated.graphId ||
            String(existing.graph_version) !== validated.graphVersion
          ) {
            throw new WorkflowStoreError('E_GRAPH_MISMATCH', '同一运行不可更换图版本')
          }
          if (validated.revision < existingRevision) {
            throw new WorkflowStoreError('E_REVISION_CONFLICT', '较旧的修订不能覆盖当前状态')
          }
          if (!sameRun) deleteRun(database, String(existing.run_id))
        }
        database
          .prepare(UPSERT_CURRENT)
          .run(
            validated.workspaceId,
            validated.stepId,
            validated.runId,
            validated.graphId,
            validated.graphVersion,
            validated.revision,
            validated.status,
            JSON.stringify(validated),
            new Date().toISOString(),
          )
      })
    } catch (error) {
      throw asWorkflowStoreError(error, '工作流状态保存失败')
    }
  }

  async getCurrent(workspaceId: string, stepId: string): Promise<WorkflowCurrentRecord | null> {
    this.#runtime.guard()
    const workspace = requireText(workspaceId, 'workspaceId')
    const step = requireText(stepId, 'stepId')
    const database = this.#runtime.database()
    try {
      const row = database
        .prepare('SELECT record_json FROM current_workflows WHERE workspace_id = ? AND step_id = ?')
        .get(workspace, step) as SqlRow | undefined
      if (row === undefined) return null
      return JSON.parse(String(row.record_json)) as WorkflowCurrentRecord
    } catch (error) {
      throw asWorkflowStoreError(error, '读取工作流状态失败')
    }
  }

  async exportCurrent(workspaceId: string, stepId: string): Promise<string> {
    this.#runtime.guard()
    const workspace = requireText(workspaceId, 'workspaceId')
    const step = requireText(stepId, 'stepId')
    const database = this.#runtime.database()
    try {
      return withTransaction(database, () => {
        const row = database
          .prepare(
            'SELECT run_id, record_json FROM current_workflows WHERE workspace_id = ? AND step_id = ?',
          )
          .get(workspace, step) as SqlRow | undefined
        if (row === undefined) throw new WorkflowStoreError('E_NOT_FOUND', '当前工作流任务不存在')
        const record = assertCurrentRecord(JSON.parse(String(row.record_json)), 'current')
        const runId = String(row.run_id)
        if (record.runId !== runId) throw new WorkflowStoreError('E_RECORD_INVALID', '当前任务运行标识不一致')
        const bundle: WorkflowBundleV1 = {
          format: WORKFLOW_BUNDLE_FORMAT,
          workspaceId: record.workspaceId,
          stepId: record.stepId,
          runId,
          graphId: record.graphId,
          graphVersion: record.graphVersion,
          revision: record.revision,
          current: record,
          checkpoints: snapshotBundleCheckpoints(database, runId),
        }
        return JSON.stringify(bundle)
      })
    } catch (error) {
      throw asWorkflowStoreError(error, '导出工作流失败')
    }
  }

  async importCurrent(serialized: string, identity: WorkflowImportIdentity): Promise<void> {
    this.#runtime.guard()
    const target = assertIdentity(identity)
    // Full validation and decode happen before the first write.
    const bundle = parseBundle(serialized, target)
    const database = this.#runtime.database()
    try {
      withTransaction(database, () => {
        const owner = database
          .prepare('SELECT workspace_id, step_id FROM current_workflows WHERE run_id = ?')
          .get(bundle.runId) as SqlRow | undefined
        if (
          owner !== undefined &&
          (String(owner.workspace_id) !== bundle.workspaceId || String(owner.step_id) !== bundle.stepId)
        ) {
          throw new WorkflowStoreError('E_RUN_ALIAS', '运行标识已被其他工作区任务占用')
        }
        const existing = database
          .prepare('SELECT run_id, status, record_json FROM current_workflows WHERE workspace_id = ? AND step_id = ?')
          .get(bundle.workspaceId, bundle.stepId) as SqlRow | undefined
        if (existing !== undefined) {
          if (occupied(existing)) {
            throw new WorkflowStoreError('E_ACTIVE_TASK', '运行中的任务需先停止才能替换')
          }
          deleteRun(database, String(existing.run_id))
        }
        deleteRun(database, bundle.runId)
        database
          .prepare(UPSERT_CURRENT)
          .run(
            bundle.workspaceId,
            bundle.stepId,
            bundle.runId,
            bundle.graphId,
            bundle.graphVersion,
            bundle.revision,
            bundle.current.status,
            JSON.stringify(bundle.current),
            new Date().toISOString(),
          )
        const checkpointStatement = database.prepare(UPSERT_CHECKPOINT)
        const writeStatement = database.prepare(UPSERT_WRITE)
        for (const checkpoint of bundle.checkpoints) {
          const savedAt = new Date().toISOString()
          checkpointStatement.run(
            bundle.runId,
            checkpoint.checkpointNs,
            checkpoint.checkpointId,
            checkpoint.parentCheckpointId,
            checkpoint.checkpointType,
            checkpoint.checkpoint,
            checkpoint.metadataType,
            checkpoint.metadata,
            savedAt,
          )
          for (const write of checkpoint.writes) {
            writeStatement.run(
              bundle.runId,
              checkpoint.checkpointNs,
              checkpoint.checkpointId,
              write.taskId,
              write.idx,
              write.taskPath,
              write.channel,
              write.valueType,
              write.value,
              savedAt,
            )
          }
        }
      })
    } catch (error) {
      throw asWorkflowStoreError(error, '导入工作流失败')
    }
  }

  async clearCurrent(workspaceId: string, stepId: string, expectedRunId: string): Promise<boolean> {
    this.#runtime.guard()
    const workspace = requireText(workspaceId, 'workspaceId')
    const step = requireText(stepId, 'stepId')
    const runId = requireText(expectedRunId, 'expectedRunId')
    const database = this.#runtime.database()
    try {
      return withTransaction(database, () => {
        const existing = database
          .prepare('SELECT run_id, status, record_json FROM current_workflows WHERE workspace_id = ? AND step_id = ?')
          .get(workspace, step) as SqlRow | undefined
        if (existing === undefined) return false
        if (String(existing.run_id) !== runId) return false
        if (occupied(existing)) {
          throw new WorkflowStoreError('E_ACTIVE_TASK', '运行中的任务需先停止才能清空')
        }
        deleteRun(database, runId)
        database.prepare('DELETE FROM current_workflows WHERE workspace_id = ? AND step_id = ?').run(workspace, step)
        return true
      })
    } catch (error) {
      throw asWorkflowStoreError(error, '清空工作流失败')
    }
  }

  async close(): Promise<void> {
    this.#runtime.close()
  }
}

/**
 * Open the local workflow store.
 *
 * Authorization is checked before any filesystem or SQLite work and again on
 * every public operation, so a revoked broker receipt fails closed even on an
 * already-open handle.
 */
export async function openWorkflowStore(options: OpenWorkflowStoreOptions): Promise<WorkflowStore> {
  const input = options as unknown as Record<string, unknown> | null | undefined
  if (input === null || input === undefined || typeof input !== 'object' || typeof input.authorize !== 'function') {
    throw new WorkflowStoreError('E_ARGUMENT_INVALID', '工作流存储参数缺失')
  }
  const authorize = input.authorize as WorkflowAuthorize
  authorizeOnce(authorize)
  const path = requireText(input.path, 'path')
  const module = await loadNativeSqlite()
  probeNativeSqlite(module)
  await ensureParentDirectory(path)
  const database = openSqliteDatabase(module, path)
  if (typeof input.note === 'string' && input.note !== '') {
    try {
      writeStoreNote(database, input.note)
    } catch {
      // The diagnostic note must never block opening a usable store.
    }
  }
  return new SqliteWorkflowStore(new WorkflowStoreRuntime(database, authorize))
}
