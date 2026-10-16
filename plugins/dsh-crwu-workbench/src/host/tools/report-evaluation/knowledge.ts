import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { fileSystem, readTextIfExists } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { isSafeIdSegment } from '../../domains/report-evaluation/project/contracts.ts'
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
} from '../../domains/report-evaluation/knowledge/index.ts'
import { channelFor } from '../../integrations/dws/knowledge-tree.ts'
import { knowledgeDigest, knowledgeFileName } from '../../domains/report-evaluation/knowledge/snapshot.ts'
import { dwsJson } from '../report-audit/dws-json.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'
import {
  containKnowledgeTarget,
  knowledgeManifestDirOf,
  knowledgeManifestPathOf,
  knowledgeMirrorRootOf,
  knowledgeWikiPathOf,
  loadKnowledgeCatalog,
  loadKnowledgeManifest,
  loadPriorKnowledgeIndex,
} from './catalog.ts'

/** Upper bound for reading a reused binary snapshot; kept in sync with the template channel. */
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

/**
 * `crwu_valuation_knowledge_materialize`：把 manifest 声明的业务知识**正文**取到案例目录，
 * 并留下可核对的知识来源证据。
 *
 * 三段分工：
 * - **决策**（`domains/.../knowledge/resolve.ts`）：哪一份、从哪来、缺了算不算致命；
 * - **取数**（本文件 + `catalog.ts`）：读一次业务库目录树 + 取 manifest；按 `extension` 走
 *   `doc +export`（adoc → markdown）或 `drive +download`（md/txt 原样）；
 *   **远程明确缺失**时才尝试身份已验证镜像；
 * - **落盘**：`<案例>/知识快照/<routeId>/…` + 每条路由一份 `知识来源/<routeId>.json`
 *   （结构逐字对齐 `schemas/knowledge-source.schema.json`）+ 一份汇总 `.知识来源.json`
 *   + 一份 `.知识目录.md`（本轮据以取数的 manifest 正文）。
 *
 * 五条不许含糊的口径：
 * 1. **没有本地 references 兜底**：知识库读不到就如实失败/gap —— 技能自带的 `references/`
 *    不再是生产正文来源（它只留技术合同）。
 * 2. **空间名只能等于配置的业务库名**：`spaceName` 传别的值 fail closed，且一个进程都不起。
 * 3. **`routeIds` 省略 = 只回报可用槽位**：先看清 manifest 声明了哪些方法，再决定取什么。
 *    `stage=parameters` 是**显式**的附加请求：在已验真的已落盘正文上解析结构化规则段，绝不默认执行。
 * 4. **除 manifest 读不到之外，任何缺失都不整体失败**：逐条 routeId 的 `states[]` 如实回报，
 *    由会话按处置表决定挂起哪一部分。`empty ≠ missing`，不许被旧镜像掩盖。
 * 5. **模型可见结果里没有 nodeId、没有镜像绝对路径、没有凭据面事实**。
 *
 * ⚠️ **模板字节不在这里**：模板是**二进制**通道（ZIP 魔数 + 非空 + 七张可见表由脚本验），
 * 归 `crwu_valuation_template_materialize`。两个通道混在一个工具里，会让"文本取回成功"
 * 看起来像"模板也验过了"。
 */

interface MaterializeOutcome {
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
  /** 配置声明的**入口 Wiki**（库内路径）；旧配置没有这个键时为空串。 */
  entryWikiPath: string
  availableRouteIds: string[]
  routeIds: string[]
  /** 本轮按 Wiki 路径请求的库内路径（协议 39 的主通道）。 */
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
    /** 这份正文里的库内链接（下一跳导航）；解析不出库内路径的按 kind 如实分类。 */
    links: Array<{ label: string; target: string; path: string; anchor: string; kind: string; error: string }>
  }>
  lookupAttempts: Array<{ routeId: string; channel: string; target: string; outcome: string; detail: string }>
  indexFiles: string[]
  digest: string
  capabilityGaps: string[]
  warnings: string[]
  failures: Array<{ step: string; error: string }>
  /** Host-bound structured rule parameters for `stage=parameters`; a stable empty/missing set otherwise. */
  ruleParameters: RuleParameterSet
}

function idleResult(): MaterializeOutcome {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', knowledgeDir: '', indexPath: '',
    spaceName: '', expectedSpaceName: VALUATION_KNOWLEDGE_SPACE, spaceVerified: false,
    manifestDigest: '', entryWikiPath: '', availableRouteIds: [], routeIds: [], wikiPaths: [],
    states: [], entries: [], lookupAttempts: [], indexFiles: [], digest: '',
    capabilityGaps: [], warnings: [], failures: [], ruleParameters: emptyRuleSet(),
  }
}

/** Host-bound rule record file, relative to the knowledge snapshot dir. */
const RULE_RECORD_FILE = '规则参数.json'

function emptyRuleSet(routeId = '', snapshotDigest = ''): RuleParameterSet {
  return {
    ok: false, error: '', errorKind: 'missing', routeId, ruleSetVersion: '',
    snapshotDigest, sectionId: '', effectiveFrom: null, effectiveTo: null,
    parameters: [], gaps: [],
  }
}

/** Schema-declared persisted shape: Host-bound provenance plus the data parameters. */
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

/**
 * Resolve structured rules from the **verified persisted bytes**.
 *
 * Exactly one rule-bearing snapshot is usable. The fragment may omit routeId/snapshotDigest; the
 * Host binds both from the persisted entry, and an explicitly mismatched value is still rejected.
 * Missing/unsafe/ambiguous results return an empty set with a capability gap and never defaults.
 */
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

export function valuationKnowledgeTools(deps: ToolDeps) {
  const materialize = defineTool({
    name: VALUATION_TOOL_NAMES.knowledgeMaterialize,
    description: [
      '把 manifest 声明的房地产估值业务规范正文取到案例目录的 知识快照/ 下，并返回知识来源证据',
      '（routeId / 实际节点名 / 来源 dws|verified-mirror / 正文指纹 / 查找轨迹 / 非空正文校验）。',
      `正文只来自「${VALUATION_KNOWLEDGE_SPACE}」或身份已验证的本地镜像。`,
      '**主通道是按入口 Wiki 的库内相对链接逐篇读取**：把链接解析出的库内路径传给 wikiPaths，',
      '每一轮都把新读到的正文里的 links[] 带回，由你决定下一跳读哪一份。',
      'routeIds 是遗留通道（manifest 槽位）：省略且没给 wikiPaths 时只回报本库声明了哪些槽位，不下载任何正文。',
      'stage=parameters 时，在已验真的已落盘正文上解析受控结构化规则段，返回并持久化 Host 绑定的规则参数记录：',
      '缺规则段只形成 capabilityGaps 与空参数集，不阻断普通 Wiki 读取，也绝不补默认值。',
      '逐条路径 / 槽位取不到只如实回报 states 与 capabilityGaps，不阻断其余；'
      + '给了 wikiPaths 时 manifest 读不到也不再整体失败（只是没有槽位清单可回报）。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      routeIds: {
        type: 'array', items: { type: 'string' },
        description: '遗留通道：manifest 声明的知识槽位（如方法选择的 routeId）。'
          + '省略且没给 wikiPaths = 只回报 availableRouteIds。',
      },
      wikiPaths: {
        type: 'array', items: { type: 'string' },
        description: '**主通道**：库内相对路径清单（逐字），来自入口 Wiki 或上一轮返回的 links[].target。'
          + '入口 Wiki 自己也通过它读取。路径逐字匹配，不做大小写 / 全半角折叠。',
      },
      planId: { type: 'string', description: '本轮方案 id（分组阶段可省略；由 Host 铸号）。' },
      stage: {
        type: 'string',
        description: '可选：`parameters` 时在已验真的已落盘正文上解析受控结构化规则段，'
          + '返回并持久化 Host 绑定的规则参数记录；缺省或其它请求只返回稳定的空/缺口集合，不影响普通 Wiki 读取。',
      },
      spaceName: {
        type: 'string',
        description: `业务知识库精确名称；缺省且在配置里只允许 ${VALUATION_KNOWLEDGE_SPACE}。`,
      },
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
          indexPath: { type: 'string', required: true, description: `汇总索引：${KNOWLEDGE_SNAPSHOT_DIR}/${KNOWLEDGE_INDEX_FILE}` },
          spaceName: { type: 'string', required: true, description: '实际读到的空间名' },
          expectedSpaceName: { type: 'string', required: true },
          spaceVerified: { type: 'boolean', required: true },
          manifestDigest: { type: 'string', required: true, description: '本轮据以取数的 manifest 正文指纹（遗留链路的留痕）' },
          entryWikiPath: {
            type: 'string', required: true,
            description: '配置声明的**入口 Wiki**（库内路径）。协议 39 起的唯一业务入口：'
              + '先读它，再按它的库内相对链接逐篇读取；manifest 只对旧配置有意义。',
          },
          availableRouteIds: {
            type: 'array', required: true, items: { type: 'string' },
            description: 'manifest 声明的全部槽位（不只是本轮请求的）',
          },
          routeIds: { type: 'array', required: true, items: { type: 'string' } },
          wikiPaths: {
            type: 'array', required: true, items: { type: 'string' },
            description: '本轮按 Wiki 路径请求的库内路径（逐字）',
          },
          states: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                routeId: { type: 'string', required: true },
                state: { type: 'string', required: true, description: 'found / missing / empty / ambiguous / unreadable' },
                error: { type: 'string', required: true },
              },
            },
          },
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                routeId: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                resolvedPath: { type: 'string', required: true },
                source: { type: 'string', required: true },
                digest: { type: 'string', required: true },
                snapshotFile: { type: 'string', required: true },
                bodyNonEmpty: { type: 'boolean', required: true },
                channel: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                links: {
                  type: 'array', required: true,
                  description: '正文里的库内链接：path 已按当前文档所在库内目录解析；kind 分 knowledge/external/anchor/invalid',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      label: { type: 'string', required: true },
                      target: { type: 'string', required: true, description: '作者写的原始 target（逐字）' },
                      path: { type: 'string', required: true, description: '库内完整路径；非 knowledge 时为空串' },
                      anchor: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      error: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          lookupAttempts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                routeId: { type: 'string', required: true },
                channel: { type: 'string', required: true },
                target: { type: 'string', required: true },
                outcome: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          indexFiles: { type: 'array', required: true, items: { type: 'string' } },
          digest: { type: 'string', required: true, description: '整份知识快照的指纹' },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          ruleParameters: {
            type: 'object', required: true, additionalProperties: true, properties: {},
            description: 'Host-bound structured rule parameters. `ok:false` with empty `parameters` means no usable rules.',
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          failures: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { step: { type: 'string', required: true }, error: { type: 'string', required: true } },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args, exec): Promise<MaterializeOutcome> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      // ① 参数收窄：任何 I/O 之前。
      const requestedSpace = text(args.spaceName).trim()
      if (requestedSpace !== '' && requestedSpace !== VALUATION_KNOWLEDGE_SPACE) {
        return {
          ...base,
          ...failure('policy',
            `业务库名只允许配置值「${VALUATION_KNOWLEDGE_SPACE}」，收到「${requestedSpace}」：`
            + '审核知识库与业务知识库不是同一个库，不接受改道。'),
        }
      }
      const requested: string[] = []
      for (const raw of Array.isArray(args.routeIds) ? args.routeIds : []) {
        const routeId = text(raw).trim()
        if (routeId !== '' && !requested.includes(routeId)) requested.push(routeId)
      }
      // **Wiki 路径通道**（协议 39 的主通道）：路径由业务侧正文决定，不由代码里的槽位表决定。
      const wikiPaths: string[] = []
      for (const raw of Array.isArray(args.wikiPaths) ? args.wikiPaths : []) {
        const wikiPath = text(raw).trim()
        if (wikiPath !== '' && !wikiPaths.includes(wikiPath)) wikiPaths.push(wikiPath)
      }
      // Pre-I/O lexical check: unsafe or unsupported paths must never reach the knowledge base.
      for (const wikiPath of wikiPaths) {
        const problem = wikiPathProblem(wikiPath)
        if (problem !== '') {
          return { ...base, ...failure('input', `Wiki 路径不能用：「${wikiPath}」：${problem}`) }
        }
      }
      const planId = text(args.planId).trim()
      if (planId !== '' && !isSafeIdSegment(planId)) {
        return { ...base, ...failure('input', `方案 id 必须是单段安全标识：「${planId}」`) }
      }
      const requestedStage = text(args.stage).trim()
      if (requestedStage !== '' && requestedStage !== 'parameters') {
        return { ...base, ...failure('input', `不支持的 stage：「${requestedStage}」（只支持 parameters）`) }
      }

      // ② 调用身份（案例归属门禁；普通会话不许把知识倒进案例目录）。
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：知识准备只能在估值子会话里进行') }
      }
      const caseDir = access.casePath
      const knowledgeDir = joinLocalPath(caseDir, KNOWLEDGE_SNAPSHOT_DIR)
      const identity = callerIdentity(exec)
      const scope = deps.valuationScopes?.scopeOf(identity.childId)
      const projectId = text(scope?.projectId) || text(scope?.valuationId) || basenameLocalPath(caseDir)
      // Exact live-scope key: a closed/reopened round (new openedAt) never reuses the catalog.
      const scopeKey = scope === undefined
        ? ''
        : `${scope.valuationId}\u0000${scope.sessionId}\u0000${String(scope.openedAt)}`
      const ownedPlans = (scope as { planIds?: string[] } | undefined)?.planIds
      if (planId !== '' && Array.isArray(ownedPlans) && !ownedPlans.includes(planId)) {
        return {
          ...base, caseDir, knowledgeDir,
          ...failure('policy', `方案「${planId}」不属于本轮估值：不能把别的方案的知识快照写进来`),
        }
      }

      const platform = await deps.world.platform()
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }
      const failures: Array<{ step: string; error: string }> = []

      const made = await ensureDirectory(deps.access, knowledgeDir, { workdir: caseDir, platform, ...writeOptions })
      if (!made.ok) return { ...base, ...failure('infrastructure', made.error), caseDir, knowledgeDir }
      // 每条路由一个子目录：正文与索引都落在这里，便于按方案只读整份快照。
      //
      // ⚠️ Wiki 路径的 routeId 形如 `wiki:01 估值与测算/01 房地产/wiki.md`（**含斜杠**）：
      // 直接当目录名会建出一串嵌套目录，把"按路由隔离"变成"按路径散落"。所以落到磁盘上的
      // 段名统一走 `knowledgeFileName()`（去掉路径分隔符与非法字符），路由 id 本身仍记在索引里。
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

      // Read the existing aggregate before any network read. A malformed or foreign index fails
      // closed and stays untouched, so a broken refresh cannot erase known sources.
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
        ctx, deps, caseDir, platform, scopeKey, ...(signal === undefined ? {} : { signal }),
      })
      failures.push(...catalogFailures)

      const mirrorRoot = knowledgeMirrorRootOf(deps)
      const manifestPath = knowledgeManifestPathOf(deps)
      // Wiki-only requests do not use the legacy slot list: skip its unused manifest export.
      const wikiOnly = wikiPaths.length > 0 && requested.length === 0
      const manifest: KnowledgeManifest = await materializeKnowledge({
        projectId, planId, routeIds: requested, wikiPaths,
      }, {
        spaceName: VALUATION_KNOWLEDGE_SPACE,
        manifestDir: knowledgeManifestDirOf(manifestPath),
        loadManifest: wikiOnly
          ? async () => ({ ok: false, document: '', error: '显式 Wiki 路径请求不需要 manifest' })
          : () => loadKnowledgeManifest({
            ctx, deps, caseDir, knowledgeDir, platform, catalog, ...(signal === undefined ? {} : { signal }),
          }),
        loadCatalog: async () => catalog,
        // Verified reuse + cumulative writes when a valid prior aggregate exists.
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
        // 远程**明确缺失**时才走身份已验证镜像；未配置镜像时这一步不出现。
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
          // 读回的产物为空时按**未支持**处理，而不是"取数失败"：
          // 空文档是知识库的事实（`empty` ≠ `missing`），而"导出成功但产物不存在"同样不该被
          // 当成有正文 —— 两种都不算命中，都不进快照。
          return { ok: true, body: await readTextIfExists(ctx, joinLocalPath(knowledgeDir, document.snapshotFile)) }
        },
        // 二进制槽位（模板）不在这条通道上：`availableRouteIds` 里**包含**它们（manifest 就是
        // 这么声明的），所以调用方会合理地请求一条。答案必须是"走模板工具"，
        // 而不是让 `resolve.ts` 说出"通道未装配"那句读起来像程序没写完的话。
        readBinary: async (document: RouteDocument) => ({
          ok: false,
          bytes: new Uint8Array(0),
          error: `「${document.name}」是二进制模板，不按正文取回：请用 ${VALUATION_TOOL_NAMES.templateMaterialize}`,
        }),
        writeSnapshot: async (input) => {
          const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath: input.relativePath })
          if (!contained.ok) return { ok: false, error: contained.error }
          const written = await writeCaseText(
            ctx, joinLocalPath(knowledgeDir, input.relativePath), String(input.content), writeOptions,
          )
          return written.ok ? { ok: true, error: '' } : { ok: false, error: written.error }
        },
        writeIndex: async (input) => {
          const written = await writeCaseText(ctx, joinLocalPath(knowledgeDir, input.relativePath), input.document, writeOptions)
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
        // 取数层的警告原样带上（通道迁移、manifest 不可读但继续按 Wiki 路径取…），
        // 再加一条旧通道的迁移提示：本库**仍然靠 manifest 槽位寻址**时明确说清该换成入口 Wiki。
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
    },
  })

  return [materialize]
}
