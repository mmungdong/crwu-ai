import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import type { Context } from '@deepseek-ai/cordis'
import { fileSystem, readTextIfExists } from '../../core/fs/paths.ts'
import {
  KNOWLEDGE_INDEX_FILE,
  TEXT_EXTENSIONS,
  VALUATION_KNOWLEDGE_SPACE,
  parseKnowledgeIndex,
  resolveRoute,
  type CatalogFile,
  type KnowledgeCatalog,
  type KnowledgeIndexDocument,
  type KnowledgeRoute,
} from '../../domains/report-evaluation/knowledge/index.ts'
import { channelFor, firstArray, isFolder, type DwsNode } from '../../integrations/dws/knowledge-tree.ts'
import { type ToolDeps } from '../common/types.ts'
import { dwsJson } from '../report-audit/dws-json.ts'
import { readTree, spaceRefOf, SPACE_TYPES, type SpaceRef } from '../report-audit/knowledge.ts'

/**
 * 业务知识库**目录树**的读取（设计稿 §6.1，计划 Task 5）。
 *
 * 知识工具与模板工具都要"读一次树再按路由解析"，两份实现迟早会分叉 ——
 * 分叉的表现是同一次会话里"知识说这份在、模板说这份不在"。所以目录读取只在这里一份。
 *
 * 身份判据只有服务端返回的 `name` 逐字相等（远端没有可比的 manifest 摘要）：
 * 定位不到业务库时 `verified=false`，任何路由都是 `unreadable`，**不退到本地近似缓存**。
 */

/** 树读取与导出的超时（知识库端点慢，给足但不无限）。 */
export const TREE_TIMEOUT_MS = 10 * 60_000

/** 库内 `extension` → 落盘后缀。`adoc` 走导出通道，正文是 markdown（与观测到的缓存命名一致）。 */
export const SUFFIX_BY_EXTENSION: Record<string, string> = {
  adoc: 'md',
  md: 'md',
  txt: 'txt',
  xlsx: 'xlsx',
}

/** Host capabilities the knowledge readers need; Tools and reusable services share it. */
export interface KnowledgeCatalogDeps {
  access: ToolDeps['access']
  config?: unknown
  /** Stable plugin/runtime object used as the catalog-cache owner. */
  cacheOwner?: object
}

/** 配置里的知识镜像根；没配 / 旧配置没有这一节时为空串（= 不启用）。 */
export function knowledgeMirrorRootOf(deps: { config?: unknown }): string {
  const config = deps.config as { valuation?: { knowledge?: { mirrorRoot?: unknown } } } | undefined
  return text(config?.valuation?.knowledge?.mirrorRoot).trim()
}

/**
 * 配置里的**入口 Wiki** 库内路径（相对知识库根，posix）。
 *
 * 协议 39 起的唯一业务入口。它与技能 `references/knowledge-routing.md` 里声明的那一行
 * 指向同一份真实知识；放在配置里是为了让 Host 在会话开始前就能取到入口正文。
 */
export function knowledgeWikiPathOf(deps: { config?: unknown }): string {
  const config = deps.config as { valuation?: { knowledge?: { wikiPath?: unknown } } } | undefined
  return text(config?.valuation?.knowledge?.wikiPath).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 配置里的 manifest 库内路径（相对**知识库根**，posix；协议 39 起是**遗留**键）。 */
export function knowledgeManifestPathOf(deps: { config?: unknown }): string {
  const config = deps.config as { valuation?: { knowledge?: { manifestPath?: unknown } } } | undefined
  return text(config?.valuation?.knowledge?.manifestPath).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * manifest **所在目录**的库内路径（posix，去掉最后一段）。
 *
 * 这是 manifest 内路径的唯一基准（与 `manifestPath` 相对知识库根是**两条不同的基准**）。
 * 不用 `node:path`：这里的输入是知识库路径，不是文件系统路径，平台分隔符会把它拆错。
 */
export function knowledgeManifestDirOf(manifestPath: string): string {
  const normalized = text(manifestPath).replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? '' : normalized.slice(0, slash)
}

/**
 * manifest 槽位本身不是 manifest 声明的路由（它是入口），所以固定一个 routeId。
 * 正文以固定名落到案例目录，作为"这一轮依据的是哪一版取数口径"的留痕。
 */
export const MANIFEST_ROUTE_ID = 'manifest'
export const KNOWLEDGE_MANIFEST_FILE = '.知识目录.md'

function manifestRouteSpec(manifestPath: string): KnowledgeRoute {
  return { routeId: MANIFEST_ROUTE_ID, path: manifestPath, kind: 'document', extensions: TEXT_EXTENSIONS }
}

export interface ManifestRead {
  ok: boolean
  document: string
  error: string
}

/**
 * 取回 manifest 正文（**唯一真停**的入口）。
 *
 * 走的是与知识正文同一条 `dws` 通道，但落点固定：`知识快照/.知识目录.md`。
 * 于是"这次用的是哪一版取数口径"在案例目录里可核对，而不只是账上有个指纹。
 */
export async function loadKnowledgeManifest(options: {
  ctx: Context
  deps: KnowledgeCatalogDeps
  caseDir: string
  knowledgeDir: string
  platform: string
  catalog: KnowledgeCatalog
  signal?: AbortSignal
}): Promise<ManifestRead> {
  const { ctx, deps, knowledgeDir, platform, catalog, signal } = options
  const spec = manifestRouteSpec(knowledgeManifestPathOf(deps))
  if (spec.path === '') {
    return { ok: false, document: '', error: '配置里没有 valuation.knowledge.manifestPath：没有入口就无从知道该取哪些知识' }
  }
  const resolution = resolveRoute(catalog, spec)
  const document = resolution.documents.find((item) => item.empty !== true)
  if (resolution.state !== 'found' || document === undefined) {
    return { ok: false, document: '', error: `知识目录 manifest 未取到（${spec.path}）：${resolution.error}` }
  }
  if (document.body !== undefined) return { ok: true, document: document.body, error: '' }
  const { channel, reason } = channelFor(document.extension)
  if (channel === 'skipped') return { ok: false, document: '', error: reason }
  const argv = channel === 'export'
    ? ['doc', '+export', '--node', document.nodeId, '--export-format', 'markdown', '--output', KNOWLEDGE_MANIFEST_FILE, '--format', 'json']
    : ['drive', '+download', '--node', document.nodeId, '--output', KNOWLEDGE_MANIFEST_FILE, '--format', 'json']
  const run = await dwsJson(ctx, platform, argv, {
    workdir: knowledgeDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }),
  })
  if (!run.ok) return { ok: false, document: '', error: run.error }
  const body = await readTextIfExists(ctx, joinLocalPath(knowledgeDir, KNOWLEDGE_MANIFEST_FILE))
  if (body.trim() === '') {
    return { ok: false, document: '', error: `知识目录 manifest 正文为空（${spec.path}）：读不到入口不算"没有要求"` }
  }
  return { ok: true, document: body, error: '' }
}

/**
 * 目录树 → 取数用的目录事实。
 *
 * 路径按**落盘后缀**命名（`adoc` → `.md`，与知识库里观测到的名字一致），
 * 于是路由表里的逐字节点名可以在真实返回上直接匹配。
 */
export function catalogFromTree(
  roots: readonly DwsNode[],
  spaceName: string,
  failures: readonly { step: string; error: string }[],
): KnowledgeCatalog {
  const files: CatalogFile[] = []
  const folders = new Set<string>()
  const walk = (node: DwsNode, prefix: string): void => {
    const base = `${prefix}${node.name}`
    if (isFolder(node)) {
      folders.add(base)
      for (const child of node.children) walk(child, `${base}/`)
      return
    }
    const extension = text(node.extension).toLowerCase()
    const suffix = SUFFIX_BY_EXTENSION[extension] ?? extension
    const name = suffix !== '' && !node.name.toLowerCase().endsWith(`.${suffix}`) ? `${node.name}.${suffix}` : node.name
    const dir = prefix.replace(/\/+$/, '')
    if (dir !== '') folders.add(dir)
    files.push({ nodeId: node.nodeId, name, path: `${prefix}${name}`, extension, updatedAt: text(node.updatedAt) })
  }
  for (const root of roots) walk(root, '')
  return { spaceName, verified: text(spaceName) !== '', files, folders: [...folders], failures: [...failures] }
}

export interface KnowledgeCatalogRead {
  catalog: KnowledgeCatalog
  failures: Array<{ step: string; error: string }>
}

/**
 * Per-plugin, per-live-project verified catalog cache.
 *
 * Keyed by the `ToolDeps` object (shared by the knowledge + template tools of one plugin instance)
 * and a caller-provided scope key that pins the exact case/round/space. Only successful, complete,
 * verified reads are stored; failures and partial trees are never cached. Bound is 64 per plugin.
 * In-flight requests are never deduplicated, so a cancellation cannot poison another caller.
 */
const CATALOG_CACHE_LIMIT = 64
const CATALOG_CACHE = new WeakMap<object, Map<string, KnowledgeCatalogRead>>()

function catalogCacheOf(deps: KnowledgeCatalogDeps): Map<string, KnowledgeCatalogRead> {
  const owner = deps.cacheOwner ?? deps
  let map = CATALOG_CACHE.get(owner)
  if (map === undefined) {
    map = new Map()
    CATALOG_CACHE.set(owner, map)
  }
  return map
}

/** 读一次业务库目录树（按精确库名定位，名字来自 `space-list` 而不是目录名）。 */
export async function loadKnowledgeCatalog(options: {
  ctx: Context
  deps: KnowledgeCatalogDeps
  caseDir: string
  platform: string
  /** Exact live-scope key (project/round/space); empty disables reuse. */
  scopeKey?: string
  signal?: AbortSignal
}): Promise<KnowledgeCatalogRead> {
  const { ctx, deps, caseDir, platform, signal } = options
  const scopeKey = text(options.scopeKey).trim()
  const cache = scopeKey === '' ? null : catalogCacheOf(deps)
  const cached = cache?.get(scopeKey)
  if (cached !== undefined) return { catalog: cached.catalog, failures: [...cached.failures] }

  const failures: Array<{ step: string; error: string }> = []
  const spaces: SpaceRef[] = []
  let result: KnowledgeCatalogRead
  try {
    for (const type of SPACE_TYPES) {
      const listed = await dwsJson(ctx, platform, [
        'wiki', '+space-list', '--type', type, '--limit', '50', '--page-all', '--format', 'json',
      ], { workdir: caseDir, access: deps.access, source: 'audit-tool', timeoutMs: TREE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) })
      if (!listed.ok) {
        failures.push({ step: `space-list(${type})`, error: listed.error })
        continue
      }
      for (const row of firstArray(listed.payload, ['spaces', 'items', 'data']) ?? []) {
        const ref = spaceRefOf(row)
        if (ref === null || ref.name !== VALUATION_KNOWLEDGE_SPACE) continue
        if (!spaces.some((item) => item.workspaceId === ref.workspaceId)) spaces.push(ref)
      }
    }
    if (spaces.length === 0) {
      failures.push({ step: 'space-list', error: `未在组织或个人范围精确定位到知识库「${VALUATION_KNOWLEDGE_SPACE}」` })
    }
    const roots: DwsNode[] = []
    for (const space of spaces) {
      const tree = await readTree(ctx, platform, {
        workdir: caseDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }),
      }, space.workspaceId)
      for (const item of tree.failures) failures.push({ step: item.step, error: item.error })
      if (tree.truncated) failures.push({ step: 'node-list', error: '知识库节点超过遍历上限，结果可能不完整' })
      roots.push(...tree.roots)
    }
    result = { catalog: catalogFromTree(roots, spaces[0]?.name ?? '', failures), failures }
  } catch (error) {
    failures.push({ step: 'knowledge-tree', error: error instanceof Error ? error.message : String(error) })
    result = { catalog: catalogFromTree([], '', failures), failures }
  }
  // Only a complete, verified read is reusable; failed / partial trees are never cached.
  if (cache !== null && result.catalog.verified === true && result.failures.length === 0) {
    if (cache.size >= CATALOG_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(scopeKey, { catalog: result.catalog, failures: [...result.failures] })
  }
  return result
}

export interface PriorKnowledgeIndexRead {
  kind: 'absent' | 'ok' | 'invalid' | 'unreadable' | 'policy'
  index: KnowledgeIndexDocument | null
  error: string
}

export interface KnowledgeTargetCheck {
  ok: boolean
  error: string
}

/**
 * Canonical containment for a knowledge-snapshot target.
 *
 * Requires the snapshot root itself to sit inside the exact owned case, and the target to sit
 * inside that snapshot root. Lexical checks plus `contains(root, target)` alone are insufficient:
 * a symlinked snapshot root can be outside the case while still containing the target.
 */
export async function containKnowledgeTarget(options: {
  ctx: Context
  caseDir: string
  knowledgeDir: string
  relativePath: string
}): Promise<KnowledgeTargetCheck> {
  const fs = fileSystem(options.ctx)
  if (fs === undefined) return { ok: false, error: '宿主文件服务不可用' }
  try {
    const caseRoot = await fs.resolve(options.caseDir)
    const knowledgeRoot = await fs.resolve(options.knowledgeDir)
    if (fs.contains(caseRoot, knowledgeRoot) !== true) {
      return { ok: false, error: '知识快照目录不在本轮案例目录内' }
    }
    const target = await fs.resolve(joinLocalPath(options.knowledgeDir, options.relativePath))
    if (fs.contains(knowledgeRoot, target) !== true) {
      return { ok: false, error: '目标不在知识快照目录内' }
    }
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read and validate the persisted aggregate index **before any network read**.
 *
 * Distinguishes absent / invalid / unreadable / policy (wrong project or space). A malformed,
 * foreign or escaping index must stay untouched and must not let the caller refetch over it.
 */
export async function loadPriorKnowledgeIndex(options: {
  ctx: Context
  caseDir: string
  knowledgeDir: string
  projectId: string
  signal?: AbortSignal
}): Promise<PriorKnowledgeIndexRead> {
  const fs = fileSystem(options.ctx)
  if (fs === undefined) {
    return { kind: 'unreadable', index: null, error: '宿主文件服务不可用：读不到既有知识索引' }
  }
  const contained = await containKnowledgeTarget({
    ctx: options.ctx,
    caseDir: options.caseDir,
    knowledgeDir: options.knowledgeDir,
    relativePath: KNOWLEDGE_INDEX_FILE,
  })
  if (!contained.ok) {
    return { kind: 'unreadable', index: null, error: `既有知识索引不在本轮案例的知识快照目录内：${contained.error}` }
  }
  const target = joinLocalPath(options.knowledgeDir, KNOWLEDGE_INDEX_FILE)
  let raw: string
  try {
    const resolved = await fs.resolve(target)
    const info = await fs.stat(resolved)
    if (info === undefined) return { kind: 'absent', index: null, error: '' }
    raw = await fs.readText(resolved, options.signal)
  } catch (error) {
    return {
      kind: 'unreadable', index: null,
      error: `既有知识索引读不到：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const parsed = parseKnowledgeIndex(raw, {
    projectId: options.projectId,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
  })
  if (!parsed.ok) return { kind: parsed.kind, index: null, error: parsed.error }
  return { kind: 'ok', index: parsed.index, error: '' }
}
