import { WorkflowStoreError } from './errors.ts'
import { WORKFLOW_BUNDLE_FORMAT } from './types.ts'
import type { WorkflowBundleCheckpoint, WorkflowBundleV1, WorkflowCurrentRecord, WorkflowImportIdentity } from './types.ts'

/** Keys that traverse the prototype chain when written with bracket notation (CWE-1321). */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const MAX_SERIALIZED_CHARS = 16 * 1024 * 1024
const MAX_BLOB_CHARS = 12 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_CHECKPOINTS = 4096
const MAX_WRITES_PER_CHECKPOINT = 4096

function fail(code: 'E_BUNDLE_INVALID' | 'E_RECORD_INVALID', message: string): never {
  throw new WorkflowStoreError(code, message)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectPollutionKeys(value: unknown, label: string, seen: Set<object>): void {
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) rejectPollutionKeys(entry, label, seen)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (POLLUTION_KEYS.has(key)) fail('E_BUNDLE_INVALID', `${label} 含非法字段名`)
    rejectPollutionKeys(entry, label, seen)
  }
}

/** Reject values `JSON.stringify` would silently drop or reinterpret (functions, undefined, NaN, cycles, class instances). */
export function assertPlainJson(value: unknown, label: string, stack: Set<object> = new Set()): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) fail('E_RECORD_INVALID', `${label} 含非有限数字`)
    return
  }
  if (kind !== 'object') fail('E_RECORD_INVALID', `${label} 含不可序列化值`)
  const object = value as object
  // A recursion stack (removed on leave), not a visited set: shared non-cyclic
  // references are legal JSON, only an object containing itself is a cycle.
  if (stack.has(object)) fail('E_RECORD_INVALID', `${label} 含循环引用`)
  stack.add(object)
  // A plain own-data JSON object excludes Date, Map, Set, Uint8Array, class instances.
  if (Array.isArray(value)) {
    for (const entry of value) assertPlainJson(entry, label, stack)
    stack.delete(object)
    return
  }
  if (!isPlainObject(value)) fail('E_RECORD_INVALID', `${label} 含非普通对象`)
  for (const [key, entry] of Object.entries(value)) {
    if (POLLUTION_KEYS.has(key)) fail('E_RECORD_INVALID', `${label} 含非法字段名`)
    assertPlainJson(entry, label, stack)
  }
  stack.delete(object)
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') fail('E_RECORD_INVALID', `${label} 缺失`)
  return value
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    fail('E_RECORD_INVALID', `${label} 非法`)
  }
  return value
}

/** Validate one current-task record: plain JSON, required metadata, finite revision, source refs. */
export function assertCurrentRecord(value: unknown, label = 'current'): WorkflowCurrentRecord {
  if (!isPlainObject(value)) fail('E_RECORD_INVALID', `${label} 不是对象`)
  assertPlainJson(value, label)
  const record = value as Record<string, unknown>
  readString(record.workspaceId, `${label}.workspaceId`)
  readString(record.stepId, `${label}.stepId`)
  readString(record.runId, `${label}.runId`)
  readString(record.graphId, `${label}.graphId`)
  readString(record.graphVersion, `${label}.graphVersion`)
  readString(record.status, `${label}.status`)
  readInteger(record.revision, `${label}.revision`)
  if (!isPlainObject(record.state)) fail('E_RECORD_INVALID', `${label}.state 不是对象`)
  if (!Array.isArray(record.files)) fail('E_RECORD_INVALID', `${label}.files 不是数组`)
  const nodes = (record.state as Record<string, unknown>).nodes
  if (nodes !== undefined) {
    if (!isPlainObject(nodes)) fail('E_RECORD_INVALID', `${label}.state.nodes 不是对象`)
    for (const entry of Object.values(nodes)) {
      if (!isPlainObject(entry)) fail('E_RECORD_INVALID', `${label}.state.nodes 条目非法`)
    }
  }
  return record as unknown as WorkflowCurrentRecord
}

export function assertRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    fail('E_RECORD_INVALID', `${label} 非法`)
  }
  return value
}

/** Pending-write indexes are signed: negative values identify special channels. */
function assertWriteIndex(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail('E_BUNDLE_INVALID', `${label} 非法`)
  }
  return value
}

export function assertIdentity(value: unknown): WorkflowImportIdentity {
  if (!isPlainObject(value)) fail('E_BUNDLE_INVALID', '导入标识缺失')
  const identity = {
    workspaceId: readString(value.workspaceId, 'identity.workspaceId'),
    stepId: readString(value.stepId, 'identity.stepId'),
    graphId: readString(value.graphId, 'identity.graphId'),
    graphVersion: readString(value.graphVersion, 'identity.graphVersion'),
  }
  return identity
}

export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decodeBytes(value: unknown, label: string, budget: { total: number }): Uint8Array {
  if (typeof value !== 'string') fail('E_BUNDLE_INVALID', `${label} 字节缺失`)
  if (value.length > MAX_BLOB_CHARS || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail('E_BUNDLE_INVALID', `${label} 字节非法`)
  }
  const decoded = Buffer.from(value, 'base64')
  budget.total += decoded.byteLength
  if (budget.total > MAX_TOTAL_BYTES) fail('E_BUNDLE_INVALID', '导入内容超出大小上限')
  return decoded
}

function toBundleCheckpoint(value: unknown): WorkflowBundleCheckpoint {
  if (!isPlainObject(value)) fail('E_BUNDLE_INVALID', '检查点条目非法')
  const writes = value.writes
  if (!Array.isArray(writes) || writes.length > MAX_WRITES_PER_CHECKPOINT) {
    fail('E_BUNDLE_INVALID', '检查点写入非法')
  }
  return value as unknown as WorkflowBundleCheckpoint
}

/** Closed set of `lc:2` constructor records `JsonPlusSerializer._default` writes. */
const SAFE_SERIALIZED_CONSTRUCTORS = new Set(['Set', 'Map', 'RegExp', 'Error', 'Uint8Array'])

function isByte(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

/**
 * Screen one `lc`-tagged record from inert JSON.
 *
 * `lc:1` records are LangChain `Serializable` envelopes that `load()` would
 * resolve by id and instantiate; imports must not carry them. Only the closed
 * `lc:2` set written by the library's own serializer is accepted.
 */
function assertSafeSerializedRecord(record: Record<string, unknown>, label: string): void {
  const lc = record.lc
  if (lc === 1) fail('E_BUNDLE_INVALID', `${label} 含未支持的构造记录`)
  if (lc !== 2) fail('E_BUNDLE_INVALID', `${label} 含非法序列化标记`)
  const type = record.type
  if (type === 'undefined') return
  if (type === 'delta_snapshot') {
    if (!Object.prototype.hasOwnProperty.call(record, 'value')) {
      fail('E_BUNDLE_INVALID', `${label} 含非法快照记录`)
    }
    return
  }
  if (type !== 'constructor') fail('E_BUNDLE_INVALID', `${label} 含未支持的序列化记录`)
  const id = record.id
  const args = record.args
  const kwargs = record.kwargs
  const method = record.method
  if (!Array.isArray(id) || id.length !== 1 || typeof id[0] !== 'string') {
    fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
  }
  if (!Array.isArray(args) || !isPlainObject(kwargs)) fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
  const name = id[0]
  if (!SAFE_SERIALIZED_CONSTRUCTORS.has(name)) fail('E_BUNDLE_INVALID', `${label} 含未支持的构造记录`)
  const hasMethod = method !== null && method !== undefined
  if (name === 'Uint8Array') {
    if (hasMethod && method !== 'from') fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    if (args.length !== 1 || !Array.isArray(args[0]) || !(args[0] as unknown[]).every(isByte)) {
      fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    }
    return
  }
  if (hasMethod) fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
  if (name === 'Set' || name === 'Map') {
    if (args.length !== 1 || !Array.isArray(args[0])) fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    if (name === 'Map' && !(args[0] as unknown[]).every((entry) => Array.isArray(entry) && entry.length === 2)) {
      fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    }
    return
  }
  if (name === 'RegExp') {
    if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'string') {
      fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    }
    return
  }
  if (name === 'Error') {
    if (args.length !== 1 || typeof args[0] !== 'string') fail('E_BUNDLE_INVALID', `${label} 含非法构造记录`)
    return
  }
}

/** Walk a decoded payload with inert JSON semantics only: no reviver, no constructor execution. */
export function screenSerializedJson(value: unknown, label: string, stack: Set<object> = new Set()): void {
  if (value === null || typeof value !== 'object') return
  const object = value as object
  if (stack.has(object)) fail('E_BUNDLE_INVALID', `${label} 含循环结构`)
  stack.add(object)
  if (Array.isArray(value)) {
    for (const entry of value) screenSerializedJson(entry, label, stack)
    stack.delete(object)
    return
  }
  if (!isPlainObject(value)) fail('E_BUNDLE_INVALID', `${label} 含非普通对象`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (POLLUTION_KEYS.has(key)) fail('E_BUNDLE_INVALID', `${label} 含非法字段名`)
  }
  if (Object.prototype.hasOwnProperty.call(record, 'lc')) assertSafeSerializedRecord(record, label)
  for (const entry of Object.values(record)) screenSerializedJson(entry, label, stack)
  stack.delete(object)
}

function decodeUtf8Json(bytes: Uint8Array, label: string): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkflowStoreError('E_BUNDLE_INVALID', `${label} 不是有效 UTF-8`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkflowStoreError('E_BUNDLE_INVALID', `${label} 不是有效 JSON`)
  }
}

function assertCheckpointPayload(payload: unknown, expectedId: string, label: string): void {
  if (!isPlainObject(payload)) fail('E_BUNDLE_INVALID', `${label} 不是对象`)
  const version = payload.v
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('E_BUNDLE_INVALID', `${label} 版本非法`)
  }
  if (payload.id !== expectedId) fail('E_BUNDLE_INVALID', `${label} 标识不一致`)
  if (typeof payload.ts !== 'string' || payload.ts === '') fail('E_BUNDLE_INVALID', `${label} 时间戳非法`)
  if (!isPlainObject(payload.channel_values)) fail('E_BUNDLE_INVALID', `${label} channel_values 非法`)
  if (!isPlainObject(payload.channel_versions)) fail('E_BUNDLE_INVALID', `${label} channel_versions 非法`)
  if (!isPlainObject(payload.versions_seen)) fail('E_BUNDLE_INVALID', `${label} versions_seen 非法`)
  for (const value of Object.values(payload.channel_versions)) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      fail('E_BUNDLE_INVALID', `${label} channel_versions 非法`)
    }
  }
  for (const seen of Object.values(payload.versions_seen)) {
    if (!isPlainObject(seen)) fail('E_BUNDLE_INVALID', `${label} versions_seen 非法`)
    for (const value of Object.values(seen)) {
      if (typeof value !== 'number' && typeof value !== 'string') {
        fail('E_BUNDLE_INVALID', `${label} versions_seen 非法`)
      }
    }
  }
}

function assertMetadataPayload(payload: unknown, label: string): void {
  if (!isPlainObject(payload)) fail('E_BUNDLE_INVALID', `${label} 不是对象`)
  if (typeof payload.source !== 'string' || payload.source === '') fail('E_BUNDLE_INVALID', `${label} 来源非法`)
  if (typeof payload.step !== 'number' || !Number.isInteger(payload.step)) fail('E_BUNDLE_INVALID', `${label} 步骤非法`)
  if (!isPlainObject(payload.parents)) fail('E_BUNDLE_INVALID', `${label} 父引用非法`)
  for (const value of Object.values(payload.parents)) {
    if (typeof value !== 'string') fail('E_BUNDLE_INVALID', `${label} 父引用非法`)
  }
}

export interface DecodedBundleWrite {
  taskId: string
  idx: number
  taskPath: string
  channel: string
  valueType: string
  value: Uint8Array
}

export interface DecodedBundleCheckpoint {
  threadId: string
  checkpointNs: string
  checkpointId: string
  parentCheckpointId: string | null
  checkpointType: string
  checkpoint: Uint8Array
  metadataType: string
  metadata: Uint8Array
  writes: DecodedBundleWrite[]
}

export interface DecodedBundle {
  workspaceId: string
  stepId: string
  runId: string
  graphId: string
  graphVersion: string
  revision: number
  current: WorkflowCurrentRecord
  checkpoints: DecodedBundleCheckpoint[]
}

/**
 * Validate and decode an exported bundle before any write.
 *
 * Identity, format version, record shape, tuple shape, and sizes are all proven
 * up front. Bytes are decoded from base64, but nothing in the payload is
 * executed or used to derive a filesystem path.
 */
export function parseBundle(serialized: unknown, identity: WorkflowImportIdentity): DecodedBundle {
  if (typeof serialized !== 'string' || serialized === '' || serialized.length > MAX_SERIALIZED_CHARS) {
    fail('E_BUNDLE_INVALID', '导入内容非法')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    fail('E_BUNDLE_INVALID', '导入内容无法解析')
  }
  if (!isPlainObject(parsed)) fail('E_BUNDLE_INVALID', '导入内容不是对象')
  rejectPollutionKeys(parsed, '导入内容', new Set())
  const envelope = parsed as unknown as WorkflowBundleV1
  if (envelope.format !== WORKFLOW_BUNDLE_FORMAT) fail('E_BUNDLE_INVALID', '导入格式不受支持')
  for (const [field, expected] of [
    ['workspaceId', identity.workspaceId],
    ['stepId', identity.stepId],
    ['graphId', identity.graphId],
    ['graphVersion', identity.graphVersion],
  ] as const) {
    if (envelope[field] !== expected) fail('E_BUNDLE_INVALID', '导入内容与目标不一致')
  }
  if (envelope.runId !== envelope.current?.runId) fail('E_BUNDLE_INVALID', '导入运行标识不一致')
  const current = assertCurrentRecord(envelope.current, 'bundle.current')
  if (current.workspaceId !== identity.workspaceId || current.stepId !== identity.stepId) {
    fail('E_BUNDLE_INVALID', '导入任务归属不一致')
  }
  if (current.graphId !== identity.graphId || current.graphVersion !== identity.graphVersion) {
    fail('E_BUNDLE_INVALID', '导入图版本不一致')
  }
  const revision = assertRevision(current.revision, 'bundle.current.revision')
  if (revision !== envelope.revision) fail('E_BUNDLE_INVALID', '导入修订号不一致')
  const checkpointValues = envelope.checkpoints
  if (!Array.isArray(checkpointValues) || checkpointValues.length > MAX_CHECKPOINTS) {
    fail('E_BUNDLE_INVALID', '检查点列表非法')
  }
  const budget = { total: 0 }
  const checkpoints: DecodedBundleCheckpoint[] = []
  const seenTuples = new Set<string>()
  for (const raw of checkpointValues) {
    const entry = toBundleCheckpoint(raw)
    const threadId = readString(entry.threadId, 'checkpoint.threadId')
    if (threadId !== envelope.runId) fail('E_BUNDLE_INVALID', '检查点线程不一致')
    const checkpointNs = typeof entry.checkpointNs === 'string' ? entry.checkpointNs : ''
    const checkpointId = readString(entry.checkpointId, 'checkpoint.checkpointId')
    const tupleKey = `${checkpointNs}\u0000${checkpointId}`
    if (seenTuples.has(tupleKey)) fail('E_BUNDLE_INVALID', '检查点重复')
    seenTuples.add(tupleKey)
    const parent = entry.parentCheckpointId
    if (parent !== null && (typeof parent !== 'string' || parent === '')) {
      fail('E_BUNDLE_INVALID', '检查点父标识非法')
    }
    const checkpointType = readString(entry.checkpointType, 'checkpoint.checkpointType')
    if (checkpointType !== 'json') fail('E_BUNDLE_INVALID', '检查点序列化类型不受支持')
    const metadataType = readString(entry.metadataType, 'checkpoint.metadataType')
    if (metadataType !== 'json') fail('E_BUNDLE_INVALID', '检查点元数据类型不受支持')
    const checkpointBytes = decodeBytes(entry.checkpointBytes, 'checkpoint.checkpointBytes', budget)
    const checkpointPayload = decodeUtf8Json(checkpointBytes, 'checkpoint.payload')
    screenSerializedJson(checkpointPayload, 'checkpoint.payload')
    assertCheckpointPayload(checkpointPayload, checkpointId, 'checkpoint.payload')
    const metadataBytes = decodeBytes(entry.metadataBytes, 'checkpoint.metadataBytes', budget)
    const metadataPayload = decodeUtf8Json(metadataBytes, 'checkpoint.metadata')
    screenSerializedJson(metadataPayload, 'checkpoint.metadata')
    assertMetadataPayload(metadataPayload, 'checkpoint.metadata')

    const writes: DecodedBundleWrite[] = []
    const seenWrites = new Set<string>()
    for (const rawWrite of entry.writes) {
      if (!isPlainObject(rawWrite)) fail('E_BUNDLE_INVALID', '写入条目非法')
      const idx = assertWriteIndex(rawWrite.idx, 'write.idx')
      const taskId = readString(rawWrite.taskId, 'write.taskId')
      const writeKey = `${taskId}\u0000${idx}`
      if (seenWrites.has(writeKey)) fail('E_BUNDLE_INVALID', '写入条目重复')
      seenWrites.add(writeKey)
      const valueType = readString(rawWrite.valueType, 'write.valueType')
      if (valueType !== 'json' && valueType !== 'bytes') {
        fail('E_BUNDLE_INVALID', '写入序列化类型不受支持')
      }
      const value = decodeBytes(rawWrite.valueBytes, 'write.valueBytes', budget)
      if (valueType === 'json') {
        screenSerializedJson(decodeUtf8Json(value, 'write.value'), 'write.value')
      }
      writes.push({
        taskId,
        idx,
        taskPath: typeof rawWrite.taskPath === 'string' ? rawWrite.taskPath : '',
        channel: readString(rawWrite.channel, 'write.channel'),
        valueType,
        value,
      })
    }
    checkpoints.push({
      threadId,
      checkpointNs,
      checkpointId,
      parentCheckpointId: parent ?? null,
      checkpointType,
      checkpoint: checkpointBytes,
      metadataType,
      metadata: metadataBytes,
      writes,
    })
  }
  const tupleKeys = new Set(checkpoints.map((checkpoint) => `${checkpoint.checkpointNs}\u0000${checkpoint.checkpointId}`))
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.parentCheckpointId !== null &&
      !tupleKeys.has(`${checkpoint.checkpointNs}\u0000${checkpoint.parentCheckpointId}`)
    ) {
      fail('E_BUNDLE_INVALID', '检查点父引用缺失')
    }
  }
  return {
    workspaceId: current.workspaceId,
    stepId: current.stepId,
    runId: current.runId,
    graphId: current.graphId,
    graphVersion: current.graphVersion,
    revision,
    current,
    checkpoints,
  }
}
