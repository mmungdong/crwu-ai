/**
 * Bounded native PDF page renderer for the embedded valuation workflow.
 *
 * The only rendering path is the official DSH `office-render` skill (`dsh-office`):
 * its content ends with a machine JSON block that names an absolute standalone
 * Node and an absolute LibreOffice Kit CLI. This adapter reads that block as
 * data, probes the CLI once per call, renders the frozen case PDF into a fresh
 * case-local directory, and then verifies the on-disk manifest, the source
 * identity and every page image before publishing anything.
 *
 * Rendering proves pages exist as PNG; it never claims a native text layer. The
 * result therefore carries no `pages` / `pagesWithText` / `pagesWithoutText`
 * facts, and an empty `text`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, realpath, stat as statPath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, isAbsoluteLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { parseJsonLoose } from '../../../shared/utils/json.ts'
import { shellInvoke } from '../../core/platform/shell.ts'
import { classifyRun } from '../../tools/common/outcome.ts'
import { callerSession } from '../../tools/common/types.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { ToolErrorKind } from '../../tools/report-audit/consts.ts'
import { kindOf } from '../../domains/report-evaluation/intake/classify.ts'
import { EXTRACT_OUTPUT_DIR } from '../../domains/report-evaluation/intake/python-extractor.ts'
import { emptyExtractedFile } from '../../domains/report-evaluation/intake/extract.ts'
import type { ExtractedFile } from '../../domains/report-evaluation/intake/types.ts'

/** Named broker operation; the command shape never leaves this module. */
const RENDER_OPERATION = 'system.valuation-document.render'
/** Official skill tool, name and provider. A different provider is never accepted. */
const SKILL_TOOL = 'skill'
const SKILL_NAME = 'office-render'
const SKILL_PROVIDER = 'dsh-office'

const MAX_PAGES = 100
const RENDER_DPI = 144
const MAX_PIXELS = 16_777_216
const MAX_DIMENSION = 8192

const PROBE_TIMEOUT_MS = 60_000
const RENDER_TIMEOUT_MS = 15 * 60_000

/** Bounded payloads: input PDF, manifest, one PNG, and all PNGs together. */
const MAX_INPUT_BYTES = 128 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024
/** Bound the official skill content before parsing its trailing machine block. */
const MAX_SKILL_CONTENT_BYTES = 1024 * 1024

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface DshWorkflowPdfRendererOptions {
  ctx: Context
  access: LocalAccessBroker
  world: { platform: () => Promise<string> }
  /** Genuine caller execution context; the registry owns its token. */
  execution: ToolRunContext
}

export interface WorkflowPdfRenderInput {
  /** Registered case directory (absolute, already resolved by the caller's gate). */
  casePath: string
  /** Absolute path of the frozen PDF inside the case directory. */
  path: string
  fileName: string
  /** `sha256:<hex>` or bare hex digest of the frozen bytes. */
  digest: string
  signal?: AbortSignal
}

export type WorkflowPdfRenderResult =
  | { ok: true; extracted: ExtractedFile }
  | { ok: false; errorKind: ToolErrorKind; error: string }

export interface WorkflowPdfRenderer {
  render(input: WorkflowPdfRenderInput): Promise<WorkflowPdfRenderResult>
}

function failed(errorKind: ToolErrorKind, error: string): WorkflowPdfRenderResult {
  return { ok: false, errorKind, error }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Fuse the parent execution signal with the per-call signal; both abort the work. */
interface CombinedSignal {
  signal: AbortSignal
  dispose(): void
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): CombinedSignal {
  if (secondary === undefined || secondary === primary) return { signal: primary, dispose(): void {} }
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (primary.aborted || secondary.aborted) {
    controller.abort()
    return { signal: controller.signal, dispose(): void {} }
  }
  primary.addEventListener('abort', abort, { once: true })
  secondary.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose(): void {
      primary.removeEventListener('abort', abort)
      secondary.removeEventListener('abort', abort)
    },
  }
}

/** Real-path containment; the only safe way to compare local paths. */
function resolvedInside(root: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(root), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Accept `sha256:<hex>` and bare `<hex>`, lowercased; anything else stays as-is. */
function normalizedDigest(value: unknown): string {
  const raw = text(value).trim().toLowerCase()
  return raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
}

function isHexDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Parse the trailing machine JSON block of the skill content.
 *
 * Only a complete JSON object anchored at the very end of the content is
 * accepted, and the surrounding prose is never interpreted as instructions.
 */
function machineTail(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  if (!trimmed.endsWith('}')) return null
  for (let at = trimmed.lastIndexOf('{'); at >= 0; at = trimmed.lastIndexOf('{', at - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(at)) as unknown
      const record = objectOf(parsed)
      if (record !== null) return record
    } catch (error) {
      // Not this brace; keep moving towards the start of the string.
      void error
    }
  }
  return null
}

/** Resolve an absolute path and require an existing regular file. */
async function existingRegularFile(path: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    return ''
  }
  try {
    const info = await statPath(resolved)
    return info.isFile() ? resolved : ''
  } catch {
    return ''
  }
}

/** Encoded PNG signature check; the declared name or extension is never trusted. */
async function isPng(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return false
  }
  try {
    const head = Buffer.alloc(PNG_MAGIC.length)
    const { bytesRead } = await handle.read(head, 0, PNG_MAGIC.length, 0)
    return bytesRead === PNG_MAGIC.length && head.equals(PNG_MAGIC)
  } catch {
    return false
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function abortSignalOf(execution: ToolRunContext): AbortSignal | undefined {
  const signal = (execution as { signal?: unknown }).signal
  if (signal === undefined) return undefined
  if (signal !== null && typeof signal === 'object'
    && typeof (signal as { aborted?: unknown }).aborted === 'boolean'
    && typeof (signal as { addEventListener?: unknown }).addEventListener === 'function') {
    return signal as AbortSignal
  }
  return undefined
}

/** The registry token, root call and agent must all be genuine; a forged context fails closed. */
function executionIssue(execution: ToolRunContext, signal: AbortSignal | undefined): string {
  if (typeof (execution as { token?: unknown }).token !== 'symbol') {
    return '缺少注册表签发的执行令牌：拒绝渲染 PDF'
  }
  if (text(execution.rootCallId).trim() === '') return '缺少根调用标识：拒绝渲染 PDF'
  if (execution.agent === undefined || execution.agent === null || typeof execution.agent !== 'object') {
    return '缺少真实的调用 Agent：拒绝渲染 PDF'
  }
  if (callerSession(execution) === undefined) return '缺少真实的调用会话：拒绝渲染 PDF'
  if (signal === undefined) return '执行上下文缺少可用的取消信号：拒绝渲染 PDF'
  return ''
}

interface CapabilityProbe {
  inputs: string[]
  output: string
  pdfBackend: string
}

function probeOf(stdout: unknown): CapabilityProbe | undefined {
  const parsed = objectOf(parseJsonLoose(stdout))
  const rendering = parsed === null ? null : objectOf(parsed.imageRendering)
  if (rendering === null) return undefined
  const inputs = Array.isArray(rendering.inputs)
    ? rendering.inputs.map((item) => text(item).trim()).filter((item) => item !== '')
    : []
  return { inputs, output: text(rendering.output).trim(), pdfBackend: text(rendering.pdfBackend).trim() }
}

/**
 * Create the PDF renderer. Every call re-authorizes, re-probes and re-verifies;
 * no capability decision, path or digest is cached across calls.
 */
export function createDshWorkflowPdfRenderer(
  options: DshWorkflowPdfRendererOptions,
): WorkflowPdfRenderer {
  return {
    async render(input: WorkflowPdfRenderInput): Promise<WorkflowPdfRenderResult> {
      if (isAborted(input.signal)) return failed('cancelled', '本次 PDF 渲染已取消')

      const casePath = text(input.casePath).trim()
      const sourcePath = text(input.path).trim()
      const fileName = text(input.fileName).trim() || basenameLocalPath(sourcePath)
      const declared = normalizedDigest(input.digest)

      if (casePath === '' || !isAbsoluteLocalPath(casePath)) {
        return failed('input', '缺少本轮估值案例目录的绝对路径：拒绝渲染 PDF')
      }
      if (sourcePath === '' || !isAbsoluteLocalPath(sourcePath)) {
        return failed('input', '缺少输入 PDF 的绝对路径：拒绝渲染 PDF')
      }
      if (kindOf(fileName) !== 'pdf' && kindOf(sourcePath) !== 'pdf') {
        return failed('input', '本机渲染只接受 PDF 资料：拒绝渲染')
      }
      if (!isHexDigest(declared)) {
        return failed('input', '输入 PDF 的内容摘要形状不可用：拒绝渲染')
      }

      // Authorize the named operation before touching any service, fs or Tool.
      const decision = options.access.authorize({ operation: RENDER_OPERATION, source: 'audit-tool', workdir: casePath })
      if (decision.ok !== true) {
        return failed('policy', text(decision.error).trim() || '本机访问未授权：拒绝渲染 PDF')
      }

      const executionSignal = abortSignalOf(options.execution)
      const issue = executionIssue(options.execution, executionSignal)
      if (issue !== '') return failed('policy', issue)
      // Explicit check so `executionSignal` narrows to AbortSignal below.
      if (executionSignal === undefined) return failed('policy', '执行上下文缺少可用的取消信号：拒绝渲染 PDF')
      if (isAborted(executionSignal)) return failed('cancelled', '本次 PDF 渲染已取消')

      // Verify the real case, source and output root before any command runs.
      let caseRootReal: string
      try {
        caseRootReal = await realpath(casePath)
      } catch {
        return failed('file', '本轮估值案例目录不可解析：拒绝渲染 PDF')
      }
      let caseInfo
      try {
        caseInfo = await statPath(caseRootReal)
      } catch {
        return failed('file', '本轮估值案例目录状态不可读取：拒绝渲染 PDF')
      }
      if (!caseInfo.isDirectory()) return failed('file', '本轮估值案例路径不是目录：拒绝渲染 PDF')

      let sourceReal: string
      try {
        sourceReal = await realpath(sourcePath)
      } catch {
        return failed('not-found', '案例目录里找不到输入 PDF：拒绝渲染')
      }
      if (!resolvedInside(caseRootReal, sourceReal)) {
        return failed('policy', '输入 PDF 不在本轮估值案例目录之内：拒绝渲染')
      }
      let sourceInfo
      try {
        sourceInfo = await statPath(sourceReal)
      } catch {
        return failed('file', '输入 PDF 状态不可读取：拒绝渲染')
      }
      if (!sourceInfo.isFile()) return failed('input', '输入路径不是普通文件：拒绝渲染')
      if (sourceInfo.size <= 0 || sourceInfo.size > MAX_INPUT_BYTES) {
        return failed('input', '输入 PDF 为空或超出大小上限：拒绝渲染')
      }
      let sourceActual: string
      try {
        sourceActual = sha256Of(await readFile(sourceReal))
      } catch {
        return failed('file', '输入 PDF 字节不可读取：拒绝渲染')
      }
      if (sourceActual !== declared) {
        return failed('input', '输入 PDF 内容摘要与登记不一致：拒绝渲染')
      }

      const outputRoot = joinLocalPath(caseRootReal, EXTRACT_OUTPUT_DIR)
      let outputRootReal: string
      try {
        outputRootReal = await realpath(outputRoot)
      } catch {
        return failed('file', '案例的提取结果目录不可解析：无法渲染 PDF')
      }
      if (!resolvedInside(caseRootReal, outputRootReal)) {
        return failed('policy', '案例的提取结果目录越出了案例目录：拒绝渲染 PDF')
      }
      let outputInfo
      try {
        outputInfo = await statPath(outputRootReal)
      } catch {
        return failed('file', '案例的提取结果目录状态不可读取：无法渲染 PDF')
      }
      if (!outputInfo.isDirectory()) return failed('file', '案例的提取结果路径不是目录：无法渲染 PDF')

      const runtime = options.ctx.get('tools') as ToolRuntime | undefined
      if (runtime === undefined || typeof runtime.execute !== 'function') {
        return failed('capability-gap', 'Host 的 tools 服务不可用：拒绝渲染 PDF')
      }
      const session = callerSession(options.execution)
      const platform = await options.world.platform()
      if (isAborted(executionSignal) || isAborted(input.signal)) {
        return failed('cancelled', '本次 PDF 渲染已取消')
      }

      const combined = combineSignals(executionSignal, input.signal)
      try {
        const nodePath = await resolveKitEntry(options, runtime, combined.signal)
        if (nodePath.error !== undefined) return nodePath.error

        // Probe first: an unsupported raster backend is a capability gap, not a render failure.
        const probe = await options.access.runShell(
          { operation: RENDER_OPERATION, source: 'audit-tool', workdir: caseRootReal },
          shellInvoke(nodePath.node, [nodePath.cli, 'capabilities', '--json'], platform),
          {
            workdir: caseRootReal,
            timeoutMs: PROBE_TIMEOUT_MS,
            ...(session === undefined ? {} : { session }),
            signal: combined.signal,
            summary: 'valuation native pdf capability probe',
          },
        )
        if (combined.signal.aborted || probe.aborted === true) return failed('cancelled', '本次 PDF 渲染已取消')
        if (probe.ok !== true) {
          const kind = classifyRun(probe)
          return failed(kind === 'approval' ? 'approval' : 'infrastructure', '本机 PDF 渲染能力探测失败：拒绝渲染')
        }
        const capabilities = probeOf(probe.stdout)
        if (capabilities === undefined) {
          return failed('infrastructure', '本机 PDF 渲染能力探测结果不可解析：拒绝渲染')
        }
        if (!capabilities.inputs.includes('pdf')
          || capabilities.output !== 'png'
          || capabilities.pdfBackend !== 'pdfium') {
          return failed('capability-gap', '当前部署没有可用的 PDF→PNG 原生渲染能力：拒绝渲染')
        }

        const outDir = joinLocalPath(outputRootReal, `native-pdf-${randomUUID()}`)
        const render = await options.access.runShell(
          { operation: RENDER_OPERATION, source: 'audit-tool', workdir: caseRootReal },
          shellInvoke(nodePath.node, [
            nodePath.cli, 'render',
            '--input', sourceReal,
            '--output-dir', outDir,
            '--pages', 'all',
            '--max-pages', String(MAX_PAGES),
            '--dpi', String(RENDER_DPI),
            '--max-pixels', String(MAX_PIXELS),
            '--max-dimension', String(MAX_DIMENSION),
          ], platform),
          {
            workdir: caseRootReal,
            timeoutMs: RENDER_TIMEOUT_MS,
            ...(session === undefined ? {} : { session }),
            signal: combined.signal,
            summary: 'valuation native pdf render',
          },
        )
        if (combined.signal.aborted || render.aborted === true) return failed('cancelled', '本次 PDF 渲染已取消')
        if (render.ok !== true) {
          const kind = classifyRun(render)
          return failed(kind === 'approval' ? 'approval' : 'infrastructure', '本机 PDF 渲染命令执行失败：详情已省略')
        }

        // The manifest on disk is the authority; stdout is ignored.
        let outDirReal: string
        try {
          outDirReal = await realpath(outDir)
        } catch {
          return failed('infrastructure', 'PDF 渲染没有产出可解析的输出目录：拒绝使用')
        }
        if (!resolvedInside(caseRootReal, outDirReal)) {
          return failed('policy', 'PDF 渲染输出目录越出了案例目录：拒绝使用')
        }

        const manifest = await readManifest(outDirReal)
        if (manifest.error !== undefined) return manifest.error

        const verified = await verifyManifest(manifest.value, {
          manifestRoot: outDirReal,
          outputRootReal,
          caseRootReal,
          sourceReal,
          sourceActual,
        })
        if (verified.error !== undefined) return verified.error

        // The original bytes must be exactly what we verified before publishing.
        let finalActual: string
        try {
          finalActual = sha256Of(await readFile(sourceReal))
        } catch {
          return failed('file', '输入 PDF 字节不可回读：拒绝发布渲染结果')
        }
        if (finalActual !== sourceActual) {
          return failed('input', '渲染过程中输入 PDF 字节发生变化：拒绝发布渲染结果')
        }

        const extracted: ExtractedFile = {
          ...emptyExtractedFile(fileName, 'pdf'),
          images: verified.images,
          pageCount: verified.pageCount,
          capabilities: { pdfRender: true },
          capabilityProbe: {
            pdfRenderTool: SKILL_NAME,
            pdfRenderProvider: SKILL_PROVIDER,
            pdfRenderBackend: 'pdfium',
          },
        }
        return { ok: true, extracted }
      } finally {
        combined.dispose()
      }
    },
  }
}

interface KitEntry {
  node: string
  cli: string
  error?: WorkflowPdfRenderResult
}

/** Resolve the official skill and read only its trailing machine block. */
async function resolveKitEntry(
  options: DshWorkflowPdfRendererOptions,
  runtime: ToolRuntime,
  signal: AbortSignal,
): Promise<KitEntry> {
  let outcome: ToolExecutionResult
  try {
    outcome = await runtime.execute({
      callId: ToolCallId(randomUUID()),
      rootCallId: options.execution.rootCallId,
      parent: options.execution.token,
      ...(options.execution.agent === undefined ? {} : { agent: options.execution.agent }),
      signal,
      name: SKILL_TOOL,
      arguments: { name: SKILL_NAME },
    })
  } catch {
    return { node: '', cli: '', error: failed('infrastructure', '官方 office-render 技能解析失败：拒绝渲染 PDF') }
  }
  if (outcome.isError === true) {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能不可用：拒绝渲染 PDF') }
  }
  const value = objectOf(outcome.value)
  if (value === null) {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能没有返回可用的运行时信息：拒绝渲染 PDF') }
  }
  if (text(value.name).trim() !== SKILL_NAME || text(value.provider).trim() !== SKILL_PROVIDER) {
    return { node: '', cli: '', error: failed('capability-gap', '技能不是官方 office-render（dsh-office）：拒绝渲染 PDF') }
  }
  const content = text(value.content)
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能内容超出大小上限：拒绝执行') }
  }
  const machine = machineTail(content)
  const kit = machine === null ? null : objectOf(machine.libreofficeKit)
  const nodeRaw = kit === null ? '' : text(kit.node).trim()
  const cliRaw = kit === null ? '' : text(kit.cli).trim()
  if (!isAbsoluteLocalPath(nodeRaw) || !isAbsoluteLocalPath(cliRaw)) {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能没有给出可用的本机组件：拒绝执行') }
  }
  const node = await existingRegularFile(nodeRaw)
  if (node === '') {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能的 Node 组件不可用：拒绝执行') }
  }
  const cli = await existingRegularFile(cliRaw)
  if (cli === '') {
    return { node: '', cli: '', error: failed('capability-gap', '官方 office-render 技能的 CLI 组件不可用：拒绝执行') }
  }
  return { node, cli }
}

interface ManifestRead {
  value: Record<string, unknown>
  error?: WorkflowPdfRenderResult
}

async function readManifest(outDirReal: string): Promise<ManifestRead> {
  const manifestPath = joinLocalPath(outDirReal, 'manifest.json')
  let info
  try {
    info = await statPath(manifestPath)
  } catch {
    return { value: {}, error: failed('infrastructure', 'PDF 渲染产物缺少 manifest：拒绝使用') }
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
    return { value: {}, error: failed('infrastructure', 'PDF 渲染的 manifest 形状不可用：拒绝使用') }
  }
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    return { value: {}, error: failed('infrastructure', 'PDF 渲染的 manifest 不可读取：拒绝使用') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { value: {}, error: failed('infrastructure', 'PDF 渲染的 manifest 不是合法 JSON：拒绝使用') }
  }
  const record = objectOf(parsed)
  if (record === null) {
    return { value: {}, error: failed('infrastructure', 'PDF 渲染的 manifest 不是对象：拒绝使用') }
  }
  return { value: record }
}

interface VerifyContext {
  /** Fresh per-render output directory (contains this render's `manifest.json`). */
  manifestRoot: string
  /** Real `案例目录/提取结果`; returned image paths are relative to this root. */
  outputRootReal: string
  caseRootReal: string
  sourceReal: string
  sourceActual: string
}

interface VerifyResult {
  pageCount: number
  images: Array<{ path: string; description: string }>
  error?: WorkflowPdfRenderResult
}

/**
 * Verify the on-disk manifest against the real source and every real page image.
 * Any external, traversing, non-PNG or digest-substituted artefact is refused.
 */
async function verifyManifest(manifest: Record<string, unknown>, context: VerifyContext): Promise<VerifyResult> {
  const empty: VerifyResult = { pageCount: 0, images: [] }
  if (manifest.schemaVersion !== 1
    || manifest.backend !== 'native'
    || manifest.rasterEngine !== 'pdfium'
    || manifest.source !== 'saved') {
    return { ...empty, error: failed('infrastructure', 'PDF 渲染的 manifest 描述与预期不一致：拒绝使用') }
  }

  const manifestInputPath = text(manifest.inputPath).trim()
  if (!isAbsoluteLocalPath(manifestInputPath)) {
    return { ...empty, error: failed('infrastructure', 'PDF 渲染的 manifest 没有给出输入路径：拒绝使用') }
  }
  let manifestInputReal: string
  try {
    manifestInputReal = await realpath(manifestInputPath)
  } catch {
    return { ...empty, error: failed('infrastructure', 'PDF 渲染的 manifest 输入路径不可解析：拒绝使用') }
  }
  if (manifestInputReal !== context.sourceReal) {
    return { ...empty, error: failed('input', 'PDF 渲染的输入路径与本轮资料不一致：拒绝使用') }
  }

  const manifestDigest = normalizedDigest(manifest.sourceSha256)
  if (!isHexDigest(manifestDigest) || manifestDigest !== context.sourceActual) {
    return { ...empty, error: failed('input', 'PDF 渲染报告的输入摘要与真实字节不一致：拒绝使用') }
  }

  const pageCount = manifest.pageCount
  if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    return { ...empty, error: failed('infrastructure', 'PDF 渲染的页数超出允许范围：拒绝使用') }
  }
  const images = manifest.images
  if (!Array.isArray(images) || images.length !== pageCount) {
    return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像数量与页数不一致：拒绝使用') }
  }

  const seenPages = new Set<number>()
  const seenIndexes = new Set<number>()
  const verified: Array<{ path: string; description: string }> = []
  let totalBytes = 0
  for (const item of images) {
    const record = objectOf(item)
    if (record === null) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像条目形状不可用：拒绝使用') }
    }
    const page = record.page
    const index = record.index
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > pageCount || seenPages.has(page)) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页码不连续或重复：拒绝使用') }
    }
    // `page` (1..pageCount) is the authoritative unique, contiguous identity.
    // `index` is a renderer-declared ordinal whose base is not part of the
    // contract (0-based and 1-based deployments both exist), so only require a
    // nonnegative integer that is unique when present.
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || seenIndexes.has(index)) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面序号不可用或重复：拒绝使用') }
    }
    seenPages.add(page)
    seenIndexes.add(index)

    const imagePath = text(record.path).trim()
    if (!isAbsoluteLocalPath(imagePath)) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像路径不可用：拒绝使用') }
    }
    let imageReal: string
    try {
      imageReal = await realpath(imagePath)
    } catch {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像路径不可解析：拒绝使用') }
    }
    if (!resolvedInside(context.manifestRoot, imageReal) || !resolvedInside(context.caseRootReal, imageReal)) {
      return { ...empty, error: failed('policy', 'PDF 渲染的页面图像越出了本轮案例目录：拒绝使用') }
    }
    let info
    try {
      info = await statPath(imageReal)
    } catch {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像状态不可读取：拒绝使用') }
    }
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像为空或超出大小上限：拒绝使用') }
    }
    if (typeof record.byteLength !== 'number' || !Number.isSafeInteger(record.byteLength) || record.byteLength !== info.size) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像字节数与真实文件不一致：拒绝使用') }
    }
    if (typeof record.width !== 'number' || !Number.isSafeInteger(record.width) || record.width <= 0
      || typeof record.height !== 'number' || !Number.isSafeInteger(record.height) || record.height <= 0) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像尺寸不可用：拒绝使用') }
    }
    if (!(await isPng(imageReal))) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像不是合法 PNG：拒绝使用') }
    }
    totalBytes += info.size
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { ...empty, error: failed('infrastructure', 'PDF 渲染的页面图像总量超出上限：拒绝使用') }
    }

    // The visual reader resolves image paths against `case/提取结果`, so the
    // returned locator must keep the fresh `native-pdf-<uuid>/` directory.
    const relativePath = relative(context.outputRootReal, imageReal)
    if (relativePath === '' || isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`) || relativePath === '..') {
      return { ...empty, error: failed('policy', 'PDF 渲染的页面图像相对路径不可用：拒绝使用') }
    }
    verified.push({ path: relativePath, description: `#第${page}页图片#1` })
  }

  return { pageCount, images: verified }
}
