import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem } from '../fs/paths.ts'
import { writeCaseText } from './case-files.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { KNOWLEDGE_DEFAULT_SPACE_NAME } from '../dws/consts.ts'
import {
  buildPathIndex,
  channelFor,
  firstArray,
  isFolder,
  localRelativePath,
  normalizeNode,
  resolveRequestedPaths,
  treeStats,
  type DwsNode,
} from '../dws/knowledge-tree.ts'
import { CASE_KNOWLEDGE_DIR, KB_MANIFEST_FILE } from './consts.ts'
import { ensureDirectory, removeFileIfExists } from './case-files.ts'
import { fileSize } from './case-dir.ts'
import { requireCaseAccess } from '../audit/case-access.ts'
import { dwsJson } from './dws-json.ts'
import { failure, renderJson } from './outcome.ts'
import { callerSession, credentialsTrusted, toolContext, type ToolDeps } from './types.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'

/**
 * 知识库取数 Tool：把自研 `crwu-dws` 的 M2（按清单实时下载）整套编排收进 Host。
 *
 * 为什么必须收进来：技能里原来写的是「在案例目录执行 `dws doc +export …`」，
 * 也就是**让模型自己拼 dws 命令** —— 它必须知道二进制在哪、profile 是哪个、
 * 分页要翻到什么时候。那是本次改造要消灭的形态。
 *
 * 现在模型只提交业务参数：
 * - `caseDir`：案例目录（产物落 `<caseDir>/knowledge/`）；
 * - `paths`：库内层级寻址键清单（单文件键不以 `/` 结尾，目录键以 `/` 结尾）；
 * - `spaceName`：库名，缺省用中瑞世联评估审核知识库。
 *
 * Tool 内部：解析库（组织 + 个人全范围精确名匹配）→ 递归遍历目录（逐页证据）
 * → 按 `extension` 分流（adoc 导出 markdown；md/txt 原样下载；其余记 skipped）
 * → 落盘 → 写 manifest 证据。**返回里没有签名 URL、没有凭据、没有 profile 标识**。
 */

/** 库引用（真实返回里取到的三个字段）。 */
interface SpaceRef {
  name: string
  workspaceId: string
  spaceType: string
}

const SPACE_TYPES = ['orgWikiSpace', 'myWikiSpace'] as const

/** 目录遍历上限：与 crwu-dws 的 10,000 节点 / 20 层一致，命中即如实报告部分结果。 */
const MAX_NODES = 10_000
const MAX_DEPTH = 20

function spaceRefOf(raw: unknown): SpaceRef | null {
  if (raw === null || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  const workspaceId = text(doc.workspaceId) || text(doc.spaceId)
  if (workspaceId === '') return null
  return {
    name: text(doc.name) || text(doc.spaceName),
    workspaceId,
    spaceType: text(doc.spaceType),
  }
}

/** 遍历游标：记录下一次要展开的目录与深度。 */
interface FolderTask {
  folderId: string
  depth: number
}

/**
 * 递归取目录树。
 *
 * 不并发：知识库端点的分页/限流行为未知，串行是唯一能保证证据完整的方式
 * （crwu-dws 的 §6.2 也明确要求顺序、不并发）。
 */
async function readTree(
  ctx: Context,
  platform: string,
  options: { workdir: string; access: LocalAccessBroker; source: LocalAccessSource; signal?: AbortSignal },
  workspaceId: string,
): Promise<{ roots: DwsNode[]; failures: Array<{ step: string; error: string }>; truncated: boolean }> {
  const failures: Array<{ step: string; error: string }> = []
  const roots: DwsNode[] = []
  const queue: FolderTask[] = [{ folderId: '', depth: 0 }]
  let count = 0
  let truncated = false

  while (queue.length > 0) {
    const task = queue.shift() as FolderTask
    const argv = ['wiki', '+node-list', '--workspace', workspaceId, '--page-all', '--page-limit', '200', '--format', 'json']
    if (task.folderId !== '') argv.push('--folder', task.folderId)
    const listed = await dwsJson(ctx, platform, argv, {
      workdir: options.workdir,
      access: options.access,
      source: options.source,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!listed.ok) {
      failures.push({ step: task.folderId === '' ? 'node-list(root)' : `node-list(${task.folderId})`, error: listed.error })
      continue
    }
    const rows = firstArray(listed.payload, ['nodes', 'files', 'items']) ?? []
    const nodes: DwsNode[] = []
    for (const row of rows) {
      const node = normalizeNode(row)
      if (node === null) continue
      nodes.push(node)
      count += 1
      if (count >= MAX_NODES || task.depth >= MAX_DEPTH) {
        truncated = true
        break
      }
      if (isFolder(node)) queue.push({ folderId: node.nodeId, depth: task.depth + 1 })
    }
    if (task.folderId === '') roots.push(...nodes)
    else attach(roots, task.folderId, nodes)
    if (truncated) break
  }
  return { roots, failures, truncated }
}

/** 把子层节点挂到它的父 folder 上（父不存在时静默丢弃，父层 failure 已经记过）。 */
function attach(roots: DwsNode[], parentId: string, children: DwsNode[]): void {
  const walk = (node: DwsNode): boolean => {
    if (node.nodeId === parentId) {
      node.children.push(...children)
      return true
    }
    for (const child of node.children) if (walk(child)) return true
    return false
  }
  for (const root of roots) if (walk(root)) return
}

interface ManifestEntry {
  requested: string
  path: string
  localPath: string
  nodeId: string
  name: string
  extension: string
  channel: string
  status: string
  reason: string
  sizeBytes: number
}

/** 输出 schema 与 `ManifestEntry` 一一对应（改一处必须改另一处，测试会盯住字段集）。 */
const MANIFEST_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requested: { required: true, type: 'string' },
    path: { required: true, type: 'string' },
    localPath: { required: true, type: 'string' },
    nodeId: { required: true, type: 'string' },
    name: { required: true, type: 'string' },
    extension: { required: true, type: 'string' },
    channel: { required: true, type: 'string' },
    status: { required: true, type: 'string' },
    reason: { required: true, type: 'string' },
    sizeBytes: { required: true, type: 'integer' },
  },
  
} as const

export function knowledgeTools(deps: ToolDeps) {
  const materialize = defineTool({
    name: 'crwu_audit_knowledge_materialize',
    description: [
      '把本次审核清单里的知识库文档**实时下载**到 <caseDir>/knowledge/ 下，并返回结构化 manifest 证据。',
      '清单项是库内层级路径：单文件（如 02-资产类型/机器设备/评估审核条目）或目录（以 / 结尾，递归展开）。',
      '通道由节点 extension 决定：adoc 导出 markdown，md/txt 原样下载，其余记 skipped（不伪造正文）。',
      '不需要提交 profile、组织、二进制位置或任何命令参数 —— 这些都由本工具内部解析。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径；产物落 <caseDir>/knowledge/' },
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '库内层级寻址键清单；目录键必须以 / 结尾，逐字匹配库内节点名（不折叠大小写/全半角）',
      },
      spaceName: { type: 'string', description: `知识库精确名称；缺省为 ${KNOWLEDGE_DEFAULT_SPACE_NAME}` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          errorKind: { required: true, type: 'string' },
          error: { required: true, type: 'string' },
          caseDir: { required: true, type: 'string' },
          knowledgeDir: { required: true, type: 'string' },
          spaces: { required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { required: true, type: 'string' },
                workspaceId: { required: true, type: 'string' },
                spaceType: { required: true, type: 'string' },
              },
              
            },
          },
          counts: { required: true,
            type: 'object',
            additionalProperties: false,
            properties: {
              exported: { required: true, type: 'integer' },
              downloaded: { required: true, type: 'integer' },
              skipped: { required: true, type: 'integer' },
              failed: { required: true, type: 'integer' },
              nodes: { required: true, type: 'integer' },
            },
            
          },
          complete: { required: true, type: 'boolean' },
          manifest: { required: true, type: 'array', items: MANIFEST_ITEM_SCHEMA },
          failures: { required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { requested: { required: true, type: 'string' }, step: { required: true, type: 'string' }, error: { required: true, type: 'string' } },
              
            },
          },
          manifestPath: { required: true, type: 'string' },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const empty = {
        caseDir: '', knowledgeDir: '', spaces: [] as SpaceRef[], manifest: [] as ManifestEntry[],
        failures: [] as Array<{ requested: string; step: string; error: string }>,
        counts: { exported: 0, downloaded: 0, skipped: 0, failed: 0, nodes: 0 },
        complete: false, manifestPath: '',
      }
      const requested = (Array.isArray(args.paths) ? args.paths : []).map((item) => text(item)).filter((item) => item !== '')
      if (requested.length === 0) return { ...failure('input', 'paths 不能为空'), ...empty }
      const caseCheck = await requireCaseAccess(ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, deps.localAudit)
      if (!caseCheck.ok) return { ...caseCheck, ...empty }

      const platform = await deps.world.platform()
      const caseDir = caseCheck.casePath
      const knowledgeDir = joinLocalPath(caseDir, CASE_KNOWLEDGE_DIR)
      const base = { ...empty, caseDir, knowledgeDir }

      const prepared = await ensureDirectory(deps.access, knowledgeDir, {
        workdir: caseDir, platform, session: callerSession(exec), signal: exec.signal,
      })
      if (!prepared.ok) return { ...failure('infrastructure', prepared.error), ...base }

      const spaceName = text(args.spaceName).trim() || KNOWLEDGE_DEFAULT_SPACE_NAME
      const spaces: SpaceRef[] = []
      const failures: Array<{ requested: string; step: string; error: string }> = []
      for (const type of SPACE_TYPES) {
        const listed = await dwsJson(ctx, platform, [
          'wiki', '+space-list', '--type', type, '--limit', '50', '--page-all', '--format', 'json',
        ], { workdir: caseDir, access: deps.access, source: 'audit-tool', ...(exec.signal === undefined ? {} : { signal: exec.signal }) })
        if (!listed.ok) {
          failures.push({ requested: '', step: `space-list(${type})`, error: listed.error })
          continue
        }
        const rows = firstArray(listed.payload, ['spaces', 'items', 'data']) ?? []
        for (const row of rows) {
          const ref = spaceRefOf(row)
          if (ref === null || ref.name !== spaceName) continue
          if (!spaces.some((item) => item.workspaceId === ref.workspaceId)) spaces.push(ref)
        }
      }
      if (spaces.length === 0) {
        return {
          ...failure('not-found', `未在组织或个人范围精确定位到知识库「${spaceName}」`),
          ...base,
          failures,
        }
      }

      const manifest: ManifestEntry[] = []
      const usedPaths = new Map<string, string>()
      let nodes = 0
      let complete = true

      for (const space of spaces) {
        const tree = await readTree(ctx, platform, {
          workdir: caseDir, access: deps.access, source: 'audit-tool',
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        }, space.workspaceId)
        nodes += treeStats(tree.roots).total
        complete = complete && tree.failures.length === 0 && !tree.truncated
        for (const item of tree.failures) failures.push({ requested: '', step: item.step, error: item.error })

        const resolved = resolveRequestedPaths(buildPathIndex(tree.roots), requested)
        for (const item of resolved.failures) failures.push({ requested: item.requested, step: 'resolve', error: item.error })

        for (const hit of resolved.items) {
          const { channel, reason } = channelFor(hit.node.extension)
          const relative = uniqueLocalPath(usedPaths, hit.node, hit.path)
          const entry: ManifestEntry = {
            requested: hit.requested,
            path: hit.path,
            localPath: relative,
            nodeId: hit.node.nodeId,
            name: hit.node.name,
            extension: hit.node.extension,
            channel,
            status: '',
            reason,
            sizeBytes: 0,
          }
          if (channel === 'skipped') {
            manifest.push({ ...entry, status: 'skipped', reason })
            continue
          }
          const local = joinLocalPath(knowledgeDir, relative)
          const cleared = await removeFileIfExists(deps.access, local, {
            workdir: caseDir, platform, session: callerSession(exec),
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
          if (!cleared.ok) {
            manifest.push({ ...entry, status: 'failed', reason: cleared.error })
            failures.push({ requested: hit.requested, step: `clear(${relative})`, error: cleared.error })
            continue
          }
          const argv = channel === 'export'
            ? ['doc', '+export', '--node', hit.node.nodeId, '--export-format', 'markdown', '--output', relative, '--format', 'json']
            : ['drive', '+download', '--node', hit.node.nodeId, '--output', relative, '--format', 'json']
          const run = await dwsJson(ctx, platform, argv, {
            workdir: knowledgeDir, access: deps.access, source: 'audit-tool',
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
          if (!run.ok) {
            manifest.push({ ...entry, status: 'failed', reason: run.error })
            failures.push({ requested: hit.requested, step: `${channel}(${relative})`, error: run.error })
            continue
          }
          const size = await fileSize(ctx, local)
          if (size <= 0) {
            const error = `${channel} 命令成功但本地产物缺失或为空：${relative}`
            manifest.push({ ...entry, status: 'failed', reason: error })
            failures.push({ requested: hit.requested, step: `${channel}(${relative})`, error })
            continue
          }
          manifest.push({
            ...entry,
            status: channel === 'export' ? 'exported' : 'downloaded',
            reason: '',
            sizeBytes: size,
          })
        }
      }

      const manifestPath = joinLocalPath(knowledgeDir, KB_MANIFEST_FILE)
      const written = await writeManifest(ctx, manifestPath, {
        schema: 'crwu.kb-materialize.manifest.v1',
        spaceName,
        spaces,
        requested,
        complete,
        entries: manifest,
        failures,
      }, { session: callerSession(exec), ...(exec.signal === undefined ? {} : { signal: exec.signal }) })
      if (!written.ok) failures.push({ requested: '', step: 'manifest', error: written.error })

      const counts = {
        exported: manifest.filter((item) => item.status === 'exported').length,
        downloaded: manifest.filter((item) => item.status === 'downloaded').length,
        skipped: manifest.filter((item) => item.status === 'skipped').length,
        failed: manifest.filter((item) => item.status === 'failed').length,
        nodes,
      }
      return {
        ok: counts.failed === 0,
        errorKind: counts.failed === 0 ? '' as const : 'cli',
        error: counts.failed === 0 ? '' : `${counts.failed} 个清单项取数失败`,
        caseDir,
        knowledgeDir,
        spaces,
        counts,
        complete,
        manifest,
        failures,
        manifestPath: written.ok ? manifestPath : '',
      }
    },
  })

  return [materialize]
}

/** 同名不同 nodeId → 追加 `-<nodeId 前 8>`；同 nodeId 复用同一路径（原位覆盖）。 */
function uniqueLocalPath(used: Map<string, string>, node: DwsNode, path: string): string {
  const base = localRelativePath(node, path)
  const owner = used.get(base)
  if (owner === undefined || owner === node.nodeId) {
    used.set(base, node.nodeId)
    return base
  }
  const suffix = node.nodeId.slice(0, 8)
  const at = base.lastIndexOf('.')
  const candidate = at < 0 ? `${base}-${suffix}` : `${base.slice(0, at)}-${suffix}${base.slice(at)}`
  used.set(candidate, node.nodeId)
  return candidate
}

async function writeManifest(
  ctx: Context,
  path: string,
  payload: Record<string, unknown>,
  options: { session?: Session; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const written = await writeCaseText(ctx, path, `${JSON.stringify(payload, null, 2)}\n`, options)
  if (written.ok) return { ok: true, error: '' }
  const kind = written.errorKind === '' ? 'infrastructure' : written.errorKind
  return { ok: false, error: `${written.error}（写入 ${path} · 归因 ${kind}）` }
}
