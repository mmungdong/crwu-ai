/**
 * Production knowledge adapter for the valuation workflow.
 *
 * The business library is read through the real authorized materialization service:
 * one exact Wiki path per call with the legacy manifest explicitly omitted. Every
 * returned document is re-verified against its own snapshot bytes (library identity,
 * path, digest and non-empty body) before it becomes a source record, and verified
 * bodies are cached per instance so a stage change never re-exports the library.
 */
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { readTextIfExists } from '../../../core/fs/paths.ts'
import type {
  KnowledgeSourceRecord,
  ValuationInferencePort,
  ValuationInferenceRequest,
  ValuationKnowledgePort,
  ValuationKnowledgeReadRequest,
  ValuationKnowledgeReadResult,
} from '../../../domains/report-evaluation/workflow/ports.ts'
import {
  createWorkflowKnowledgeReader,
  knowledgeRolesForStage,
  type WorkflowKnowledgeDocument,
  type WorkflowKnowledgeSelection,
  type WorkflowKnowledgeSelectionInput,
} from '../../../domains/report-evaluation/knowledge/workflow.ts'
import type { WikiLink } from '../../../domains/report-evaluation/knowledge/wiki-links.ts'
import { parseWikiLinks } from '../../../domains/report-evaluation/knowledge/wiki-links.ts'
import { VALUATION_KNOWLEDGE_SPACE } from '../../../domains/report-evaluation/knowledge/route.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { cloneInitialInput } from '../../../domains/report-evaluation/workflow/input-context.ts'
import { runKnowledgeMaterialization } from '../services/knowledge.ts'
import type { ValuationServicePrincipal } from '../services/access.ts'
import type { HostWorkflowServiceDeps } from '../services/deps.ts'

const KNOWLEDGE_ROLES = ['common', 'rights', 'method', 'evidence', 'output'] as const
type KnowledgeRoleValue = (typeof KNOWLEDGE_ROLES)[number]

function isKnowledgeRole(value: string): value is KnowledgeRoleValue {
  return (KNOWLEDGE_ROLES as readonly string[]).includes(value)
}

function normalizeWikiPath(path: string): string {
  const normalized = text(path).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

function safeError(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** Bounded hop-1 discovery: root plus a small number of directly linked prose docs. */
const TEMPLATE_CATALOG_MAX_DOCUMENTS = 12

export interface WorkflowTemplateCatalog {
  /** Exact verified XLSX link paths, never guessed or fetched as prose. */
  paths: string[]
  /** Verified source records for the root and directly linked prose documents. */
  sources: KnowledgeSourceRecord[]
}

export interface CollectWorkflowTemplateCatalogOptions {
  entryWikiPath: string
  loadDocument: (
    path: string,
    request: ValuationKnowledgeReadRequest,
  ) => Promise<WorkflowKnowledgeDocument | undefined>
  /** When set, every source must belong to this exact business library. */
  spaceName?: string
  /** Caller's read identity; forwarded to the loader. */
  request?: ValuationKnowledgeReadRequest
  maxDocuments?: number
}

function catalogRequest(options: CollectWorkflowTemplateCatalogOptions): ValuationKnowledgeReadRequest {
  return options.request ?? {
    runId: '', revision: 0, stage: 'plan', objectId: '', mode: '', wikiPaths: [], knownSourceDigests: [],
  }
}

/** Re-verify a document's own body identity; a claimed digest or link list is never trusted. */
function verifiedCatalogSource(
  document: WorkflowKnowledgeDocument | undefined,
  expectedPath: string,
  spaceName: string,
): KnowledgeSourceRecord | null {
  if (document === undefined || document.ok !== true || document.source === undefined) return null
  const source = document.source
  if (typeof source.sourceId !== 'string' || source.sourceId.trim() === '') return null
  if (normalizeWikiPath(source.path) !== normalizeWikiPath(expectedPath)) return null
  if (spaceName !== '' && source.spaceName !== spaceName) return null
  if (typeof source.body !== 'string' || source.body.trim() === '') return null
  if (source.kind !== 'prose' && source.kind !== 'table') return null
  if (source.digest !== knowledgeDigest(source.body)) return null
  return source
}

/**
 * Follow the verified entry Wiki links at most one hop and collect exact XLSX paths.
 *
 * Every document is re-read from its actual body, re-verified by path, library and
 * recomputed SHA before its links are honoured. Forged digests, external links,
 * out-of-library paths and cycles are refused; XLSX targets are recorded but never
 * fetched as prose. Only the root and directly linked prose documents are loaded.
 */
export async function collectWorkflowTemplateCatalog(
  options: CollectWorkflowTemplateCatalogOptions,
): Promise<WorkflowTemplateCatalog> {
  const entryPath = normalizeWikiPath(options.entryWikiPath)
  if (entryPath === '') return { paths: [], sources: [] }
  const spaceName = text(options.spaceName)
  const request = catalogRequest(options)
  const requestedMax = options.maxDocuments
  const maxDocuments = typeof requestedMax === 'number' && Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(Math.floor(requestedMax), TEMPLATE_CATALOG_MAX_DOCUMENTS))
    : TEMPLATE_CATALOG_MAX_DOCUMENTS
  const paths: string[] = []
  const sources: KnowledgeSourceRecord[] = []
  const visited = new Set<string>()
  // Every attempted distinct document load (root included, failures included) consumes the
  // budget; failed reads must not let a broken link list drive unbounded materialization.
  let attempted = 0

  const load = async (
    path: string,
  ): Promise<{ source: KnowledgeSourceRecord; links: WikiLink[] } | null> => {
    const key = normalizeWikiPath(path)
    if (key === '' || visited.has(key)) return null
    if (attempted >= maxDocuments) return null
    visited.add(key)
    attempted += 1
    let document: WorkflowKnowledgeDocument | undefined
    try {
      document = await options.loadDocument(path, request)
    } catch {
      return null
    }
    const source = verifiedCatalogSource(document, path, spaceName)
    if (source === null) return null
    return { source, links: parseWikiLinks(source.body, source.path) }
  }

  const collectTemplates = (links: readonly WikiLink[]): void => {
    for (const link of links) {
      if (link.kind !== 'knowledge') continue
      const path = normalizeWikiPath(link.path)
      if (path === '' || !/\.xlsx$/i.test(path)) continue
      if (!paths.includes(path)) paths.push(path)
    }
  }

  const root = await load(entryPath)
  if (root === null) return { paths: [], sources: [] }
  sources.push(root.source)
  collectTemplates(root.links)

  for (const link of root.links) {
    if (link.kind !== 'knowledge') continue
    const path = normalizeWikiPath(link.path)
    if (path === '' || /\.xlsx$/i.test(path)) continue
    if (attempted >= maxDocuments) break
    const hopped = await load(path)
    if (hopped === null) continue
    sources.push(hopped.source)
    collectTemplates(hopped.links)
  }

  return { paths, sources }
}

export interface BuildWorkflowKnowledgeSelectionRequestInput {
  request: ValuationKnowledgeReadRequest
  entrySource: KnowledgeSourceRecord
  allowedLinks: WikiLink[]
  /**
   * Frozen user method request. It is forwarded verbatim and never derived from the
   * valuation-basis `mode`; absent stays null rather than defaulting to `auto`.
   */
  methodRequest?: string
  /** Present only on the single bounded correction attempt for a missing-navigation quote. */
  correction?: { error: string }
}

/**
 * Exact `{path, quote}` navigation lines taken from the verified entry body.
 *
 * Every line is parsed from its real bytes; only paths that are both knowledge
 * links and already-allowed links are emitted, first line per path, deduplicated.
 * No Markdown is manufactured and no external or unknown target is resolved.
 */
function navigationQuotesOf(
  entrySource: KnowledgeSourceRecord,
  allowedLinks: WikiLink[],
): Array<{ path: string; quote: string }> {
  const allowed = new Set(allowedLinks
    .filter((link) => link.kind === 'knowledge' && typeof link.path === 'string' && link.path !== '')
    .map((link) => link.path))
  if (allowed.size === 0) return []
  const found: Array<{ path: string; quote: string }> = []
  const seen = new Set<string>()
  for (const line of entrySource.body.split(/\r?\n/)) {
    if (line.trim() === '') continue
    for (const link of parseWikiLinks(line, entrySource.path)) {
      if (link.kind !== 'knowledge' || !allowed.has(link.path) || seen.has(link.path)) continue
      seen.add(link.path)
      found.push({ path: link.path, quote: line })
    }
  }
  return found
}

/**
 * Build the tool-free knowledge-selection inference request from the already admitted
 * context. The native request keeps the strict selection schema and the verified entry
 * body; materials are cloned so the caller's record is never shared.
 */
export function buildWorkflowKnowledgeSelectionRequest(
  input: BuildWorkflowKnowledgeSelectionRequestInput,
): ValuationInferenceRequest {
  const request = input.request
  const entry = input.entrySource
  const object = request.object
  const materials = (Array.isArray(request.materials) ? request.materials : []).map((material) => ({ ...material }))
  const initialInput = cloneInitialInput(request.initialInput)
  // A present canonical snapshot owns the method, including an explicit `null`;
  // the legacy option is only a fallback for a genuinely absent snapshot.
  const legacyMethodRequest = text(input.methodRequest)
  const methodRequest = initialInput !== null
    ? initialInput.methodRequest
    : (legacyMethodRequest === '' ? null : legacyMethodRequest)
  // Exact navigation lines let the model quote a real link line instead of prose.
  const navigationQuotes = navigationQuotesOf(entry, input.allowedLinks)
  const selectionCorrection = input.correction === undefined ? null : { error: input.correction.error }
  return {
    runId: request.runId === '' ? 'knowledge-selection' : request.runId,
    revision: request.revision,
    nodeId: 'knowledge-selection',
    stage: request.stage,
    attempt: 1,
    correlationId: `${request.runId}:knowledge-selection:${entry.digest}`,
    operation: 'knowledge-selection',
    materials,
    facts: {
      entryDigest: entry.digest,
      allowedLinks: input.allowedLinks.map((link) => link.path),
      objectId: request.objectId,
      mode: request.mode,
      userInput: text(request.userInput),
      object: object === undefined || object === null
        ? null
        : { objectId: text(object.objectId), useLabel: text(object.useLabel), areaSqm: object.areaSqm ?? null },
      assetType: request.assetType ?? null,
      purpose: text(request.purpose),
      baseDate: text(request.baseDate),
      promptSupplement: text(request.promptSupplement),
      stage: request.stage,
      applicableRoles: knowledgeRolesForStage(request.stage),
      methodRequest,
      initialInput,
      navigationQuotes,
      selectionCorrection,
    },
    knowledge: [{
      sourceId: entry.sourceId,
      path: entry.path,
      section: '',
      quote: entry.body.slice(0, 400),
      digest: entry.digest,
      body: entry.body,
    }],
  }
}

export interface CreateWorkflowKnowledgeAdapterOptions {
  deps: HostWorkflowServiceDeps
  /** Configured entry Wiki business path (relative to the business library root). */
  entryWikiPath: string
  /** Exact business library name; defaults to the configured valuation library. */
  spaceName?: string
  /** Live principal for the current genuine execution. */
  principal: () => ValuationServicePrincipal | undefined
  planId: () => string
  inference: ValuationInferencePort
  /** Frozen explicit method selection; never the valuation-basis `mode`. */
  methodRequest?: string
}

export interface WorkflowKnowledgeAdapter {
  port: ValuationKnowledgePort
  /** Verified document loader exposed to planning for template-directory navigation. */
  loadDocument: (path: string, request: ValuationKnowledgeReadRequest) => Promise<WorkflowKnowledgeDocument | undefined>
  /** Verified template-directory catalog: exact XLSX paths plus their source bodies. */
  templateCatalog: () => Promise<WorkflowTemplateCatalog>
  /** Exact XLSX paths the verified entry document links to; never guessed. */
  templatePaths: () => Promise<string[]>
}

export function createWorkflowKnowledgeAdapter(
  options: CreateWorkflowKnowledgeAdapterOptions,
): WorkflowKnowledgeAdapter {
  const spaceName = text(options.spaceName) || VALUATION_KNOWLEDGE_SPACE
  const entryWikiPath = normalizeWikiPath(options.entryWikiPath)
  const documents = new Map<string, WorkflowKnowledgeDocument>()

  const loadDocument = async (
    path: string,
    request: ValuationKnowledgeReadRequest,
  ): Promise<WorkflowKnowledgeDocument | undefined> => {
    const wikiPath = normalizeWikiPath(path)
    if (wikiPath === '') return { ok: false, error: '知识路径为空：拒绝读取业务库' }
    // The live principal is an execution-identity gate, not a cache concern: a cached
    // document may never bypass it on a later stage.
    const principal = options.principal()
    if (principal === undefined) {
      return { ok: false, error: '本轮工作流没有可用的受控执行：拒绝读取业务知识库' }
    }
    const cached = documents.get(wikiPath)
    if (cached !== undefined) return cached

    const outcome = await runKnowledgeMaterialization({
      wikiPaths: [wikiPath],
      omitManifest: true,
      planId: options.planId(),
    }, options.deps, principal)
    if (!outcome.ok || outcome.spaceVerified !== true) {
      return { ok: false, error: safeError(outcome.error, `业务知识库不可用：${wikiPath}`) }
    }
    if (outcome.spaceName !== spaceName) {
      return { ok: false, error: `知识来源不属于预期业务知识库（${spaceName}）：${wikiPath}` }
    }
    const entry = outcome.entries.find((item) => item.routeId === `wiki:${wikiPath}`
      || normalizeWikiPath(item.resolvedPath) === wikiPath)
    if (entry === undefined || entry.digest === '' || entry.bodyNonEmpty !== true) {
      return { ok: false, error: `业务库里没有这份可核对正文：${wikiPath}` }
    }
    const body = await readTextIfExists(options.deps.ctx, joinLocalPath(outcome.knowledgeDir, entry.snapshotFile))
    if (body.trim() === '' || knowledgeDigest(body) !== entry.digest) {
      return { ok: false, error: `知识正文与其快照摘要不一致：${wikiPath}` }
    }
    const links: WikiLink[] = entry.links.map((link) => ({
      label: link.label,
      target: link.target,
      path: link.path,
      anchor: link.anchor,
      kind: link.kind as WikiLink['kind'],
      error: link.error,
    }))
    const document: WorkflowKnowledgeDocument = {
      ok: true,
      source: {
        sourceId: `wiki:${wikiPath}`,
        spaceName,
        path: wikiPath,
        digest: entry.digest,
        body,
        kind: 'prose',
      },
      links,
    }
    documents.set(wikiPath, document)
    return document
  }

  const selectSources = async (input: WorkflowKnowledgeSelectionInput): Promise<WorkflowKnowledgeSelection> => {
    const entry = input.entrySource
    const inferenceRequest = buildWorkflowKnowledgeSelectionRequest({
      request: input.request,
      entrySource: entry,
      allowedLinks: input.allowedLinks,
      ...(options.methodRequest === undefined ? {} : { methodRequest: options.methodRequest }),
      ...(input.correction === undefined ? {} : { correction: input.correction }),
    })
    const result = await options.inference.infer(inferenceRequest)
    if (!result.ok || result.outputs === undefined) {
      return {
        ok: false,
        entryDigest: entry.digest,
        selections: [],
        questions: [],
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        error: result.error === undefined || result.error === '' ? '知识来源选择未完成' : result.error,
      }
    }
    const outputs = result.outputs
    const rawSelections = Array.isArray(outputs.selections) ? outputs.selections : []
    const selections: WorkflowKnowledgeSelection['selections'] = []
    for (const raw of rawSelections) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const record = raw as Record<string, unknown>
      const role = text(record.role)
      if (!isKnowledgeRole(role)) continue
      selections.push({ path: text(record.path), role, quote: text(record.quote) })
    }
    const rawQuestions = Array.isArray(outputs.questions) ? outputs.questions : []
    const questions = rawQuestions.map((question) => text(question)).filter((question) => question !== '')
    return {
      ok: true,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      entryDigest: text(outputs.entryDigest) || entry.digest,
      selections,
      questions,
    }
  }

  const reader = createWorkflowKnowledgeReader({
    spaceName,
    entryWikiPath,
    loadDocument,
    selectSources,
  })

  const port: ValuationKnowledgePort = {
    stageAware: true,
    read: (request): Promise<ValuationKnowledgeReadResult> => reader.read(request),
  }

  const templateRequest: ValuationKnowledgeReadRequest = {
    runId: '',
    revision: 0,
    stage: 'plan',
    objectId: '',
    mode: '',
    wikiPaths: [],
    knownSourceDigests: [],
  }

  const templateCatalog = async (): Promise<WorkflowTemplateCatalog> => {
    if (entryWikiPath === '') return { paths: [], sources: [] }
    return collectWorkflowTemplateCatalog({
      entryWikiPath,
      loadDocument,
      spaceName,
      request: templateRequest,
    })
  }

  const templatePaths = async (): Promise<string[]> => (await templateCatalog()).paths

  return { port, loadDocument, templateCatalog, templatePaths }
}
