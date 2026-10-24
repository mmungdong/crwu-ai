/**
 * Protected-root verification for the valuation workflow Host.
 *
 * A prepared task is only admitted when the on-disk protected project record, the
 * frozen `估值输入.json`, every archived material byte and the actual parent session
 * placement all agree with the Host-derived project identity. Nothing here trusts a
 * caller-supplied path: the case directory is always `<selected workspace>/<projectId>`.
 * The frozen input is re-derived from the parsed record content, so a changed body with
 * a stale digest label is refused.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { samePathText } from '../../../domains/report-audit/scope.ts'
import { sha256OfBytes } from '../../../domains/report-evaluation/intake/manifest.ts'
import {
  PROJECT_RECORD_FILE,
  PROJECT_RECORD_SCHEMA_VERSION,
  materialOfEntry,
  projectRecordOf,
} from '../../../domains/report-evaluation/lifecycle/project-record.ts'
import type { ProjectRecordFileEntry } from '../../../domains/report-evaluation/lifecycle/project-record.ts'
import { valuationInputDigest } from '../../../domains/report-evaluation/intake/preview.ts'
import { isSafeIdSegment } from '../../../domains/report-evaluation/project/contracts.ts'
import { WORKBENCH_PROTOCOL } from '../../../../shared/consts.ts'
import {
  VALUATION_INPUT_SCHEMA_VERSION,
  type AssetType,
  type MethodRequest,
} from '../../../../shared/contracts/valuation-project.ts'
import type { ValuationWorkflowRunDTO } from '../../../domains/report-evaluation/workflow/persistence.ts'
import type { WorkflowFrozenInput } from './types.ts'

export const WORKFLOW_FROZEN_FILE = '估值输入.json'

/** Frozen input identity expected by the Host from a DTO or an exported task. */
export interface ProtectedProjectOptions {
  workspacePath: string
  workspaceId: string
  projectId: string
  parentSessionId: string
  frozen: WorkflowFrozenInput
  /** Extra evidenced files from a saved DTO or calculation receipt; each is contained and byte-checked. */
  extraFiles?: readonly { relativePath: string; digest: string; sizeBytes?: number }[]
}

export interface ProtectedProjectResult {
  ok: boolean
  error: string
  casePath: string
  rootReal: string
}

interface FrozenFacts {
  assetType: string
  methodRequest: string
  baseDate: string | null
  purpose: string | null
  valueType: string | null
  templateFileId: string | null
  supplementalPrompt: string
}

interface FileIdentity {
  fileId: string
  fileName: string
  archiveRelativePath: string
  kind: string
  sizeBytes: number
  sha256: string
  duplicateOf: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function codeOf(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

function normalizeDigest(value: string): string {
  const raw = text(value).trim().toLowerCase()
  if (raw === '') return ''
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = text(value)
  return raw === '' ? null : raw
}

function resolvedInside(rootReal: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(rootReal), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function safeRelative(relativePath: string): boolean {
  if (relativePath === '' || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return false
  return !relativePath.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
}

function factsOf(value: Record<string, unknown>): FrozenFacts {
  return {
    assetType: text(value.assetType),
    methodRequest: text(value.methodRequest),
    baseDate: optionalText(value.baseDate),
    purpose: optionalText(value.purpose),
    valueType: optionalText(value.valueType),
    templateFileId: optionalText(value.templateFileId),
    supplementalPrompt: text(value.supplementalPrompt),
  }
}

function sameFacts(left: FrozenFacts, right: FrozenFacts): boolean {
  return left.assetType === right.assetType
    && left.methodRequest === right.methodRequest
    && left.baseDate === right.baseDate
    && left.purpose === right.purpose
    && left.valueType === right.valueType
    && left.templateFileId === right.templateFileId
    && left.supplementalPrompt === right.supplementalPrompt
}

function fileIdentities(value: unknown): FileIdentity[] {
  if (!Array.isArray(value)) return []
  const entries: FileIdentity[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const size = item.sizeBytes
    entries.push({
      fileId: text(item.fileId),
      fileName: text(item.fileName),
      archiveRelativePath: text(item.archiveRelativePath),
      kind: text(item.kind),
      sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : -1,
      sha256: normalizeDigest(text(item.sha256)),
      duplicateOf: optionalText(item.duplicateOf),
    })
  }
  return entries
}

function sameFiles(left: readonly FileIdentity[], right: readonly FileIdentity[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.fileId !== b.fileId || a.fileName !== b.fileName
      || a.archiveRelativePath !== b.archiveRelativePath || a.kind !== b.kind
      || a.sizeBytes !== b.sizeBytes || a.sha256 !== b.sha256 || a.duplicateOf !== b.duplicateOf) {
      return false
    }
  }
  return true
}

function asEntry(entry: FileIdentity): ProjectRecordFileEntry {
  return {
    fileId: entry.fileId,
    fileName: entry.fileName,
    archiveRelativePath: entry.archiveRelativePath,
    kind: entry.kind,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    duplicateOf: entry.duplicateOf,
  }
}

function fail(error: string, casePath = ''): ProtectedProjectResult {
  return { ok: false, error, casePath, rootReal: '' }
}

/**
 * Verify the protected record, frozen input and every archived byte for one task.
 *
 * The caller must already have verified the parent session placement; this function
 * only answers "is this project directory the exact frozen task the Host prepared".
 */
export async function verifyProtectedProject(
  options: ProtectedProjectOptions,
): Promise<ProtectedProjectResult> {
  const projectId = text(options.projectId)
  if (!isSafeIdSegment(projectId)) return fail('项目标识不是安全的单段目录名')
  const frozen = options.frozen
  if (frozen === null || frozen === undefined) return fail('缺少冻结输入：不能确认这一轮的项目身份')
  if (text(frozen.projectId) !== projectId) return fail('冻结输入的项目归属不一致')
  const claimedDigest = normalizeDigest(text(frozen.inputDigest))
  if (claimedDigest === '') return fail('冻结输入缺少摘要')
  if (text(frozen.schemaVersion) !== '' && text(frozen.schemaVersion) !== VALUATION_INPUT_SCHEMA_VERSION) {
    return fail('冻结输入的 Schema 版本不受支持')
  }

  const workspacePath = text(options.workspacePath)
  let workspaceReal: string
  try {
    workspaceReal = await realpath(workspacePath)
  } catch {
    return fail('选定工作区不可解析')
  }
  const casePath = joinLocalPath(workspacePath, projectId)
  // The real case root must stay inside the real selected workspace before anything is read.
  let rootReal: string
  try {
    rootReal = await realpath(casePath)
  } catch (error) {
    return fail(codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'
      ? '案例目录不存在'
      : '案例目录不可解析', casePath)
  }
  if (!resolvedInside(workspaceReal, rootReal)) return fail('案例目录越出选定的工作区', casePath)

  const recordRaw = await readFile(joinLocalPath(casePath, PROJECT_RECORD_FILE), 'utf8')
    .catch(() => null)
  if (recordRaw === null) return fail('受保护的项目记录读不回来', casePath)
  let recordValue: unknown
  try {
    recordValue = JSON.parse(recordRaw) as unknown
  } catch {
    return fail('受保护的项目记录无法解析', casePath)
  }
  const parsedRead = projectRecordOf(recordValue)
  if (!parsedRead.ok) return fail(parsedRead.error, casePath)
  const record = parsedRead.record
  if (record.schemaVersion !== PROJECT_RECORD_SCHEMA_VERSION) return fail('项目记录的 Schema 版本不受支持', casePath)
  // Current protocol plus the exact prior graph generations whose input schema and
  // identity checks are unchanged. Reads never rewrite the protected record.
  const READABLE_PROTOCOLS = new Set([WORKBENCH_PROTOCOL, 43, 44, 45, 46, 47, 48, 49])
  if (!READABLE_PROTOCOLS.has(record.protocolVersion)) return fail('项目记录的协议代不匹配', casePath)
  if (record.inputSchemaVersion !== VALUATION_INPUT_SCHEMA_VERSION) return fail('项目记录的输入 Schema 不匹配', casePath)
  if (record.projectId !== projectId) return fail('项目记录的项目归属不一致', casePath)
  if (record.sessionId !== text(options.parentSessionId)) return fail('项目记录绑定的父会话不一致', casePath)
  if (record.workspaceId !== text(options.workspaceId)) return fail('项目记录的工作区归属不一致', casePath)
  if (!samePathText(record.casePath, casePath)) return fail('项目记录的案例目录不一致', casePath)

  const frozenRaw = await readFile(joinLocalPath(casePath, WORKFLOW_FROZEN_FILE), 'utf8')
    .catch(() => null)
  if (frozenRaw === null) return fail('冻结输入文件读不回来', casePath)
  let storedValue: unknown
  try {
    storedValue = JSON.parse(frozenRaw) as unknown
  } catch {
    return fail('冻结输入文件无法解析', casePath)
  }
  if (!isRecord(storedValue)) return fail('冻结输入文件不是对象', casePath)
  if (text(storedValue.projectId) !== projectId) return fail('冻结输入文件的归属不一致', casePath)
  if (text(storedValue.schemaVersion) !== VALUATION_INPUT_SCHEMA_VERSION) {
    return fail('冻结输入文件的 Schema 版本不受支持', casePath)
  }

  // Every frozen choice fact and ordered file identity must agree across the passed
  // frozen input, the on-disk frozen file and the parsed protected record.
  const passedFacts = factsOf(frozen as unknown as Record<string, unknown>)
  const storedFacts = factsOf(storedValue)
  const recordFacts = factsOf(record as unknown as Record<string, unknown>)
  if (!sameFacts(passedFacts, storedFacts) || !sameFacts(passedFacts, recordFacts)) {
    return fail('冻结输入的选择事实在项目记录与文件之间不一致', casePath)
  }
  const passedFiles = fileIdentities(frozen.files)
  const storedFiles = fileIdentities(storedValue.files)
  const recordFiles = fileIdentities(record.files)
  if (!sameFiles(passedFiles, storedFiles) || !sameFiles(passedFiles, recordFiles)) {
    return fail('冻结输入的材料身份在项目记录与文件之间不一致', casePath)
  }

  // Recompute the actual input digest from the parsed record content and again from the
  // on-disk frozen file; a changed body that keeps the old label must refuse.
  const recordDigest = valuationInputDigest({
    assetType: record.assetType,
    methodRequest: record.methodRequest,
    baseDate: record.baseDate,
    purpose: record.purpose,
    valueType: record.valueType,
    templateFileId: record.templateFileId,
    supplementalPrompt: record.supplementalPrompt,
    files: record.files.map(materialOfEntry),
  })
  if (normalizeDigest(recordDigest) !== claimedDigest) {
    return fail('项目记录的输入内容与其摘要不一致：文件被改过', casePath)
  }
  const storedDigest = valuationInputDigest({
    assetType: text(storedValue.assetType) as AssetType,
    methodRequest: text(storedValue.methodRequest) as MethodRequest,
    baseDate: storedFacts.baseDate,
    purpose: storedFacts.purpose,
    valueType: storedFacts.valueType,
    templateFileId: storedFacts.templateFileId,
    supplementalPrompt: storedFacts.supplementalPrompt,
    files: storedFiles.map(asEntry).map(materialOfEntry),
  })
  if (normalizeDigest(storedDigest) !== claimedDigest || normalizeDigest(text(storedValue.inputDigest)) !== claimedDigest) {
    return fail('冻结输入文件的内容与其摘要不一致：文件被改过', casePath)
  }
  if (normalizeDigest(record.inputDigest) !== claimedDigest) {
    return fail('项目记录的输入摘要与冻结输入不一致', casePath)
  }

  for (const file of passedFiles) {
    const relativePath = file.archiveRelativePath
    if (!safeRelative(relativePath)) return fail('冻结材料的归档路径不安全', casePath)
    if (file.sha256 === '') return fail('冻结材料缺少摘要', casePath)
    const problem = await readContained(rootReal, casePath, relativePath, file.sha256, file.sizeBytes)
    if (problem !== '') return fail(problem, casePath)
  }

  for (const extra of options.extraFiles ?? []) {
    const relativePath = text(extra.relativePath)
    if (!safeRelative(relativePath)) return fail('证据文件路径不安全', casePath)
    const expected = normalizeDigest(text(extra.digest))
    if (expected === '') return fail('证据文件缺少摘要', casePath)
    const problem = await readContained(
      rootReal,
      casePath,
      relativePath,
      expected,
      typeof extra.sizeBytes === 'number' ? extra.sizeBytes : undefined,
    )
    if (problem !== '') return fail(problem, casePath)
  }

  return { ok: true, error: '', casePath, rootReal }
}

/** Read one archived file and prove containment, size and digest; `''` means success. */
async function readContained(
  rootReal: string,
  casePath: string,
  relativePath: string,
  expectedDigest: string,
  expectedSize?: number,
): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(joinLocalPath(casePath, relativePath))
  } catch (error) {
    return codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'
      ? '归档文件已经不在案例目录里'
      : '归档文件不可读取'
  }
  if (!resolvedInside(rootReal, resolved)) return '归档文件越出案例目录'
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    return '归档文件不可读取'
  }
  if (!info.isFile()) return '归档文件不是普通文件'
  if (expectedSize !== undefined && info.size !== expectedSize) return '归档文件的实际字节数与记录不一致'
  let bytes: Buffer
  try {
    bytes = await readFile(resolved)
  } catch {
    return '归档文件不可读取'
  }
  return sha256OfBytes(bytes) === expectedDigest ? '' : '归档文件的实际摘要与记录不一致'
}

/** The known case-relative plan prefix (`方案/<planId>/`) derived from the approved template path. */
function planPrefixOf(templateRelativePath: string): string {
  const raw = text(templateRelativePath).replace(/\\/g, '/')
  if (raw === '') return ''
  const segments = raw.split('/').filter((segment) => segment !== '')
  if (segments.length >= 2 && segments[0] === '方案') return `方案/${segments[1]}/`
  return ''
}

/** Prefix a plan-root-relative capture, preserving an already case-relative identity. */
function planRelative(path: unknown, prefix: string): string {
  const raw = text(path).replace(/\\/g, '/')
  if (raw === '') return ''
  if (raw.startsWith('方案/')) return raw
  return prefix === '' ? raw : `${prefix}${raw.replace(/^\.\//, '')}`
}

/**
 * Evidence files a saved DTO already names; used to re-prove they still exist on load.
 *
 * Verified plan-template identity is included, plan-relative captures are rebased onto
 * the known `方案/<planId>/` prefix, already case-relative identities are preserved, and
 * exact duplicates are dropped. No blank-digest placeholder is ever returned.
 */
export function evidenceFilesOf(
  dto: ValuationWorkflowRunDTO | null,
): Array<{ relativePath: string; digest: string; sizeBytes?: number }> {
  if (dto === null) return []
  const template = dto.plan?.template
  const prefix = planPrefixOf(text(template?.relativePath))
  const found = new Map<string, { relativePath: string; digest: string; sizeBytes?: number }>()
  const add = (relativePath: unknown, digest: unknown, sizeBytes?: unknown): void => {
    const path = planRelative(relativePath, prefix)
    const sha = normalizeDigest(text(digest))
    if (path === '' || sha === '') return
    const bytes = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : undefined
    const key = `${path}\u0000${sha}\u0000${bytes === undefined ? '' : String(bytes)}`
    if (!found.has(key)) {
      found.set(key, bytes === undefined ? { relativePath: path, digest: sha } : { relativePath: path, digest: sha, sizeBytes: bytes })
    }
  }
  if (dto.templateMarket) {
    const market = dto.templateMarket
    if (market.plan) add(market.plan.template.relativePath, market.plan.template.digest)
    for (const artifact of market.artifacts) add(artifact.relativePath, artifact.digest, artifact.bytes)
    for (const candidate of market.candidates) for (const source of candidate.sourceRefs) add(source.location, source.digest)
  }
  if (template !== undefined) add(template.relativePath, template.digest)
  for (const sample of [...(dto.observedSamples ?? []), ...(dto.evidencePool?.samples ?? [])]) {
    add(sample.evidence, sample.digest, sample.bytes)
    add(sample.screenshot, sample.screenshotDigest)
  }
  for (const source of dto.plan?.sources ?? []) {
    const fields = isRecord(source.fields) ? source.fields : null
    const observed = fields !== null && isRecord(fields.observed) ? fields.observed : null
    const capture = observed !== null && isRecord(observed.capture) ? observed.capture : null
    if (capture === null) continue
    add(capture.file, capture.digest, capture.bytes)
    add(capture.screenshot, capture.screenshotDigest)
  }
  return [...found.values()]
}
