import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'
import {
  idleListingReferenceResult,
  runListingReference,
  type ListingReferenceResult,
} from '../../integrations/valuation-workflow/services/listing-reference.ts'

/**
 * `crwu_valuation_listing_reference`: one-call listing-reference delivery.
 *
 * This registered Tool is a schema/transport wrapper. The reusable authorized
 * service owns the fixed-input verification, packaged-Python invocation, four-file
 * checks and the always-`partial` status; the future workflow runtime calls the same
 * service, so there is exactly one business execution path.
 */
export function valuationListingReferenceTools(deps: ToolDeps) {
  const tool = defineTool({
    name: VALUATION_TOOL_NAMES.listingReference,
    description: [
      '挂牌参考的**一次性交付**：读本方案的固定输入',
      '（`方案/<planId>` 或 `修订/<n>` 下的 `挂牌参考输入.json`），',
      '经配置好的 DSH Python 跑一次打包脚本，产出 计算轨迹 / 估值底稿 /',
      '估值报告数据 / 估值报告。四个产物都必须真实存在且非空，状态只可能是 partial。',
      '输入路径、脚本与输出目录全部由 Host 从已登记方案派生，调用方提交不了任意路径或命令。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', required: true, description: '已登记到本轮的方案 id（输入与产物按方案隔离）。' },
      revision: {
        type: 'integer',
        description: '修订版本：> 1 时读 / 写 方案/<planId>/修订/<n>/；缺省 / 1 = 方案根。',
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
          status: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          planId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          reused: { type: 'boolean', required: true },
          outputs: { type: 'array', required: true, items: { type: 'string' } },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          python: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              path: { type: 'string', required: true },
              versionText: { type: 'string', required: true },
              source: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args, exec): Promise<ListingReferenceResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleListingReferenceResult()

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：挂牌参考交付只能在估值子会话里进行') }
      }

      const session = callerSession(exec)
      return await runListingReference(args, {
        ctx,
        config: deps.config,
        access: deps.access,
        world: deps.world,
        python: deps.python,
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

  return [tool]
}
