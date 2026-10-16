import { text } from '../../../../shared/utils/value.ts'
import { isSafeCityCode } from '../market/city.ts'
import { providerLabel, type LoginState, type MarketProviderId } from './login-state.ts'
import { classifyProbe } from './login-probe.ts'
import type { MarketFetchResult, MarketProvider, MarketSearchInput, MarketTransport, RawListing } from './provider.ts'
import { parseSitePage, type ParseFailureKind } from '../market/site-parsers.ts'

/**
 * 三个来源的**站点定义**与 `MarketProvider` 实现。
 *
 * ## 这里只写"站点相关"的三件事
 *
 * 1. **检索 URL 模板**（关键字、城市、页码怎么拼）；
 * 2. **公开探测 URL**（预检访问哪一个页面）；
 * 3. **登录入口 URL**（"在默认浏览器登录"打开哪一个页面）。
 *
 * 解析本身不在这里：它由 `market/jsonld.ts` 统一做（只认页面里明确声明的结构化数据）。
 * 这样站点改版时改的是**模板**，而不是在解析器里堆站点分支。
 *
 * ## URL 模板是**插件内部**的事实
 *
 * 模型提交的只有"来源 id + 关键字 + 城市 + 页数"，URL 由这里拼。所以模型无法让插件去访问
 * 白名单之外的任何站点 —— 这是来源白名单真正的落点（`narrowProviders` 只校验了 id）。
 */

/** 站点定义：id、展示名、三个 URL 模板。 */
export interface ProviderSite {
  id: MarketProviderId
  /** 检索页：`{keyword}` / `{city}` / `{page}` 会被替换（值都做过 URL 编码）。 */
  searchUrl: string
  /** 预检页：判断站点是否放行公开检索。 */
  probeUrl: string
  /** 登录入口（用系统默认浏览器打开）。 */
  loginUrl: string
  /** 城市参数名不一定叫 city；这里是站点自己的写法。 */
  cityParam?: string
  /**
   * 这个来源的模板 / 选择器**是从哪来的**（协议 39：把"没验收"写成可核对的事实）。
   *
   * - `archived-capture`：有**归档的真实页面字节**作依据（链家的选择器与 URL 来自 2026-10-13 的实测归档）；
   * - `public-pattern`：只有公开的站点路径约定，**没有**归档字节、也没在授权环境里重跑过一次。
   *
   * 取数层据此记能力缺口：`public-pattern` 的来源**可以尝试**，但解析不出结构化数据时
   * 会如实报 `template-stale` / 没有结构化数据，**绝不按标题猜价格与面积**。
   */
  evidence: 'archived-capture' | 'public-pattern'
  /** 依据的具体出处（人话；进能力缺口与报告的技术过程）。 */
  evidenceNote: string
}

/**
 * 三个站点。
 *
 * ⚠️ 房天下与安居客的模板仍是**待真机核对**的；链家的检索模板已按 2026-10-13 归档的逐字 URL 校正
 * （见 `docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md`），
 * 但**仍未**在授权环境下重跑过一次成功取数。模板不对时的表现是"探测/检索拿不到结构化数据"，
 * 会如实进 `notes` 与 `capabilityGaps`，不会产出编造的案例。
 */
export const PROVIDER_SITES: readonly ProviderSite[] = [
  {
    id: 'fang',
    searchUrl: 'https://search.fang.com/house/?keyword={keyword}&city={city}&page={page}',
    probeUrl: 'https://search.fang.com/house/',
    loginUrl: 'https://passport.fang.com/',
    evidence: 'public-pattern',
    evidenceNote: '检索 URL 与解析选择器来自公开的站点路径约定，**没有归档字节**、'
      + '也未在授权环境里重跑过一次成功取数：登录墙 / 挑战分类与解析结论都要真机验收后才算数。',
  },
  {
    id: 'anjuke',
    searchUrl: 'https://{city}.anjuke.com/sale/?kw={keyword}&p={page}',
    probeUrl: 'https://www.anjuke.com/sale/',
    loginUrl: 'https://login.anjuke.com/login/',
    evidence: 'public-pattern',
    evidenceNote: '同房天下：模板按公开的站点路径约定写的，**尚未真机验收**。'
      + '该来源的城市表也没有适配（业务城市只能靠链家公布的列表解析）。',
  },
  {
    id: 'wuba',
    // 58 同城的城市在**子域名**上，与安居客同形；列表路径用站点自己的 `ershoufang`。
    // 关键字与页码按站点约定的查询参数给出。**没有归档字节可核对**（见 evidence）。
    searchUrl: 'https://{city}.58.com/ershoufang/?key={keyword}&pn={page}',
    probeUrl: 'https://www.58.com/ershoufang/',
    loginUrl: 'https://passport.58.com/login/',
    evidence: 'public-pattern',
    evidenceNote: '协议 39 按来源阶梯新增的替代来源（链家未覆盖 / 未登录 / 不足时使用）。'
      + 'URL 模板与解析口径来自公开的站点路径约定，**没有归档字节**、也未在授权环境里验收过：'
      + '在真机验收通过之前，解析不出结构化数据一律如实报缺口，不得声称该来源已经可用。',
  },
  {
    id: 'lianjia',
    // Keyword search is the `rs<keyword>` segment; paging is a separate `/pg<N>/` segment.
    // Verified layout from the 2026-10-13 archive: `…/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/`
    // returned 54 rows, and `…/ershoufang/rs<keyword>/pg1/` returned the same 54 rows.
    searchUrl: 'https://{city}.lianjia.com/ershoufang/rs{keyword}/pg{page}/',
    // 预检页用**城市页**而不是 `www.`：归档实测（2026-10-13）未登录状态下
    // `https://bj.lianjia.com/ershoufang/` 公开返回 200 / 175263B / 30 个 `data-price`；
    // 而 `www.` 这个 host 从未被独立核对过。首期就是北京住宅，所以这里直接落北京页。
    probeUrl: 'https://bj.lianjia.com/ershoufang/',
    // 登录入口必须是**站点自己发布的那个链接**（带 `service` 参数）；裸 passport 地址会被
    // 站点回一句「指定的服务未被授权，不能认证。」（2026-10-14 真机 A/B 实测）。
    loginUrl: 'https://clogin.lianjia.com/login?service=https%3A%2F%2Fwww.lianjia.com%2Fuser%2Fchecklogin%3Fredirect%3Dhttps%253A%252F%252Fbj.lianjia.com%252Fershoufang%252F',
    evidence: 'archived-capture',
    evidenceNote: '检索 URL 与列表 / 详情选择器来自 2026-10-13 归档的**真实页面字节**'
      + '（见 docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md）。'
      + '归档只能证明"选择器与字段口径能被解析"，**不证明**站点当前可用：仍需授权环境重跑一次。',
  },
]

export function siteOf(id: MarketProviderId): ProviderSite {
  const site = PROVIDER_SITES.find((item) => item.id === id)
  if (site === undefined) throw new Error(`未定义的来源：${id}`)
  return site
}

/** 模板替换：每个值都做 URL 编码（关键字来自用户，可能含 `&` 与空格）。 */
export function expandTemplate(template: string, values: Record<string, string | number>): string {
  return text(template).replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key]
    // `{city}` 会进**域名**（`https://{city}.lianjia.com/…`）。任务生成阶段已经校验过城市码，
    // 这里是**最后一道**：中文城市名代进去得到的是 `https://北京.lianjia.com/…` ——
    // 页面取不到，而调用方看到的会是"这个来源没有案例"（一个看起来像业务结论的错误）。
    // 所以宁可在拼 URL 这一步就拒绝，也不产出一个一定取不到的地址。
    if (key === 'city' && value !== undefined && !isSafeCityCode(value)) {
      throw new RangeError(`站点城市标识不合规：${String(value)}（必须是站点自己的城市码，例如 bj / sh）`)
    }
    return value === undefined ? whole : encodeURIComponent(String(value))
  })
}

/**
 * 硬上限：页数由调用方给，但插件这一侧还要再夹一次（防止"翻到底"）。
 *
 * 协议 39：同组同轮每来源 **10** 页（原 5 页）。真正的停止判据是 Host 持有的持久预算
 * （`market/budget.ts`），这里只是"单次调用不许超过"的硬夹。
 */
export const MARKET_MAX_PAGES = 10

export interface HtmlProviderDeps {
  transport: MarketTransport
  /** 探测与检索的超时（毫秒）。 */
  timeoutMs?: number
}

/**
 * 由站点定义造一个 `MarketProvider`。
 *
 * `preflight` 访问**公开探测页**并分类（网络失败 / 验证码 / 登录墙 / 状态码 / 正常）；
 * `searchPage` 取一页并只从结构化数据里提案例。两者都不读 Cookie、不带凭据。
 */
export function htmlProvider(site: ProviderSite, deps: HtmlProviderDeps): MarketProvider {
  const withTimeout = async (url: string, signal?: AbortSignal): Promise<MarketFetchResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, deps.timeoutMs ?? 20_000)
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    try {
      return await deps.transport(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    id: site.id,
    label: providerLabel(site.id),

    async preflight(): Promise<{ state: LoginState; detail: string }> {
      try {
        const result = await withTimeout(site.probeUrl)
        const verdict = classifyProbe(result)
        return { state: verdict.state, detail: verdict.detail }
      } catch (error) {
        return {
          state: 'unknown',
          detail: `无法访问${providerLabel(site.id)}：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },

    async searchPage(input: MarketSearchInput, page: number, signal?: AbortSignal): Promise<{
      raw: RawListing[]; notes: string[]; body: string; url: string; status: number; failureKind?: ParseFailureKind
    }> {
      const url = expandTemplate(site.searchUrl, {
        keyword: text(input.keyword),
        city: text(input.city),
        page,
      })
      const result = await withTimeout(url, signal)
      const notes: string[] = []
      if (!result.ok) {
        // 抛错让调用方按"两次尝试"重试：网络失败是**可重试**的，页面结构问题是不可重试的。
        throw new Error(result.error || `无法访问 ${url}`)
      }
      if (result.captcha) notes.push('该页面要求验证码 / 人机校验：插件不做绕过，请人工在浏览器完成')
      else if (result.loginRequired) notes.push('该页面要求登录：请在默认浏览器登录该来源后重试')
      // **JSON-LD 优先、固定 DOM 选择器兜底**：两条通道的选择与失败分类都在 `parseSitePage`
      // 里（JSON-LD 命中就是权威声明；否则用固定选择器；0 命中且像结果页 = 模板已改版）。
      // 这里**不猜**价格与面积，也不把"0 条"说成"没有案例"。
      const parsed = parseSitePage({ providerId: site.id, body: result.body, finalUrl: result.url || url })
      notes.push(...parsed.notes)
      return {
        raw: parsed.listings, notes, failureKind: parsed.failureKind,
        body: result.body, url: result.url || url, status: result.status,
      }
    },

    async openLogin(openExternal: (url: string) => Promise<boolean>): Promise<string> {
      try {
        const opened = await openExternal(site.loginUrl)
        return opened ? '' : '系统默认浏览器没有打开登录页：请手动打开该来源的登录页。'
      } catch (error) {
        return `打开登录页失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

/** 全部来源的实现（顺序与白名单一致）。 */
export function allProviders(deps: HtmlProviderDeps): MarketProvider[] {
  return PROVIDER_SITES.map((site) => htmlProvider(site, deps))
}
