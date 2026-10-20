/**
 * Stage-aware knowledge reader for the valuation workflow.
 *
 * The business library is ordinary prose. One entry Wiki document links to the
 * documents a run may use; a structured selection maps each allowed link to a
 * business role, and every section of the workflow then reads the roles that apply
 * to it. The reader verifies the library identity, the entry snapshot, every quoted
 * entry line and every selected path before it reads a target body. Selecting a new
 * reference mode reselects against the same verified entry, never the raw link target.
 *
 * The reader caches verified bodies and the verified root per instance. A selection is
 * keyed by the actual stage, revision and user/object context, so a stage change or a
 * user correction reselects while a repeated read of the same context reuses it.
 */
import type { ValuationWorkflowStage } from '../../../../shared/contracts/valuation-workflow.ts'
import { text } from '../../../../shared/utils/value.ts'
import type {
  KnowledgeSourceRecord,
  ValuationKnowledgeReadRequest,
  ValuationKnowledgeReadResult,
} from '../workflow/ports.ts'
import { knowledgeDigest } from './snapshot.ts'
import { parseWikiLinks } from './wiki-links.ts'
import type { WikiLink } from './wiki-links.ts'

/** Roles a selected document may carry in the business workflow. */
export type KnowledgeRole = 'common' | 'rights' | 'method' | 'evidence' | 'output'

const KNOWLEDGE_ROLES: readonly KnowledgeRole[] = ['common', 'rights', 'method', 'evidence', 'output']

/**
 * Role applicability by stage. Common knowledge always applies; rights carry
 * forward from the rights stage; method knowledge governs plan through review;
 * evidence governs evidence, calculation and review; output governs review and
 * delivery.
 */
const STAGE_ROLES: Record<ValuationWorkflowStage, readonly KnowledgeRole[]> = {
  elements: ['common'],
  rights: ['common', 'rights'],
  plan: ['common', 'rights', 'method', 'evidence', 'output'],
  evidence: ['common', 'rights', 'method', 'evidence'],
  calculation: ['common', 'rights', 'method', 'evidence'],
  review: ['common', 'rights', 'method', 'evidence', 'output'],
  delivery: ['common', 'rights', 'output'],
}

/** Roles that apply to one workflow stage; `common` always applies. Pure getter. */
export function knowledgeRolesForStage(stage: ValuationWorkflowStage): KnowledgeRole[] {
  return [...(STAGE_ROLES[stage] ?? ['common'])]
}

/**
 * Stable identity of one selection context. `knownSourceDigests` is deliberately
 * excluded: a repeated read of the same context reuses the same selection.
 */
function selectionContextKey(request: ValuationKnowledgeReadRequest): string {
  const object = request.object
  const materials = (Array.isArray(request.materials) ? request.materials : []).map((material) => ({
    materialId: text(material?.materialId),
    digest: text(material?.digest),
    text: text(material?.text),
  }))
  return knowledgeDigest(JSON.stringify([
    request.runId,
    request.revision,
    request.stage,
    request.objectId,
    request.mode,
    text(request.userInput),
    object === undefined || object === null
      ? null
      : { objectId: text(object.objectId), useLabel: text(object.useLabel), areaSqm: object.areaSqm ?? null },
    request.assetType ?? null,
    text(request.purpose),
    text(request.baseDate),
    text(request.promptSupplement),
    request.initialInput ?? null,
    materials,
  ]))
}

/** One document returned by the knowledge loader, plus the entry document's links. */
export interface WorkflowKnowledgeDocument {
  ok: boolean
  source?: KnowledgeSourceRecord
  links?: WikiLink[]
  error?: string
}

/** The structured selection returned by the model for one object/mode pair. */
export interface WorkflowKnowledgeSelection {
  ok: boolean
  sessionId?: string
  entryDigest: string
  selections: Array<{ path: string; role: KnowledgeRole; quote: string }>
  questions: string[]
  error?: string
}

/** Everything the selection call may see: the request, verified entry and links. */
export interface WorkflowKnowledgeSelectionInput {
  request: ValuationKnowledgeReadRequest
  entrySource: KnowledgeSourceRecord
  allowedLinks: WikiLink[]
  /** Present only on the single bounded correction attempt for a missing-navigation quote. */
  correction?: { error: string }
}

export interface CreateWorkflowKnowledgeReaderOptions {
  spaceName: string
  entryWikiPath: string
  loadDocument(
    path: string,
    input: ValuationKnowledgeReadRequest,
  ): Promise<WorkflowKnowledgeDocument | undefined>
  selectSources(input: WorkflowKnowledgeSelectionInput): Promise<WorkflowKnowledgeSelection>
}

export interface WorkflowKnowledgeReader {
  readonly stageAware: true
  read(input: ValuationKnowledgeReadRequest): Promise<ValuationKnowledgeReadResult>
}

interface VerifiedRoot {
  source: KnowledgeSourceRecord
  links: WikiLink[]
}

function normalizeWikiPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

function safeError(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function failure(message: string, extraGaps: readonly string[] = []): ValuationKnowledgeReadResult {
  const error = message.trim() === '' ? '知识来源不可用' : message
  const gaps = [...new Set([...extraGaps.filter((gap) => gap.trim() !== ''), error])]
  return { ok: false, error, gaps }
}

/**
 * A source is usable only when its identity, path, library, body type and
 * recomputed digest all agree. A response that merely claims a digest is refused.
 */
function sourceProblem(
  source: KnowledgeSourceRecord | null | undefined,
  expectedPath: string,
  spaceName: string,
): string {
  if (source === null || source === undefined || typeof source !== 'object') return '知识加载没有返回来源记录'
  if (typeof source.sourceId !== 'string' || source.sourceId.trim() === '') return '知识来源缺少来源标识'
  if (typeof source.path !== 'string' || source.path.trim() === '') return '知识来源缺少库内路径'
  if (normalizeWikiPath(source.path) !== normalizeWikiPath(expectedPath)) {
    return `知识来源路径与请求不一致：${expectedPath}`
  }
  if (source.spaceName !== spaceName) return `知识来源不属于预期业务知识库：${expectedPath}`
  if (typeof source.body !== 'string') return `知识来源正文不是文本：${expectedPath}`
  if (source.body.trim() === '') return `知识来源正文为空：${expectedPath}`
  if (source.kind !== 'prose' && source.kind !== 'table') return `知识来源正文类型无法核对：${expectedPath}`
  if (source.digest !== knowledgeDigest(source.body)) return `知识来源摘要与正文不一致：${expectedPath}`
  return ''
}

function allowedKnowledgeLinks(links: WikiLink[]): WikiLink[] {
  const seen = new Set<string>()
  const allowed: WikiLink[] = []
  for (const link of links) {
    if (link.kind !== 'knowledge' || typeof link.path !== 'string' || link.path.trim() === '') continue
    if (seen.has(link.path)) continue
    seen.add(link.path)
    allowed.push(link)
  }
  return allowed
}

/** Reject a selection before any selected body is read. */
function selectionProblem(
  selection: WorkflowKnowledgeSelection | null | undefined,
  entrySource: KnowledgeSourceRecord,
): string {
  if (selection === undefined || selection === null || typeof selection !== 'object') {
    return '知识来源选择没有返回结果'
  }
  if (selection.ok !== true) return safeError(selection.error, '知识来源选择未完成')
  if (typeof selection.entryDigest !== 'string' || selection.entryDigest !== entrySource.digest) {
    return '知识来源选择引用的入口版本与已验真快照不一致'
  }
  if (!Array.isArray(selection.selections)) return '知识来源选择没有给出选择清单'
  if (!Array.isArray(selection.questions)) return '知识来源选择没有给出问题清单'
  return ''
}

/**
 * Structured outcome of one selection verification.
 *
 * `repairable` is true only when every problem is a quote that lacks the navigation
 * link for its own selected path: the single case the reader may ask the model to
 * correct. A stale root, an unregistered path, a forged quote or any malformed
 * entry is fatal and never retried.
 */
interface SelectionVerification {
  ok: boolean
  repairable: boolean
  error: string
}

function verifySelection(
  selection: WorkflowKnowledgeSelection,
  entrySource: KnowledgeSourceRecord,
  allowedLinks: WikiLink[],
): SelectionVerification {
  const fatal = (error: string): SelectionVerification => ({ ok: false, repairable: false, error })
  const problem = selectionProblem(selection, entrySource)
  if (problem !== '') return fatal(problem)
  const allowed = new Set(allowedLinks.map((link) => link.path))
  const roles = new Set<string>(KNOWLEDGE_ROLES)
  const seen = new Set<string>()
  let navigationError = ''
  for (const raw of selection.selections as unknown[]) {
    if (raw === null || typeof raw !== 'object') return fatal('知识来源选择包含无效条目')
    const item = raw as { path?: unknown; role?: unknown; quote?: unknown }
    const role = item.role
    if (typeof role !== 'string' || !roles.has(role)) return fatal(`知识来源选择包含未知角色：${String(role)}`)
    if (typeof item.path !== 'string' || !allowed.has(item.path)) {
      return fatal(`知识来源选择引用了未登记的路径：${String(item.path)}`)
    }
    if (typeof item.quote !== 'string' || item.quote.trim() === '' || !entrySource.body.includes(item.quote)) {
      return fatal(`知识来源选择引用的入口原文不存在：${item.path}`)
    }
    // A duplicate role+path is fatal even when the repeated quote is only prose: the
    // duplicate check must run before the repairable missing-link branch.
    const rolePath = `${role}\u0000${item.path}`
    if (seen.has(rolePath)) return fatal(`知识来源选择重复了角色与路径：${item.path}`)
    seen.add(rolePath)
    // The quote must itself contain the navigation link that resolves to this path.
    // A quote for a different valid link cannot authorize the selected document. A
    // quote that is genuine entry text but merely lacks its own link is the one
    // repairable problem; every other failure stays fatal.
    const quoteLinks = parseWikiLinks(item.quote, entrySource.path)
    if (!quoteLinks.some((link) => link.kind === 'knowledge' && link.path === item.path)) {
      if (navigationError === '') navigationError = `知识来源选择的原文没有指向所选文档：${item.path}`
      continue
    }
  }
  if (navigationError !== '') return { ok: false, repairable: true, error: navigationError }
  return { ok: true, repairable: false, error: '' }
}

/**
 * Create one reader bound to a single business library and entry document.
 */
export function createWorkflowKnowledgeReader(
  options: CreateWorkflowKnowledgeReaderOptions,
): WorkflowKnowledgeReader {
  const spaceName = String(options.spaceName ?? '').trim()
  const entryWikiPath = String(options.entryWikiPath ?? '').trim()
  let root: VerifiedRoot | null = null
  const bodies = new Map<string, KnowledgeSourceRecord>()
  const selections = new Map<string, WorkflowKnowledgeSelection>()

  const verifiedRoot = async (
    request: ValuationKnowledgeReadRequest,
  ): Promise<{ ok: true; root: VerifiedRoot } | { ok: false; error: string }> => {
    if (root !== null) return { ok: true, root }
    if (spaceName === '' || entryWikiPath === '') {
      return { ok: false, error: '知识读取缺少业务知识库身份或入口文档' }
    }
    let loaded: WorkflowKnowledgeDocument | undefined
    try {
      loaded = await options.loadDocument(entryWikiPath, request)
    } catch {
      return { ok: false, error: `知识入口文档加载失败：${entryWikiPath}` }
    }
    if (loaded === undefined || loaded.ok !== true) {
      return { ok: false, error: safeError(loaded?.error, `知识入口文档不可用：${entryWikiPath}`) }
    }
    const problem = sourceProblem(loaded.source, entryWikiPath, spaceName)
    if (problem !== '') return { ok: false, error: problem }
    const verified: VerifiedRoot = {
      source: loaded.source as KnowledgeSourceRecord,
      links: allowedKnowledgeLinks(Array.isArray(loaded.links) ? loaded.links : []),
    }
    root = verified
    return { ok: true, root: verified }
  }

  const verifiedBody = async (
    path: string,
    request: ValuationKnowledgeReadRequest,
  ): Promise<{ ok: true; source: KnowledgeSourceRecord } | { ok: false; error: string }> => {
    const cached = bodies.get(path)
    if (cached !== undefined) return { ok: true, source: cached }
    let loaded: WorkflowKnowledgeDocument | undefined
    try {
      loaded = await options.loadDocument(path, request)
    } catch {
      return { ok: false, error: `知识正文加载失败：${path}` }
    }
    if (loaded === undefined || loaded.ok !== true) {
      return { ok: false, error: safeError(loaded?.error, `知识正文不可用：${path}`) }
    }
    const problem = sourceProblem(loaded.source, path, spaceName)
    if (problem !== '') return { ok: false, error: problem }
    const source = loaded.source as KnowledgeSourceRecord
    bodies.set(path, source)
    return { ok: true, source }
  }

  const selectionFor = async (
    request: ValuationKnowledgeReadRequest,
    verified: VerifiedRoot,
  ): Promise<
    { ok: true; selection: WorkflowKnowledgeSelection }
    | { ok: false; error: string; gaps?: string[] }
  > => {
    const key = selectionContextKey(request)
    const cached = selections.get(key)
    if (cached !== undefined) return { ok: true, selection: cached }

    const attempt = async (correction?: { error: string }): Promise<WorkflowKnowledgeSelection | null> => {
      try {
        return await options.selectSources({
          request,
          entrySource: verified.source,
          allowedLinks: verified.links,
          ...(correction === undefined ? {} : { correction }),
        })
      } catch {
        return null
      }
    }
    const questionGaps = (selection: WorkflowKnowledgeSelection): string[] => selection.questions.filter(
      (question): question is string => typeof question === 'string' && question.trim() !== '',
    )

    const first = await attempt()
    if (first === null) return { ok: false, error: '知识来源选择调用失败' }
    // Malformed or failed selections are rejected before any question inspection,
    // so a non-array questions field can never crash the reader.
    const firstProblem = selectionProblem(first, verified.source)
    if (firstProblem !== '') return { ok: false, error: firstProblem }
    // Business questions are never a reason to re-ask the selector.
    const firstQuestions = questionGaps(first)
    if (firstQuestions.length > 0) {
      return { ok: false, error: '知识来源选择仍有未确认问题', gaps: firstQuestions }
    }
    const firstVerification = verifySelection(first, verified.source, verified.links)
    if (firstVerification.ok) {
      selections.set(key, first)
      return { ok: true, selection: first }
    }
    // Only a genuine entry quote that lacks its own navigation link may be corrected,
    // and only once. Everything else fails closed before any target body is read.
    if (!firstVerification.repairable) return { ok: false, error: firstVerification.error }
    const second = await attempt({ error: firstVerification.error })
    if (second === null) return { ok: false, error: '知识来源选择调用失败' }
    const secondProblem = selectionProblem(second, verified.source)
    if (secondProblem !== '') return { ok: false, error: secondProblem }
    const secondQuestions = questionGaps(second)
    if (secondQuestions.length > 0) {
      return { ok: false, error: '知识来源选择仍有未确认问题', gaps: secondQuestions }
    }
    const secondVerification = verifySelection(second, verified.source, verified.links)
    if (!secondVerification.ok) return { ok: false, error: secondVerification.error }
    selections.set(key, second)
    return { ok: true, selection: second }
  }

  const read = async (request: ValuationKnowledgeReadRequest): Promise<ValuationKnowledgeReadResult> => {
    const rootResult = await verifiedRoot(request)
    if (!rootResult.ok) return failure(rootResult.error)
    const selectionResult = await selectionFor(request, rootResult.root)
    if (!selectionResult.ok) return failure(selectionResult.error, selectionResult.gaps ?? [])

    const selection = selectionResult.selection
    const stageRoles = knowledgeRolesForStage(request.stage)
    const wanted = selection.selections.filter((item) => stageRoles.includes(item.role))
    if (wanted.length === 0) {
      return { ok: true, sources: [], gaps: ['当前阶段没有选中的知识正文'] }
    }

    const sources: KnowledgeSourceRecord[] = []
    const seen = new Set<string>()
    for (const item of wanted) {
      if (seen.has(item.path)) continue
      seen.add(item.path)
      const body = await verifiedBody(item.path, request)
      if (!body.ok) return failure(body.error)
      sources.push(body.source)
    }
    return { ok: true, sources }
  }

  return { stageAware: true, read }
}
