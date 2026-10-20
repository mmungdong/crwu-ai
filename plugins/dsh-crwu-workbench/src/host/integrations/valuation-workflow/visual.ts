/**
 * Scanned-page visual reader for the embedded valuation workflow.
 *
 * Page images written by the packaged extractor are re-located inside the case's
 * own `提取结果` directory, re-verified as real bounded files, admitted as actual
 * attachment bytes, and transcribed by the existing `page-reading` inference
 * operation. Only pages the child actually transcribed become coverage; pages it
 * did not return stay explicit uncertainties instead of an implied full read.
 */
import { open, realpath, stat as statPath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, isAbsoluteLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { EXTRACT_OUTPUT_DIR } from '../../domains/report-evaluation/intake/python-extractor.ts'
import type { ExtractedFile } from '../../domains/report-evaluation/intake/types.ts'
import type {
  ValuationImageAttachmentRef,
  ValuationInferencePort,
  ValuationInferenceRequest,
  ValuationInferenceResult,
} from '../../domains/report-evaluation/workflow/ports.ts'

/** One encoded page image; the harness decodes and validates the raster. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

type VisualMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Bounded page images the read actually produced, plus what stayed unread. */
export interface WorkflowVisualReading {
  readPages: number[]
  sessionIds: string[]
  uncertainties: string[]
}

export interface WorkflowVisualReadInput {
  casePath: string
  materialId: string
  digest: string
  fileName: string
  extracted: ExtractedFile
  signal?: AbortSignal
}

export interface WorkflowVisualReadResult extends WorkflowVisualReading {
  ok: boolean
  text: string
  error?: string
  errorKind?: string
}

export interface WorkflowVisualReader {
  read(input: WorkflowVisualReadInput): Promise<WorkflowVisualReadResult>
}

interface VisualContextLike {
  get(name: string): unknown
}

interface VisualLlmLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

interface VisualAttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: VisualMediaType; name?: string }): Promise<unknown>
}

export interface DshWorkflowVisualReaderOptions {
  ctx: VisualContextLike
  parentAgent: unknown
  inference: ValuationInferencePort
}

/** Constant public error: raw infrastructure text never leaves the Host boundary. */
const PUBLIC_VISUAL_ERROR = '视觉判读子会话执行失败：详情已省略'

/** Distinct controlled states; unknown modality is `missing`, a failed probe is `probe-failed`. */
function failed(errorKind: string, error: string, extra?: Partial<WorkflowVisualReading>): WorkflowVisualReadResult {
  return {
    ok: false,
    text: '',
    readPages: extra?.readPages ?? [],
    sessionIds: extra?.sessionIds ?? [],
    uncertainties: extra?.uncertainties ?? [],
    error,
    errorKind,
  }
}

/** Read abort state through a call so later reads are not narrowed by an earlier check. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The parent's current request route wins over its configured options. */
function modelRouteOf(parentAgent: unknown): { provider: string; model: string } | null {
  const agent = parentAgent !== null && typeof parentAgent === 'object'
    ? parentAgent as { options?: unknown; session?: unknown }
    : null
  if (agent === null) return null
  const options = agent.options !== null && typeof agent.options === 'object'
    ? agent.options as { provider?: unknown; model?: unknown }
    : {}
  const session = agent.session !== null && typeof agent.session === 'object'
    ? agent.session as { requestHeader?: unknown }
    : {}
  if (typeof session.requestHeader === 'function') {
    const header = session.requestHeader.call(session) as { config?: unknown } | undefined
    const config = header !== null && typeof header === 'object' && header.config !== null && typeof header.config === 'object'
      ? header.config as { provider?: unknown; model?: unknown }
      : {}
    const provider = text(config.provider).trim()
    const model = text(config.model).trim()
    if (provider !== '' && model !== '') return { provider, model }
  }
  const provider = text(options.provider).trim()
  const model = text(options.model).trim()
  return provider === '' || model === '' ? null : { provider, model }
}

/** Page number declared by the exporter filename `第N页-图M` or description `#第N页图片#M`. */
function pageIndexOf(image: { path: string; description?: string }): number | undefined {
  for (const candidate of [basenameLocalPath(text(image.path)), text(image.description)]) {
    const matched = /第\s*(\d+)\s*页/.exec(candidate)
    if (matched === null) continue
    const index = Number(matched[1])
    if (Number.isSafeInteger(index) && index >= 1) return index
  }
  return undefined
}

/** Encoded content sniffing; a declared extension or name is never trusted. */
function imageMediaTypeOf(bytes: Buffer): VisualMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (bytes.length >= 6) {
    const head = bytes.toString('latin1', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  return undefined
}

/** Read at most one bounded encoded image with no network access. */
async function readBoundedImage(path: string): Promise<Buffer | undefined> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return undefined
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset)
      if (bytesRead <= 0) return undefined
      offset += bytesRead
    }
    return buffer
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Real-path containment check; the only safe way to compare local paths. */
function resolvedInside(root: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(root), fold(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

interface LocatedPage {
  index: number
  images: Array<{ mediaType: VisualMediaType; bytes: Buffer; name: string }>
}

/** Accept exactly the one requested page; any extra, duplicate, renumbered or malformed entry is refused. */
function readPageOutput(
  result: ValuationInferenceResult,
  index: number,
): { text: string; uncertainties: string[] } | undefined {
  if (!result.ok) return undefined
  const pages = result.outputs?.pages
  if (!Array.isArray(pages) || pages.length !== 1) return undefined
  const item: unknown = pages[0]
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  if (record.index !== index) return undefined
  if (typeof record.text !== 'string' || !Array.isArray(record.uncertainties)) return undefined
  const pageText = record.text.trim()
  const list: string[] = []
  for (const value of record.uncertainties) {
    if (typeof value !== 'string') return undefined
    if (value.trim() !== '') list.push(value.trim())
  }
  if (pageText === '' && list.length === 0) return undefined
  return { text: pageText, uncertainties: list }
}

/** A locator must stay a plain case-relative name before any real-path resolution. */
function unsafeLocator(locator: string): boolean {
  if (locator.trim() === '' || locator.includes('\u0000')) return true
  if (isAbsoluteLocalPath(locator)) return true
  return locator.split(/[\\/]+/).includes('..')
}

/** Display name for errors: the basename only, never an absolute locator. */
function safeLocatorName(locator: string): string {
  return basenameLocalPath(locator) || '(未命名图像)'
}

/** Admit verified real bytes through the attachment store; never mint a reference. */
async function admitPages(
  store: VisualAttachmentStoreLike,
  located: LocatedPage[],
): Promise<Array<{ index: number; refs: ValuationImageAttachmentRef[] }> | undefined> {
  const groups: Array<{ index: number; refs: ValuationImageAttachmentRef[] }> = []
  for (const page of located) {
    const refs: ValuationImageAttachmentRef[] = []
    for (const image of page.images) {
      let saved: unknown
      try {
        saved = await store.saveImage({ data: image.bytes, mediaType: image.mediaType, name: image.name })
      } catch {
        return undefined
      }
      const ref = saved !== null && typeof saved === 'object' ? saved as Record<string, unknown> : null
      if (ref === null || text(ref.attachmentId) === '') return undefined
      refs.push({
        attachmentId: text(ref.attachmentId),
        mediaType: text(ref.mediaType) || image.mediaType,
        bytes: typeof ref.bytes === 'number' && Number.isFinite(ref.bytes) ? ref.bytes : image.bytes.length,
        width: typeof ref.width === 'number' && Number.isFinite(ref.width) ? ref.width : 0,
        height: typeof ref.height === 'number' && Number.isFinite(ref.height) ? ref.height : 0,
      })
    }
    groups.push({ index: page.index, refs })
  }
  return groups
}

/**
 * Resolve real page images, confirm the current model accepts them, and transcribe
 * them through the page-reading operation. Fails closed on an unverifiable route,
 * an unverified locator, or a child that returned no readable page text.
 */
export function createDshWorkflowVisualReader(options: DshWorkflowVisualReaderOptions): WorkflowVisualReader {
  return {
    async read(input: WorkflowVisualReadInput): Promise<WorkflowVisualReadResult> {
      const signal = input.signal
      if (isAborted(signal)) return failed('cancelled', '本次视觉判读已取消')
      const images = input.extracted.images
      if (!Array.isArray(images) || images.length === 0) {
        return failed('missing', '没有可判读的页面图像：不会创建空读子会话')
      }

      const route = modelRouteOf(options.parentAgent)
      if (route === null) {
        return failed('missing', '无法确认当前模型的 provider 与 model：拒绝在未知模型上判读图像')
      }
      const llm = options.ctx?.get?.('llm') as VisualLlmLike | undefined
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
        return failed('missing', 'Host 的模型能力服务不可用：无法确认图像输入能力')
      }
      const attachments = options.ctx?.get?.('attachments') as VisualAttachmentStoreLike | undefined
      if (attachments === undefined || typeof attachments.saveImage !== 'function') {
        return failed('missing', 'Host 没有可用的图像附件存储：拒绝提交未经入册的图像引用')
      }
      let info: unknown
      try {
        info = await llm.resolveModelInfo(route.provider, route.model, signal)
      } catch {
        return failed('probe-failed', '模型图像能力探测失败：拒绝在未确认的多模态路由上判读图像')
      }
      const modalities = info !== null && typeof info === 'object'
        ? (info as { inputModalities?: unknown }).inputModalities
        : undefined
      if (!Array.isArray(modalities) || !modalities.includes('image')) {
        return failed('missing', '当前模型没有声明图像输入能力：请切换到多模态模型后重试')
      }

      const uncertainties: string[] = []
      let outputRoot: string
      try {
        const caseRoot = await realpath(text(input.casePath))
        const resolved = await realpath(joinLocalPath(caseRoot, EXTRACT_OUTPUT_DIR))
        if (!resolvedInside(caseRoot, resolved)) {
          return failed('execution', '案例的提取结果目录经符号链接越出了案例目录：拒绝判读图像')
        }
        outputRoot = resolved
      } catch {
        return failed('execution', '案例的提取结果目录不可解析：无法定位页面图像')
      }

      const order: number[] = []
      const byPage = new Map<number, LocatedPage['images']>()
      for (const image of images) {
        const locator = text(image.path)
        const name = safeLocatorName(locator)
        if (unsafeLocator(locator)) {
          return failed('execution', `页面图像路径不可用：${name}`)
        }
        const index = pageIndexOf(image)
        if (index === undefined) {
          uncertainties.push(`未能从图像文件名或描述定位页码：${name}`)
          continue
        }
        let resolved: string
        try {
          resolved = await realpath(joinLocalPath(outputRoot, locator))
        } catch {
          return failed('execution', `页面图像路径不可用：${name}`)
        }
        if (!resolvedInside(outputRoot, resolved)) {
          return failed('execution', `页面图像经符号链接越出了案例的提取结果目录：${name}`)
        }
        let info2
        try {
          info2 = await statPath(resolved)
        } catch {
          return failed('execution', `页面图像状态不可读取：${name}`)
        }
        if (!info2.isFile()) {
          return failed('execution', `页面图像不是普通文件：${name}`)
        }
        const bytes = await readBoundedImage(resolved)
        if (bytes === undefined) {
          return failed('execution', `页面图像不可读取或超出大小上限：${name}`)
        }
        const mediaType = imageMediaTypeOf(bytes)
        if (mediaType === undefined) {
          return failed('execution', `页面图像不是受支持的 PNG/JPEG/WEBP/GIF 内容：${name}`)
        }
        if (!byPage.has(index)) {
          byPage.set(index, [])
          order.push(index)
        }
        byPage.get(index)?.push({ mediaType, bytes, name })
      }
      if (order.length === 0) {
        return failed('execution', uncertainties[0] ?? '没有可定位页码的页面图像', { uncertainties })
      }

      const located: LocatedPage[] = order.map((index) => ({ index, images: byPage.get(index) ?? [] }))
      const admitted = await admitPages(attachments, located)
      if (admitted === undefined) {
        return failed('execution', '页面图像附件入册失败：拒绝提交未经真实入册的图像')
      }
      if (isAborted(signal)) return failed('cancelled', '本次视觉判读已取消')

      const sessionIds: string[] = []
      const texts: string[] = []
      const readPages: number[] = []
      const issues: string[] = []
      for (const page of admitted) {
        if (isAborted(signal)) {
          return failed('cancelled', '本次视觉判读已取消', {
            readPages, sessionIds, uncertainties: [...uncertainties, ...issues],
          })
        }
        const request: ValuationInferenceRequest = {
          runId: `visual:${input.materialId}`,
          revision: 1,
          nodeId: 'page-reading',
          stage: 'elements',
          attempt: 1,
          correlationId: `${input.materialId}:page-${page.index}`,
          operation: 'page-reading',
          images: page.refs,
          facts: { pageIndexes: [page.index], materialId: input.materialId, digest: input.digest },
          knowledge: [],
          ...(signal === undefined ? {} : { signal }),
        }
        let result: ValuationInferenceResult
        try {
          result = await options.inference.infer(request)
        } catch {
          result = { ok: false, error: PUBLIC_VISUAL_ERROR }
        }
        if (text(result.sessionId) !== '') sessionIds.push(text(result.sessionId))
        // An unresolved child stop outranks the cancellation that may have caused it.
        if (result.errorKind === 'stop-unknown') {
          return {
            ok: false,
            text: texts.join('\n\n'),
            readPages, sessionIds,
            uncertainties: [...uncertainties, ...issues],
            error: '视觉判读子会话停止状态未知：本批余下页面不再启动',
            errorKind: 'stop-unknown',
          }
        }
        if (isAborted(signal)) {
          return failed('cancelled', '本次视觉判读已取消', {
            readPages, sessionIds, uncertainties: [...uncertainties, ...issues],
          })
        }
        if (result.errorKind === 'cancelled') {
          return failed('cancelled', '本次视觉判读已取消', {
            readPages, sessionIds, uncertainties: [...uncertainties, ...issues],
          })
        }
        const output = readPageOutput(result, page.index)
        if (output === undefined) {
          issues.push(`第${page.index}页没有返回可核对的判读结果`)
          continue
        }
        for (const value of output.uncertainties) uncertainties.push(`第${page.index}页：${value}`)
        if (output.text !== '') {
          if (!readPages.includes(page.index)) readPages.push(page.index)
          texts.push(output.text)
        } else {
          issues.push(`第${page.index}页只返回了不确定说明，没有可读文字`)
        }
      }

      if (texts.length === 0 || readPages.length === 0) {
        return failed('execution', issues[0] ?? '没有读到任何可用的页面文字', {
          sessionIds, uncertainties: [...uncertainties, ...issues],
        })
      }
      readPages.sort((left, right) => left - right)
      return {
        ok: true,
        text: texts.join('\n\n'),
        readPages,
        sessionIds,
        uncertainties: [...uncertainties, ...issues],
      }
    },
  }
}
