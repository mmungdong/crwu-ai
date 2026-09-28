import { text } from '../../shared/utils/value.ts'

/**
 * 知识库目录树：`dws wiki +node-list` 应答的**纯解析与寻址**。
 *
 * 单独成文件是因为这一层能在没有 shell、没有凭据的情况下被测试：
 * 「清单项 → 库内节点」的寻址规则（单文件精确命中 / 目录前缀展开 / 未命中记 failure）
 * 是审核链路里最容易出错、也最需要回归的部分。命令编排留在 `tools/knowledge.ts`。
 *
 * 两条纪律（来自 `crwu-dws` 的 references）：
 * - **名称不替代 ID**：所有远端操作只认 `nodeId`；
 * - **`extension` 是取数通道的唯一判据**，缺失记空串（= null），不按名称后缀猜测。
 */

export interface DwsNodePage {
  autoPageComplete: boolean
  pagesFetched: number
  itemsInPage: number
}

export interface DwsNode {
  nodeId: string
  name: string
  /** 服务端 `nodeType`：`folder` / `file` / 未知原值。 */
  type: string
  /** 服务端真实 `extension`；缺席为空串（不推断）。 */
  extension: string
  contentType: string
  parentFolderId: string
  hasChildren: boolean | null
  children: DwsNode[]
  page: DwsNodePage
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 单个节点 → 规范形状；没有 nodeId 或 name 的条目丢弃（无法寻址，也无法展示）。 */
export function normalizeNode(raw: unknown): DwsNode | null {
  if (raw === null || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  const nodeId = text(doc.nodeId)
  const name = text(doc.name)
  if (nodeId === '' || name === '') return null
  const page = doc.page !== null && typeof doc.page === 'object' ? doc.page as Record<string, unknown> : {}
  const children = Array.isArray(doc.children)
    ? doc.children.map(normalizeNode).filter((item): item is DwsNode => item !== null)
    : []
  return {
    nodeId,
    name,
    type: text(doc.type) || text(doc.nodeType),
    extension: text(doc.extension),
    contentType: text(doc.contentType),
    parentFolderId: text(doc.parentFolderId),
    hasChildren: boolOrNull(doc.hasChildren),
    children,
    page: {
      autoPageComplete: doc.autoPageComplete === true || page.autoPageComplete === true,
      pagesFetched: typeof page.pagesFetched === 'number' ? page.pagesFetched : 0,
      itemsInPage: typeof page.itemsInPage === 'number' ? page.itemsInPage : 0,
    },
  }
}

/** 从任意应答里取业务数组。 */
export function firstArray(payload: unknown, keys: readonly string[]): unknown[] | null {
  const seen: unknown[] = [payload]
  const visit = (value: unknown, depth: number): unknown[] | null => {
    if (depth > 3 || value === null || typeof value !== 'object') return null
    if (Array.isArray(value)) return value
    const doc = value as Record<string, unknown>
    for (const key of keys) {
      const hit = doc[key]
      if (Array.isArray(hit)) return hit
    }
    for (const key of ['data', 'result', 'payload']) {
      const nested = doc[key]
      if (nested !== undefined && nested !== null && typeof nested === 'object') {
        const found = visit(nested, depth + 1)
        if (found !== null) return found
      }
    }
    return null
  }
  void seen
  return visit(payload, 0)
}

/** 节点是否是目录。 */
export function isFolder(node: DwsNode): boolean {
  return node.type.toLowerCase() === 'folder'
}

/** 取数通道：`adoc` 走导出，可读原生文本走下载，其余记 skipped。 */
export type KnowledgeChannel = 'export' | 'download' | 'skipped'

export function channelFor(extension: string): { channel: KnowledgeChannel; reason: string } {
  const ext = extension.trim().toLowerCase()
  if (ext === 'adoc') return { channel: 'export', reason: '' }
  if (ext === 'md' || ext === 'txt') return { channel: 'download', reason: '' }
  if (ext === '') return { channel: 'skipped', reason: 'extension 缺失，类型不可判定' }
  return { channel: 'skipped', reason: `不支持取正文的节点类型：${ext}` }
}

/** 一条寻址键的解析结果。 */
export interface ResolvedItem {
  /** 逐字来自清单的寻址键。 */
  requested: string
  kind: 'file' | 'directory'
  node: DwsNode
  /** 节点在库内的层级路径（不含库名，目录以 `/` 结尾）。 */
  path: string
}

export interface ResolveOutcome {
  items: ResolvedItem[]
  failures: Array<{ requested: string; error: string }>
}

/**
 * 把扁平化的「库内层级路径」索引应用于清单。
 *
 * 索引键规则与 `crwu-dws` 的 `by_path` 一致：**不折叠大小写或全半角**。
 * 单文件键不以 `/` 结尾，目录键必须以 `/` 结尾；目录项展开为其下**全部**支持正文的文件
 * （递归），由调用方按 `channelFor` 决定每条的处理方式。
 */
export function resolveRequestedPaths(index: Map<string, DwsNode[]>, requested: readonly string[]): ResolveOutcome {
  const items: ResolvedItem[] = []
  const failures: ResolveOutcome['failures'] = []
  const seen = new Set<string>()

  const push = (requestedKey: string, node: DwsNode, path: string): void => {
    const dedupe = `${requestedKey}\u0000${node.nodeId}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    items.push({ requested: requestedKey, kind: isFolder(node) ? 'directory' : 'file', node, path })
  }

  const collect = (requestedKey: string, node: DwsNode, prefix: string): void => {
    const path = `${prefix}${node.name}${isFolder(node) ? '/' : ''}`
    if (isFolder(node)) {
      for (const child of node.children) collect(requestedKey, child, path)
      return
    }
    push(requestedKey, node, path)
  }

  for (const raw of requested) {
    const key = text(raw).trim()
    if (key === '') {
      failures.push({ requested: raw, error: '空寻址键' })
      continue
    }
    const isDirKey = key.endsWith('/')
    const normalized = key.replace(/^\/+/, '')
    const bare = normalized.replace(/\/+$/, '')
    const hits = index.get(normalized) ?? index.get(`${bare}/`) ?? index.get(bare) ?? []
    if (hits.length === 0) {
      failures.push({ requested: key, error: `清单项在库内不存在：${key}` })
      continue
    }
    if (hits.length > 1) {
      failures.push({ requested: key, error: `清单项在库内不唯一（命中 ${hits.length} 个节点）：${key}` })
      continue
    }
    const node = hits[0] as DwsNode
    if (isDirKey && !isFolder(node)) {
      failures.push({ requested: key, error: `清单项声明为目录，但库内是文档：${key}` })
      continue
    }
    if (!isDirKey && isFolder(node)) {
      failures.push({ requested: key, error: `清单项声明为单文件，但库内是目录：${key}` })
      continue
    }
    collect(key, node, '')
  }
  return { items, failures }
}

/**
 * 目录树 → 全路径索引。
 *
 * 同名同路径多节点都会进同一个桶（`hits.length > 1` 时由 `resolveRequestedPaths` 报不唯一），
 * 从而不会退化成「选第一个」。
 */
export function buildPathIndex(roots: readonly DwsNode[]): Map<string, DwsNode[]> {
  const index = new Map<string, DwsNode[]>()
  const add = (path: string, node: DwsNode): void => {
    const bucket = index.get(path)
    if (bucket === undefined) index.set(path, [node])
    else bucket.push(node)
  }
  const walk = (node: DwsNode, prefix: string): void => {
    const path = `${prefix}${node.name}${isFolder(node) ? '/' : ''}`
    add(path, node)
    if (isFolder(node)) for (const child of node.children) walk(child, path)
  }
  for (const root of roots) walk(root, '')
  return index
}

/** 本地落盘路径：库内层级路径 → `knowledge/` 下的同构相对路径（去掉目录键尾部的 `/`）。 */
export function localRelativePath(node: DwsNode, path: string): string {
  const { channel } = channelFor(node.extension)
  const ext = channel === 'download' ? `.${node.extension.trim().toLowerCase()}` : '.md'
  return `${path.replace(/\/$/, '')}${ext}`
}

/** 树统计（快照/摘要共用）。 */
export function treeStats(roots: readonly DwsNode[]): { total: number; folders: number; docs: number; maxDepth: number; complete: boolean } {
  let total = 0
  let folders = 0
  let docs = 0
  let maxDepth = 0
  let complete = true
  const walk = (node: DwsNode, depth: number): void => {
    total += 1
    if (depth > maxDepth) maxDepth = depth
    if (isFolder(node)) folders += 1
    else docs += 1
    if (!node.page.autoPageComplete) complete = false
    for (const child of node.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return { total, folders, docs, maxDepth, complete }
}
