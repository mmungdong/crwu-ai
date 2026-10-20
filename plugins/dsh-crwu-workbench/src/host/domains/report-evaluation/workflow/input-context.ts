/**
 * Canonical initial-input snapshot helpers (host-neutral, no IO, no AI host).
 *
 * The snapshot is the immutable record of the entry choices first submitted for a
 * run. These helpers clone it for independent projection, validate an admitted JSON
 * shape (durable restore) and derive the known subset for a legacy fresh start.
 * Unknown optional choices stay `null` and never imply an automatic selection.
 */
import type {
  ValuationWorkflowInitialInput,
  ValuationWorkflowInitialInputFile,
} from '../../../../shared/contracts/valuation-workflow.ts'
import { isAbsoluteLocalPath } from '../../../../shared/utils/local-path.ts'
import { text } from '../../../../shared/utils/value.ts'

const INITIAL_INPUT_KEYS = [
  'userInput', 'assetType', 'methodRequest', 'purpose', 'baseDate', 'valueType',
  'templateFileId', 'supplementalPrompt', 'inputDigest', 'files',
] as const

const FILE_KEYS = ['fileId', 'fileName', 'relativePath', 'digest'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

/** A nullable scalar must be a string or `null`; anything else is malformed. */
function nullableText(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  return { ok: true, value }
}

/**
 * An archived identity is case-relative only: no absolute path, drive letter, UNC
 * target or `..` segment may appear.
 */
export function safeArchivedRelativePath(value: string): boolean {
  const raw = text(value)
  if (raw.trim() === '' || raw.includes('\u0000')) return false
  if (isAbsoluteLocalPath(raw)) return false
  if (/^[A-Za-z]:/.test(raw)) return false
  return !raw.split(/[\\/]+/).includes('..')
}

export type InitialInputValidation =
  | { ok: true; value: ValuationWorkflowInitialInput }
  | { ok: false; error: string }

/** Validate one admitted JSON snapshot; unknown keys, wrong types and unsafe paths fail. */
export function validateInitialInput(value: unknown): InitialInputValidation {
  if (!isRecord(value)) return { ok: false, error: '初始输入快照必须是对象' }
  if (!hasExactKeys(value, INITIAL_INPUT_KEYS)) {
    return { ok: false, error: '初始输入快照字段不完整或包含未知字段' }
  }
  if (typeof value.userInput !== 'string' || typeof value.supplementalPrompt !== 'string') {
    return { ok: false, error: '初始输入快照的文本字段无效' }
  }
  const assetType = nullableText(value.assetType)
  const methodRequest = nullableText(value.methodRequest)
  const purpose = nullableText(value.purpose)
  const baseDate = nullableText(value.baseDate)
  const valueType = nullableText(value.valueType)
  const templateFileId = nullableText(value.templateFileId)
  const inputDigest = nullableText(value.inputDigest)
  if (!assetType.ok || !methodRequest.ok || !purpose.ok || !baseDate.ok
    || !valueType.ok || !templateFileId.ok || !inputDigest.ok) {
    return { ok: false, error: '初始输入快照包含无效的可选字段' }
  }
  if (!Array.isArray(value.files)) return { ok: false, error: '初始输入快照的文件清单无效' }
  const files: ValuationWorkflowInitialInputFile[] = []
  for (const raw of value.files) {
    if (!isRecord(raw) || !hasExactKeys(raw, FILE_KEYS)) {
      return { ok: false, error: '初始输入快照包含无效的文件身份' }
    }
    if (typeof raw.fileId !== 'string' || typeof raw.fileName !== 'string'
      || typeof raw.digest !== 'string' || typeof raw.relativePath !== 'string') {
      return { ok: false, error: '初始输入快照包含无效的文件身份' }
    }
    const relativePath = text(raw.relativePath)
    if (!safeArchivedRelativePath(relativePath)) {
      return { ok: false, error: '初始输入快照包含不安全的归档相对路径' }
    }
    files.push({ fileId: raw.fileId, fileName: raw.fileName, relativePath, digest: raw.digest })
  }
  return {
    ok: true,
    value: {
      userInput: value.userInput,
      assetType: assetType.value,
      methodRequest: methodRequest.value,
      purpose: purpose.value,
      baseDate: baseDate.value,
      valueType: valueType.value,
      templateFileId: templateFileId.value,
      supplementalPrompt: value.supplementalPrompt,
      inputDigest: inputDigest.value,
      files,
    },
  }
}

/** Independent deep clone; `null`/`undefined` stay `null` (unknown, never inferred). */
export function cloneInitialInput(
  value: ValuationWorkflowInitialInput | null | undefined,
): ValuationWorkflowInitialInput | null {
  if (value === null || value === undefined) return null
  return {
    userInput: value.userInput,
    assetType: value.assetType,
    methodRequest: value.methodRequest,
    purpose: value.purpose,
    baseDate: value.baseDate,
    valueType: value.valueType,
    templateFileId: value.templateFileId,
    supplementalPrompt: value.supplementalPrompt,
    inputDigest: value.inputDigest,
    files: value.files.map((file) => ({ ...file })),
  }
}

/**
 * Derive the known-original subset for a fresh start that supplied no explicit
 * snapshot: only the start input's own userInput/purpose/baseDate are known; every
 * unconfirmed choice stays `null` and files stay empty.
 */
export function deriveInitialInput(input: {
  userInput?: unknown
  purpose?: unknown
  baseDate?: unknown
}): ValuationWorkflowInitialInput {
  const purpose = input.purpose === null || input.purpose === undefined ? '' : text(input.purpose)
  const baseDate = input.baseDate === null || input.baseDate === undefined ? '' : text(input.baseDate)
  return {
    userInput: text(input.userInput),
    assetType: null,
    methodRequest: null,
    purpose: purpose === '' ? null : purpose,
    baseDate: baseDate === '' ? null : baseDate,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '',
    inputDigest: null,
    files: [],
  }
}
