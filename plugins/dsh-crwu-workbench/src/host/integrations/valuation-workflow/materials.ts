/**
 * Real material preparation for the embedded valuation workflow.
 *
 * The only input is the frozen file manifest of the live registered valuation
 * scope. Paths, sizes and digests are re-verified against the case directory
 * before any parser runs, and again after each parse, so content changed under a
 * stale digest can never be published. The actual document parser is the same
 * packaged-Python extractor the registered value tools use.
 */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat as statPath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, isAbsoluteLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { PythonRuntimeResolver, PythonRuntimeView } from '../../core/runtime/python.ts'
import type { ValuationScopeService } from '../../domains/report-evaluation/scope.ts'
import { extensionOf, kindOf, type ValuationFileKind } from '../../domains/report-evaluation/intake/classify.ts'
import {
  EXTRACT_OUTPUT_DIR,
  EXTRACT_SCRIPT_DIR,
  ExtractionFailure,
  type ExtractionFailureScope,
  type ExtractionFailureState,
  pythonFileExtractor,
} from '../../domains/report-evaluation/intake/python-extractor.ts'
import type {
  ExtractedFile,
  ExtractedPageFact,
  ExtractedTable,
  ExtractionCapabilities,
  FileExtractor,
} from '../../domains/report-evaluation/intake/types.ts'
import { ensureDirectory } from '../../tools/common/case-files.ts'
import { callerSession } from '../../tools/common/types.ts'
import type { WorkflowPdfRenderer } from './native-pdf.ts'
import { requireBoundValuationActor } from './services/access.ts'
import type { WorkflowVisualReadResult, WorkflowVisualReading, WorkflowVisualReader } from './visual.ts'

export interface WorkflowMaterialsDeps {
  ctx: Context
  access: LocalAccessBroker
  world: { platform: () => Promise<string> }
  python?: PythonRuntimeResolver
  valuationScopes?: ValuationScopeService
  /** Optional scanned-page reader; absent keeps native text-layer behavior only. */
  visualReader?: WorkflowVisualReader
  /**
   * Optional native PDF page renderer. Absent keeps Python-only behavior; when
   * present it supplies page images for PDFs the Python reader cannot rasterize.
   */
  pdfRenderer?: WorkflowPdfRenderer
}

/** Frozen identity plus what was actually read from those exact bytes. */
export interface WorkflowPreparedMaterial {
  materialId: string
  fileName: string
  relativePath: string
  digest: string
  sizeBytes: number
  fileType: ValuationFileKind
  text: string
  tables: ExtractedTable[]
  images: Array<{ path: string; description?: string }>
  extractedFields: Record<string, string>
  pages?: ExtractedPageFact[]
  pageCount?: number
  pagesWithText?: number
  pagesWithoutText?: number
  capabilities?: ExtractionCapabilities
  capabilityProbe?: Record<string, string>
  warnings: string[]
  capabilityGaps: string[]
  /** Actual visual coverage; never rewrites the native text-layer facts in `pages`. */
  visualReading?: WorkflowVisualReading
}

/** A frozen identity that could not be published, with the employee action. */
export interface WorkflowUnverifiedMaterial {
  materialId: string
  fileName: string
  relativePath: string
  digest: string
  reason: string
  nextAction: string
}

/** Structured, controlled environment facts for the workflow consumer. */
export type WorkflowEnvironmentState = 'missing' | 'execution-failed' | 'probe-failed'

export interface WorkflowEnvironmentDetail {
  component: 'python-runtime' | 'material-staging' | 'material-parser'
  state: WorkflowEnvironmentState
  reason: string
  nextAction: string
  /** Safe resolver state (capability-gap / missing-package / failed / …), never raw error text. */
  runtimeState?: string
}

export interface WorkflowMaterialsResult {
  ok: boolean
  errorKind: string
  error: string
  materials: WorkflowPreparedMaterial[]
  unverified: WorkflowUnverifiedMaterial[]
  environment?: WorkflowEnvironmentDetail
  /** Present only when a visual child's stop state is unknown and must be reconciled by the host. */
  stopUnknown?: { sessionIds: string[] }
}

interface FrozenFile {
  fileName: string
  relativePath: string
  kind: string
  sizeBytes: number
  sha256: string
}

interface PlannedFile {
  frozen: FrozenFile
  relativePath: string
  absolute: string
}

interface VerifiedFile {
  ok: true
}

interface VerifyFailure {
  ok: false
  errorKind: string
  error: string
}

const ACTION_REUPLOAD = '请确认该文件能正常打开；必要时另存为 PDF/DOCX 后重新提交本轮资料'
const ACTION_ENVIRONMENT = '请把结构化失败交给管理员检查案例目录权限、DSH Python 与插件包后重试，不要重复逐份重试同一批资料'
const ACTION_CANCELLED = '请重新发起本轮资料准备'
const ACTION_INPUT_CHANGED = '请重新确认并冻结本轮资料后再执行，不要沿用旧快照'
const ACTION_INPUT = '请修正资料清单后重新发起本轮资料准备'
const ACTION_POLICY = '请重新确认本轮估值与资料归属后重试，不要手工替换案例目录中的文件'
const ACTION_RECONCILE = '请交由宿主核对仍在运行的视觉子会话并确认其停止后，再重新发起本轮资料准备；不要重复提交同一批资料'

function actionFor(kind: string): string {
  switch (kind) {
    case 'input-changed': return ACTION_INPUT_CHANGED
    case 'environment': return ACTION_ENVIRONMENT
    case 'cancelled': return ACTION_CANCELLED
    case 'policy': return ACTION_POLICY
    default: return ACTION_INPUT
  }
}

function idleResult(): WorkflowMaterialsResult {
  return { ok: false, errorKind: '', error: '', materials: [], unverified: [] }
}

function safeRuntimeState(value: unknown): string | undefined {
  return value === 'capability-gap' || value === 'missing-package' || value === 'failed' || value === 'ok'
    ? value
    : undefined
}

function environmentDetail(
  component: WorkflowEnvironmentDetail['component'],
  state: WorkflowEnvironmentState,
  reason: string,
  runtimeState?: string,
): WorkflowEnvironmentDetail {
  const safeState = safeRuntimeState(runtimeState)
  return {
    component,
    state,
    reason,
    nextAction: ACTION_ENVIRONMENT,
    ...(safeState === undefined ? {} : { runtimeState: safeState }),
  }
}

function pythonEnvironmentDetail(
  probe: PythonRuntimeView | undefined,
  probeThrew: boolean,
): WorkflowEnvironmentDetail {
  if (probeThrew) {
    return environmentDetail('python-runtime', 'probe-failed', 'DSH 自带 Python 运行时探测失败')
  }
  if (probe === undefined) {
    return environmentDetail('python-runtime', 'missing', 'DSH 自带 Python 运行时未装配')
  }
  if (probe.unresolved === true) {
    return environmentDetail('python-runtime', 'probe-failed', '未能确认 DSH 自带 Python 运行时的状态', probe.state)
  }
  if (probe.blockedBySandbox === true) {
    return environmentDetail('python-runtime', 'execution-failed', '受限沙箱阻止了 DSH 自带 Python 运行时启动', probe.state)
  }
  if (probe.state === 'capability-gap') {
    return environmentDetail('python-runtime', 'missing', 'DSH 自带 Python 运行时不可用', probe.state)
  }
  if (probe.state === 'missing-package') {
    return environmentDetail('python-runtime', 'execution-failed', 'DSH 自带 Python 运行时缺少必需包', probe.state)
  }
  if (probe.state === 'failed') {
    return environmentDetail('python-runtime', 'execution-failed', 'DSH 自带 Python 运行时执行失败', probe.state)
  }
  return environmentDetail('python-runtime', 'execution-failed', 'DSH 自带 Python 运行时不可用', probe.state)
}

/** Only classified material errors may carry text; infrastructure text is never echoed. */
function materialReasonOf(error: unknown): string {
  if (error instanceof ExtractionFailure && error.kind === 'material') {
    const message = error.message.trim()
    if (message !== '') return message
  }
  return '这份资料读取失败（格式或内容不受支持）'
}

function codeOf(error: unknown): string {
  return error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
}

interface FailureFacts {
  kind: 'environment' | 'material' | 'unknown'
  scope?: ExtractionFailureScope
  format?: string
  state?: ExtractionFailureState
}

function normalizeFormat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().toLowerCase()
  if (raw === '') return undefined
  return raw.startsWith('.') ? raw : `.${raw}`
}

function failureFactsOf(error: unknown): FailureFacts {
  const record = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
  const kind: FailureFacts['kind'] = record.kind === 'environment'
    ? 'environment'
    : record.kind === 'material' ? 'material' : 'unknown'
  const scope: ExtractionFailureScope | undefined = record.scope === 'format'
    ? 'format'
    : record.scope === 'global' ? 'global' : undefined
  const format = normalizeFormat(record.format)
  const state: ExtractionFailureState | undefined = record.state === 'missing'
    ? 'missing'
    : record.state === 'execution-failed'
      ? 'execution-failed'
      : record.state === 'probe-failed' ? 'probe-failed' : undefined
  return {
    kind,
    ...(scope === undefined ? {} : { scope }),
    ...(format === undefined ? {} : { format }),
    ...(state === undefined ? {} : { state }),
  }
}

function formatGapReason(format: string, state: ExtractionFailureState): string {
  if (state === 'missing') return `当前部署没有可用的 ${format} 读取能力`
  if (state === 'probe-failed') return `无法确认 ${format} 读取能力是否可用`
  return `${format} 读取组件执行失败`
}

function formatGapAction(format: string): string {
  return `请让管理员补齐 ${format} 读取能力，或把该格式资料另存为可读格式后重新提交`
}

function materialIdOf(file: FrozenFile): string {
  const identity = `${text(file.relativePath)}\u0000${text(file.sha256).toLowerCase()}`
  return `material-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
}

function fileNameOf(file: FrozenFile): string {
  return text(file.fileName) || basenameLocalPath(text(file.relativePath))
}

function unverifiedOf(file: FrozenFile, reason: string, nextAction: string): WorkflowUnverifiedMaterial {
  return {
    materialId: materialIdOf(file),
    fileName: fileNameOf(file),
    relativePath: text(file.relativePath),
    digest: text(file.sha256),
    reason: reason.trim() || '这份资料未能读取',
    nextAction,
  }
}

function unverifiedAll(
  files: ReadonlyArray<FrozenFile>,
  reason: string,
  nextAction: string,
): WorkflowUnverifiedMaterial[] {
  return files.map((file) => unverifiedOf(file, reason, nextAction))
}

function failureResult(
  kind: string,
  error: string,
  files: ReadonlyArray<FrozenFile>,
  nextAction: string,
  environment?: WorkflowEnvironmentDetail,
): WorkflowMaterialsResult {
  const detail = environment ?? (kind === 'environment'
    ? environmentDetail('material-staging', 'execution-failed', error)
    : undefined)
  return {
    ok: false,
    errorKind: kind,
    error,
    materials: [],
    unverified: unverifiedAll(files, error, nextAction),
    ...(detail === undefined ? {} : { environment: detail }),
  }
}

function validRelativePath(value: string): boolean {
  if (value === '' || value.includes('\u0000')) return false
  if (isAbsoluteLocalPath(value)) return false
  return !value.split(/[\\/]+/).includes('..')
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function resolvedInside(caseRootReal: string, target: string): boolean {
  const fold = process.platform === 'win32' ? (value: string): string => value.toLowerCase() : (value: string): string => value
  const rel = relative(fold(caseRootReal), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function digestMatches(expected: unknown, actual: string): boolean {
  const raw = text(expected).trim().toLowerCase()
  if (raw === '') return false
  return (raw.startsWith('sha256:') ? raw : `sha256:${raw}`) === actual
}

async function verifyFrozenFile(caseRootReal: string, entry: PlannedFile): Promise<VerifiedFile | VerifyFailure> {
  let resolved: string
  try {
    resolved = await realpath(entry.absolute)
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, errorKind: 'not-found', error: `案例目录里找不到冻结清单登记的这份资料：${entry.relativePath}` }
    }
    return { ok: false, errorKind: 'environment', error: `资料路径不可解析：${entry.relativePath}` }
  }
  if (!resolvedInside(caseRootReal, resolved)) {
    return { ok: false, errorKind: 'policy', error: `资料路径经符号链接逃出了本轮估值案例目录：${entry.relativePath}` }
  }
  let info
  try {
    info = await statPath(resolved)
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, errorKind: 'input-changed', error: `资料在读取前消失了：${entry.relativePath}` }
    }
    return { ok: false, errorKind: 'environment', error: `资料状态不可读取：${entry.relativePath}` }
  }
  if (!info.isFile()) {
    return { ok: false, errorKind: 'not-found', error: `登记的资料不是普通文件：${entry.relativePath}` }
  }
  if (info.size !== entry.frozen.sizeBytes) {
    return { ok: false, errorKind: 'input-changed', error: `资料字节数与冻结清单不一致：${entry.relativePath}` }
  }
  let bytes: Buffer
  try {
    bytes = await readFile(resolved)
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, errorKind: 'input-changed', error: `资料在读取途中消失了：${entry.relativePath}` }
    }
    return { ok: false, errorKind: 'environment', error: `资料字节不可读取：${entry.relativePath}` }
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (!digestMatches(entry.frozen.sha256, digest)) {
    return { ok: false, errorKind: 'input-changed', error: `资料内容摘要与冻结清单不一致：${entry.relativePath}` }
  }
  return { ok: true }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function internalFileName(index: number, fileName: string): string {
  return `wf-${index + 1}-${basenameLocalPath(fileName) || 'file'}`
}

/** Structured outcome of one native page-render fallback for a frozen PDF. */
type NativePdfFallback =
  | { kind: 'rendered'; extracted: ExtractedFile }
  | { kind: 'gap'; reason: string }
  | { kind: 'stop'; errorKind: string; error: string; action: string; environment?: WorkflowEnvironmentDetail }

/**
 * Render one frozen PDF through the injected native renderer.
 *
 * Only the frozen identity is submitted. Cancellation, a policy denial or a
 * changed input stops preparation immediately; a missing PDF capability is a
 * format-scoped gap the caller may fuse without touching other formats.
 */
async function renderFrozenPdf(
  renderer: WorkflowPdfRenderer,
  entry: PlannedFile,
  casePath: string,
  signal: AbortSignal | undefined,
): Promise<NativePdfFallback> {
  let outcome: Awaited<ReturnType<WorkflowPdfRenderer['render']>>
  try {
    outcome = await renderer.render({
      casePath,
      path: entry.absolute,
      fileName: fileNameOf(entry.frozen),
      digest: text(entry.frozen.sha256),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    return {
      kind: 'stop',
      errorKind: 'environment',
      error: 'PDF 原生页面渲染执行失败：详情已省略',
      action: ACTION_ENVIRONMENT,
      environment: environmentDetail('material-parser', 'execution-failed', 'PDF 原生页面渲染执行失败，已停止剩余资料'),
    }
  }
  if (outcome.ok) return { kind: 'rendered', extracted: outcome.extracted }
  switch (outcome.errorKind) {
    case 'cancelled':
      return { kind: 'stop', errorKind: 'cancelled', error: '本次资料准备已取消', action: ACTION_CANCELLED }
    case 'policy':
      return { kind: 'stop', errorKind: 'policy', error: outcome.error, action: ACTION_POLICY }
    case 'input':
    case 'not-found':
    case 'file':
      return { kind: 'stop', errorKind: 'input-changed', error: outcome.error, action: ACTION_INPUT_CHANGED }
    case 'capability-gap':
      return { kind: 'gap', reason: outcome.error }
    default:
      return {
        kind: 'stop',
        errorKind: 'environment',
        error: outcome.error,
        action: ACTION_ENVIRONMENT,
        environment: environmentDetail('material-parser', 'execution-failed', 'PDF 原生页面渲染组件执行失败，已停止剩余资料'),
      }
  }
}

/**
 * Add rendered page images to an existing extraction without overwriting its
 * verified text, tables or page facts. Rendering proves images exist; it never
 * proves that a native text layer is absent.
 */
function mergeRenderedPages(original: ExtractedFile, rendered: ExtractedFile): ExtractedFile {
  const capabilities = { ...(original.capabilities ?? {}), ...(rendered.capabilities ?? {}) }
  const capabilityProbe = { ...(original.capabilityProbe ?? {}), ...(rendered.capabilityProbe ?? {}) }
  const renderedCount = rendered.pageCount
  // The Python reader may record a zero count when it could not establish the
  // page facts; rendering is a real page count only when it is positive.
  const takeRenderedCount = (original.pageCount === undefined || original.pageCount <= 0)
    && typeof renderedCount === 'number'
    && Number.isFinite(renderedCount)
    && renderedCount > 0
    ? renderedCount
    : undefined
  return {
    ...original,
    images: rendered.images.map((image) => ({
      path: image.path,
      ...(image.description === undefined ? {} : { description: image.description }),
    })),
    ...(takeRenderedCount === undefined ? {} : { pageCount: takeRenderedCount }),
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    ...(Object.keys(capabilityProbe).length === 0 ? {} : { capabilityProbe }),
  }
}

function materialTextOf(extracted: ExtractedFile): string {
  const original = text(extracted.text)
  if (original.trim() !== '') return original
  if (extracted.tables.length === 0) return ''
  const blocks: string[] = []
  for (const table of extracted.tables) {
    const lines: string[] = []
    if (text(table.name) !== '') lines.push(text(table.name))
    for (const row of table.rows) lines.push(row.map((cell) => text(cell)).join('\t'))
    if (lines.length > 0) blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/** Images exist and the native text layer is incomplete, or the material itself is an image. */
function needsVisualRead(extracted: ExtractedFile, materialText: string): boolean {
  if (!Array.isArray(extracted.images) || extracted.images.length === 0) return false
  if (extracted.fileType === 'image') return true
  if ((extracted.pagesWithoutText ?? 0) > 0) return true
  if ((extracted.pages ?? []).some((page) => page.hasTextLayer === false)) return true
  return materialText.trim() === ''
}

function materialOf(
  file: FrozenFile,
  extracted: ExtractedFile,
  materialText: string,
  visualReading?: WorkflowVisualReading,
  extraGaps: readonly string[] = [],
): WorkflowPreparedMaterial {
  return {
    materialId: materialIdOf(file),
    fileName: fileNameOf(file),
    relativePath: text(file.relativePath),
    digest: text(file.sha256),
    sizeBytes: file.sizeBytes,
    fileType: extracted.fileType,
    text: materialText,
    tables: extracted.tables.map((table) => ({ name: table.name, rows: table.rows.map((row) => [...row]) })),
    images: extracted.images.map((image) => ({
      path: image.path,
      ...(image.description === undefined ? {} : { description: image.description }),
    })),
    extractedFields: { ...extracted.extractedFields },
    ...(extracted.pages === undefined ? {} : { pages: extracted.pages.map((page) => ({ ...page })) }),
    ...(extracted.pageCount === undefined ? {} : { pageCount: extracted.pageCount }),
    ...(extracted.pagesWithText === undefined ? {} : { pagesWithText: extracted.pagesWithText }),
    ...(extracted.pagesWithoutText === undefined ? {} : { pagesWithoutText: extracted.pagesWithoutText }),
    ...(extracted.capabilities === undefined ? {} : { capabilities: { ...extracted.capabilities } }),
    ...(extracted.capabilityProbe === undefined ? {} : { capabilityProbe: { ...extracted.capabilityProbe } }),
    warnings: [...extracted.warnings],
    capabilityGaps: [...extracted.capabilityGaps, ...extraGaps.filter((gap) => gap.trim() !== '')],
    ...(visualReading === undefined ? {} : { visualReading }),
  }
}

/**
 * Read the frozen live material manifest through the real parser.
 *
 * An injected extractor exists only as a test seam; production always omits it.
 */
export async function prepareWorkflowMaterials(
  deps: WorkflowMaterialsDeps,
  exec: ToolRunContext,
  extractor?: FileExtractor,
): Promise<WorkflowMaterialsResult> {
  const empty = idleResult()
  const identity = callerIdentity(exec)
  const session = callerSession(exec)
  const signal = (exec as { signal?: AbortSignal }).signal
  const agent = exec.agent

  if (agent === undefined || agent === null || typeof agent !== 'object') {
    return { ...empty, ...{ ok: false, errorKind: 'policy', error: '缺少真实的调用 Agent：拒绝读取本轮估值资料' } }
  }
  if (session === undefined) {
    return { ...empty, ...{ ok: false, errorKind: 'policy', error: '缺少真实的调用会话：拒绝读取本轮估值资料' } }
  }

  const bound = requireBoundValuationActor({
    sessionId: identity.childId,
    caseDir: '',
    source: 'workflow-runtime',
    session,
    agent,
    ...(signal === undefined ? {} : { signal }),
  }, { valuationScopes: deps.valuationScopes })
  if (!bound.ok) {
    return { ...empty, ...{ ok: false, errorKind: bound.errorKind, error: bound.error } }
  }

  const scope = deps.valuationScopes?.scopeOf(identity.childId)
  if (scope === undefined) {
    return { ...empty, ...{ ok: false, errorKind: 'policy', error: '本轮估值的案例归属已失效：拒绝读取资料' } }
  }
  const files = scope.snapshot.files
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true, errorKind: '', error: '', materials: [], unverified: [] }
  }
  if (isAborted(signal)) {
    return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
  }

  const casePath = text(scope.casePath)
  let caseRootReal: string
  try {
    caseRootReal = await realpath(casePath)
  } catch {
    return failureResult('not-found', '本轮估值的案例目录不存在：无法读取资料', files, ACTION_INPUT)
  }

  const planned: PlannedFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const relativePath = text(file.relativePath).trim()
    if (!validRelativePath(relativePath)) {
      return failureResult('input', '本轮估值冻结的资料清单包含不合法的相对路径', files, ACTION_INPUT)
    }
    let absolute: string
    try {
      absolute = joinLocalPath(casePath, relativePath)
    } catch {
      return failureResult('input', `不是一条可用的案例内路径：${relativePath}`, files, ACTION_INPUT)
    }
    const key = pathKey(absolute)
    if (seen.has(key)) {
      return failureResult('input', `本轮估值冻结的资料清单包含重复路径：${relativePath}`, files, ACTION_INPUT)
    }
    seen.add(key)
    planned.push({ frozen: file, relativePath, absolute })
  }

  const verified: PlannedFile[] = []
  for (const entry of planned) {
    const checked = await verifyFrozenFile(caseRootReal, entry)
    if (!checked.ok) {
      return failureResult(checked.errorKind, checked.error, files, actionFor(checked.errorKind))
    }
    verified.push(entry)
  }

  if (isAborted(signal)) {
    return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
  }

  const python = deps.python
  if (python === undefined) {
    const detail = pythonEnvironmentDetail(undefined, false)
    return failureResult('environment', detail.reason, files, detail.nextAction, detail)
  }
  let probe: PythonRuntimeView | undefined
  try {
    // The genuine controlled execution, not a reconstructed token: `runtime.guard`
    // compares the enclosing token, root call and agent object by identity.
    probe = await python.check({ agent, execution: exec })
  } catch {
    const detail = pythonEnvironmentDetail(undefined, true)
    return failureResult('environment', detail.reason, files, detail.nextAction, detail)
  }
  if (probe === undefined || !probe.ok) {
    const detail = pythonEnvironmentDetail(probe, false)
    return failureResult('environment', detail.reason, files, detail.nextAction, detail)
  }

  if (extractor === undefined) {
    // The packaged Python backend stages its script and output inside these two
    // case directories. Prepare them through the real Broker before it runs.
    let platform = ''
    try {
      platform = text(await deps.world.platform()).trim()
    } catch {
      platform = ''
    }
    if (platform === '') {
      const detail = environmentDetail('material-staging', 'execution-failed', '无法确认执行平台，未能准备资料目录')
      return failureResult('environment', detail.reason, files, detail.nextAction, detail)
    }
    for (const [label, directory] of [
      ['脚本', EXTRACT_SCRIPT_DIR],
      ['提取结果', EXTRACT_OUTPUT_DIR],
    ] as const) {
      if (isAborted(signal)) {
        return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
      }
      let created: Awaited<ReturnType<typeof ensureDirectory>>
      try {
        created = await ensureDirectory(deps.access, joinLocalPath(casePath, directory), {
          workdir: casePath,
          platform,
          session,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        const detail = environmentDetail('material-staging', 'execution-failed', `无法准备案例内的${label}目录`)
        return failureResult('environment', detail.reason, files, detail.nextAction, detail)
      }
      if (!created.ok || created.postcondition !== 'directory') {
        const detail = environmentDetail('material-staging', 'execution-failed', `无法确认案例内的${label}目录已就绪`)
        return failureResult('environment', detail.reason, files, detail.nextAction, detail)
      }
    }
  }

  const effective = extractor ?? pythonFileExtractor({
    ctx: deps.ctx,
    access: deps.access,
    python,
    world: deps.world,
    casePath,
    session,
    agent,
    ...(signal === undefined ? {} : { signal }),
  })

  const materials: WorkflowPreparedMaterial[] = []
  const unverified: WorkflowUnverifiedMaterial[] = []
  const brokenFormats = new Map<string, { reason: string; action: string }>()

  for (let index = 0; index < verified.length; index += 1) {
    const entry = verified[index]
    if (entry === undefined) continue
    if (isAborted(signal)) {
      return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
    }

    const fileFormat = extensionOf(entry.frozen.fileName)
    const broken = brokenFormats.get(fileFormat)
    if (broken !== undefined) {
      unverified.push(unverifiedOf(entry.frozen, broken.reason, broken.action))
      continue
    }

    let canHandle = true
    try {
      canHandle = effective.canHandle('', entry.frozen.fileName)
    } catch {
      canHandle = false
    }
    if (!canHandle) {
      unverified.push(unverifiedOf(entry.frozen, '当前没有可用的提取器', ACTION_REUPLOAD))
      continue
    }

    let extracted: ExtractedFile | undefined
    try {
      extracted = await effective.extract({
        path: entry.absolute,
        fileName: internalFileName(index, entry.frozen.fileName),
        kind: kindOf(entry.frozen.fileName),
      })
    } catch (error) {
      const facts = failureFactsOf(error)
      if (facts.kind === 'material') {
        // Even a failed parse must not silently leave changed bytes behind.
        const afterFailure = await verifyFrozenFile(caseRootReal, entry)
        if (!afterFailure.ok) {
          return failureResult(
            afterFailure.errorKind,
            afterFailure.error,
            files,
            actionFor(afterFailure.errorKind),
          )
        }
        unverified.push(unverifiedOf(
          entry.frozen,
          materialReasonOf(error),
          ACTION_REUPLOAD,
        ))
        continue
      }

      const gapFormat = facts.format
      const gapState = facts.state
      const gapStateKnown: ExtractionFailureState = gapState ?? 'execution-failed'
      const formatGap = facts.kind === 'environment'
        && facts.scope === 'format'
        && gapFormat !== undefined
        && gapState !== undefined
        && gapFormat === fileFormat
      if (formatGap) {
        // A structured missing-PDF capability may still be recoverable through
        // native page rendering. Corrupt, changed or non-PDF failures keep their
        // existing paths and are never retried here.
        if (fileFormat === '.pdf' && deps.pdfRenderer !== undefined) {
          const rendered = await renderFrozenPdf(deps.pdfRenderer, entry, casePath, signal)
          if (rendered.kind === 'stop') {
            return failureResult(rendered.errorKind, rendered.error, files, rendered.action, rendered.environment)
          }
          if (rendered.kind === 'rendered') {
            extracted = rendered.extracted
          } else {
            const reason = rendered.reason.trim() || formatGapReason(fileFormat, gapStateKnown)
            const action = formatGapAction(fileFormat)
            unverified.push(unverifiedOf(entry.frozen, reason, action))
            brokenFormats.set(fileFormat, { reason, action })
            continue
          }
        } else {
          const reason = formatGapReason(fileFormat, gapStateKnown)
          const action = formatGapAction(fileFormat)
          unverified.push(unverifiedOf(entry.frozen, reason, action))
          brokenFormats.set(fileFormat, { reason, action })
          continue
        }
      } else {
        // Global environment and unclassified systemic failures stop the batch:
        // retrying every remaining file would only repeat the same broken channel.
        const detail = facts.kind === 'environment'
          ? environmentDetail('material-parser', facts.state ?? 'execution-failed', '资料解析组件执行失败，已停止剩余资料')
          : environmentDetail('material-parser', 'execution-failed', '资料解析组件出现未归类失败，已停止剩余资料')
        return {
          ok: false,
          errorKind: 'environment',
          error: detail.reason,
          materials,
          unverified: [
            ...unverified,
            ...unverifiedAll(verified.slice(index).map((item) => item.frozen), detail.reason, detail.nextAction),
          ],
          environment: detail,
        }
      }
    }
    if (extracted === undefined) {
      unverified.push(unverifiedOf(entry.frozen, '资料解析没有产出可用结果', ACTION_REUPLOAD))
      continue
    }

    const rechecked = await verifyFrozenFile(caseRootReal, entry)
    if (!rechecked.ok) {
      return failureResult(
        rechecked.errorKind,
        rechecked.error,
        files,
        actionFor(rechecked.errorKind),
      )
    }
    if (isAborted(signal)) {
      return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
    }

    // A PDF the Python reader could not rasterize (no images plus empty text, or
    // known pages without a text layer) gets page images from native rendering.
    // The merge never overwrites verified text, tables or page facts.
    const pdfNeedsPages = deps.pdfRenderer !== undefined
      && kindOf(entry.frozen.fileName) === 'pdf'
      && extracted.images.length === 0
      && ((extracted.text.trim() === '' && extracted.tables.length === 0)
        || (extracted.pagesWithoutText ?? 0) > 0)
    if (pdfNeedsPages && deps.pdfRenderer !== undefined) {
      const rendered = await renderFrozenPdf(deps.pdfRenderer, entry, casePath, signal)
      if (rendered.kind === 'stop') {
        return failureResult(rendered.errorKind, rendered.error, files, rendered.action, rendered.environment)
      }
      if (rendered.kind === 'rendered') {
        extracted = mergeRenderedPages(extracted, rendered.extracted)
        const afterRender = await verifyFrozenFile(caseRootReal, entry)
        if (!afterRender.ok) {
          return failureResult(afterRender.errorKind, afterRender.error, files, actionFor(afterRender.errorKind))
        }
      }
      // A capability gap leaves the original verified extraction in place; the
      // empty-text check below still records this material as unread.
    }

    const materialText = materialTextOf(extracted)
    let mergedText = materialText
    let visualReading: WorkflowVisualReading | undefined
    const capabilityNotes: string[] = []
    const reader = deps.visualReader
    if (reader !== undefined && needsVisualRead(extracted, materialText)) {
      let readResult: WorkflowVisualReadResult
      try {
        readResult = await reader.read({
          casePath,
          materialId: materialIdOf(entry.frozen),
          digest: text(entry.frozen.sha256),
          fileName: fileNameOf(entry.frozen),
          extracted,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        readResult = {
          ok: false, text: '', readPages: [], sessionIds: [], uncertainties: [],
          error: '视觉判读执行失败：详情已省略', errorKind: 'execution',
        }
      }
      // An unresolved child stop must be reported before any cancellation or publishing.
      if (readResult.errorKind === 'stop-unknown') {
        const reason = '视觉判读子会话停止状态未知：本轮余下资料不再解析，等待宿主核对在跑的子会话'
        return {
          ok: false,
          errorKind: 'stop-unknown',
          error: reason,
          materials,
          unverified: [
            ...unverified,
            ...unverifiedAll(verified.slice(index).map((item) => item.frozen), reason, ACTION_RECONCILE),
          ],
          stopUnknown: { sessionIds: [...readResult.sessionIds] },
        }
      }
      // The visual child may run for a while: never publish under a stale digest.
      const afterVisual = await verifyFrozenFile(caseRootReal, entry)
      if (!afterVisual.ok) {
        return failureResult(afterVisual.errorKind, afterVisual.error, files, actionFor(afterVisual.errorKind))
      }
      if (isAborted(signal)) {
        return failureResult('cancelled', '本次资料准备已取消', files, ACTION_CANCELLED)
      }
      if (readResult.ok && readResult.text.trim() !== '') {
        mergedText = materialText.trim() === '' ? readResult.text : `${materialText}\n\n${readResult.text}`
        visualReading = {
          readPages: [...readResult.readPages],
          sessionIds: [...readResult.sessionIds],
          uncertainties: [...readResult.uncertainties],
        }
        capabilityNotes.push(...(readResult.uncertainties ?? []))
      } else if (materialText.trim() === '') {
        const reason = text(readResult.error)
          || (readResult.uncertainties ?? []).find((item) => item.trim() !== '')
          || '页面图像没有返回可用的判读文字'
        unverified.push(unverifiedOf(entry.frozen, reason, ACTION_REUPLOAD))
        continue
      } else {
        const reason = text(readResult.error) || '视觉判读未能补全缺少文本层的页面'
        capabilityNotes.push(reason, ...(readResult.uncertainties ?? []))
      }
    }
    if (mergedText.trim() === '') {
      const gap = extracted.capabilityGaps.map((item) => text(item)).filter((item) => item !== '').join('；')
      unverified.push(unverifiedOf(entry.frozen, gap || '没有读到可用的正文或表格', ACTION_REUPLOAD))
      continue
    }

    materials.push(materialOf(entry.frozen, extracted, mergedText, visualReading, capabilityNotes))
  }

  const ok = materials.length > 0
  // Surface the first concrete unverified reason so the real cause (for example
  // a native child failure) reaches the parent instead of the generic headline.
  const firstUnverifiedReason = unverified
    .map((item) => text(item.reason).trim())
    .find((reason) => reason !== '')
  const headline = '没有任何一份资料被成功读取：请检查文件格式，或补充可读的资料'
  const error = ok
    ? ''
    : (firstUnverifiedReason === undefined ? headline : `${headline}；首要原因：${firstUnverifiedReason}`)
  return {
    ok,
    errorKind: ok ? '' : 'capability-gap',
    error,
    materials,
    unverified,
  }
}
