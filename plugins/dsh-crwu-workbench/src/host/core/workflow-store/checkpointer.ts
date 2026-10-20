import { BaseCheckpointSaver, INTERRUPT, copyCheckpoint } from '@langchain/langgraph'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph'
import { WorkflowStoreError } from './errors.ts'
import type { WorkflowStoreRuntime } from './runtime.ts'

/** Minimal structural view of `RunnableConfig`; the library owns the full type. */
type SaverConfig = { configurable?: Record<string, unknown> }
interface SaverListOptions {
  limit?: number
  before?: SaverConfig
  filter?: Record<string, unknown>
}
type WritePair = [string, unknown]
type SqlRow = Record<string, unknown>

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Special channels map to fixed negative indexes so they never collide with a
 * task's positional writes. Mirrors `WRITES_IDX_MAP` from the saver contract.
 * A `Map` keeps a channel literally named `__proto__` from hitting the
 * prototype chain.
 */
const WRITES_INDEX = new Map<string, number>([
  ['__error__', -1],
  ['__scheduled__', -2],
  [INTERRUPT, -3],
  ['__resume__', -4],
])

const SELECT_COLUMNS =
  'thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, ' +
  'checkpoint_type, checkpoint_blob, metadata_type, metadata_blob'
const SELECT_WRITES =
  'SELECT task_id, idx, task_path, channel, value_type, value_blob ' +
  'FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?'

const INSERT_CHECKPOINT =
  'INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, ' +
  'checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, saved_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET ' +
  'parent_checkpoint_id = excluded.parent_checkpoint_id, checkpoint_type = excluded.checkpoint_type, ' +
  'checkpoint_blob = excluded.checkpoint_blob, metadata_type = excluded.metadata_type, ' +
  'metadata_blob = excluded.metadata_blob, saved_at = excluded.saved_at'

const INSERT_WRITE_SKIP =
  'INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, ' +
  'task_path, channel, value_type, value_blob, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING'

const INSERT_WRITE_OVERWRITE =
  'INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, ' +
  'task_path, channel, value_type, value_blob, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET ' +
  'task_path = excluded.task_path, channel = excluded.channel, value_type = excluded.value_type, ' +
  'value_blob = excluded.value_blob, saved_at = excluded.saved_at'

/** Compare strings by Unicode code point, matching the saver contract (not UTF-16 order). */
function compareCodePoints(a: string, b: string): number {
  let ai = 0
  let bi = 0
  while (ai < a.length && bi < b.length) {
    const ac = a.codePointAt(ai) ?? 0
    const bc = b.codePointAt(bi) ?? 0
    if (ac !== bc) return ac < bc ? -1 : 1
    ai += ac > 0xffff ? 2 : 1
    bi += bc > 0xffff ? 2 : 1
  }
  if (ai >= a.length && bi >= b.length) return 0
  return ai >= a.length ? -1 : 1
}

/** `(taskPath, taskId, idx)` ordering for one superstep's pending writes. */
function compareWriteKeys(a: [string, string, number], b: [string, string, number]): number {
  if (a[0] !== b[0]) return compareCodePoints(a[0], b[0])
  if (a[1] !== b[1]) return compareCodePoints(a[1], b[1])
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

function configurableValue(config: SaverConfig, key: string): unknown {
  return config.configurable?.[key]
}

/** Read a caller-influenced configurable key; reject prototype-pollution keys. */
function readKey(
  value: unknown,
  label: string,
  options: { allowMissing: boolean; allowEmpty: boolean },
): string | undefined {
  if (value === undefined || value === null) {
    if (options.allowMissing) return undefined
    throw new WorkflowStoreError('E_ARGUMENT_INVALID', `${label} 缺失`)
  }
  if (typeof value !== 'string' || (!options.allowEmpty && value === '') || POLLUTION_KEYS.has(value)) {
    throw new WorkflowStoreError('E_ARGUMENT_INVALID', `${label} 非法`)
  }
  return value
}

/**
 * LangGraph `BaseCheckpointSaver` backed by the local SQLite file.
 *
 * Checkpoints, metadata, and pending writes are stored as the serializer's typed
 * bytes — no ad-hoc JSON dumping of framework objects — and read back in
 * `(taskPath, taskId, idx)` order.
 */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  readonly #runtime: WorkflowStoreRuntime

  constructor(runtime: WorkflowStoreRuntime) {
    super()
    this.#runtime = runtime
  }

  async getTuple(config: SaverConfig): Promise<CheckpointTuple | undefined> {
    this.#runtime.guard()
    const database = this.#runtime.database()
    const threadId = readKey(configurableValue(config, 'thread_id'), 'thread_id', {
      allowMissing: true,
      allowEmpty: false,
    })
    if (threadId === undefined) return undefined
    const checkpointNs =
      readKey(configurableValue(config, 'checkpoint_ns'), 'checkpoint_ns', {
        allowMissing: true,
        allowEmpty: true,
      }) ?? ''
    const requestedId =
      readKey(configurableValue(config, 'checkpoint_id'), 'checkpoint_id', {
        allowMissing: true,
        allowEmpty: true,
      }) ||
      readKey(configurableValue(config, 'thread_ts'), 'thread_ts', { allowMissing: true, allowEmpty: true }) ||
      undefined

    const row = requestedId
      ? database
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
          )
          .get(threadId, checkpointNs, requestedId)
      : database
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ` +
              'ORDER BY checkpoint_id DESC LIMIT 1',
          )
          .get(threadId, checkpointNs)
    if (row === undefined) return undefined
    return this.#tupleFromRow(row, config, requestedId !== undefined)
  }

  /**
   * Caller-visible list. Authorization runs eagerly here so a revoked receipt
   * fails before the generator is iterated.
   */
  list(config: SaverConfig, options?: SaverListOptions): AsyncGenerator<CheckpointTuple> {
    this.#runtime.guard()
    return this.#iterate(config, options)
  }

  async put(
    config: SaverConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<SaverConfig> {
    this.#runtime.guard()
    const database = this.#runtime.database()
    const threadId = readKey(configurableValue(config, 'thread_id'), 'thread_id', {
      allowMissing: false,
      allowEmpty: false,
    })!
    const checkpointNs =
      readKey(configurableValue(config, 'checkpoint_ns'), 'checkpoint_ns', {
        allowMissing: true,
        allowEmpty: true,
      }) ?? ''
    const parentId =
      readKey(configurableValue(config, 'checkpoint_id'), 'checkpoint_id', {
        allowMissing: true,
        allowEmpty: true,
      }) || null
    const checkpointId = readKey(checkpoint?.id, 'checkpoint.id', { allowMissing: false, allowEmpty: false })!
    const prepared = copyCheckpoint(checkpoint)
    const [checkpointType, checkpointBlob] = await this.serde.dumpsTyped(prepared)
    const [metadataType, metadataBlob] = await this.serde.dumpsTyped(metadata)
    database
      .prepare(INSERT_CHECKPOINT)
      .run(
        threadId,
        checkpointNs,
        checkpointId,
        parentId,
        checkpointType,
        checkpointBlob,
        metadataType,
        metadataBlob,
        new Date().toISOString(),
      )
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } }
  }

  async putWrites(config: SaverConfig, writes: WritePair[], taskId: string, taskPath = ''): Promise<void> {
    this.#runtime.guard()
    const database = this.#runtime.database()
    const threadId = readKey(configurableValue(config, 'thread_id'), 'thread_id', {
      allowMissing: false,
      allowEmpty: false,
    })!
    const checkpointNs =
      readKey(configurableValue(config, 'checkpoint_ns'), 'checkpoint_ns', {
        allowMissing: true,
        allowEmpty: true,
      }) ?? ''
    const checkpointId = readKey(configurableValue(config, 'checkpoint_id'), 'checkpoint_id', {
      allowMissing: false,
      allowEmpty: false,
    })!
    const safeTaskId = readKey(taskId, 'task_id', { allowMissing: false, allowEmpty: false })!
    const safeTaskPath = typeof taskPath === 'string' ? taskPath : ''
    const savedAt = new Date().toISOString()
    for (let position = 0; position < writes.length; position += 1) {
      const [channel, value] = writes[position]!
      const [valueType, valueBlob] = await this.serde.dumpsTyped(value)
      const mapped = WRITES_INDEX.get(channel)
      const idx = mapped === undefined ? position : mapped
      const statement = idx >= 0 ? INSERT_WRITE_SKIP : INSERT_WRITE_OVERWRITE
      database
        .prepare(statement)
        .run(
          threadId,
          checkpointNs,
          checkpointId,
          safeTaskId,
          idx,
          safeTaskPath,
          channel,
          valueType,
          valueBlob,
          savedAt,
        )
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.#runtime.guard()
    const database = this.#runtime.database()
    const safeThreadId = readKey(threadId, 'thread_id', { allowMissing: false, allowEmpty: false })!
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM checkpoint_writes WHERE thread_id = ?').run(safeThreadId)
      database.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(safeThreadId)
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  async *#iterate(config: SaverConfig, options?: SaverListOptions): AsyncGenerator<CheckpointTuple> {
    const database = this.#runtime.database()
    const threadId = readKey(configurableValue(config, 'thread_id'), 'thread_id', {
      allowMissing: true,
      allowEmpty: false,
    })
    const namespaceFilter = readKey(configurableValue(config, 'checkpoint_ns'), 'checkpoint_ns', {
      allowMissing: true,
      allowEmpty: true,
    })
    const checkpointFilter = readKey(configurableValue(config, 'checkpoint_id'), 'checkpoint_id', {
      allowMissing: true,
      allowEmpty: true,
    })
    const beforeId = options?.before
      ? readKey(configurableValue(options.before, 'checkpoint_id'), 'before.checkpoint_id', {
          allowMissing: true,
          allowEmpty: true,
        })
      : undefined
    const filter = options?.filter
    let remaining = options?.limit

    const sql =
      threadId === undefined
        ? `SELECT ${SELECT_COLUMNS} FROM checkpoints ORDER BY thread_id ASC, checkpoint_ns ASC, checkpoint_id DESC`
        : `SELECT ${SELECT_COLUMNS} FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_ns ASC, checkpoint_id DESC`
    const rows = (threadId === undefined ? database.prepare(sql).all() : database.prepare(sql).all(threadId)) as SqlRow[]
    for (const row of rows) {
      // Re-authorize on every advance: the generator may resume long after the
      // receipt was revoked, including after an awaited serde decode below.
      this.#runtime.guard()
      const rowNamespace = String(row.checkpoint_ns ?? '')
      if (namespaceFilter !== undefined && rowNamespace !== namespaceFilter) continue
      const rowId = String(row.checkpoint_id ?? '')
      if (checkpointFilter !== undefined && checkpointFilter !== '' && rowId !== checkpointFilter) continue
      if (beforeId !== undefined && beforeId !== '' && rowId >= beforeId) continue
      if (filter !== undefined) {
        const metadata = (await this.serde.loadsTyped(
          String(row.metadata_type),
          row.metadata_blob as Uint8Array,
        )) as Record<string, unknown>
        this.#runtime.guard()
        if (!Object.entries(filter).every(([key, value]) => metadata[key] === value)) continue
      }
      if (remaining !== undefined) {
        if (remaining <= 0) return
        remaining -= 1
      }
      const tuple = await this.#tupleFromRow(row, config, false)
      this.#runtime.guard()
      yield tuple
    }
    this.#runtime.guard()
  }

  async #pendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointTuple['pendingWrites']> {
    this.#runtime.guard()
    const database = this.#runtime.database()
    const rows = database.prepare(SELECT_WRITES).all(threadId, checkpointNs, checkpointId) as SqlRow[]
    const ordered = rows
      .map((row) => ({
        key: [String(row.task_path ?? ''), String(row.task_id ?? ''), Number(row.idx ?? 0)] as [
          string,
          string,
          number,
        ],
        row,
      }))
      .sort((a, b) => compareWriteKeys(a.key, b.key))
    const pending: [string, string, unknown][] = []
    for (const { row } of ordered) {
      const value = await this.serde.loadsTyped(String(row.value_type), row.value_blob as Uint8Array)
      this.#runtime.guard()
      pending.push([String(row.task_id ?? ''), String(row.channel ?? ''), value])
    }
    return pending
  }

  async #tupleFromRow(row: SqlRow, fallbackConfig: SaverConfig, explicit: boolean): Promise<CheckpointTuple> {
    const threadId = String(row.thread_id ?? '')
    const checkpointNs = String(row.checkpoint_ns ?? '')
    const checkpointId = String(row.checkpoint_id ?? '')
    const checkpoint = (await this.serde.loadsTyped(
      String(row.checkpoint_type),
      row.checkpoint_blob as Uint8Array,
    )) as Checkpoint
    this.#runtime.guard()
    const metadata = (await this.serde.loadsTyped(
      String(row.metadata_type),
      row.metadata_blob as Uint8Array,
    )) as CheckpointMetadata
    this.#runtime.guard()
    const pendingWrites = await this.#pendingWrites(threadId, checkpointNs, checkpointId)
    this.#runtime.guard()
    const tuple: CheckpointTuple = {
      config: explicit
        ? fallbackConfig
        : { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } },
      checkpoint,
      metadata,
      pendingWrites,
    }
    const parentCheckpointId = row.parent_checkpoint_id
    if (parentCheckpointId !== null && parentCheckpointId !== undefined) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: String(parentCheckpointId),
        },
      }
    }
    return tuple
  }
}
