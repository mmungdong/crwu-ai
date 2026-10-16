import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_browser_recover`：**继续**一次被可见人机验证打断的取数任务（设计稿 §8.4）。
 *
 * ## 它不是一个"再试一次"按钮
 *
 * 自动恢复由取数链路（`browser-transport.ts`）**自己做**：遇到可见挑战先调用固定脚本，
 * 最多 2 次尝试、总窗口 120 秒，预算与冷却由协调器管理。所以这个 Tool 的职责只有一件事：
 * **员工在可见窗口里完成网页验证之后，让他从同一个断点继续**。
 *
 * 三条因此定死的口径：
 *
 * 1. **输入只有 `providerId` + `retrievalTaskId`**：没有 URL、没有策略、没有脚本、没有输出目录。
 *    原页面 URL 从协调器里那份受保护的预算记录读 —— 否则这个 Tool 就变成了"导航到任意页面"。
 * 2. **没登记过的取数任务一律拒绝**：凭空发起一次恢复等于凭空导航，而且"恢复的是哪一个房源"
 *    会变得无法追溯。
 * 3. **它不重置自动预算**：员工继续不等于又可以自动尝试两轮。
 *
 * 返回值只给**安全摘要**：状态、原因码、尝试次数、策略、页面级校验结果。
 * **不含** Cookie、挑战凭证、原始 CDP 指令，也不含截图（挑战页截图永远不是案例证据）。
 */
interface RecoverArgs {
  caseDir?: unknown
  providerId?: unknown
  retrievalTaskId?: unknown
}

interface RecoverResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  /** 恢复结论：`recovered` / `waiting-user` / `unsupported` / `cancelled` / `unavailable` / `failed`。 */
  state: string
  reasonCode: string
  attempts: number
  strategyId: string
  /** 页面级证据（Host 侧还会补房源字段校验）。 */
  pageValidation: {
    finalUrl: string
    hostMatches: boolean
    challengeVisible: boolean
    loginWall: boolean
    blocked: boolean
    overlaySelectors: string[]
    reason: string
  }
  /** 给员工看的下一步（`waiting-user` 时非空）。 */
  nextAction: string
  nextEligibleAt: string
}

const MEANING = '自动恢复由取数链路自己做（最多 2 次 / 120 秒，预算与冷却由程序管理）。'
  + '本工具只在员工完成网页验证之后，从同一个取数任务继续；它不接受 URL、策略或脚本，也不重置自动预算。'

const emptyValidation = (): RecoverResult['pageValidation'] => ({
  finalUrl: '', hostMatches: false, challengeVisible: false,
  loginWall: false, blocked: false, overlaySelectors: [], reason: '',
})

export function valuationBrowserRecoverTools(deps: ToolDeps) {
  const recover = defineTool({
    name: VALUATION_TOOL_NAMES.browserRecover,
    description: [
      '在员工完成可见人机验证之后，从**同一个取数任务**继续取数。',
      '自动恢复（固定脚本、最多 2 次 / 120 秒）由取数链路自己做，不需要调用本工具发起；',
      '本工具不接受 URL / 策略 / 脚本 / 输出目录，也不会重置自动尝试预算。',
      '没有登记过的取数任务会被拒绝：恢复不能凭空导航到别的页面。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      providerId: { type: 'string', required: true, description: '该取数任务的来源 id（与原任务一致）。' },
      retrievalTaskId: { type: 'string', required: true, description: '被打断的那个取数任务 id。' },
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
          state: { type: 'string', required: true },
          reasonCode: { type: 'string', required: true },
          attempts: { type: 'number', required: true },
          strategyId: { type: 'string', required: true },
          pageValidation: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              finalUrl: { type: 'string', required: true },
              hostMatches: { type: 'boolean', required: true },
              challengeVisible: { type: 'boolean', required: true },
              loginWall: { type: 'boolean', required: true },
              blocked: { type: 'boolean', required: true },
              overlaySelectors: { type: 'array', required: true, items: { type: 'string' } },
              reason: { type: 'string', required: true },
            },
          },
          nextAction: { type: 'string', required: true },
          nextEligibleAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: RecoverArgs, exec): Promise<RecoverResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base: RecoverResult = {
        ok: false, errorKind: '', error: '', caseDir: '',
        state: '', reasonCode: '', attempts: 0, strategyId: '',
        pageValidation: emptyValidation(), nextAction: '', nextEligibleAt: '',
      }
      const coordinator = deps.browserRuntime?.coordinator
      if (coordinator === undefined) {
        // 缺能力就如实说缺能力：**不允许**去装库、拼命令或改用别的通道抓网页。
        return {
          ...base,
          ...failure('capability-gap', `本部署没有装配浏览器恢复能力（${MEANING}）：无法继续该取数任务。`),
        }
      }

      // 案例归属门禁：与原取数任务同一条口径（会话 → 本轮案例目录逐字相等）。
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...failure('policy', access.error) }
      const caseDir = access.casePath ?? ''

      const providerId = String(args.providerId ?? '').trim()
      const retrievalTaskId = String(args.retrievalTaskId ?? '').trim()
      if (providerId === '' || retrievalTaskId === '') {
        return { ...base, caseDir, ...failure('input', 'providerId 与 retrievalTaskId 都必须给出。') }
      }

      try {
        const outcome = await coordinator.resume(
          { providerId, retrievalTaskId },
          callerSession(exec) === undefined ? undefined : exec.signal,
        )
        const recovered = outcome.state === 'recovered'
        const nextAction = recovered
          ? '页面已恢复：请对**原房源**重新读取详情并重新抓取正式截图（挑战页截图不能作为案例证据）。'
          : outcome.state === 'unsupported'
            ? '没有适配的挑战策略：请让员工在当前可见窗口里人工完成验证，然后用同一取数任务再次调用本工具。'
            : '请在当前可见浏览器窗口里完成网页验证，然后用**同一取数任务**继续（不需要重传资料、不重建会话）。'
        return {
          ok: true,
          errorKind: '',
          error: '',
          caseDir,
          state: outcome.state,
          reasonCode: outcome.reasonCode,
          attempts: outcome.attempts,
          strategyId: outcome.strategyId,
          pageValidation: {
            finalUrl: outcome.pageValidation.finalUrl,
            hostMatches: outcome.pageValidation.hostMatches,
            challengeVisible: outcome.pageValidation.challengeVisible,
            loginWall: outcome.pageValidation.loginWall,
            blocked: outcome.pageValidation.blocked,
            overlaySelectors: [...outcome.pageValidation.overlaySelectors].slice(0, 8),
            reason: outcome.pageValidation.reason,
          },
          nextAction: recovered ? nextAction : nextAction,
          nextEligibleAt: outcome.nextEligibleAt,
        }
      } catch (error) {
        // 「没登记过这个取数任务」是**输入**问题，不是基础设施故障：分开报，员工才知道该做什么。
        const message = error instanceof Error ? error.message : String(error)
        const kind = /没有登记过|属于来源|已经绑定/.test(message) ? 'input' : 'infrastructure'
        return { ...base, caseDir, ...failure(kind, message) }
      }
    },
  })
  return [recover]
}
