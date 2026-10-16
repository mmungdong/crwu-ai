import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { fileSystem } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { isSafeIdSegment } from '../../domains/report-evaluation/project/contracts.ts'
import {
  KNOWLEDGE_INDEX_DIR,
  KNOWLEDGE_SNAPSHOT_DIR,
  VALUATION_KNOWLEDGE_SPACE,
  isValuationMethodKey,
  loadVerifiedMirror,
  materializeKnowledge,
  methodTemplateRouteId,
  parseValuationManifest,
  safeSnapshotRelative,
  verifyTemplateWorkbook,
  wikiPathProblem,
  type KnowledgeManifest,
  type KnowledgeRoute,
  type RouteDocument,
} from '../../domains/report-evaluation/knowledge/index.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { dwsJson } from '../report-audit/dws-json.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'
import {
  containKnowledgeTarget,
  knowledgeManifestDirOf,
  knowledgeManifestPathOf,
  knowledgeMirrorRootOf,
  loadKnowledgeCatalog,
  loadKnowledgeManifest,
  loadPriorKnowledgeIndex,
} from './catalog.ts'

/**
 * `crwu_valuation_template_materialize`：把 manifest 为该方法声明的**那一份**计算表模板
 * 取回案例目录，并逐字节验真。
 *
 * ## 为什么模板必须单独一个通道
 *
 * 模板是**二进制**：按文本读回来会得到一堆乱码，而"读到了内容"会被误当成"模板到手了"。
 * 而且模板的价值全在数值口径上 —— 表序、公式链、输入区位置。所以这条通道有两道门：
 *
 * 1. **来源只有一处**：manifest 的 `methods.<m>.template`。为 `null` 或不声明就是
 *    "该方法还没有模板"，如实返回 capability-gap —— **不拿别的方法的模板顶替，
 *    也不按物业类型猜一份**；
 * 2. **逐字节验真**（`verifyTemplateWorkbook`）：非 ZIP、空字节都拒绝 ——
 *    HTML 错误页 / 登录页 / 网关改写响应在这里被抓住，而不是在员工填表时。
 *
 * 结构合同（七张可见表、公式链）交给技能自带的 `check_workbook_contract.py`。
 *
 * ## 按方法维度，不按物业类型
 *
 * 原来的 `templateRouteFor(propertyType, method)` 用物业类型选模板
 * （`template.market.residential`），manifest 的 `methods.<m>.template` 只有方法维度。
 * **本次按方法维度落地**：物业类型细分留到业务侧真需要第二份模板时再扩 manifest 结构。
 * 这是一个有意的简化 —— 多一个维度就多一处"没登记的口径"，而首期只有一份住宅市场法模板。
 *
 * ## 模型可见结果
 *
 * 只回 routeId / 节点名 / 相对路径 / 指纹 / 字节数 / 查找轨迹。
 * `nodeId`、镜像绝对路径、原始命令一律不出现在结果里。
 */

/** 模板工作簿的字节上限：模板是"空表"，超过这个数说明取回来的不是模板。 */
const TEMPLATE_MAX_BYTES = 32 * 1024 * 1024

interface TemplateOutcome {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  knowledgeDir: string
  method: string
  routeId: string
  nodeName: string
  source: string
  snapshotFile: string
  digest: string
  sizeBytes: number
  spaceName: string
  spaceVerified: boolean
  manifestDigest: string
  availableRouteIds: string[]
  lookupAttempts: Array<{ routeId: string; channel: string; target: string; outcome: string; detail: string }>
  capabilityGaps: string[]
  warnings: string[]
}

function idleResult(): TemplateOutcome {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', knowledgeDir: '', method: '', routeId: '',
    nodeName: '', source: '', snapshotFile: '', digest: '', sizeBytes: 0,
    spaceName: '', spaceVerified: false, manifestDigest: '', availableRouteIds: [],
    lookupAttempts: [], capabilityGaps: [], warnings: [],
  }
}

export function valuationTemplateTools(deps: ToolDeps) {
  const materialize = defineTool({
    name: VALUATION_TOOL_NAMES.templateMaterialize,
    description: [
      '按知识目录 manifest 为该方法声明的路径取出计算表模板（xlsx）到案例目录的 知识快照/ 下，',
      '并逐字节验真（ZIP/xlsx 魔数、非空）。来源只有 manifest 一处：',
      'methods.<方法>.template 为 null 或不声明 = 该方法还没有模板，返回 capability-gap 而不猜一份。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      method: { type: 'string', required: true, description: '采用的方法：market / income / cost。' },
      planId: { type: 'string', description: '本轮方案 id（分组阶段可省略）。' },
      wikiPath: {
        type: 'string',
        description: '可选：业务知识库内的 xlsx 相对路径（逐字）。给出后直接按该路径取回模板，'
          + '不再依赖 manifest 槽位；只接受库内相对 xlsx 路径。',
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
          method: { type: 'string', required: true },
          routeId: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          source: { type: 'string', required: true, description: 'dws / verified-mirror' },
          snapshotFile: { type: 'string', required: true, description: '相对 知识快照/ 的落盘路径' },
          digest: { type: 'string', required: true },
          sizeBytes: { type: 'number', required: true },
          spaceName: { type: 'string', required: true },
          spaceVerified: { type: 'boolean', required: true },
          manifestDigest: { type: 'string', required: true },
          availableRouteIds: { type: 'array', required: true, items: { type: 'string' } },
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
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args, exec): Promise<TemplateOutcome> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      // ① 参数收窄：任何 I/O 之前。
      const method = text(args.method).trim()
      if (!isValuationMethodKey(method) || method === 'auto') {
        return { ...base, method, ...failure('input', `模板只能按**已确定**的方法选取，收到「${method || '(空)'}」`) }
      }
      const requestedSpace = text(args.spaceName).trim()
      if (requestedSpace !== '' && requestedSpace !== VALUATION_KNOWLEDGE_SPACE) {
        return {
          ...base, method,
          ...failure('policy',
            `业务库名只允许配置值「${VALUATION_KNOWLEDGE_SPACE}」，收到「${requestedSpace}」：模板同样只来自业务库。`),
        }
      }
      const planId = text(args.planId).trim()
      if (planId !== '' && !isSafeIdSegment(planId)) {
        return { ...base, method, ...failure('input', `方案 id 必须是单段安全标识：「${planId}」`) }
      }
      // Explicit template path: reject unsafe or non-xlsx input before any I/O.
      const wikiPath = text(args.wikiPath).trim()
      if (wikiPath !== '') {
        const problem = wikiPathProblem(wikiPath)
        if (problem !== '') {
          return { ...base, method, ...failure('input', `模板 wikiPath 不能用：「${wikiPath}」：${problem}`) }
        }
        const extension = wikiPath.toLowerCase().slice(wikiPath.toLowerCase().lastIndexOf('.') + 1)
        if (extension !== 'xlsx') {
          return { ...base, method, ...failure('input', `模板必须是 xlsx（收到 .${extension}）：显式路径只接受库内 xlsx 文件`) }
        }
      }

      // ② 归属门禁。
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, method, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, method, ...failure('policy', '这条会话不是本轮估值会话：模板只能取进本轮估值案例目录') }
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
          ...base, caseDir, knowledgeDir, method,
          ...failure('policy', `方案「${planId}」不属于本轮估值：不能把别的方案的模板写进来`),
        }
      }

      const platform = await deps.world.platform()
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }
      const fs = fileSystem(ctx)

      const made = await ensureDirectory(deps.access, knowledgeDir, { workdir: caseDir, platform, ...writeOptions })
      if (!made.ok) return { ...base, caseDir, knowledgeDir, method, ...failure('infrastructure', made.error) }

      // Read the persisted aggregate before any network read; a malformed or foreign index fails
      // closed so a broken refresh cannot erase known sources.
      const priorRead = await loadPriorKnowledgeIndex({
        ctx, caseDir, knowledgeDir, projectId, ...(signal === undefined ? {} : { signal }),
      })
      if (priorRead.kind !== 'absent' && priorRead.kind !== 'ok') {
        return {
          ...base, caseDir, knowledgeDir, method,
          ...failure(priorRead.kind === 'policy' ? 'policy' : 'infrastructure', priorRead.error),
        }
      }
      const priorIndex = priorRead.index

      const { catalog, failures: catalogFailures } = await loadKnowledgeCatalog({
        ctx, deps, caseDir, platform, scopeKey, ...(signal === undefined ? {} : { signal }),
      })

      // Shared hooks for both acquisition routes.
      const writeSnapshotOf = async (input: { relativePath: string; content: string | Uint8Array; binary: boolean }) => {
        const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath: input.relativePath })
        if (!contained.ok) return { ok: false, error: contained.error }
        if (input.binary) {
          // `drive +download --output` already wrote the bytes; only confirm they landed.
          if (fs === undefined) return { ok: false, error: '宿主文件服务不可用' }
          try {
            const bytes = await fs.readBytes(
              await fs.resolve(joinLocalPath(knowledgeDir, input.relativePath)), undefined, TEMPLATE_MAX_BYTES,
            )
            return bytes.length > 0 ? { ok: true, error: '' } : { ok: false, error: '模板字节为空：没有落盘' }
          } catch (error) {
            return { ok: false, error: `模板未落盘（${input.relativePath}）：${error instanceof Error ? error.message : String(error)}` }
          }
        }
        const written = await writeCaseText(ctx, joinLocalPath(knowledgeDir, input.relativePath), String(input.content), writeOptions)
        return written.ok ? { ok: true, error: '' } : { ok: false, error: written.error }
      }
      const writeIndexOf = async (input: { relativePath: string; document: string }) => {
        const written = await writeCaseText(ctx, joinLocalPath(knowledgeDir, input.relativePath), input.document, writeOptions)
        return written.ok ? { ok: true, error: '' } : { ok: false, error: written.error }
      }
      const readSnapshotOf = async (relativePath: string, binary: boolean) => {
        if (fs === undefined) return { ok: false, error: '宿主文件服务不可用' }
        if (!safeSnapshotRelative(relativePath)) return { ok: false, error: '快照路径越界' }
        const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath })
        if (!contained.ok) return { ok: false, error: contained.error }
        try {
          const resolved = await fs.resolve(joinLocalPath(knowledgeDir, relativePath))
          if (binary) return { ok: true, content: await fs.readBytes(resolved, signal, TEMPLATE_MAX_BYTES) }
          return { ok: true, content: await fs.readText(resolved, signal) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      const makeReadBinary = (routeIdForVerify: string) => async (document: RouteDocument) => {
        if (fs === undefined) return { ok: false, bytes: new Uint8Array(0), error: '宿主文件服务不可用' }
        const contained = await containKnowledgeTarget({ ctx, caseDir, knowledgeDir, relativePath: document.snapshotFile })
        if (!contained.ok) {
          return { ok: false, bytes: new Uint8Array(0), error: `目标不在本轮案例的知识快照目录内：${contained.error}` }
        }
        const slash = document.snapshotFile.indexOf('/')
        const routeDir = slash < 0 ? knowledgeDir : joinLocalPath(knowledgeDir, document.snapshotFile.slice(0, slash))
        const output = slash < 0 ? document.snapshotFile : document.snapshotFile.slice(slash + 1)
        const dirReady = await ensureDirectory(deps.access, routeDir, { workdir: caseDir, platform, ...writeOptions })
        if (!dirReady.ok) return { ok: false, bytes: new Uint8Array(0), error: dirReady.error }
        const run = await dwsJson(ctx, platform, [
          'drive', '+download', '--node', document.nodeId, '--output', output, '--format', 'json',
        ], {
          workdir: routeDir, access: deps.access, source: 'audit-tool', ...(signal === undefined ? {} : { signal }),
        })
        if (!run.ok) return { ok: false, bytes: new Uint8Array(0), error: run.error }
        let bytes: Uint8Array
        try {
          bytes = await fs.readBytes(await fs.resolve(joinLocalPath(routeDir, output)), signal, TEMPLATE_MAX_BYTES)
        } catch (error) {
          return { ok: false, bytes: new Uint8Array(0), error: `模板字节读回失败（${document.name}）：${error instanceof Error ? error.message : String(error)}` }
        }
        const check = verifyTemplateWorkbook(bytes, routeIdForVerify)
        if (!check.ok) return { ok: false, bytes: new Uint8Array(0), error: check.problems.join('；') }
        return { ok: true, bytes }
      }
      // Binary routes are never read through the text channel.
      const readTextBody = async (document: RouteDocument) => (
        { ok: false, error: `路由「${document.name}」是二进制模板，不能用文本通道读回` }
      )
      const mirrorRoot = knowledgeMirrorRootOf(deps)
      const mirrorOption = mirrorRoot === ''
        ? {}
        : { loadMirror: (route: KnowledgeRoute) => loadVerifiedMirror(route, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot }) }
      const resultOf = (manifest: KnowledgeManifest, common: TemplateOutcome): TemplateOutcome => {
        const entryOfRoute = manifest.entries[0]
        const lookupAttempts = manifest.lookupAttempts.map((attempt) => ({
          routeId: attempt.routeId, channel: attempt.channel, target: attempt.target,
          outcome: attempt.outcome, detail: attempt.detail,
        }))
        const gaps = [...manifest.capabilityGaps, ...catalogFailures.map((row) => `${row.step}: ${row.error}`)]
        if (!manifest.ok || entryOfRoute === undefined) {
          return {
            ...common,
            spaceName: manifest.spaceName, spaceVerified: manifest.spaceVerified,
            manifestDigest: manifest.manifestDigest, availableRouteIds: manifest.availableRouteIds,
            lookupAttempts, capabilityGaps: gaps,
            ...failure(manifest.errorKind === '' ? 'capability-gap' : manifest.errorKind,
              manifest.error || `模板路由「${manifest.routeIds[0] ?? common.routeId}」没有取到：${gaps.join('；')}`),
          }
        }
        return {
          ok: true, errorKind: '', error: '',
          caseDir: common.caseDir, knowledgeDir: common.knowledgeDir, method: common.method,
          routeId: entryOfRoute.routeId,
          nodeName: entryOfRoute.nodeName, source: entryOfRoute.source,
          snapshotFile: entryOfRoute.snapshotFile, digest: entryOfRoute.digest, sizeBytes: entryOfRoute.sizeBytes,
          spaceName: manifest.spaceName, spaceVerified: manifest.spaceVerified,
          manifestDigest: manifest.manifestDigest, availableRouteIds: manifest.availableRouteIds,
          lookupAttempts, capabilityGaps: gaps, warnings: [],
        }
      }

      const indexDir = await ensureDirectory(deps.access, joinLocalPath(knowledgeDir, KNOWLEDGE_INDEX_DIR), { workdir: caseDir, platform, ...writeOptions })
      if (!indexDir.ok) return { ...base, caseDir, knowledgeDir, method, ...failure('infrastructure', indexDir.error) }

      // Explicit wikiPath: fetch that exact xlsx and never export the legacy manifest.
      if (wikiPath !== '') {
        const explicitRouteId = `wiki:${wikiPath}`
        const manifest: KnowledgeManifest = await materializeKnowledge({ projectId, planId, wikiPaths: [wikiPath] }, {
          spaceName: VALUATION_KNOWLEDGE_SPACE,
          manifestDir: knowledgeManifestDirOf(knowledgeManifestPathOf(deps)),
          loadManifest: async () => ({ ok: false, document: '', error: '显式 wikiPath 不需要 manifest' }),
          loadCatalog: async () => catalog,
          ...(priorIndex === null ? {} : { priorIndex }),
          readSnapshot: readSnapshotOf,
          ...mirrorOption,
          readBody: readTextBody,
          readBinary: makeReadBinary(explicitRouteId),
          writeSnapshot: writeSnapshotOf,
          writeIndex: writeIndexOf,
        })
        return resultOf(manifest, { ...base, caseDir, knowledgeDir, method, routeId: explicitRouteId })
      }

      // ③ Legacy manifest route: still the only source when no explicit path is given.
      let read: Awaited<ReturnType<typeof loadKnowledgeManifest>> | undefined
      const loadManifest = async (): Promise<{ ok: boolean; document: string; error: string }> => {
        read ??= await loadKnowledgeManifest({
          ctx, deps, caseDir, knowledgeDir, platform, catalog, ...(signal === undefined ? {} : { signal }),
        })
        return read
      }
      const manifestRead = await loadManifest()
      const routeId = methodTemplateRouteId(method)
      const common = { ...base, caseDir, knowledgeDir, method, routeId }
      if (!manifestRead.ok) {
        return {
          ...common, ...failure('capability-gap', `知识目录 manifest 读不到（唯一真停）：${manifestRead.error}`),
          capabilityGaps: catalogFailures.map((row) => `${row.step}: ${row.error}`),
        }
      }
      const parsed = parseValuationManifest(manifestRead.document)
      if (!parsed.ok) {
        return { ...common, ...failure('capability-gap', `知识目录 manifest 不可用：${parsed.error}`) }
      }
      const declared = parsed.routes.find((route) => route.routeId === routeId)
      if (declared === undefined) {
        return {
          ...common,
          availableRouteIds: parsed.routes.map((route) => route.routeId).sort(),
          ...failure('capability-gap',
            `manifest 未声明方法「${method}」的模板（${routeId}）：该方法还没有模板，不拿别的模板顶替。`),
        }
      }

      const manifest: KnowledgeManifest = await materializeKnowledge({ projectId, planId, routeIds: [routeId] }, {
        spaceName: VALUATION_KNOWLEDGE_SPACE,
        manifestDir: knowledgeManifestDirOf(knowledgeManifestPathOf(deps)),
        loadManifest,
        loadCatalog: async () => catalog,
        ...(priorIndex === null ? {} : { priorIndex }),
        readSnapshot: readSnapshotOf,
        ...mirrorOption,
        readBody: readTextBody,
        readBinary: makeReadBinary(routeId),
        writeSnapshot: writeSnapshotOf,
        writeIndex: writeIndexOf,
      })
      return resultOf(manifest, common)
    },
  })

  return [materialize]
}
