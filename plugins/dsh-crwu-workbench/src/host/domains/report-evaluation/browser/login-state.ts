import { text } from '../../../../shared/utils/value.ts'

/**
 * 浏览器**登录状态**与页面阶段的映射。
 *
 * 为什么单独一层：这两个概念最容易被混成一句"没登录就别继续"，而实际口径分成两支：
 *
 * ```text
 * 某个来源三次都失败
 *   ├── 该来源登录状态**未确认**（unauthenticated / unknown）→ 页面进入 browser-login-required
 *   │      （可恢复：用户在默认浏览器登录，再点"重新检查并继续"）
 *   └── 登录状态**已确认**（authenticated）→ 该来源记为失败，写进 capability_gaps，继续其他来源
 * ```
 *
 * 差别是"用户能做点什么"：前者有明确的下一步（去登录），后者没有 ——
 * 把后者也说成"请登录"会让员工反复登录一个本来就没坏的账号。
 *
 * ⚠️ 这里**不读 Cookie、不存密码、不知道任何凭据**：状态只由各来源自己的探测命令回答，
 * 插件把结论当成不透明枚举用。
 */

export type LoginState = 'authenticated' | 'unauthenticated' | 'unknown'

/** 数据源标识（固定枚举；模型只能从中选）。 */
export const MARKET_PROVIDER_IDS = ['fang', 'anjuke', 'lianjia'] as const
export type MarketProviderId = typeof MARKET_PROVIDER_IDS[number]

export function isMarketProviderId(value: unknown): value is MarketProviderId {
  return (MARKET_PROVIDER_IDS as readonly string[]).includes(text(value))
}

/** 来源展示名（界面与提示词都用它，只此一份）。 */
const LABELS: Record<MarketProviderId, string> = {
  fang: '房天下',
  anjuke: '安居客',
  lianjia: '链家 / 贝壳',
}

export function providerLabel(id: MarketProviderId): string {
  return LABELS[id]
}

/** 登录状态的人话（界面直接展示）。 */
export function loginStateLabel(state: LoginState): string {
  switch (state) {
    case 'authenticated': return '已登录'
    case 'unauthenticated': return '未登录'
    default: return '无法检查'
  }
}

export interface ProviderLogin {
  id: MarketProviderId
  state: LoginState
  detail: string
}

/** 登录状态的收窄：认不出来一律 `unknown`（不假设已登录，也不假设未登录）。 */
export function loginStateOf(value: unknown): LoginState {
  const raw = text(value)
  return raw === 'authenticated' || raw === 'unauthenticated' ? raw : 'unknown'
}

/** 某个来源本轮抓取的结果。 */
export interface ProviderRun {
  id: MarketProviderId
  login: LoginState
  /** 每页尝试完成后仍失败的页数（0 = 全部成功）。 */
  failedPages: number
  /** 成功取回的页数。 */
  fetchedPages: number
  /** 收进案例的条数。 */
  caseCount: number
  /** 每个分页的尝试上限（写进缺口文案，让"三次"这件事可核对）。 */
  attemptLimit: number
  detail: string
}

export type PagePhase = 'running' | 'browser-login-required' | 'completed'

export interface PhaseDecision {
  phase: PagePhase
  /** 能不能继续往下（false 时页面停在"需要登录"）。 */
  canProceed: boolean
  /** 需要用户在默认浏览器登录的来源。 */
  needsLogin: MarketProviderId[]
  /** 已确认登录、却仍然失败的来源（这些只记缺口，不阻塞）。 */
  failed: MarketProviderId[]
  detail: string
}

/**
 * 由各来源的运行结果推出页面阶段。
 *
 * 判据只看两件事：**有没有来源需要登录**、**有没有来源确认已登录却失败**。
 * 两者都为空就是正常完成 —— 包括"所有来源都没抓到案例"（那由案例数与缺口表达，
 * 不是登录问题）。
 */
export function decidePhase(runs: readonly ProviderRun[]): PhaseDecision {
  const needsLogin: MarketProviderId[] = []
  const failed: MarketProviderId[] = []
  for (const run of runs) {
    if (run.failedPages <= 0) continue
    if (run.login === 'authenticated') failed.push(run.id)
    else needsLogin.push(run.id)
  }

  if (needsLogin.length > 0) {
    const labels = needsLogin.map(providerLabel).join('、')
    return {
      phase: 'browser-login-required',
      canProceed: false,
      needsLogin,
      failed,
      detail: `${labels} 的页面没有取到（多为未登录或登录已过期）：请在默认浏览器登录后点「重新检查并继续」。`,
    }
  }
  if (failed.length > 0) {
    const labels = failed.map(providerLabel).join('、')
    return {
      phase: 'running',
      canProceed: true,
      needsLogin,
      failed,
      detail: `${labels} 已登录但页面仍然取不到：本轮不用这个来源（已记入能力缺口），继续其他来源。`,
    }
  }
  return { phase: 'completed', canProceed: true, needsLogin, failed, detail: '' }
}

/**
 * 能力缺口文案：**登录状态未确认时不许静默继续**。
 *
 * 这条是刻意的：如果"没确认登录"就当普通失败记一条缺口继续跑，用户会拿到一份
 * "案例不足"的估值结论，而真实原因是自己没登录 —— 结论看起来完全合理，没人会去查。
 */
export function loginGapText(run: ProviderRun): string {
  const label = providerLabel(run.id)
  if (run.login === 'authenticated') {
    return `${label}：已登录但 ${run.failedPages} 个页面在最多 ${run.attemptLimit} 次尝试后仍失败，本轮未采用该来源`
  }
  return `${label}：${loginStateLabel(run.login)}，${run.failedPages} 个页面未取到（${run.detail}）；`
    + '需要人工确认登录状态后重试，本轮该来源不作为案例依据'
}
