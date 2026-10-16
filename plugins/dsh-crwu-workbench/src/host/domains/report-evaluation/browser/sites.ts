import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../../../shared/utils/value.ts'
import { packageRootFrom } from '../../../core/platform/package-root.ts'
import { DEFAULT_VALUATION_BROWSER, type WorkbenchConfig } from '../../../config/config.ts'
import { PROVIDER_SITES } from './providers.ts'

/**
 * Skill 自带的**站点连接配置**（`skills/biz/.../assets/browser-sites.json`）。
 *
 * ## 为什么站点清单是文件而不是代码常量
 *
 * 它是 `crwu browser --sites` 直接吃的输入，而 CLI 刻意不认识任何站点。把它放 Skill 的
 * `assets/` 里，站点增删就不需要一次 CLI 或插件发版；同时它**不是**业务规范 ——
 * 来源优先级、案例有效性、替代来源条件都在业务知识库的 `03-案例选取` 里。
 *
 * ## 校验口径与 CLI 的 `LoadSites` **对齐**
 *
 * 两处各写一套的后果是"插件认为能加载、CLI 认为不行"，而员工看到的是一句来自 CLI 的
 * 参数错误。所以这里同样要求：`id` / `loginUrl` / `protectedUrl` / `authCookie` 非空、
 * `id` 唯一、两个 URL 是绝对 http(s) 地址。少了任何一项都**整批拒绝** ——
 * 跳过坏的条目会让门禁悄悄少检一个来源。
 *
 * 这里**不读 Cookie、不碰凭据**：`authCookie` 只是给 CLI 判"会话在不在"用的名字。
 */

export interface BrowserSite {
  id: string
  label: string
  loginUrl: string
  protectedUrl: string
  authCookie: string
  authDomains: string[]
}

export interface SiteListResult {
  ok: boolean
  error: string
  sites: BrowserSite[]
}

function absoluteHttpUrl(value: unknown): string {
  const raw = text(value).trim()
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.hostname === '') return ''
    return raw
  } catch {
    return ''
  }
}

/** 收窄一份站点清单。任何一条不合格 → 整批拒绝。 */
export function siteListFrom(value: unknown): SiteListResult {
  if (!Array.isArray(value)) return { ok: false, error: '站点清单必须是顶层数组', sites: [] }
  if (value.length === 0) return { ok: false, error: '站点清单为空：至少需要一个站点', sites: [] }
  const sites: BrowserSite[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const where = `第 ${String(index + 1)} 个站点`
    if (value[index] === null || typeof value[index] !== 'object' || Array.isArray(value[index])) {
      return { ok: false, error: `${where} 不是对象`, sites: [] }
    }
    const record = value[index] as Record<string, unknown>
    const id = text(record.id).trim()
    if (id === '') return { ok: false, error: `${where} 缺少 id`, sites: [] }
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { ok: false, error: `${where} 的 id 必须是单段标识`, sites: [] }
    }
    if (seen.has(id)) return { ok: false, error: `站点 id 重复：${id}`, sites: [] }
    seen.add(id)
    const loginUrl = absoluteHttpUrl(record.loginUrl)
    if (loginUrl === '') return { ok: false, error: `站点 ${id} 的 loginUrl 不是合法的绝对地址`, sites: [] }
    const protectedUrl = absoluteHttpUrl(record.protectedUrl)
    if (protectedUrl === '') return { ok: false, error: `站点 ${id} 的 protectedUrl 不是合法的绝对地址`, sites: [] }
    const authCookie = text(record.authCookie).trim()
    if (authCookie === '') return { ok: false, error: `站点 ${id} 缺少 authCookie`, sites: [] }
    const domains = Array.isArray(record.authDomains)
      ? record.authDomains.map((item) => text(item).trim()).filter((item) => item !== '')
      : []
    sites.push({
      id,
      label: text(record.label).trim() || id,
      loginUrl,
      protectedUrl,
      authCookie,
      authDomains: domains,
    })
  }
  return { ok: true, error: '', sites }
}

/** 把配置里的相对路径解析成包内绝对路径（link 开发与 TGZ 安装都对）。 */
export function resolveSitesPath(config: WorkbenchConfig, moduleUrl = import.meta.url): string {
  const relative = text(config.valuation?.browser?.sitesFile) || DEFAULT_VALUATION_BROWSER.sitesFile
  const root = packageRootFrom(dirname(fileURLToPath(moduleUrl)))
  if (root === '') return ''
  return join(root, ...relative.split('/'))
}

export interface LoadedSites extends SiteListResult {
  path: string
}

/**
 * 交接给父会话的一条**来源事实**（协议 39）。
 *
 * 它在交接那一刻只知道"配置里有没有这个来源、它是不是被标为必需、为什么现在还没有状态"，
 * 所以 `state` 是 `'unknown'` + 原因 —— **不许**编一个"已登录"或"搜不到"，
 * 也**不许**再像旧实现那样把整份列表留空（那会让父会话以为一个来源都没有）。
 */
export interface ValuationSourceFact {
  id: string
  label: string
  /** 配置把它标成了必需还是可选（只是展示/优先级口径，不阻断）。 */
  tier: 'required' | 'optional'
  /** 交接时刻的来源状态：只有一个诚实取值 `unknown`（还没开始检索）。 */
  state: string
  /**
   * 适配器的依据（协议 39 起随来源策略一起交给父会话）。
   *
   * `public-pattern` = 只有公开的站点路径约定、**尚未真机验收**：父会话必须知道这件事，
   * 否则"58 取不到数据"会被写成"这个小区没有房源"。
   */
  evidence: 'archived-capture' | 'public-pattern'
  reason: string
}

/**
 * 站点清单里的 id → 适配器的依据。
 *
 * 清单是**部署配置**（可以只登记链家），适配器依据是**代码里的事实**（有归档字节还是只有
 * 公开路径约定）。两者对不上时按"没有适配器"处理：宁可说"这个来源还没接"，
 * 也不声称一个不存在的适配器已经可用。
 */
function providerFactOf(id: string): { evidence: 'archived-capture' | 'public-pattern' } {
  const site = PROVIDER_SITES.find((item) => item.id === id)
  return { evidence: site?.evidence ?? 'public-pattern' }
}

/**
 * 由站点清单与配置推出交接用的来源事实。
 *
 * 站点清单读不出来（`loaded.ok === false`）时返回**一条**说明原因的事实，而不是空数组：
 * "没有来源"与"来源清单不可用"是两件事，父会话必须分得清。
 */
export function browserSourceFacts(
  config: WorkbenchConfig,
  loaded: LoadedSites,
): ValuationSourceFact[] {
  if (!loaded.ok) {
    return [{
      id: 'sources',
      label: '案例来源',
      tier: 'optional',
      state: 'unavailable',
      evidence: 'public-pattern',
      reason: loaded.error || '站点清单不可用',
    }]
  }
  const plan = gateSiteIds(config, loaded.sites)
  return loaded.sites.map((site) => {
    const fact = providerFactOf(site.id)
    return {
      id: site.id,
      label: site.label,
      tier: plan.required.includes(site.id) ? 'required' as const : 'optional' as const,
      state: 'unknown',
      evidence: fact.evidence,
      reason: plan.required.includes(site.id)
        ? '交接时尚未检查该来源的登录状态；未登录不阻止本轮开始'
        : '可补充来源：按业务知识库的渠道与降级策略决定何时使用',
    }
  })
}

/**
 * 读站点清单。
 *
 * 解析不出包根、文件不存在、JSON 非法都返回**结构化失败**而不是抛错：门禁要能把
 * "配置坏了"如实显示成"浏览器来源不可用"，而不是让整个页面白屏。
 */
export function loadBrowserSites(config: WorkbenchConfig, moduleUrl = import.meta.url): LoadedSites {
  const path = resolveSitesPath(config, moduleUrl)
  if (path === '') return { ok: false, error: '解析不出插件包根：无法定位站点清单', sites: [], path: '' }
  if (!existsSync(path)) return { ok: false, error: `站点清单不存在：${path}`, sites: [], path }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      ok: false, path, sites: [],
      error: `站点清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const result = siteListFrom(parsed)
  return { ...result, path }
}

/**
 * 需要检查的来源：**分两档展示**，但两档都**不再阻塞**任何页面（协议 39）。
 *
 * `required` 只表示"这个来源对本轮业务更重要"，不表示"没登录就不能开始"。所以配置里
 * 一个必需来源都没写时，答案是**空数组**，而不是"那就全都必需" —— 旧实现那条回退会在
 * 配置被改成可选时静默地把所有站点重新变成硬门禁，而界面上完全看不出来。
 */
export function gateSiteIds(config: WorkbenchConfig, sites: readonly BrowserSite[]): { required: string[]; optional: string[] } {
  const browser = config.valuation?.browser ?? DEFAULT_VALUATION_BROWSER
  const known = new Set(sites.map((site) => site.id))
  const required = (browser.requiredSiteIds ?? []).filter((id) => known.has(id))
  const optional = (browser.optionalSiteIds ?? []).filter((id) => known.has(id) && !required.includes(id))
  // 清单里有、两档都没点名的站点仍然**要展示**（它是可用的替代来源，藏起来等于骗人）。
  const unlisted = sites.map((site) => site.id).filter((id) => !required.includes(id) && !optional.includes(id))
  return { required, optional: [...optional, ...unlisted] }
}
