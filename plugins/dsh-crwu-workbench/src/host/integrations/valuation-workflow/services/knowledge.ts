/**
 * Reusable authorized knowledge materialization service.
 *
 * This is the real business I/O behind `crwu_valuation_knowledge_materialize`: it
 * reads the configured business Wiki through the existing DWS/Broker channel, routes
 * and snapshots documents via the pure domain layer, preserves provenance/index
 * safety, and optionally parses structured rules. Registered Tools and the future
 * project runtime both call it; neither calls `Tool.execute`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { fileSystem, readTextIfExists } from '../../../core/fs/paths.ts'
import { isSafeIdSegment } from '../../../domains/report-evaluation/project/contracts.ts'
import {
  KNOWLEDGE_INDEX_DIR,
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  VALUATION_KNOWLEDGE_SPACE,
  knowledgeSnapshotDigest,
  loadVerifiedMirror,
  materializeKnowledge,
  parseRuleParameters,
  safeSnapshotRelative,
  wikiPathProblem,
  type KnowledgeManifest,
  type KnowledgeManifestEntry,
  type RouteDocument,
  type RuleParameterSet,
} from '../../../domains/report-evaluation/knowledge/index.ts'
import { channelFor } from '../../dws/knowledge-tree.ts'
import { knowledgeDigest, knowledgeFileName } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { dwsJson } from '../../../tools/report-audit/dws-json.ts'
import { ensureDirectory, writeCaseText } from '../../../tools/common/case-files.ts'
import { failure } from '../../../tools/common/outcome.ts'
import { VALUATION_TOOL_NAMES } from '../../../tools/report-evaluation/consts.ts'
import {
  containKnowledgeTarget,
  knowledgeManifestDirOf,
  knowledgeManifestPathOf,
  knowledgeMirrorRootOf,
  knowledgeWikiPathOf,
  loadKnowledgeCatalog,
  loadKnowledgeManifest,
  loadPriorKnowledgeIndex,
} from '../../../tools/report-evaluation/catalog.ts'
import { requireBoundValuationActor, type ValuationServicePrincipal } from './access.ts'
import type { HostWorkflowServiceDeps } from './deps.ts'

const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
const RULE_RECORD_FILE = '规则参数.json'

export interface MaterializeOutcome {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  knowledgeDir: string
  indexPath: string
  spaceName: string
  expectedSpaceName: string
  spaceVerified: boolean
  manifestDigest: string
  entryWikiPath: string
  availableRouteIds: string[]
  routeIds: string[]
  wikiPaths: string[]
  states: Array<{ routeId: string; state: string; error: string }>
  entries: Array<{
    routeId: string
    nodeName: string
    resolvedPath: string
    source: string
    digest: string
    snapshotFile: string
    bodyNonEmpty: boolean
    channel: string
    updatedAt: string
    links: Array<{ label: string; target: string; path: string; anchor: string; kind: string; error: string }>
  }>
  lookupAttempts: Array<{ routeId: string; channel: string; target: string; outcome: string; detail: string }>
  indexFiles: string[]
  digest: string
  capabilityGaps: string[]
  warnings: string[]
  failures: Array<{ step: string; error: string }>
  ruleParameters: RuleParameterSet
}

export function idleKnowledgeResult(): MaterializeOutcome {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', knowledgeDir: '', indexPath: '',
    spaceName: '', expectedSpaceName: VALUATION_KNOWLEDGE_SPACE, spaceVerified: false,
    manifestDigest: '', entryWikiPath: '', availableRouteIds: [], routeIds: [], wikiPaths: [],
    states: [], entries: [], lookupAttempts: [], indexFiles: [], digest: '',
    capabilityGaps: [], warnings: [], failures: [], ruleParameters: emptyRuleSet(),
  }
}

function emptyRuleSet(routeId = '', snapshotDigest = ''): RuleParameterSet {
  return {
    ok: false, error: '', errorKind: 'missing', routeId, ruleSetVersion: '',
    snapshotDigest, sectionId: '', effectiveFrom: null, effectiveTo: null,
    parameters: [], gaps: [],
  }
}

function toRuleRecord(set: RuleParameterSet): Record<string, unknown> {
  return {
    ruleSetVersion: set.ruleSetVersion,
    routeId: set.routeId,
    snapshotDigest: set.snapshotDigest,
    ...(set.sectionId === '' ? {} : { sectionId: set.sectionId }),
    effectiveFrom: set.effectiveFrom,
    effectiveTo: set.effectiveTo,
    parameters: set.parameters,
  }
}

interface RuleOutcome {
  ruleParameters: RuleParameterSet
  capabilityGap: string
}

async function collectRuleParameters(input: {
  ctx: Context
  knowledgeDir: string
  entries: readonly KnowledgeManifestEntry[]
  writeOptions: { session?: Session; signal?: AbortSignal }
}): Promise<RuleOutcome> {
  const parsedSets: RuleParameterSet[] = []
  for (const entry of input.entries) {
    if (!entry.bodyNonEmpty || entry.digest === '' || entry.routeId === '') continue
    const body = await readTextIfExists(input.ctx, joinLocalPath(input.knowledgeDir, entry.snapshotFile))
    if (knowledgeDigest(body) !== entry.digest) {
      parsedSets.push({
        ...emptyRuleSet(entry.routeId, entry.digest),
        errorKind: 'digest-mismatch',
        error: '知识正文字节与索引摘要不符：不得绑定规则参数',
        gaps: ['知识快照已发生变化：请重新物化后再读取规则参数'],
      })
      continue
    }
    if (body.trim() === '') continue
    parsedSets.push(parseRuleParameters({ routeId: entry.routeId, snapshotDigest: entry.digest, body }))
  }

  const rejected = parsedSets.find((item) => !item.ok && item.errorKind !== 'missing')
  if (rejected !== undefined) {
    return { ruleParameters: rejected, capabilityGap: `规则参数不可用：${rejected.error}` }
  }
  const eligible = parsedSets.filter((item) => item.ok)
  if (eligible.length > 1) {
    const set: RuleParameterSet = {
      ...emptyRuleSet(),
      errorKind: 'ambiguous',
      error: `有 ${String(eligible.length)} 份正文带结构化规则段：无法确定使用哪一份（不选第一份）`,
      gaps: [`同一轮快照出现多份规则段（${String(eligible.length)}）：需要业务侧只在一份正文里声明参数`],
    }
    return { ruleParameters: set, capabilityGap: `规则参数不可用：${set.error}` }
  }
  if (eligible.length === 1) {
    const parsed = eligible[0] as RuleParameterSet
    const written = await writeCaseText(
      input.ctx,
      joinLocalPath(input.knowledgeDir, RULE_RECORD_FILE),
      JSON.stringify(toRuleRecord(parsed), null, 2) + '\n',
      input.writeOptions,
    )
    if (!written.ok) {
      const set: RuleParameterSet = {
        ...emptyRuleSet(parsed.routeId, parsed.snapshotDigest),
        errorKind: 'infrastructure',
        error: `规则参数记录落盘失败：${written.error}`,
        gaps: ['规则参数没有持久化：不得据此认为参数可用'],
      }
      return { ruleParameters: set, capabilityGap: set.error }
    }
    return { ruleParameters: parsed, capabilityGap: '' }
  }

  const failed = parsedSets.length === 1 ? parsedSets[0] as RuleParameterSet : emptyRuleSet()
  const set: RuleParameterSet = failed.ok
    ? { ...emptyRuleSet(), error: '没有任何带结构化规则段的可核对正文' }
    : failed
  const detail = set.error !== '' ? set.error : '没有任何带结构化规则段的可核对正文'
  return { ruleParameters: set, capabilityGap: `规则参数不可用：${detail}` }
}

export interface KnowledgeMaterializationInput {
  routeIds?: unknown
  wikiPaths?: unknown
  planId?: unknown
  stage?: unknown
  spaceName?: unknown
  caseDir?: unknown
  /**
   * Explicitly omit the legacy manifest slot list. The graph's primary Wiki channel
   * sets this: an unrequested manifest is not a failed read.
   */
  omitManifest?: boolean
}

/**
 * Run one real knowledge materialization for a live-bound valuation actor.
 *
 * The caller must already have performed its transport-specific access check (the
 * registered Tool uses `requireCaseAccess`); this service independently rechecks the
 * live valuation scope and case/project binding before any I/O.
 */
export async function runKnowledgeMaterialization(
  input: KnowledgeMaterializationInput,
  deps: HostWorkflowServiceDeps,
  principal: ValuationServicePrincipal,
): Promise<MaterializeOutcome> {
  const ctx = deps.ctx
  const base = idleKnowledgeResult()

  // ① Parameter narrowing: any I/O starts only after this pass.
  const requestedSpace = text(input.spaceName).trim()
  if (requestedSpace !== '' && requestedSpace !== VALUATION_KNOWLEDGE_SPACE) {
    return {
      ...base,
      ...failure('policy',
        `业务库名只允许配置值「${VALUATION_KNOWLEDGE_SPACE}」，收到「${requestedSpace}」：`
        + '审核知识库与业务知识库不是同一个库，不接受改道。'),
    }
  }
  const requested: string[] = []
  for (const raw of Array.isArray(input.routeIds) ? input.routeIds : []) {
    const routeId = text(raw).trim()
    if (routeId !== '' && !requested.includes(routeId)) requested.push(routeId)
  }
  const wikiPaths: string[] = []
  for (const raw of Array.isArray(input.wikiPaths) ? input.wikiPaths : []) {
    const wikiPath = text(raw).trim()
    if (wikiPath !== '' && !wikiPaths.includes(wikiPath)) wikiPaths.push(wikiPath)
  }
  for (const wikiPath of wikiPaths) {
    const problem = wikiPathProblem(wikiPath)
    if (problem !== '') {
      return { ...base, ...failure('input', `Wiki 路径不能用：「${wikiPath}」：${problem}`) }
    }
  }
  const planId = text(input.planId).trim()
  if (planId !== '' && !isSafeIdSegment(planId)) {
    return { ...base, ...failure('input', `方案 id 必须是单段安全标识：「${planId}」`) }
  }
  const requestedStage = text(input.stage).trim()
  if (requestedStage !== '' && requestedStage !== 'parameters') {
    return { ...base, ...failure('input', `不支持的 stage：「${requestedStage}」（只支持 parameters）`) }
  }

  // ② Independent live scope binding: the service never trusts a caller boolean.
  const bound = requireBoundValuationActor(principal, { valuationScopes: deps.valuationScopes })
  if (!bound.ok) return { ...base, ...failure(bound.errorKind, bound.error) }
  const actor = bound.actor
  const caseDir = actor.caseDir
  const knowledgeDir = joinLocalPath(caseDir, KNOWLEDGE_SNAPSHOT_DIR)
  const projectId = actor.projectId
  const scopeKey = actor.scopeKey
  const ownedPlans = deps.valuationScopes?.scopeOf(actor.sessionId)?.planIds
  if (planId !== '' && Array.isArray(ownedPlans) && !ownedPlans.includes(planId)) {
    return {
      ...base, caseDir, knowledgeDir,
      ...failure('policy', `方案「${planId}」不属于本轮估值：不能把别的方案的知识快照写进来`),
    }
  }

  const platform = await deps.world.platform()
  const session = actor.session
  const signal = actor.signal
  const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }
  const failures: Array<{ step: string; error: string }> = []
  const catalogDeps = { access: deps.access, config: deps.config, ...(deps.cacheOwner === undefined ? {} : { cacheOwner: deps.cacheOwner }) }

  const made = await ensureDirectory(deps.access, knowledgeDir, { workdir: caseDir, platform, ...writeOptions })
  if (!made.ok) return { ...base, ...failure('infrastructure', made.error), caseDir, knowledgeDir }
  const routeDirs = [
    ...requested,
    ...wikiPaths.map((item) => `wiki:${item}`),
  ]
  for (const routeId of routeDirs) {
    const sub = await ensureDirectory(
      deps.access,
      joinLocalPath(knowledgeDir, knowledgeFileName(routeId)),
      { workdir: caseDir, platform, ...writeOptions },
    )
    if (!sub.ok) return { ...base, ...failure('infrastructure', sub.error), caseDir, knowledgeDir }
  }
  const indexDir = await ensureDirectory(deps.access, joinLocalPath(knowledgeDir, KNOWLEDGE_INDEX_DIR), { workdir: caseDir, platform, ...writeOptions })
  if (!indexDir.ok) return { ...base, ...failure('infrastructure', indexDir.error), caseDir, knowledgeDir }

  const priorRead = await loadPriorKnowledgeIndex({
    ctx, caseDir, knowledgeDir, projectId, ...(signal === undefined ? {} : { signal }),
  })
  if (priorRead.kind === 'invalid' || priorRead.kind === 'unreadable' || priorRead.kind === 'policy') {
    return {
      ...base, caseDir, knowledgeDir,
      ...failure(priorRead.kind === 'policy' ? 'policy' : 'infrastructure', priorRead.error),
    }
  }

  const { catalog, failures: catalogFailures } = await loadKnowledgeCatalog({
    ctx, deps: catalogDeps, caseDir, platform, scopeKey, ...(signal === undefined ? {} : { signal }),
  })
  failures.push(...catalogFailures)

  const mirrorRoot = knowledgeMirrorRootOf(deps)
  const manifestPath = knowledgeManifestPathOf(deps)
  // The graph's primary Wiki channel and the Tool's wiki-only call explicitly do not
  // request the legacy slot list: the pure resolver then never calls its loader.
  const manifestRequested = input.omitManifest !== true && !(wikiPaths.length > 0 && requested.length === 0)
  const manifest: KnowledgeManifest = await materializeKnowledge({
    projectId, planId, routeIds: requested, wikiPaths, manifestRequested,
  }, {
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    manifestDir: knowledgeManifestDirOf(manifestPath),
    loadManifest: () => loadKnowledgeManifest({
      ctx, deps: catalogDeps, caseDir, knowledgeDir, platform, catalog, ...(signal === undefined ? {} : { signal }),
    }),
    loadCatalog: async () => catalog,
    ...(priorRead.index === null ? {} : { priorIndex: priorRead.index }),
    readSnapshot: async (relativePath: string, binary: boolean) => {
      const fs = fileSystem(ctx)
      if (fs === undefined) return { ok: false, content: undefined, error: '宿主文件服务不可用' }
      if (!safeSnapshotRelative(relativePath)) {
        return { ok: false, content: undefined, error: '快照路径越界' }
      }
      const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath })
      if (!contained.ok) return { ok: false, content: undefined, error: contained.error }
      try {
        const resolved = await fs.resolve(joinLocalPath(knowledgeDir, relativePath))
        if (binary) {
          const bytes = await fs.readBytes(resolved, signal, SNAPSHOT_MAX_BYTES)
          return { ok: true, content: bytes }
        }
        return { ok: true, content: await fs.readText(resolved, signal) }
      } catch (error) {
        return { ok: false, content: undefined, error: error instanceof Error ? error.message : String(error) }
      }
    },
    ...(mirrorRoot === ''
      ? {}
      : { loadMirror: (route) => loadVerifiedMirror(route, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot }) }),
    readBody: async (document: RouteDocument) => {
      const { channel, reason } = channelFor(document.extension)
      if (channel === 'skipped') return { ok: false, error: reason }
      const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath: document.snapshotFile })
      if (!contained.ok) return { ok: false, bytes: new Uint8Array(0), error: `目标不在本轮案例的知识快照目录内：${contained.error}` }
      const slash = document.snapshotFile.indexOf('/')
      const routeDir = slash < 0 ? knowledgeDir : joinLocalPath(knowledgeDir, document.snapshotFile.slice(0, slash))
      const output = slash < 0 ? document.snapshotFile : document.snapshotFile.slice(slash + 1)
      const argv = channel === 'export'
        ? ['doc', '+export', '--node', document.nodeId, '--export-format', 'markdown', '--output', output, '--format', 'json']
        : ['drive', '+download', '--node', document.nodeId, '--output', output, '--format', 'json']
      const run = await dwsJson(ctx, platform, argv, {
        workdir: routeDir, access: deps.access, source: 'audit-tool',
        ...(signal === undefined ? {} : { signal }),
      })
      if (!run.ok) return { ok: false, bytes: new Uint8Array(0), error: run.error }
      return { ok: true, body: await readTextIfExists(ctx, joinLocalPath(knowledgeDir, document.snapshotFile)) }
    },
    readBinary: async (document: RouteDocument) => ({
      ok: false,
      bytes: new Uint8Array(0),
      error: `「${document.name}」是二进制模板，不按正文取回：请用 ${VALUATION_TOOL_NAMES.templateMaterialize}`,
    }),
    writeSnapshot: async (item) => {
      const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath: item.relativePath })
      if (!contained.ok) return { ok: false, error: contained.error }
      const written = await writeCaseText(
        ctx, joinLocalPath(knowledgeDir, item.relativePath), String(item.content), writeOptions,
      )
      return written.ok ? { ok: true, error: '' } : { ok: false, error: written.error }
    },
    writeIndex: async (item) => {
      const written = await writeCaseText(ctx, joinLocalPath(knowledgeDir, item.relativePath), item.document, writeOptions)
      return written.ok ? { ok: true, error: '' } : { ok: false, error: written.error }
    },
  })

  const digest = knowledgeSnapshotDigest(manifest.entries)
  const aggregateIndex = joinLocalPath(knowledgeDir, KNOWLEDGE_INDEX_FILE)
  const ruleOutcome: RuleOutcome = requestedStage === 'parameters'
    ? await collectRuleParameters({ ctx, knowledgeDir, entries: manifest.entries, writeOptions })
    : { ruleParameters: emptyRuleSet(), capabilityGap: '' }
  return {
    ok: manifest.ok,
    errorKind: manifest.errorKind,
    error: manifest.error,
    caseDir,
    knowledgeDir,
    indexPath: manifest.indexFiles.includes(KNOWLEDGE_INDEX_FILE) ? aggregateIndex : '',
    spaceName: manifest.spaceName,
    expectedSpaceName: manifest.expectedSpaceName,
    spaceVerified: manifest.spaceVerified,
    manifestDigest: manifest.manifestDigest,
    entryWikiPath: knowledgeWikiPathOf(deps),
    availableRouteIds: manifest.availableRouteIds,
    routeIds: manifest.routeIds,
    wikiPaths: manifest.wikiPaths,
    states: manifest.routes.map((route) => ({ routeId: route.routeId, state: route.state, error: route.error })),
    entries: manifest.entries.map((entry) => ({
      routeId: entry.routeId,
      nodeName: entry.nodeName,
      resolvedPath: entry.resolvedPath,
      source: entry.source,
      digest: entry.digest,
      snapshotFile: entry.snapshotFile,
      bodyNonEmpty: entry.bodyNonEmpty,
      channel: entry.channel,
      updatedAt: entry.updatedAt,
      links: entry.links.map((link) => ({
        label: link.label, target: link.target, path: link.path,
        anchor: link.anchor, kind: link.kind, error: link.error,
      })),
    })),
    lookupAttempts: manifest.lookupAttempts.map((attempt) => ({
      routeId: attempt.routeId,
      channel: attempt.channel,
      target: attempt.target,
      outcome: attempt.outcome,
      detail: attempt.detail,
    })),
    indexFiles: manifest.indexFiles,
    digest,
    capabilityGaps: [
      ...manifest.capabilityGaps,
      ...(ruleOutcome.capabilityGap === '' ? [] : [ruleOutcome.capabilityGap]),
    ],
    ruleParameters: ruleOutcome.ruleParameters,
    warnings: [
      ...manifest.warnings,
      ...(manifest.ok && manifest.wikiPaths.length === 0 && manifest.routeIds.length > 0
        ? [`本轮知识取数仍走**遗留的 manifest 槽位**（${knowledgeManifestPathOf(deps)}）：`
          + '协议 39 起的入口是配置里的 `valuation.knowledge.wikiPath` 指向的**入口 Wiki**，'
          + '按它的库内相对链接逐篇读取。请让维护者把知识库切成 Wiki 导航后再迁移本配置。']
        : []),
    ],
    failures,
  }
}
