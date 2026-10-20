import { text } from '../../../../shared/utils/value.ts'
import type { LookupAttempt } from '../../../../shared/contracts/valuation-project.ts'
import {
  BINARY_EXTENSIONS,
  KNOWLEDGE_INDEX_DIR,
  KNOWLEDGE_INDEX_FILE,
  TEXT_EXTENSIONS,
  extensionsForKind,
  type KnowledgeRoute,
  type RouteState,
} from './route.ts'
import {
  manifestRoutePath,
  parseValuationManifest,
  type ManifestRoute,
} from './manifest.ts'
import {
  byteLength,
  knowledgeDigest,
  knowledgeFileName,
  knowledgeSnapshotDigest,
  safeSnapshotRelative,
  toKnowledgeSourceDocument,
  type KnowledgeIndexDocument,
  type KnowledgeManifest,
  type KnowledgeManifestEntry,
  type KnowledgeRouteOutcome,
} from './snapshot.ts'
import type { MirrorOutcome } from './mirror.ts'
import { parseWikiLinks } from './wiki-links.ts'

/**
 * 知识路由的**决策与物化层**（设计稿 §4.1 / §4.3）。
 *
 * 两个入口：
 *
 * - `resolveRoute(catalog, spec)`：纯函数，在**一次目录树读数**上按库内路径解析。
 *   目录不是正文、多命中即 ambiguous、空正文返回未支持、身份未验证即 unreadable。
 * - `materializeKnowledge(input, deps)`：编排。先取 manifest（**唯一真停**：没入口就无从
 *   知道该取哪些知识），再按显式 routeId 取正文 / 落快照 / 写来源索引。远程明确缺失时
 *   才尝试身份已验证镜像（`empty` ≠ `missing`）。
 *
 * **不再有缺失恢复阶梯里的"必需项"概念**：除 manifest 本身读不到之外，任何一条 routeId
 * 没取到都只是如实记状态与缺口，不阻断其余 —— 规范越细，越容易在某个格子空着时把整个业务卡死。
 *
 * I/O 全部由 `deps` 注入：这一层不碰 shell、不碰 fs、不拼 dws 命令，于是"哪一份、从哪来、
 * 缺了算不算致命"能被穷尽单测，而不必先有一个可用的知识库。
 */

// ---------------------------------------------------------------------------
// 目录树读数（catalog）
// ---------------------------------------------------------------------------

/** 库内一个节点（文件）的结构化事实。`body` 未取过时为 `undefined`（≠ 空正文）。 */
export interface CatalogFile {
  /**
   * 服务端 nodeId（**Host 内部**：取数通道只认它；它不进任何模型可见结果）。
   * 目录镜像来源没有 nodeId，留空串。
   */
  nodeId?: string
  name: string
  /** 库内完整路径（逐字），文档带后缀。 */
  path: string
  /** 服务端 extension（小写）；缺失为空串。 */
  extension: string
  updatedAt: string
  /** 已取到的正文；`undefined` = 还没取过（**不是**空正文）。 */
  body?: string
  /** 服务端明确标记为空文档。 */
  empty?: boolean
  /** 二进制内容（模板）；`undefined` = 还没取。 */
  bytes?: Uint8Array
  mediaType?: string
}

/** 一次目录树读数。`verified === false` 时任何路由都不可用（身份不成立）。 */
export interface KnowledgeCatalog {
  /** **实际**读到的空间名（空串 = 没读到）。 */
  spaceName: string
  /** 空间身份是否已交叉验证（manifest 口径，不是目录名口径）。 */
  verified: boolean
  files: readonly CatalogFile[]
  /** 目录路径集合（不含尾斜杠）。 */
  folders: readonly string[]
  /** 目录树读取失败记录（非空 + 无候选 = unreadable，不是 missing）。 */
  failures: readonly { step: string; error: string }[]
}

/** 文件名去掉最后一个后缀。**只对文件名用**：`stemOf(完整路径)` 会连目录一起留下。 */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 路径的最后一段（文件名）。 */
function nameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

/** 所在目录（顶层为空串）。 */
function parentPathOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

// ---------------------------------------------------------------------------
// 节点身份的**显式映射**（连字符 ↔ 空格、全角 ↔ 半角）
// ---------------------------------------------------------------------------

/** 全角 ASCII（U+FF01–U+FF5E）与表意空格 → 半角；其余字符原样。 */
function foldWidth(segment: string): string {
  let out = ''
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else out += char
  }
  return out
}

/**
 * 库内节点的**身份键**：把"同一条路由的两种写法"折叠成同一个键。
 *
 * 只折叠两类**已观测到**的差异（`references/knowledge-routing.md` §2）：连字符 ↔ 空格、
 * 全角 ↔ 半角；连续分隔符折叠成一个。大小写、编号、后缀、去掉分隔符一律**不**折叠 ——
 * 折叠过头会把两条不同的规则当成同一条。
 *
 * 折叠是双向的（真实节点与声明路径各自折叠后比较），所以知识库把 `02-市场法` 改名成
 * `02 市场法`（或改回来）都不会让路由落空；两条真实节点只差这两种写法时折叠后**同键**，
 * 于是 `resolveRoute` 返回 `ambiguous` 而不是随便选一份。原始节点身份不受影响：
 * 命中的永远是库内真实路径（`RouteDocument.path` / `name` 逐字保留）。
 */
export function knowledgeIdentityKey(path: string): string {
  return text(path)
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => foldWidth(segment).trim().replace(/[-\s]+/g, '-'))
    .join('/')
}

interface IndexedFile {
  file: CatalogFile
  /** 完整路径的身份键。 */
  key: string
  /** 所属目录的身份键（顶层为空串）。 */
  parentKey: string
  /** 去后缀文件名的身份键。 */
  stemKey: string
}

interface CatalogIndex {
  /** 身份键 → 真实文件（多份 = 只差这两种写法的不同节点）。 */
  byKey: Map<string, IndexedFile[]>
  /** 身份键 → 真实目录路径（可能多个）。 */
  folderByKey: Map<string, string[]>
  /** `<目录身份键>\u0000<stem 身份键>` → 文件。 */
  byDirStemKey: Map<string, IndexedFile[]>
}

function buildIndex(catalog: KnowledgeCatalog): CatalogIndex {
  const byKey = new Map<string, IndexedFile[]>()
  const byDirStemKey = new Map<string, IndexedFile[]>()
  const folderPaths = new Set<string>()
  const add = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [value])
    else bucket.push(value)
  }
  for (const raw of catalog.folders) {
    const folder = raw.replace(/\/+$/, '')
    if (folder !== '') folderPaths.add(folder)
  }
  for (const file of catalog.files) {
    const parent = parentPathOf(file.path)
    if (parent !== '') folderPaths.add(parent)
    const indexed: IndexedFile = {
      file,
      key: knowledgeIdentityKey(file.path),
      parentKey: knowledgeIdentityKey(parent),
      stemKey: knowledgeIdentityKey(stemOf(file.name)),
    }
    add(byKey, indexed.key, indexed)
    add(byDirStemKey, `${indexed.parentKey}\u0000${indexed.stemKey}`, indexed)
  }
  const folderByKey = new Map<string, string[]>()
  for (const folder of [...folderPaths].sort()) {
    const key = knowledgeIdentityKey(folder)
    const bucket = folderByKey.get(key)
    if (bucket === undefined) folderByKey.set(key, [folder])
    else if (!bucket.includes(folder)) bucket.push(folder)
  }
  return { byKey, folderByKey, byDirStemKey }
}

function allowedExtension(spec: KnowledgeRoute, file: CatalogFile): boolean {
  // 服务端没报 extension 时按节点名兜底取最后一段；`apple-touch-icon` 这类无后缀名答不出后缀，
  // 于是不被任何路由接受 —— 保守方向正确。
  const extension = text(file.extension).toLowerCase() || nameOf(file.name).split('.').pop()?.toLowerCase() || ''
  return spec.extensions.includes(extension)
}

// ---------------------------------------------------------------------------
// 单条路由的解析
// ---------------------------------------------------------------------------

/** 一条路由命中的一份文档（正文或字节二选一）。 */
export interface RouteDocument {
  /** 服务端 nodeId（Host 内部；镜像来源为空串）。 */
  nodeId: string
  name: string
  path: string
  extension: string
  updatedAt: string
  channel: LookupAttempt['channel']
  source: 'dws' | 'verified-mirror'
  body: string | undefined
  bytes: Uint8Array | undefined
  empty: boolean
  mediaType: string
  /** 相对本方案 `知识快照/` 的落盘路径。 */
  snapshotFile: string
}

export interface RouteResolution {
  routeId: string
  state: RouteState
  documents: RouteDocument[]
  attempts: LookupAttempt[]
  error: string
  ok: boolean
}

/** 相对 `知识快照/` 的落点：`<routeId>/<安全节点名>`。 */
export function snapshotFileFor(spec: KnowledgeRoute, nodeName: string): string {
  // 路由段也要安全化（协议 39）：Wiki 路径通道的 routeId 形如 `wiki:01 …/01 …/wiki.md`，
  // 直接拼进落盘路径会建出一串嵌套目录，把"按路由隔离"变成"按库内目录结构散落"。
  // 槽位路由（`method.market.guide`）不含非法字符，落盘形状与从前逐字一致。
  return `${knowledgeFileName(spec.routeId)}/${knowledgeFileName(nodeName)}`
}

function documentOf(spec: KnowledgeRoute, file: CatalogFile, channel: LookupAttempt['channel']): RouteDocument {
  return {
    nodeId: text(file.nodeId),
    name: file.name,
    path: file.path,
    extension: file.extension,
    updatedAt: file.updatedAt,
    channel,
    source: 'dws',
    body: file.body,
    bytes: file.bytes,
    empty: file.empty === true,
    mediaType: text(file.mediaType),
    snapshotFile: snapshotFileFor(spec, file.name),
  }
}

/** 明显是空正文（服务端标记，或已经读到的正文去掉空白后为空）。 */
function knownEmpty(document: RouteDocument): boolean {
  if (document.empty) return true
  if (typeof document.body === 'string') return document.body.trim() === ''
  return false
}

/**
 * 在**一次目录树读数**上按**库内路径**解析一条路由。
 *
 * 阶梯只有两级，每一级都留痕：
 *
 * ```text
 * ① 声明的库内路径（含折叠后的命名变体：连字符 ↔ 空格、全角 ↔ 半角）
 * ② 同目录同名（后缀可以不同，按声明的后缀逐个试）
 * ```
 *
 * 镜像（③）由 `materializeKnowledge` 在**远程明确缺失**时另行尝试。
 */
export function resolveRoute(catalog: KnowledgeCatalog, spec: KnowledgeRoute): RouteResolution {
  const attempts: LookupAttempt[] = []
  const note = (
    channel: LookupAttempt['channel'],
    target: string,
    outcome: LookupAttempt['outcome'],
    detail: string,
  ): void => {
    attempts.push({ routeId: spec.routeId, channel, target, outcome, detail })
  }
  const stop = (state: RouteState, error: string, documents: RouteDocument[] = []): RouteResolution => ({
    routeId: spec.routeId,
    state,
    documents,
    attempts,
    error,
    ok: state === 'found' && documents.some((document) => !knownEmpty(document)),
  })

  // ⓪ 身份：目录名相符**不**构成证明。
  if (catalog.verified !== true) {
    const actual = text(catalog.spaceName)
    note('dws-tree', actual === '' ? '(未读到业务库)' : actual, 'rejected-identity',
      `知识库身份未验证（实际 space=${actual === '' ? '未知' : actual}）：目录名相符不构成身份证明`)
    return stop('unreadable', `知识库身份未验证：实际空间「${actual === '' ? '未知' : actual}」不是业务库`)
  }

  const index = buildIndex(catalog)
  const canonical = spec.path
  const canonicalKey = knowledgeIdentityKey(canonical)

  const conclude = (files: readonly CatalogFile[], channel: LookupAttempt['channel']): RouteResolution => {
    const documents = files.map((file) => documentOf(spec, file, channel))
    const nonEmpty = documents.filter((document) => !knownEmpty(document))
    if (nonEmpty.length === 0) {
      note(channel, canonical, 'empty',
        `命中节点但正文为空：${documents.map((document) => document.name).join('、')}（空文档返回未支持）`)
      return stop('empty', `命中的知识正文为空（空文档返回未支持）：${documents.map((document) => document.name).join('、')}`, documents)
    }
    note(channel, canonical, 'found', `命中 ${nonEmpty.length} 份非空知识`)
    return stop('found', '', documents)
  }

  // ① 声明的库内路径（含折叠后的命名变体）。
  const bucket = (index.byKey.get(canonicalKey) ?? []).filter((item) => allowedExtension(spec, item.file))
  if (bucket.length > 1) {
    note('exact-route', canonical, 'ambiguous',
      `声明路径折叠后命中 ${bucket.length} 个真实节点（不选第一份）：${bucket.map((item) => item.file.path).join('、')}`)
    return stop('ambiguous', `同路径多命中（${bucket.length} 个节点）：${bucket.map((item) => item.file.path).join('、')}`)
  }
  const hit = bucket[0]
  if (hit !== undefined) {
    // 精确命中之后仍要确认"同目录同名只有一份"：`02 市场法.md` 与 `02 市场法.adoc` 同时存在时
    // 是两个候选，不许因为声明了后缀就悄悄选一份。
    const sameDirStem = (index.byDirStemKey.get(`${hit.parentKey}\u0000${hit.stemKey}`) ?? [])
      .filter((item) => allowedExtension(spec, item.file))
    if (sameDirStem.length > 1) {
      note('exact-route', canonical, 'ambiguous', `同目录同名命中 ${sameDirStem.length} 份（不选第一份）`)
      return stop('ambiguous', `同目录同名多命中（${sameDirStem.length} 份）：${sameDirStem.map((item) => item.file.path).join('、')}`)
    }
    if (hit.file.path !== canonical) {
      note('exact-route', canonical, 'found',
        `命名变体命中：声明「${canonical}」→ 实际节点「${hit.file.path}」（连字符/空格/全角按声明折叠）`)
    }
    return conclude([hit.file], 'exact-route')
  }

  // 同名目录：声明的是文档，库里只有同名目录。**目录不是正文**，文件夹标题不能当规范。
  const siblingFolders = index.folderByKey.get(canonicalKey) ?? []
  if (siblingFolders.length > 0) {
    note('exact-route', canonical, 'empty', `命中同名目录：${siblingFolders.join('、')}（目录不是正文，文件夹标题不能当规范）`)
    return stop('empty', `命中的是目录而不是文档：${siblingFolders.join('、')}`)
  }

  // ② 同目录同名（后缀可以不同）。`stem` 只取**文件名**去后缀：整条路径去后缀会连目录一起留下。
  const stem = stemOf(nameOf(canonical))
  const dirKey = knowledgeIdentityKey(parentPathOf(canonical))
  const hits = (index.byDirStemKey.get(`${dirKey}\u0000${knowledgeIdentityKey(stem)}`) ?? [])
    .filter((item) => allowedExtension(spec, item.file))
  if (hits.length > 1) {
    note('same-name', `${parentPathOf(canonical)}/${stem}.*`, 'ambiguous', `同目录同名命中 ${hits.length} 份（不选第一份）`)
    return stop('ambiguous', `同目录同名多命中（${hits.length} 份）：${hits.map((item) => item.file.path).join('、')}`)
  }
  if (hits.length === 1) {
    const sameStem = hits[0] as IndexedFile
    note('same-name', `${parentPathOf(canonical)}/${stem}.*`, 'found', `同目录同名命中：${sameStem.file.path}`)
    return conclude([sameStem.file], 'same-name')
  }
  note('same-name', `${parentPathOf(canonical)}/${stem}.*`, 'missing', '目标目录下没有同名文档')

  // 两级都没有：目录树读取失败时是 unreadable（**探测失败 ≠ 节点不存在**）。
  const failures = catalog.failures.filter((failure) => text(failure.error) !== '')
  if (failures.length > 0) {
    const detail = failures.map((failure) => `${failure.step}: ${failure.error}`).join('；')
    note('dws-tree', canonical, 'unreadable', `目录树读取失败：${detail}`)
    return stop('unreadable', `知识库目录树读取失败：${detail}`)
  }
  return stop('missing', `库内不存在这个节点：${canonical}`)
}

// ---------------------------------------------------------------------------
// materializeKnowledge
// ---------------------------------------------------------------------------

/** manifest 的一条槽位 → 取数路由（把 manifest 内的相对路径拼成库内完整路径）。 */
export function toKnowledgeRoute(manifestDir: string, route: ManifestRoute): KnowledgeRoute {
  return {
    routeId: route.routeId,
    path: manifestRoutePath(manifestDir, route),
    kind: route.kind,
    extensions: extensionsForKind(route.kind),
  }
}

export interface KnowledgeMaterializeInput {
  projectId: string
  planId?: string | null
  /**
   * 要物化的 routeId（manifest 声明的槽位）——**遗留通道**。
   *
   * 协议 39 起业务知识由**入口 Wiki + 库内相对路径链接**驱动（见 `wikiPaths`）。
   * 这条通道保留一代：老会话 / 老提示词仍按槽位取数，取到时会在 `warnings` 里
   * 说明已迁移到 Wiki 路径读取。
   *
   * **两个都省略 = 只回报本库声明了哪些槽位**，不落任何正文。
   */
  routeIds?: readonly string[]
  /**
   * **Wiki 路径通道**（协议 39 的主通道）：库内逐字路径，Agent 按入口 Wiki 里的相对链接
   * 自己走出来（入口 Wiki 本身也在这一串里）。
   *
   * 与 `routeIds` 的区别是**谁决定取什么**：
   *
   * - `routeIds` 由 manifest 的槽位表决定 —— 换一条业务路径就要改 manifest，而 manifest
   *   是代码侧的键位映射；业务侧的正文写得再细，Agent 也只能拿到槽位表允许的那几份；
   * - `wikiPaths` 由**业务侧正文**决定：入口 Wiki 写到哪、链接指向哪，Agent 就能读到哪。
   *   路径按库内**完整路径**匹配，与槽位通道共用同一套折叠口径（容忍知识库的命名漂移：
   *   大小写、全半角、后缀写法），但**没有**前缀 / 模糊 / 相似度匹配 ——
   *   猜出来的路径会安静地取到另一份规范，而结果看起来完全正常。
   *
   * 给了 `wikiPaths` 就**不**要求 manifest 可读：manifest 读不到只是"没有槽位清单可回报"，
   * 不再是把整轮业务卡死的唯一真停。
   */
  wikiPaths?: readonly string[]
  /**
   * Whether the legacy manifest slot list is actually requested.
   *
   * Defaults to `true` (legacy callers). An explicit primary-Wiki caller may set
   * `false`: the loader is then never invoked and the result must not describe the
   * unrequested manifest as missing/failed.
   */
  manifestRequested?: boolean
}

export interface KnowledgeMaterializeDeps {
  /** 期望的业务库名（配置口径）。 */
  spaceName: string
  /**
   * manifest **所在目录**的库内路径（`manifestPath` 去掉文件名）。
   *
   * 路径基准的唯一落点：manifest 内的路径相对它拼。与 `manifestPath`（相对知识库根）
   * 是两条不同的基准，不得混用。
   */
  manifestDir: string
  /** 读一次业务库目录树（缓存由调用方负责）。 */
  loadCatalog(): Promise<KnowledgeCatalog>
  /** 取回 manifest 正文。读不到就是**唯一真停**。 */
  loadManifest(): Promise<{ ok: boolean; document: string; error?: string }>
  /** 取一份文档正文（dws 通道）。 */
  readBody(document: RouteDocument): Promise<{ ok: boolean; body?: string; error?: string }>
  /** 取二进制（模板）；未装配时由调用方返回 `ok:false` + 缺口说明。 */
  readBinary?(document: RouteDocument): Promise<{ ok: boolean; bytes: Uint8Array; error?: string }>
  /** 把正文 / 二进制落到 `知识快照/` 下（`relativePath` 相对它）。 */
  writeSnapshot(input: { relativePath: string; content: string | Uint8Array; binary: boolean }): Promise<{ ok: boolean; error?: string }>
  /** 落一条来源索引（`relativePath` 相对 `知识快照/`）。 */
  writeIndex(input: { relativePath: string; document: string }): Promise<{ ok: boolean; error?: string }>
  /** 远程**明确缺失**时的镜像恢复；未配置镜像时必须返回 `ok:false`。 */
  loadMirror?(route: KnowledgeRoute): Promise<MirrorOutcome>
  /**
   * Existing aggregate index, already read and validated by the caller. Enables verified reuse
   * (no repeat export) and cumulative aggregate/per-route writes. Absent/undefined keeps the
   * legacy always-fetch behavior.
   */
  priorIndex?: KnowledgeIndexDocument | null
  /**
   * Read a persisted snapshot for reuse verification by content (never trust a caller digest).
   * Required for reuse; when absent, a matching prior entry fails closed instead of refetching.
   */
  readSnapshot?(relativePath: string, binary: boolean): Promise<{ ok: boolean; content?: string | Uint8Array; error?: string }>
  now?: () => Date
}

const IDLE_MANIFEST: Omit<KnowledgeManifest, 'projectId' | 'planId' | 'expectedSpaceName' | 'materializedAt'> = {
  schemaVersion: 'crwu.valuation.knowledge-source.v1',
  spaceName: '',
  spaceVerified: false,
  manifestDigest: '',
  availableRouteIds: [],
  routeIds: [],
  wikiPaths: [],
  warnings: [],
  entries: [],
  routes: [],
  lookupAttempts: [],
  indexFiles: [],
  mirrorRoot: null,
  capabilityGaps: [],
  ok: false,
  error: '',
  errorKind: '',
}

function nowIso(deps: KnowledgeMaterializeDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function emptyManifest(
  input: KnowledgeMaterializeInput,
  deps: KnowledgeMaterializeDeps,
  error: string,
  errorKind: KnowledgeManifest['errorKind'],
): KnowledgeManifest {
  return {
    ...IDLE_MANIFEST,
    projectId: text(input.projectId),
    planId: text(input.planId) === '' ? null : text(input.planId),
    expectedSpaceName: text(deps.spaceName),
    routeIds: [...(input.routeIds ?? [])],
    error,
    errorKind,
    materializedAt: nowIso(deps),
  }
}

function mirrorDocumentOf(spec: KnowledgeRoute, document: MirrorOutcome['documents'][number]): RouteDocument {
  const binary = spec.kind === 'binary'
  return {
    nodeId: '',
    name: document.name,
    path: document.relativePath,
    extension: document.extension,
    updatedAt: document.updatedAt,
    channel: 'mirror',
    source: 'verified-mirror',
    // 镜像正文已经读进来了（逐字节验过 digest），绝不再回业务库取一次。
    body: binary ? undefined : new TextDecoder().decode(document.bytes),
    bytes: binary ? document.bytes : undefined,
    empty: false,
    mediaType: document.mediaType,
    snapshotFile: snapshotFileFor(spec, document.name),
  }
}

/**
 * 把 manifest 声明的知识物化到案例目录。
 *
 * 顺序：读一次目录树 → 取 manifest（**读不到即停**）→ 解析 → 逐 routeId 解析（含镜像恢复）
 * → 逐份验正文非空并落盘 → 写来源索引。
 *
 * **`ok` 只由"索引落盘"决定**。逐条 routeId 取到与否如实进 `routes[]` / `capabilityGaps[]`，
 * 不阻断其余 —— 单一方法正文缺失只影响用该方法的方案，模板缺失只影响该方案的填表。
 */
/**
 * 由**库内相对路径**推出取数槽位（协议 39 的 Wiki 路径通道）。
 *
 * 与 manifest 槽位的唯一区别是"谁起的名字"：这里路由 id 就是路径本身（前缀 `wiki:`），
 * 所以结果里能一眼看出这条知识是**按链接走到的**、还是按槽位表取到的。
 *
 * 返回 `null` 表示路径不可用（空 / 绝对路径 / 带 `..` / 后缀不在允许范围）——
 * 调用方据此如实拒绝，**不**去猜一个相近的路径。
 */
export function wikiRouteFromPath(path: string): KnowledgeRoute | null {
  const raw = text(path).trim().replace(/\\/g, '/')
  if (raw === '' || raw.startsWith('/') || raw.startsWith('~')) return null
  // `..` 会跳出知识库根：库内相对路径不允许带它（链接解析那一层已经拦过，这里是第二道）。
  if (raw.split('/').some((segment) => segment === '..' || segment === '.')) return null
  const lower = raw.toLowerCase()
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (extension === '') return null
  const binary = BINARY_EXTENSIONS.includes(extension)
  if (!binary && !TEXT_EXTENSIONS.includes(extension)) return null
  return {
    routeId: `wiki:${raw}`,
    path: raw,
    kind: binary ? 'binary' : 'document',
    // Document shape accepts any text extension: a `.md` export link must resolve a real
    // `adoc` node (and vice versa). Binary shape stays exact.
    extensions: binary ? [extension] : TEXT_EXTENSIONS,
  }
}

/**
 * Pre-I/O lexical check for a business-Wiki-relative path.
 *
 * Returns `''` when usable, otherwise a short reason. This runs before any catalog read so unsafe
 * paths (absolute / traversal / URL / drive-letter / unknown suffix) never reach the network.
 */
export function wikiPathProblem(path: string): string {
  const raw = text(path).trim().replace(/\\/g, '/')
  if (raw === '') return '路径为空'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return '不能是网址'
  if (raw.startsWith('/') || raw.startsWith('~')) return '不能是绝对路径'
  if (/^[a-zA-Z]:\//.test(raw)) return '不能是盘符路径'
  if (raw.split('/').some((segment) => segment === '..' || segment === '.')) return '不能包含 . 或 .. 片段'
  const lower = raw.toLowerCase()
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (extension === '') return '必须带允许的后缀'
  if (!BINARY_EXTENSIONS.includes(extension) && !TEXT_EXTENSIONS.includes(extension)) {
    return `后缀 ${extension} 不在允许范围内`
  }
  return ''
}

export async function materializeKnowledge(
  input: KnowledgeMaterializeInput,
  deps: KnowledgeMaterializeDeps,
): Promise<KnowledgeManifest> {
  const expectedSpace = text(deps.spaceName)
  const catalog = await deps.loadCatalog()
  const actualSpace = text(catalog.spaceName)
  const spaceVerified = catalog.verified === true && actualSpace === expectedSpace

  const requestedWikiPaths = (input.wikiPaths ?? [])
    .map((item) => text(item).trim())
    .filter((item, index, list) => item !== '' && list.indexOf(item) === index)
  const usesWikiPaths = requestedWikiPaths.length > 0

  // manifest 是**遗留通道**的槽位表：它是**被请求时**才读的输入，不是无条件真停。
  // ⚠️ 协议 39 起它**不是**真停：走 Wiki 路径通道时不要求它可读，读不到只是没有槽位清单可回报。
  // 显式声明"不请求"时**不调用加载器**，也不把未请求写成"读不到/失败"。
  const manifestRequested = input.manifestRequested !== false
  const loaded = manifestRequested
    ? await deps.loadManifest()
    : { ok: false, document: '', error: '' }
  const warnings: string[] = []
  const parsed = loaded.ok ? parseValuationManifest(text(loaded.document)) : null
  const specs: KnowledgeRoute[] = parsed !== null && parsed.ok
    ? parsed.routes.map((route) => toKnowledgeRoute(deps.manifestDir, route))
    : []
  if (!manifestRequested) {
    if (usesWikiPaths) {
      warnings.push(`本轮显式声明不读取遗留 manifest；按 Wiki 路径读取（${String(requestedWikiPaths.length)} 条），`
        + '槽位清单不回报。')
    } else {
      return emptyManifest(input, deps,
        '调用方显式声明不读取遗留 manifest，且没有给出 Wiki 路径：没有可用的知识入口',
        'capability-gap')
    }
  } else if (!loaded.ok || parsed === null || !parsed.ok) {
    const why = parsed === null || !loaded.ok
      ? `知识目录 manifest 读不到：${text(loaded.error)}`
      : `知识目录 manifest 不可用：${parsed.error}`
    if (usesWikiPaths) {
      // 走 Wiki 路径通道时这只影响"槽位清单"，不影响能不能取到正文 —— 如实记一条警告。
      warnings.push(`${why}；本轮按 Wiki 路径读取（${String(requestedWikiPaths.length)} 条），`
        + '槽位清单不可回报。')
    } else {
      return emptyManifest(input, deps, `${why}（唯一真停：既没有 manifest 也没有 Wiki 路径）`, 'capability-gap')
    }
  }
  if (usesWikiPaths && specs.length > 0) {
    // 两条通道同时给：不去猜"用户想要哪一条"，逐条都取，但把这件事说出来。
    if ((input.routeIds ?? []).length > 0) {
      warnings.push('同时给了 routeIds 与 wikiPaths：两条通道都会取，结果里逐条标明来源。')
    }
    warnings.push('按 Wiki 路径读取：槽位清单仍会回报，但取哪些知识由业务侧正文决定。')
  }
  const specById = new Map(specs.map((spec) => [spec.routeId, spec]))
  const availableRouteIds = specs.map((spec) => spec.routeId).sort()

  const manifest: KnowledgeManifest = {
    ...IDLE_MANIFEST,
    projectId: text(input.projectId),
    planId: text(input.planId) === '' ? null : text(input.planId),
    // **实际** space：读到了就写实际值（可能是审核库，也可能是空串）。
    spaceName: actualSpace === '' ? expectedSpace : actualSpace,
    expectedSpaceName: expectedSpace,
    spaceVerified,
    manifestDigest: loaded.ok ? knowledgeDigest(text(loaded.document)) : '',
    availableRouteIds,
    materializedAt: nowIso(deps),
  }

  const requested: string[] = []
  for (const raw of input.routeIds ?? []) {
    const routeId = text(raw).trim()
    if (routeId === '' || requested.includes(routeId)) continue
    if (!specById.has(routeId)) {
      return {
        ...manifest,
        routeIds: requested,
        error: `manifest 没有声明这条槽位：「${routeId}」。本库声明了：${availableRouteIds.join('、')}`,
        errorKind: 'input',
      }
    }
    requested.push(routeId)
  }

  // **Wiki 路径通道**：路径本身推出槽位（`wiki:<路径>`）与形态（按后缀分文本 / 二进制）。
  // 逐字匹配库内节点名 —— 不折叠大小写、不做模糊匹配：折叠会把两份不同的规范并成一份，
  // 而"取到了别的规范"读起来完全正常。
  for (const wikiPath of requestedWikiPaths) {
    const spec = wikiRouteFromPath(wikiPath)
    if (spec === null) {
      return {
        ...manifest,
        routeIds: requested,
        wikiPaths: requestedWikiPaths,
        error: `Wiki 路径不能用：「${wikiPath}」。它必须是库内相对路径且后缀在允许范围内`
          + `（文本 ${TEXT_EXTENSIONS.join(' / ')}；模板 ${BINARY_EXTENSIONS.join(' / ')}）`,
        errorKind: 'input',
      }
    }
    if (specById.has(spec.routeId)) continue
    specById.set(spec.routeId, spec)
    requested.push(spec.routeId)
  }
  manifest.routeIds = requested
  manifest.wikiPaths = requestedWikiPaths
  // 只有**真的按槽位取了正文**才提示迁移：只回报槽位清单的那一轮什么都没取，
  // 对它说"你走了遗留通道"是一句与事实不符的话。
  if (!usesWikiPaths && requested.length > 0) {
    warnings.push('按 manifest 槽位读取（遗留通道）：业务知识的新主通道是入口 Wiki 里的相对链接'
      + '（wikiPaths），槽位表只覆盖被声明过的那几份文档。')
  }
  if (warnings.length > 0) manifest.warnings = [...manifest.warnings, ...warnings]

  // 只回报清单：不落任何正文。
  if (requested.length === 0) {
    manifest.ok = true
    return manifest
  }

  const entries: KnowledgeManifestEntry[] = []
  const routes: KnowledgeRouteOutcome[] = []
  const attempts: LookupAttempt[] = []
  const gaps: string[] = []
  let mirrorRoot: string | null = null
  const priorIndex = deps.priorIndex ?? null
  // An index from an unverified run is never reused (but also never blocks a fresh fetch).
  const priorTrusted = priorIndex !== null && priorIndex.spaceVerified === true
  const priorEntries = priorTrusted ? priorIndex.entries : []

  /** Verify a persisted snapshot by content; never trust the stored digest or size. */
  const verifyPriorEntry = async (
    entry: KnowledgeManifestEntry,
    spec: KnowledgeRoute,
  ): Promise<KnowledgeManifestEntry | null> => {
    const readSnapshot = deps.readSnapshot
    if (readSnapshot === undefined) return null
    const binary = spec.kind === 'binary'
    if (binary && entry.templateVerified !== true) return null
    const read = await readSnapshot(entry.snapshotFile, binary)
    if (!read.ok || read.content === undefined) return null
    const content = read.content
    const empty = typeof content === 'string' ? content.trim() === '' : content.byteLength === 0
    if (empty) return null
    const digest = knowledgeDigest(content)
    if (digest !== entry.digest) return null
    const sizeBytes = typeof content === 'string' ? byteLength(content) : content.byteLength
    if (entry.sizeBytes > 0 && entry.sizeBytes !== sizeBytes) return null
    return {
      routeId: entry.routeId,
      nodeName: entry.nodeName,
      resolvedPath: entry.resolvedPath,
      source: entry.source,
      digest,
      sizeBytes,
      snapshotFile: entry.snapshotFile,
      mediaType: entry.mediaType,
      updatedAt: entry.updatedAt,
      bodyNonEmpty: true,
      channel: entry.channel,
      sectionIds: entry.sectionIds,
      ruleIds: entry.ruleIds,
      links: binary ? [] : parseWikiLinks(content as string, entry.resolvedPath),
      templateId: binary ? entry.routeId : null,
      templateContractVersion: binary ? entry.templateContractVersion : null,
      templateVerified: binary ? true : null,
    }
  }

  for (const routeId of requested) {
    const spec = specById.get(routeId) as KnowledgeRoute
    const resolution = resolveRoute(catalog, spec)
    attempts.push(...resolution.attempts)
    let documents = resolution.documents
    let state: RouteState = resolution.state
    let error = resolution.error

    // ③ 镜像：**只在远程明确缺失时**（empty / ambiguous / unreadable 都不许被旧副本掩盖）。
    if (state === 'missing' && deps.loadMirror !== undefined) {
      const outcome = await deps.loadMirror(spec)
      attempts.push(...outcome.attempts)
      if (outcome.ok && outcome.documents.length > 0) {
        documents = outcome.documents.map((item) => mirrorDocumentOf(spec, item))
        state = 'found'
        error = ''
        mirrorRoot = text(outcome.mirrorRoot) === '' ? null : text(outcome.mirrorRoot)
      } else if (outcome.reasonKind !== 'disabled') {
        gaps.push(`镜像恢复未通过（${routeId}）：${outcome.reason}`)
      }
    }

    if (state !== 'found') {
      routes.push({ routeId, state, nodeName: '', source: '', digest: '', snapshotFile: '', error })
      if (state === 'empty') gaps.push(`知识正文为空，未支持（${routeId}）：${error}`)
      else if (state === 'missing') gaps.push(`缺少知识正文（${routeId}）：${error}`)
      else gaps.push(`知识不可读（${routeId}）：${error}`)
      continue
    }

    // Verified reuse: a matching prior entry whose persisted bytes still hash to the stored digest
    // is accepted without touching the network. A matching-but-unusable entry fails closed; a
    // destination owned by another route is refused so cache collisions cannot swap evidence.
    const priorForRoute = priorEntries.filter((entry) => entry.routeId === routeId)
    // Two distinct route ids can sanitize to the same snapshot directory / index file name. Never
    // let one route overwrite another route's evidence.
    const indexCollision = priorEntries.some((entry) => (
      entry.routeId !== routeId && knowledgeFileName(entry.routeId) === knowledgeFileName(routeId)
    ))
    const destinationCollision = documents.some((document) => priorEntries.some(
      (entry) => entry.routeId !== routeId && entry.snapshotFile === document.snapshotFile,
    ))
    if (indexCollision || destinationCollision) {
      const message = `快照落点与其它路由冲突（${routeId}）：拒绝覆盖已属于别的路由的已验真证据`
      attempts.push({ routeId, channel: 'exact-route', target: spec.path, outcome: 'unreadable', detail: message })
      gaps.push(`知识不可读（${routeId}）：${message}`)
      routes.push({ routeId, state: 'unreadable', nodeName: '', source: '', digest: '', snapshotFile: '', error: message })
      continue
    }
    const singleDocument = documents.length === 1 ? documents[0] : undefined
    const matching = singleDocument === undefined ? [] : priorForRoute.filter((entry) => (
      entry.resolvedPath === singleDocument.path
      && entry.nodeName === singleDocument.name
      && entry.snapshotFile === singleDocument.snapshotFile
      && safeSnapshotRelative(entry.snapshotFile)
    ))
    if (matching.length > 0) {
      const reused = await verifyPriorEntry(matching[0] as KnowledgeManifestEntry, spec)
      if (reused !== null) {
        entries.push(reused)
        routes.push({
          routeId, state: 'found', nodeName: reused.nodeName, source: reused.source,
          digest: reused.digest, snapshotFile: reused.snapshotFile, error: '',
        })
        continue
      }
      const message = `已物化快照不可核对（${routeId}）：既有正文与索引摘要/字节数不符，保留既有条目，不静默重取`
      attempts.push({ routeId, channel: 'exact-route', target: spec.path, outcome: 'unreadable', detail: message })
      gaps.push(`知识不可读（${routeId}）：${message}`)
      routes.push({ routeId, state: 'unreadable', nodeName: '', source: '', digest: '', snapshotFile: '', error: message })
      continue
    }

    let routeFailed = ''
    let routeState: RouteState = 'found'
    for (const item of documents) {
      const binary = spec.kind === 'binary'
      let content: string | Uint8Array | null = null
      if (binary) {
        if (item.bytes !== undefined) {
          content = item.bytes
        } else if (deps.readBinary !== undefined) {
          const read = await deps.readBinary(item)
          if (!read.ok) {
            routeFailed = `模板二进制未取到（${item.name}）：${text(read.error)}`
            routeState = 'unreadable'
            break
          }
          content = read.bytes
        } else {
          routeFailed = `模板二进制通道未装配：无法逐字节取回「${item.name}」`
          routeState = 'unreadable'
          break
        }
      } else if (item.body !== undefined) {
        content = item.body
      } else {
        const read = await deps.readBody(item)
        if (!read.ok) {
          routeFailed = `正文未取到（${item.name}）：${text(read.error)}`
          routeState = 'unreadable'
          break
        }
        content = text(read.body)
      }

      const body = typeof content === 'string' ? content : ''
      if (!binary && body.trim() === '') {
        // 空文档返回未支持：不留一条看起来像规则的空记录。
        attempts.push({
          routeId, channel: item.channel, target: item.path, outcome: 'empty',
          detail: `命中节点但正文为空：${item.name}`,
        })
        continue
      }
      const written = await deps.writeSnapshot({ relativePath: item.snapshotFile, content, binary })
      if (!written.ok) {
        routeFailed = `知识正文落盘失败（${item.snapshotFile}）：${text(written.error)}`
        routeState = 'unreadable'
        break
      }
      entries.push({
        routeId,
        nodeName: item.name,
        resolvedPath: item.path,
        source: item.source,
        digest: knowledgeDigest(content),
        sizeBytes: typeof content === 'string' ? byteLength(content) : content.byteLength,
        snapshotFile: item.snapshotFile,
        mediaType: item.mediaType,
        updatedAt: item.updatedAt,
        bodyNonEmpty: true,
        channel: item.channel,
        sectionIds: [],
        ruleIds: [],
        // 链接只在**文本**条目上有意义（模板是二进制，解析出来的是字节噪声）。
        links: binary ? [] : parseWikiLinks(body, item.path),
        // 模板的"身份"就是 manifest 为它起的槽位名（`method.<m>.template`）—— manifest
        // 取代了模板索引之后，不再有另一个业务侧的 templateId 可引用。
        templateId: binary ? routeId : null,
        // 合同版本由 manifest 声明不了；填表脚本按模板自身的合同定位输入区。
        templateContractVersion: null,
        // 二进制条目只在字节验真通过后才建得出来（`readBinary` 不通过就没有 entry）。
        templateVerified: binary ? true : null,
      })
    }

    if (routeFailed !== '') {
      state = routeState
      error = routeFailed
      attempts.push({ routeId, channel: 'exact-route', target: spec.path, outcome: 'unreadable', detail: routeFailed })
      gaps.push(routeFailed)
      routes.push({ routeId, state, nodeName: '', source: '', digest: '', snapshotFile: '', error })
      continue
    }

    const routeEntries = entries.filter((entry) => entry.routeId === routeId)
    if (routeEntries.length === 0) {
      state = 'empty'
      error = error === '' ? `命中的知识正文全部为空（空文档返回未支持）：${routeId}` : error
      gaps.push(`知识正文为空，未支持（${routeId}）`)
      routes.push({ routeId, state, nodeName: '', source: '', digest: '', snapshotFile: '', error })
      continue
    }
    routes.push({
      routeId,
      state: 'found',
      nodeName: routeEntries.map((entry) => entry.nodeName).join('、'),
      source: routeEntries[0]?.source ?? '',
      digest: routeEntries[0]?.digest ?? '',
      snapshotFile: routeEntries.map((entry) => entry.snapshotFile).join('、'),
      error: '',
    })
  }

  manifest.entries = entries
  manifest.routes = routes
  manifest.lookupAttempts = attempts
  manifest.capabilityGaps = gaps
  manifest.mirrorRoot = mirrorRoot

  const merged = mergeCumulative(manifest, entries, routes, priorTrusted ? priorIndex : null)
  // 索引落盘：每条路由一份 schema 文档 + 一份汇总。**任何一份写失败都不算完成**。
  const indexFiles: string[] = []
  const indexErrors: string[] = []
  for (const routeId of requested) {
    const relativePath = `${KNOWLEDGE_INDEX_DIR}/${knowledgeFileName(routeId)}.json`
    const priorForRoute = priorEntries.filter((entry) => entry.routeId === routeId)
    if (!entries.some((entry) => entry.routeId === routeId) && priorForRoute.length > 0) {
      // A failed refresh must not overwrite a prior good per-route document with an empty one.
      indexFiles.push(relativePath)
      continue
    }
    const written = await deps.writeIndex({
      relativePath,
      document: `${JSON.stringify(toKnowledgeSourceDocument(manifest, routeId), null, 2)}\n`,
    })
    if (!written.ok) indexErrors.push(`${relativePath}: ${text(written.error)}`)
    else indexFiles.push(relativePath)
  }
  const aggregateWritten = await deps.writeIndex({
    relativePath: KNOWLEDGE_INDEX_FILE,
    document: `${JSON.stringify(aggregateIndex(manifest, merged, manifest.spaceVerified || priorTrusted), null, 2)}\n`,
  })
  if (!aggregateWritten.ok) indexErrors.push(`${KNOWLEDGE_INDEX_FILE}: ${text(aggregateWritten.error)}`)
  else indexFiles.push(KNOWLEDGE_INDEX_FILE)
  manifest.indexFiles = indexFiles

  if (indexErrors.length > 0) {
    manifest.ok = false
    manifest.errorKind = 'infrastructure'
    manifest.error = `知识来源索引落盘失败，本轮物化不算完成：${indexErrors.join('；')}`
    return manifest
  }
  // 逐条 routeId 的缺失**不**让物化失败：如实记 `routes[]` 与 `capabilityGaps[]`，
  // 由调用方按处置表决定挂起哪一部分。唯一真停在前面（manifest 读不到）。
  manifest.ok = true
  manifest.error = ''
  manifest.errorKind = ''
  return manifest
}

/**
 * Merge this run's entries with prior audited entries not produced now.
 *
 * A failed refresh therefore keeps known sources instead of replacing the aggregate with an empty
 * snapshot. Deduplication is per produced entry, not per requested route id: a requested route that
 * failed (corrupt / unreadable) retains its prior audited metadata while its route outcome stays
 * failed (never marked found, never used for parameters). Requested route ids stay listed even
 * when they produced no entry.
 */
function mergeCumulative(
  manifest: KnowledgeManifest,
  currentEntries: readonly KnowledgeManifestEntry[],
  currentRoutes: readonly KnowledgeRouteOutcome[],
  priorIndex: KnowledgeIndexDocument | null,
): { entries: KnowledgeManifestEntry[]; routes: KnowledgeRouteOutcome[]; routeIds: string[] } {
  const entries: KnowledgeManifestEntry[] = []
  const routeIds: string[] = []
  const routeSeen = new Set<string>()
  const routesWithCurrentEntries = new Set<string>()
  const pushRoute = (routeId: string): void => {
    if (routeSeen.has(routeId)) return
    routeSeen.add(routeId)
    routeIds.push(routeId)
  }
  for (const entry of currentEntries) {
    pushRoute(entry.routeId)
    routesWithCurrentEntries.add(entry.routeId)
    entries.push(entry)
  }
  for (const routeId of manifest.routeIds) pushRoute(routeId)
  for (const entry of priorIndex?.entries ?? []) {
    if (routesWithCurrentEntries.has(entry.routeId)) continue
    if (!safeSnapshotRelative(entry.snapshotFile)) continue
    pushRoute(entry.routeId)
    entries.push(entry)
  }
  const currentByRoute = new Map(currentRoutes.map((route) => [route.routeId, route]))
  const priorByRoute = new Map((priorIndex?.routes ?? []).map((route) => [route.routeId, route]))
  // For a requested route the current outcome always wins (a failed refresh must be reported, not
  // masked by a prior success). Prior outcomes are only carried for routes not touched this run.
  const routes = routeIds.map((routeId) => {
    const current = currentByRoute.get(routeId)
    if (current !== undefined) return current
    const old = priorByRoute.get(routeId)
    return old ?? { routeId, state: 'missing' as const, nodeName: '', source: '', digest: '', snapshotFile: '', error: '' }
  })
  return { entries, routes, routeIds }
}

/** 汇总索引（Host 内部证据；不是落盘 Schema 的那一份逐路由文档）。 */
function aggregateIndex(
  manifest: KnowledgeManifest,
  merged: { entries: KnowledgeManifestEntry[]; routes: KnowledgeRouteOutcome[]; routeIds: string[] },
  spaceVerified: boolean,
): Record<string, unknown> {
  return {
    schema: 'crwu.valuation.knowledge.v1',
    projectId: manifest.projectId,
    planId: manifest.planId,
    spaceName: manifest.spaceName,
    expectedSpaceName: manifest.expectedSpaceName,
    spaceVerified,
    manifestDigest: manifest.manifestDigest,
    availableRouteIds: manifest.availableRouteIds,
    routeIds: merged.routeIds,
    digest: knowledgeSnapshotDigest(merged.entries),
    materializedAt: manifest.materializedAt,
    routes: merged.routes,
    entries: merged.entries.map((entry) => ({
      routeId: entry.routeId,
      nodeName: entry.nodeName,
      resolvedPath: entry.resolvedPath,
      source: entry.source,
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
      snapshotFile: entry.snapshotFile,
      mediaType: entry.mediaType,
      updatedAt: entry.updatedAt,
      bodyNonEmpty: entry.bodyNonEmpty,
      channel: entry.channel,
      sectionIds: entry.sectionIds,
      ruleIds: entry.ruleIds,
      templateId: entry.templateId,
      templateContractVersion: entry.templateContractVersion,
      templateVerified: entry.templateVerified,
    })),
    lookupAttempts: manifest.lookupAttempts,
    capabilityGaps: manifest.capabilityGaps,
    ok: manifest.ok,
  }
}
