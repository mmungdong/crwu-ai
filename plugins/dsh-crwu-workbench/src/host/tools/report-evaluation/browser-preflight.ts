import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { credentialsTrusted, toolContext, type ToolDeps } from '../common/types.ts'
import { recordCapabilityGap, recordProviderState } from './record.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { allProviders, siteOf } from '../../domains/report-evaluation/browser/providers.ts'
import { fetchTransport, MARKET_USER_AGENT } from '../../domains/report-evaluation/browser/fetch-transport.ts'
import type { MarketTransport } from '../../domains/report-evaluation/browser/provider.ts'
import { narrowProviders } from '../../domains/report-evaluation/browser/provider.ts'
import { providerLabel } from '../../domains/report-evaluation/browser/login-state.ts'
import {
  PROBE_TEXTS, accessLabel, accessVerdictOf, probeCategoryOfDetail,
} from '../../domains/report-evaluation/browser/login-probe.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_browser_preflight`：**执行前的来源可用性预检**（协议 32）。
 *
 * ## 它回答的是**三件彼此独立的事实**
 *
 * 对每个来源访问一次**公开探测页**，把结论拆成三条（口径见 `browser/login-probe.ts`）：
 *
 * 1. `login`：登录 / 凭据事实 —— **公开页返回 200 不是"已登录"**，只有登录墙才是 `signed-out`；
 * 2. `readability`：当前页可读性；
 * 3. `retrieval`：本次检索能力。
 *
 * `accessVerdict` 只是三条派生出来的**访问结论**，供界面显示"这一页放不放行"。
 * 它**不读 Cookie、不碰凭据、不知道账号状态** —— 这一点在返回的 `meaning` 字段里明说。
 *
 * ## 为什么"在默认浏览器登录"不在这里
 *
 * 打开系统浏览器是**面板来源**的特权操作（`system.browser.open` 的 `allowedSources` 只有
 * `panel`）。Tool 的来源是 `audit-tool`，它**不能**借面板的身份去开浏览器 —— 那正是
 * 操作表要防的提权。所以登录动作由面板侧的 Host 操作发起（`valuation-browser-preflight`），
 * 这里只把"该去哪个来源登录"如实回给上层。
 */

interface PreflightArgs {
  caseDir?: unknown
  providers?: unknown
}

interface ProviderState {
  id: string
  label: string
  /** ① 登录 / 凭据事实（**不是**"公开页 200 就等于已登录"）。 */
  login: string
  /** ② 当前页可读性。 */
  readability: string
  /** ③ 本次检索能力。 */
  retrieval: string
  /** 三条派生出的访问结论；`public-page-open` **不是**"已登录"。 */
  accessVerdict: string
  /** 访问结论的人话（界面直接展示，不写"已登录"）。 */
  accessLabel: string
  detail: string
  /** 需要人工在浏览器完成验证（插件不做任何绕过）。 */
  captcha: boolean
  /** 这一类别的下一步动作。 */
  nextAction: string
  /** 该来源的登录入口；面板据此打开默认浏览器。**不是**凭据，只是公开登录页地址。 */
  loginUrl: string
}

interface PreflightResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  /** 状态的语义说明（防止被误读成"插件知道账号状态"）。 */
  meaning: string
  states: ProviderState[]
  /** 确实"没登录 / 被登录墙挡住"的来源（只有这一类的处置是去登录）。 */
  needsLogin: string[]
  /** 需要人工完成人机验证的来源（**不是**登录失败）。 */
  needsChallenge: string[]
  /** 无法检查的来源：网络不可达 / 站点错误等（**不是**登录失败）。 */
  needsCheck: string[]
  /** 每一类各自的下一步动作。 */
  nextActions: string[]
  capabilityGaps: string[]
}

/** 状态语义：写进返回，界面直接展示。 */
const MEANING = '这里回答的是「该来源是否放行公开检索」，不是「插件知道你的账号状态」：'
  + '插件不读 Cookie、不保存密码、不持有任何站点凭据。'
  + '公开页返回 200 只说明这一页可访问，**不代表**账号已登录。'

/**
 * `transport` 只用于测试注入：生产形态缺省用全局 `fetch`。
 * 没有这个口子的话，单测会真的去访问三家站点 —— 那是绝对不行的。
 */
export function valuationBrowserPreflightTools(deps: ToolDeps, transport?: MarketTransport) {
  const preflight = defineTool({
    name: VALUATION_TOOL_NAMES.browserPreflight,
    description: [
      '检查本轮估值要用到的外部案例来源是否可访问：房天下 / 安居客 / 链家，逐家给出',
      '登录事实 / 页面可读性 / 本次检索能力三件事与原因。它不读 Cookie、不碰凭据，也不修改任何状态。',
      '公开页返回 200 不等于账号已登录；`needsLogin` 只包含被登录墙挡住的来源。',
      '本工具**不会**打开浏览器（那是面板侧的动作）；需要登录时请在上层点「在默认浏览器登录」。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      providers: {
        type: 'array', items: { type: 'string' },
        description: '要检查的来源 id（fang / anjuke / lianjia）；缺省全部。',
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
          meaning: { type: 'string', required: true },
          states: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                login: { type: 'string', required: true, description: 'signed-out = 页面明确是登录墙；not-observed = 没观察到登录事实' },
                readability: { type: 'string', required: true, description: 'readable / blocked / unreachable' },
                retrieval: { type: 'string', required: true, description: 'public-page-ok / needs-login / needs-challenge / unreachable / http-error' },
                accessVerdict: { type: 'string', required: true, description: 'public-page-open / login-wall / unknown（**不是**登录状态）' },
                accessLabel: { type: 'string', required: true },
                detail: { type: 'string', required: true },
                captcha: { type: 'boolean', required: true },
                nextAction: { type: 'string', required: true },
                loginUrl: { type: 'string', required: true },
              },
            },
          },
          needsLogin: { type: 'array', required: true, items: { type: 'string' } },
          needsChallenge: { type: 'array', required: true, items: { type: 'string' } },
          needsCheck: { type: 'array', required: true, items: { type: 'string' } },
          nextActions: { type: 'array', required: true, items: { type: 'string' } },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: PreflightArgs, exec): Promise<PreflightResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = {
        ok: false, errorKind: '', error: '', caseDir: '', meaning: MEANING,
        states: [] as ProviderState[], needsLogin: [] as string[], needsChallenge: [] as string[],
        needsCheck: [] as string[], nextActions: [] as string[], capabilityGaps: [] as string[],
      }
      // 授权门禁：未在本机访问授权里放过之前**一个外部请求都不发**。
      // 与氚云 / 钉钉 / OSS / iFinD 同一条口径（协议 18）：未授权时探测得到的结论不可信，
      // 而"不可达"被当成"站点没有案例"会直接污染估值依据。
      if (!credentialsTrusted(deps)) {
        return { ...base, ...failure('policy', '尚未在本机访问授权里允许工作台访问本机能力：请在面板授权后再检查外部来源。') }
      }
      const picked = narrowProviders(args.providers)
      if (!picked.ok) return { ...base, ...failure('input', picked.error) }

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：来源预检只能在估值子会话里进行') }
      }

      const providers = allProviders({ transport: transport ?? fetchTransport({ userAgent: MARKET_USER_AGENT }) })
      const wanted = providers.filter((provider) => picked.ids.includes(provider.id))
      const states: ProviderState[] = []
      const gaps: string[] = []
      const needsLogin: string[] = []
      const needsChallenge: string[] = []
      const needsCheck: string[] = []
      const nextActions: string[] = []
      // 串行：三家站点的风控按来源独立，但并发探测更容易被一起判成异常流量。
      for (const provider of wanted) {
        const verdict = await provider.preflight()
        // `preflight()` 只回"访问结论 + 说明"（`providers.ts` 的既有形状）。三条独立事实由
        // `probeCategoryOfDetail` 从**唯一一份**类别文案里取回来 —— 不是拿错误文本猜原因。
        const category = probeCategoryOfDetail(verdict.detail) || (verdict.state === 'authenticated' ? 'public-page-ok' : '')
        const facts = category === '' ? undefined : PROBE_TEXTS[category]
        const login = facts?.login ?? (verdict.state === 'unauthenticated' ? 'signed-out' : 'not-observed')
        const readability = facts?.readability ?? 'blocked'
        const retrieval = facts?.retrieval ?? 'http-error'
        const captcha = facts?.captcha ?? false
        const nextAction = facts?.nextAction ?? '按详情里的真实类别处置后点「重新检查」；这不是登录问题。'
        states.push({
          id: provider.id,
          label: providerLabel(provider.id),
          login,
          readability,
          retrieval,
          accessVerdict: accessVerdictOf(verdict.state),
          // 人话只说"公开页放行"，不说"已登录"：那个词会让员工以为凭据有问题。
          accessLabel: accessLabel(verdict.state),
          detail: verdict.detail,
          captcha,
          nextAction,
          // 登录入口取站点定义里的那一条（只此一份，别在这里再抄一遍）。
          loginUrl: siteOf(provider.id).loginUrl,
        })
        if (login === 'signed-out') needsLogin.push(provider.id)
        else if (captcha) needsChallenge.push(provider.id)
        else if (verdict.state !== 'authenticated') needsCheck.push(provider.id)
        if (verdict.state !== 'authenticated') {
          gaps.push(`${providerLabel(provider.id)}：${
            login === 'signed-out' ? '需要登录后才能检索'
              : captcha ? '要求人工完成人机验证'
                : '无法确认可用性'}（${verdict.detail}）`)
          if (!nextActions.includes(nextAction)) nextActions.push(nextAction)
        }
      }

      // **写回轮次**：预检的结论是面板"即将访问的数据源"那一块的事实来源。
      // 不写回的话，子会话自己看到的登录状态与界面显示的会是两回事
      //（界面读宿主注册表），而用户正是照着界面决定要不要去登录。
      for (const state of states) {
        recordProviderState(deps, exec, state.id, {
          // 写回的仍是三态**访问结论**（线协议只有这三个值）：面板据此决定能否进正文。
          state: state.accessVerdict === 'public-page-open' ? 'authenticated'
            : state.accessVerdict === 'login-wall' ? 'unauthenticated' : 'unknown',
          attempts: 0,
          detail: state.detail,
        })
      }
      for (const gap of gaps) recordCapabilityGap(deps, exec, gap)

      return {
        ok: states.length > 0,
        errorKind: states.length > 0 ? '' : 'input',
        error: states.length > 0 ? '' : '没有选中任何来源',
        caseDir: access.casePath,
        meaning: MEANING,
        states,
        needsLogin,
        needsChallenge,
        needsCheck,
        nextActions,
        capabilityGaps: gaps,
      }
    },
  })

  return [preflight]
}
