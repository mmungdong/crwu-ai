import { providerLabel, type MarketProviderId, type LoginState } from './login-state.ts'
import { MARKET_PROVIDER_IDS } from './login-state.ts'
import { allProviders, siteOf } from './providers.ts'
import type { MarketTransport } from './provider.ts'

/**
 * 外部来源的**预检编排**（面板与 Tool 共用同一份）。
 *
 * 为什么要抽出来：预检有两个调用方 —— 估值子会话的工具，以及确认抽屉（面板 RPC）。
 * 各写一遍循环的后果不是重复，而是**两处结论不一致**：抽屉显示"可用"、工具却报"需要登录"，
 * 用户会以为其中一个在骗他。
 *
 * 三条口径（与 Tool 的返回一致）：
 * - 状态语义是"站点是否放行公开检索"，不是"插件知道你的账号状态"；
 * - 串行探测：三家站点的风控独立，但并发探测更容易被一起判成异常流量；
 * - `loginUrl` 只是**公开登录页地址**（不是凭据），面板据此打开默认浏览器。
 */

export const ALL_PROVIDER_IDS: readonly MarketProviderId[] = MARKET_PROVIDER_IDS

export interface ProviderPreflight {
  id: MarketProviderId
  label: string
  state: LoginState
  stateLabel: string
  detail: string
  captcha: boolean
  loginUrl: string
}

/**
 * 确认抽屉**首屏**要显示的三行来源（状态一律"尚未检查"）。
 *
 * 为什么要有它：`valuation-intake` 不再串行访问三家站点（§11.2）—— 那会把按钮卡住几十秒。
 * 但抽屉一打开就必须让人看到"有哪三家、现在什么状态"，所以宿主在这里给出**未探测**的三行；
 * 真正的探测在抽屉打开之后由 `valuation-browser-preflight` 异步完成并局部更新。
 *
 * 这**不是**在猜登录状态：`state: 'unknown'` 配上 `尚未检查` 的文案，说的是"还没查"。
 */
export function uncheckedProviders(ids: readonly MarketProviderId[] = ALL_PROVIDER_IDS): ProviderPreflight[] {
  return ids.map((id) => ({
    id,
    label: providerLabel(id),
    state: 'unknown' as LoginState,
    stateLabel: '尚未检查',
    detail: '',
    captcha: false,
    loginUrl: siteOf(id).loginUrl,
  }))
}

export async function preflightProviders(input: {
  transport: MarketTransport
  ids?: readonly MarketProviderId[]
}): Promise<ProviderPreflight[]> {
  const wanted = input.ids ?? ALL_PROVIDER_IDS
  const providers = allProviders({ transport: input.transport })
  const out: ProviderPreflight[] = []
  for (const provider of providers) {
    if (!wanted.includes(provider.id)) continue
    const verdict = await provider.preflight()
    out.push({
      id: provider.id,
      label: providerLabel(provider.id),
      state: verdict.state,
      stateLabel: verdict.state === 'authenticated' ? '可用' : verdict.state === 'unauthenticated' ? '需要登录' : '无法检查',
      detail: verdict.detail,
      captcha: /验证码|人机/.test(verdict.detail),
      loginUrl: siteOf(provider.id).loginUrl,
    })
  }
  return out
}
