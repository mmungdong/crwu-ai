import { text } from '../../../../shared/utils/value.ts'
import { providerLabel, type LoginState, type MarketProviderId } from './login-state.ts'
import { classifyProbe } from './login-probe.ts'
import type { MarketFetchResult, MarketProvider, MarketSearchInput, MarketTransport, RawListing } from './provider.ts'
import { dedupeListings, listingsFromJsonLd } from '../market/jsonld.ts'

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
}

/**
 * 三个站点。
 *
 * ⚠️ 这些模板是**待真机核对**的：我没有在真实网络上验证过它们（本轮不访问外部站点）。
 * 模板不对时的表现是"探测/检索拿不到结构化数据"，会如实进 `notes` 与 `capabilityGaps`，
 * 不会产出编造的案例。第一次真机使用后应当按实际 URL 校正这三条，并补一条契约断言。
 */
export const PROVIDER_SITES: readonly ProviderSite[] = [
  {
    id: 'fang',
    searchUrl: 'https://search.fang.com/house/?keyword={keyword}&city={city}&page={page}',
    probeUrl: 'https://search.fang.com/house/',
    loginUrl: 'https://passport.fang.com/',
  },
  {
    id: 'anjuke',
    searchUrl: 'https://{city}.anjuke.com/sale/?kw={keyword}&p={page}',
    probeUrl: 'https://www.anjuke.com/sale/',
    loginUrl: 'https://login.anjuke.com/login/',
  },
  {
    id: 'lianjia',
    searchUrl: 'https://{city}.lianjia.com/ershoufang/{keyword}pg{page}/',
    probeUrl: 'https://www.lianjia.com/ershoufang/',
    loginUrl: 'https://passport.lianjia.com/',
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
    return value === undefined ? whole : encodeURIComponent(String(value))
  })
}

/** 硬上限：页数由调用方给，但插件这一侧还要再夹一次（防止"翻到底"）。 */
export const MARKET_MAX_PAGES = 5

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
      raw: RawListing[]; notes: string[]; body: string; url: string; status: number
    }> {
      const url = expandTemplate(site.searchUrl, {
        keyword: text(input.keyword),
        city: text(input.city),
        page,
      })
      const result = await withTimeout(url, signal)
      const notes: string[] = []
      if (!result.ok) {
        // 抛错让调用方按"三次尝试"重试：网络失败是**可重试**的，页面结构问题是不可重试的。
        throw new Error(result.error || `无法访问 ${url}`)
      }
      if (result.captcha) notes.push('该页面要求验证码 / 人机校验：插件不做绕过，请人工在浏览器完成')
      else if (result.loginRequired) notes.push('该页面要求登录：请在默认浏览器登录该来源后重试')
      const { listings, notes: parseNotes } = listingsFromJsonLd(result.body, site.id)
      notes.push(...parseNotes)
      return {
        raw: dedupeListings(listings), notes,
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
