import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WorkflowStoreError } from './errors.ts'

/** The native module shape, loaded lazily so an unsupported runtime never crashes import time. */
export type SqliteModule = typeof import('node:sqlite')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS current_workflows (
  workspace_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, step_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  checkpoint_type TEXT NOT NULL,
  checkpoint_blob BLOB NOT NULL,
  metadata_type TEXT NOT NULL,
  metadata_blob BLOB NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_ns
  ON checkpoints (thread_id, checkpoint_ns, checkpoint_id DESC);

CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  task_path TEXT NOT NULL,
  channel TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_blob BLOB NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * Import native SQLite. A runtime without `node:sqlite` is a capability gap
 * (`E_SQLITE_MISSING`), never a fallback to another command or package.
 */
export async function loadNativeSqlite(): Promise<SqliteModule> {
  try {
    return await import('node:sqlite')
  } catch {
    throw new WorkflowStoreError('E_SQLITE_MISSING', '当前运行时不支持内置 SQLite')
  }
}

/** Real side-effect probe: open an in-memory database and round-trip one row. */
export function probeNativeSqlite(module: SqliteModule): void {
  let probe: DatabaseSync | undefined
  try {
    probe = new module.DatabaseSync(':memory:')
    probe.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe (value) VALUES ('ok')")
    const row = probe.prepare('SELECT value FROM probe').get()
    if (row?.value !== 'ok') throw new Error('probe mismatch')
  } catch {
    throw new WorkflowStoreError('E_SQLITE_PROBE_FAILED', '内置 SQLite 能力探测未通过')
  } finally {
    try {
      probe?.close()
    } catch {
      // A probe that already failed must not mask its own error.
    }
  }
}

/** Create the parent directory from the Host-supplied path before opening the file. */
export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

/** Open the database and create the fixed schema. */
export function openSqliteDatabase(module: SqliteModule, path: string): DatabaseSync {
  let database: DatabaseSync | undefined
  try {
    database = new module.DatabaseSync(path)
    database.exec(SCHEMA)
    return database
  } catch {
    try {
      database?.close()
    } catch {
      // ignore close failure while reporting the open failure
    }
    throw new WorkflowStoreError('E_SQLITE_EXEC_FAILED', '工作流数据库初始化失败')
  }
}

/** Run `work` in one immediate transaction; roll back on any failure. */
export function withTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original failure; a rollback error carries no extra meaning here.
    }
    throw error
  }
}

/** Insert or refresh the optional diagnostic note. */
export function writeStoreNote(database: DatabaseSync, note: string): void {
  database
    .prepare(
      'INSERT INTO store_meta (key, value) VALUES (:key, :value) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run({ key: 'note', value: note })
}
