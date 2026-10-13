import { text } from '../../../../shared/utils/value.ts'
import type { LoginState, MarketProviderId } from './login-state.ts'
import { MARKET_PROVIDER_IDS, providerLabel } from './login-state.ts'

/**
 * 外部案例**来源的框架**：白名单、调用面与"不做的事"。
 *
 * ## 来源白名单
 *
 * `MARKET_PROVIDER_IDS` 是唯一的来源集合，模型只能从中选（提交别的名字一律拒绝）。
 * 白名单不是"配置项"：它同时决定哪些域名会被访问、哪些站点的页面会被抓进案例目录 ——
 * 可配置就等于把"插件会去访问任意站点"这件事交给了模型。
 *
 * ## 明确不做的事（写在这里，因为它们都是"看起来更聪明"的错）
 *
 * 1. **不绕过验证码 / 风控 / 登录保护**。探测到验证码就如实报"需要人工在浏览器完成验证"，
 *    不用任何绕过手段（换 UA、打码、代填）。
 * 2. **不读 Cookie、不存密码、不碰凭据**。登录动作只是"用系统默认浏览器打开该站首页"，
 *    会话由浏览器自己保持；插件拿不到、也不需要拿到它。
 * 3. **不编造案例**。页面上没有结构化数据就报能力缺口，而不是按标题猜价格与面积。
 * 4. **挂牌价不算成交价**。每一条案例都带 `transactionType`，没有明确"成交"字样的一律是
 *    `挂牌`（见 `market/normalize.ts`）。
 */

/** 单页抓取的返回。 */
export interface MarketFetchResult {
  ok: boolean
  error: string
  /** HTTP 状态码；拿不到时为 0。 */
  status: number
  /** 响应体（HTML / JSON 文本）。 */
  body: string
  /** 响应内容类型。 */
  contentType: string
  /** 最终 URL（跟随重定向之后）；拿不到时回填请求 URL。 */
  url: string
  /**
   * 页面看起来要求登录 / 要求验证码。
   *
   * 由内容判定而不是猜：出现登录表单特征或验证码特征时置位。置位后调用方把它当
   * "登录状态可疑"，而不是"页面没有案例"。
   */
  loginRequired: boolean
  captcha: boolean
  /**
   * 失败的**类别**（§7.3 要求重试区分这几类，而不是把什么都写成一句"取不到"）。
   *
   * 为什么必须分类：它们的处置完全不同 —— 需要登录要去登录、验证码要人工过、
   * 限流要等一会儿、页面失效说明模板过期了、网络错误换网络、响应读不出来是站点异常。
   * 合成一句"失败了"，事后只能看到"这个来源没结果"。
   */
  failureKind?: MarketFailureKind
}

/**
 * 抓取失败的类别。
 *
 * `''` 表示没有失败（成功）；`unknown` 是"认不出来"——**不猜**成上面任何一类。
 */
export type MarketFailureKind =
  | ''
  | 'login'
  | 'captcha'
  | 'rate-limited'
  | 'not-found'
  | 'server-error'
  | 'network'
  | 'blocked'
  | 'unreadable'
  | 'unknown'

/** 抓取通道（注入；生产用全局 `fetch`，测试用内存替身）。 */
export type MarketTransport = (url: string, options: { signal?: AbortSignal }) => Promise<MarketFetchResult>

export interface MarketSearchInput {
  /** 关键字（小区名 / 地址）。 */
  keyword: string
  /** 城市（站点侧的城市标识）。 */
  city: string
  /** 最多取几页；上限由调用方给（Host 侧还有更硬的上限）。 */
  maxPages?: number
}

/** 一条原始挂牌/成交记录（站点字段名各异，做完标准化之后才是案例）。 */
export interface RawListing {
  /** 来源平台 id。 */
  source: MarketProviderId
  url: string
  title: string
  /** 原始站点上的其它字段（键名不保证统一；标准化时按别名表识别）。 */
  fields: Record<string, string>
}

export interface MarketSearchResult {
  provider: MarketProviderId
  ok: boolean
  error: string
  /** 这一轮真正访问过的完整 URL（逐页、去重）。 */
  urls: string[]
  /** 失败的页数（三次都失败的页）。 */
  failedPages: number
  listings: RawListing[]
  /** 页面级观察（需要登录 / 验证码 / 结构无法解析）。 */
  notes: string[]
}

export interface MarketProvider {
  id: MarketProviderId
  label: string
  /** 检查登录状态（只读探测；不改任何状态）。 */
  preflight(): Promise<{ state: LoginState; detail: string }>
  /**
   * 取一页并解析；每次失败由调用方按 `MARKET_ATTEMPTS` 重试（**抛错 = 可重试**）。
   *
   * 返回值带上**原始页面字节**：调用方要把它当证据存进案例目录。让 provider 自己存盘
   * 会把"抓取"与"落盘"混在一起，而落盘要过案例门禁（那属于 Tool 的职责）。
   */
  searchPage(input: MarketSearchInput, page: number, signal?: AbortSignal): Promise<{
    raw: RawListing[]
    notes: string[]
    /** 页面字节（证据）；拿不到时为（极少数实现）。 */
    body: string
    /** 真正取回的 URL（跟随重定向之后）。 */
    url: string
    status: number
  }>
  /** 用系统默认浏览器打开该来源首页（登录动作）。返回空串 = 已受理。 */
  openLogin(openExternal: (url: string) => Promise<boolean>): Promise<string>
}

/** 来源白名单判定（逐字匹配，不折叠大小写）。 */
export function isAllowedProvider(value: unknown): value is MarketProviderId {
  return (MARKET_PROVIDER_IDS as readonly string[]).includes(text(value))
}

/**
 * 收窄来源清单。
 *
 * 空清单 = **全部来源**（用户没选就是"都试试"）；含非法名字时**整批拒绝**，
 * 而不是"忽略非法项继续" —— 静默忽略会让调用方以为某个来源被查过了。
 */
export function narrowProviders(value: unknown): { ok: true; ids: MarketProviderId[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: true, ids: [...MARKET_PROVIDER_IDS] }
  const ids: MarketProviderId[] = []
  for (const item of value) {
    const raw = text(item)
    if (!isAllowedProvider(raw)) {
      return { ok: false, error: `不支持的来源：${raw || '（空）'}。只允许 ${MARKET_PROVIDER_IDS.map(providerLabel).join('、')}` }
    }
    if (!ids.includes(raw)) ids.push(raw)
  }
  return { ok: true, ids }
}

/** 全部来源的展示名（界面"即将访问的数据源"一节）。 */
export function providerCatalogue(): Array<{ id: MarketProviderId; label: string }> {
  return MARKET_PROVIDER_IDS.map((id) => ({ id, label: providerLabel(id) }))
}
