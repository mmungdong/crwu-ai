import { text } from '../../../../shared/utils/value.ts'

/**
 * 浏览器**登录状态**与页面阶段的映射。
 *
 * 为什么单独一层：这两个概念最容易被混成一句"没登录就别继续"，而实际口径分成三支：
 *
 * ```text
 * 某个来源两次都失败
 *   ├── 被登录墙挡住（unauthenticated）        → needsLogin   ：去登录
 *   ├── 登录状态没能确认（unknown：网络 / 验证码 / 站点错误）
 *   │                                          → unconfirmed  ：按真实类别处置，**不是**去登录
 *   └── 已确认放行（authenticated）            → failed       ：记能力缺口，继续其他来源
 * ```
 *
 * 差别是"用户能做点什么"：第一支有明确动作（去登录），第二支是"看来源详情按类别处置"，
 * 第三支没有 —— 把它说成"请登录"会让员工反复登录一个本来就没坏的账号。
 *
 * ⚠️ 这里**不读 Cookie、不存密码、不知道任何凭据**：状态只由各来源自己的探测命令回答，
 * 插件把结论当成不透明枚举用。
 */

export type LoginState = 'authenticated' | 'unauthenticated' | 'unknown'

/** 数据源标识（固定枚举；模型只能从中选）。 */
export const MARKET_PROVIDER_IDS = ['fang', 'anjuke', 'lianjia', 'wuba'] as const
export type MarketProviderId = typeof MARKET_PROVIDER_IDS[number]

export function isMarketProviderId(value: unknown): value is MarketProviderId {
  return (MARKET_PROVIDER_IDS as readonly string[]).includes(text(value))
}

/** 来源展示名（界面与提示词都用它，只此一份）。 */
const LABELS: Record<MarketProviderId, string> = {
  fang: '房天下',
  anjuke: '安居客',
  // 协议 39：按已确认的来源阶梯补上 58 同城（链家未覆盖 / 未登录 / 不足时的替代来源）。
  // ⚠️ 适配器**尚未真机验收**：URL 模板来自公开的站点路径约定，没有归档字节可核对。
  // 这件事由 `providers.ts` 的 `evidence` 如实标出，并由取数层记入能力缺口 ——
  // 不因为"枚举里有它"就声称这个来源已经可用。
  wuba: '58同城',
  // 链家是首期唯一登记的案例来源：域名、受保护页与登录状态各自验证（设计稿 §8.2）。
  // 合成来源会让"链家登录了"被读成"别的来源也可用"，也会让跨站去重丢掉来源轨迹。
  lianjia: '链家',
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
  /** 每个分页的尝试上限（写进缺口文案，让"两次"这件事可核对）。 */
  attemptLimit: number
  detail: string
}

export type PagePhase = 'running' | 'browser-login-required' | 'completed'

export interface PhaseDecision {
  /**
   * 页面阶段。`browser-login-required` 是**状态机**里"暂停等待人工、可恢复"的那一格，
   * 不是诊断结论 —— 是登录墙还是人机验证，看 `needsLogin` / `unconfirmed` 与 `detail`。
   */
  phase: PagePhase
  /** 能不能继续往下（false 时页面停在"需要人工处理"）。 */
  canProceed: boolean
  /**
   * 确实"没登录 / 被登录墙挡住"的来源。
   *
   * **只有这一类的处置是去登录**。`unknown`（网络不可达 / 验证码 / 站点错误）不许进这里：
   * 把"没确认"说成"请登录"会让员工反复登录一个没坏的账号。
   */
  needsLogin: MarketProviderId[]
  /**
   * 登录状态**没能确认**的来源（网络不可达 / 人机验证 / 站点错误）。
   *
   * 与 `needsLogin` 分开：它们的下一步是"按来源详情处置后重新检查"，不是去登录。
   */
  unconfirmed: MarketProviderId[]
  /** 已确认登录、却仍然失败的来源（这些只记缺口，不阻塞）。 */
  failed: MarketProviderId[]
  detail: string
}

/**
 * 由各来源的运行结果推出**页面阶段与原因分类**（协议 39 起不再阻断）。
 *
 * 判据只看三件事：**有没有来源被登录墙挡住**、**有没有来源没能确认**、
 * **有没有来源确认已登录却失败**。三者都为空就是正常完成 —— 包括"所有来源都没抓到案例"
 * （那由案例数与缺口表达，不是登录问题）。
 *
 * ## 为什么三类都 `canProceed: true`
 *
 * 旧实现把这三类都判成"停在等人"（`browser-login-required` + `canProceed: false`）。
 * 已确认的口径是：**登录是可选用能力**。链家未登录就用房天下与 58 继续；来源不覆盖、
 * 搜不到、被挑战都只是本轮来源策略里的一条事实与原因，不该让整轮估值停在原地。
 * 分类仍然分开保留 —— 它们的**处置**不同，"下一步做什么"要说对。
 */
export function decidePhase(runs: readonly ProviderRun[]): PhaseDecision {
  const needsLogin: MarketProviderId[] = []
  const unconfirmed: MarketProviderId[] = []
  const failed: MarketProviderId[] = []
  for (const run of runs) {
    if (run.failedPages <= 0) continue
    if (run.login === 'authenticated') failed.push(run.id)
    else if (run.login === 'unauthenticated') needsLogin.push(run.id)
    else unconfirmed.push(run.id)
  }

  if (needsLogin.length === 0 && unconfirmed.length === 0) {
    if (failed.length === 0) return { phase: 'completed', canProceed: true, needsLogin, unconfirmed, failed, detail: '' }
    const labels = failed.map(providerLabel).join('、')
    return {
      phase: 'running',
      canProceed: true,
      needsLogin,
      unconfirmed,
      failed,
      detail: `${labels} 已确认放行但页面仍然取不到：本轮不用这个来源（已记入能力缺口），继续其他来源。`,
    }
  }

  const parts: string[] = []
  if (needsLogin.length > 0) {
    parts.push(`${needsLogin.map(providerLabel).join('、')} 未登录（或登录已过期）：`
      + '本轮改用其它来源；需要这个来源时可在能力区登录后重试。')
  }
  if (unconfirmed.length > 0) {
    parts.push(`${unconfirmed.map(providerLabel).join('、')} 的页面没有取到、登录状态也没能确认`
      + '（网络不可达 / 需要人工过人机验证 / 站点错误）：请按该来源详情里的真实类别处置，'
      + '**不要**当成"没登录"去重新登录；本轮继续使用其它来源。')
  }
  return {
    // `browser-login-required` 在这里只表示"有人工可做的动作"，**不是**暂停等人。
    phase: 'browser-login-required',
    canProceed: true,
    needsLogin,
    unconfirmed,
    failed,
    detail: parts.join(' '),
  }
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
    return `${label}：已确认放行但 ${run.failedPages} 个页面在最多 ${run.attemptLimit} 次尝试后仍失败，本轮未采用该来源`
  }
  if (run.login === 'unauthenticated') {
    return `${label}：被登录墙挡住（未登录或登录已过期），${run.failedPages} 个页面未取到（${run.detail}）；`
      + '请在默认浏览器登录该来源后重试，本轮该来源不作为案例依据'
  }
  return `${label}：登录状态未确认（${run.detail}），${run.failedPages} 个页面未取到；`
    + '这不等于"没登录"：请按真实类别处置（网络 / 人机验证 / 站点错误）后重试，本轮该来源不作为案例依据'
}
