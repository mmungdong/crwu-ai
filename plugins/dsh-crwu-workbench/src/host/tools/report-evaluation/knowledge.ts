import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { dwsJson } from '../report-audit/dws-json.ts'
import { buildPathIndex, channelFor, firstArray, resolveRequestedPaths, treeStats, type DwsNode } from '../../integrations/dws/knowledge-tree.ts'
import { readTree, spaceRefOf, SPACE_TYPES, type SpaceRef } from '../report-audit/knowledge.ts'
import { ensureDirectory, removeFileIfExists, writeCaseText } from '../common/case-files.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  VALUATION_KNOWLEDGE_ROUTES,
  VALUATION_KNOWLEDGE_SPACE,
  knowledgeFileName,
  knowledgeRouteChecklist,
  knowledgeSourcesView,
  localKnowledgeProbe,
  resolveKnowledgePlan,
  type KnowledgeProbe,
  type KnowledgeRoute,
  type KnowledgeSourceView,
} from '../../domains/report-evaluation/knowledge/index.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_knowledge_materialize`：把本轮需要的**业务规范正文**落到案例目录，
 * 并留下可核对的知识来源证据（协议 32）。
 *
 * 三段分工：
 * - **决策**（纯逻辑，`domains/.../knowledge/resolve.ts`）：哪一份、从哪来、缺了算不算致命；
 * - **取数**（本文件）：知识库优先，失败/缺失走技能自带参考；
 * - **落盘**：`<案例目录>/知识快照/*.md` + `.知识来源.json`（路由 / 来源 / 更新时间 / 指纹）。
 *
 * 两条不许含糊的口径：
 * 1. **必需知识缺失就停**：`01-房地产估值通用` 两边都没有时返回 `ok:false`，
 *    子会话不许"按规范"往下算 —— 没有口径的数字无法核对。
 * 2. **来源必须写清楚**：每条记录都带 `source`（dws/local）与 `digest`。
 *    把本地参考说成"知识库正文"，等于把技能发布时刻冒充规范修订时刻。
 *
 * DSW 取数**每个节点一次**：`wiki +node-list` 读一次树（缓存），命中后按 `extension`
 * 走 `doc +export`（adoc → markdown）或 `drive +download`（md/txt 原样），与审核链路同一套通道。
 */

/** 树读取与导出的超时（知识库端点慢，给足但不无限）。 */
const TREE_TIMEOUT_MS = 10 * 60_000

interface MaterializeResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  knowledgeDir: string
  indexPath: string
  space: string
  /** 知识库是否被真的读过（false = 直接走了本地参考）。 */
  spaceFound: boolean
  method: string
  sources: KnowledgeSourceView[]
  digest: string
  capabilityGaps: string[]
  warnings: string[]
  failures: Array<{ step: string; error: string }>
  /** 本轮需要哪些知识（含必需标记），供界面说明。 */
  checklist: Array<{ route: string; node: string; required: boolean; when: string }>
}

function idleResult(): MaterializeResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', knowledgeDir: '', indexPath: '', space: '',
    spaceFound: false, method: '', sources: [], digest: '', capabilityGaps: [], warnings: [],
    failures: [], checklist: [],
  }
}

export function valuationKnowledgeTools(deps: ToolDeps) {
  const materialize = defineTool({
    name: VALUATION_TOOL_NAMES.knowledgeMaterialize,
    description: [
      '把本轮房地产估值需要的**业务规范正文**取到案例目录的 知识快照/ 下，并返回知识来源证据',
      '（路由 / 来源 dws|local / 更新时间 / 正文指纹）。优先读知识库；知识库没有或读不到时',
      '回退到技能自带参考文件，并如实标注来源与能力缺口。',
      '必需知识（01-房地产估值通用）两边都缺失时**返回失败**：那种情况下不许继续测算。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      method: {
        type: 'string', required: true,
        description: '采用的方法：auto / market / income / cost。决定需要哪几份规范。',
      },
      spaceName: { type: 'string', description: `业务知识库精确名称；缺省为 ${VALUATION_KNOWLEDGE_SPACE}` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          knowledgeDir: { type: 'string', required: true },
          indexPath: { type: 'string', required: true, description: `知识来源索引：${KNOWLEDGE_SNAPSHOT_DIR}/${KNOWLEDGE_INDEX_FILE}` },
          space: { type: 'string', required: true },
          spaceFound: { type: 'boolean', required: true, description: 'false = 没读到知识库，正文全部来自本地参考' },
          method: { type: 'string', required: true },
          sources: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                route: { type: 'string', required: true },
                source: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                digest: { type: 'string', required: true },
              },
            },
          },
          digest: { type: 'string', required: true, description: '整份知识快照的指纹' },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          failures: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { step: { type: 'string', required: true }, error: { type: 'string', required: true } },
            },
          },
          checklist: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                route: { type: 'string', required: true },
                node: { type: 'string', required: true },
                required: { type: 'boolean', required: true },
                when: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args, exec): Promise<MaterializeResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()
      const method = text(args.method).trim() || 'auto'
      const checklist = knowledgeRouteChecklist(method as never)

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access, checklist }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：知识准备只能在估值子会话里进行'), checklist }
      }
      const caseDir = access.casePath
      const knowledgeDir = joinLocalPath(caseDir, KNOWLEDGE_SNAPSHOT_DIR)
      const platform = await deps.world.platform()
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }
      const spaceName = text(args.spaceName).trim() || VALUATION_KNOWLEDGE_SPACE
      const failures: Array<{ step: string; error: string }> = []

      const made = await ensureDirectory(deps.access, knowledgeDir, { workdir: caseDir, platform, ...writeOptions })
      if (!made.ok) return { ...base, ...failure('infrastructure', made.error), checklist }

      // ① 知识库：先读一次树，把七条路由解析出来（一次遍历，不做七次探测）。
      const hits = new Map<string, { node: DwsNode; path: string } | null>()
      let spaceFound = false
      try {
        const spaces: SpaceRef[] = []
        for (const type of SPACE_TYPES) {
          const listed = await dwsJson(ctx, platform, [
            'wiki', '+space-list', '--type', type, '--limit', '50', '--page-all', '--format', 'json',
          ], { workdir: caseDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }) })
          if (!listed.ok) {
            failures.push({ step: `space-list(${type})`, error: listed.error })
            continue
          }
          for (const row of firstArray(listed.payload, ['spaces', 'items', 'data']) ?? []) {
            const ref = spaceRefOf(row)
            if (ref === null || ref.name !== spaceName) continue
            if (!spaces.some((item) => item.workspaceId === ref.workspaceId)) spaces.push(ref)
          }
        }
        if (spaces.length === 0) {
          failures.push({ step: 'space-list', error: `未在组织或个人范围精确定位到知识库「${spaceName}」` })
        }
        for (const space of spaces) {
          const tree = await readTree(ctx, platform, {
            workdir: caseDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }),
          }, space.workspaceId)
          for (const item of tree.failures) failures.push({ step: item.step, error: item.error })
          if (tree.truncated) failures.push({ step: 'node-list', error: '知识库节点超过遍历上限，结果可能不完整' })
          const resolved = resolveRequestedPaths(
            buildPathIndex(tree.roots),
            VALUATION_KNOWLEDGE_ROUTES.map((route) => route.route),
          )
          for (const item of resolved.failures) failures.push({ step: 'resolve', error: item.error })
          for (const hit of resolved.items) {
            hits.set(hit.node.name, { node: hit.node, path: hit.path })
            spaceFound = true
          }
        }
      } catch (error) {
        failures.push({ step: 'knowledge-tree', error: error instanceof Error ? error.message : String(error) })
      }

      // ② DSW 探针：命中就按通道导出到最终落点，再把正文读回来交给决策层。
      const dwsProbe: KnowledgeProbe['dws'] = async (route: KnowledgeRoute) => {
        const hit = hits.get(route.node)
        if (hit === undefined) return { found: false, error: failures.length > 0 ? failures.map((item) => item.error).join('；') : '' }
        if (hit === null) return { found: false }
        const { channel, reason } = channelFor(hit.node.extension)
        if (channel === 'skipped') return { found: false, error: reason }
        const fileName = knowledgeFileName(route)
        const cleared = await removeFileIfExists(deps.access, joinLocalPath(knowledgeDir, fileName), {
          workdir: caseDir, platform, ...writeOptions,
        })
        if (!cleared.ok) return { found: false, error: cleared.error }
        const argv = channel === 'export'
          ? ['doc', '+export', '--node', hit.node.nodeId, '--export-format', 'markdown', '--output', fileName, '--format', 'json']
          : ['drive', '+download', '--node', hit.node.nodeId, '--output', fileName, '--format', 'json']
        const run = await dwsJson(ctx, platform, argv, {
          workdir: knowledgeDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }),
        })
        if (!run.ok) return { found: false, error: run.error }
        const body = await readTextIfExists(ctx, joinLocalPath(knowledgeDir, fileName))
        if (body.trim() === '') return { found: false, error: `${channel} 成功但产物为空：${fileName}` }
        return { found: true, body, updatedAt: text(hit.node.updatedAt) }
      }

      // ③ 决策 + 落盘。
      const resolved = await resolveKnowledgePlan({
        method: method as never,
        probe: { dws: dwsProbe, local: localKnowledgeProbe() },
        dir: KNOWLEDGE_SNAPSHOT_DIR,
      })
      for (const body of resolved.bodies) {
        // DSW 的那一份已经在最终落点（探针写的）；本地那一份要写进去。
        if (body.source !== 'local') continue
        const written = await writeCaseText(ctx, joinLocalPath(caseDir, body.file), body.body, writeOptions)
        if (!written.ok) failures.push({ step: `write(${body.file})`, error: written.error })
      }

      const indexPath = joinLocalPath(knowledgeDir, KNOWLEDGE_INDEX_FILE)
      const indexWritten = await writeCaseText(ctx, indexPath, canonicalJson({
        schema: 'crwu.valuation.knowledge.v1',
        spaceName,
        spaceFound,
        method,
        digest: resolved.digest,
        sources: resolved.sources,
        capabilityGaps: resolved.capabilityGaps,
        warnings: resolved.warnings,
        failures,
      }), writeOptions)
      if (!indexWritten.ok) failures.push({ step: 'index', error: indexWritten.error })

      return {
        ok: resolved.ok,
        errorKind: resolved.ok ? '' : 'capability-gap',
        error: resolved.error,
        caseDir,
        knowledgeDir,
        indexPath: indexWritten.ok ? indexPath : '',
        space: spaceName,
        spaceFound,
        method,
        sources: knowledgeSourcesView(resolved.sources),
        digest: resolved.digest,
        capabilityGaps: resolved.capabilityGaps,
        warnings: resolved.warnings,
        failures,
        checklist,
      }
    },
  })

  return [materialize]
}

/** 知识库树里的节点数（诊断用；行为与 `knowledgeTools` 的统计口径一致）。 */
export function valuationKnowledgeNodeCount(nodes: readonly DwsNode[]): number {
  return treeStats([...nodes]).total
}
