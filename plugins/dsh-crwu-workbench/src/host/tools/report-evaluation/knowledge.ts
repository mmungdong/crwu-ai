import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  VALUATION_KNOWLEDGE_SPACE,
} from '../../domains/report-evaluation/knowledge/index.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'
import {
  idleKnowledgeResult,
  runKnowledgeMaterialization,
  type MaterializeOutcome,
} from '../../integrations/valuation-workflow/services/knowledge.ts'

/**
 * `crwu_valuation_knowledge_materialize`：把业务知识正文取到案例目录并留下来源证据。
 *
 * This registered Tool is now only a schema/transport wrapper: the same reusable
 * authorized service is called by the future workflow runtime, so the two paths
 * cannot drift. Case access is checked here before any I/O; the service then
 * independently rechecks the live valuation scope/case/project binding.
 */
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
        description: '**主通道**：库内相对路径清单（逐字），来自入口 Wiki 或上一轮返回的 links[].path'
          + '（已按当前文档所在目录解析的库内完整路径；links[].target 只是作者原文，不能直接当路径）。'
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
      const base = idleKnowledgeResult()

      // Transport authorization first: the service never accepts a model boolean.
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：知识准备只能在估值子会话里进行') }
      }

      const session = callerSession(exec)
      return await runKnowledgeMaterialization(args, {
        ctx,
        config: deps.config,
        access: deps.access,
        world: deps.world,
        valuationScopes: deps.valuationScopes,
        cacheOwner: deps,
      }, {
        sessionId: callerIdentity(exec).childId,
        caseDir: access.casePath,
        source: 'valuation-tool',
        ...(session === undefined ? {} : { session }),
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
    },
  })

  return [materialize]
}
