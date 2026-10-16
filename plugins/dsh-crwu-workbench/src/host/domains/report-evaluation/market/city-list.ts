import { text } from '../../../../shared/utils/value.ts'

/**
 * 站点**自己公布的**城市列表 → 站点城市标识（设计稿 §8.2 / 分析 P7）。
 *
 * ## 为什么映射必须从页面来
 *
 * 链家的检索 URL 形如 `https://{city}.lianjia.com/ershoufang/…` —— 城市标识会进**域名**。
 * 模型提交的是业务城市（`北京`），站点要的是它自己的城市标识（`bj`）。把"北京 → bj"写进代码
 * 就是又一份要跟着站点改的硬编码表（而且表一旦过期，错的是**域名**，症状是"这个来源没有案例"
 * 这种看起来像业务结论的错误）。所以这里只做一件事：**读站点公布的城市列表，按页面内容建映射**。
 *
 * ## 哪些链接算数
 *
 * 页面上同时有城市入口（`https://bj.lianjia.com/`）、页脚链接（`https://bj.lianjia.com/about/…`）、
 * 行政区链接（`https://bj.lianjia.com/ershoufang/chaoyangqu/`）、小区链接、以及
 * `https://qxn.fang.lianjia.com/`、`http://you.lianjia.com/qh` 这类**表达不成单段域名**的城市入口。
 * 只有"链接文本是城市名（2~4 个汉字）**且** host 恰好是 `<标识>.lianjia.com`、path 为空"的锚点
 * 才能成为映射；其余如实记进 `unusable`，**不硬塞一个标识**（塞出来的标识会指向另一个城市，
 * 而结果页看起来完全正常）。
 *
 * ## 缓存
 *
 * 一次进程内只读一次（同一个页面地址共享同一个 promise，避免并发重复取数）。**失败不进缓存**：
 * 一次网络抖动不该让整个进程后面都解析不出城市；重试由调用方按需发起。
 */

/** 站点城市标识同时是域名的第一段标签：只允许小写字母，长度有界。 */
export const SITE_KEY_PATTERN = /^[a-z]{2,10}$/

/** 公布城市选择入口的页面（映射的唯一出处）。 */
export const LIANJIA_CITY_LIST_PAGE = 'https://www.lianjia.com/city/'

/** 城市标识必须是这个后缀前面**唯一的一段**。 */
export const CITY_HOST_SUFFIX = '.lianjia.com'

/** 页面上的城市名链接文本：2~4 个汉字（`海门房产网` 这类页脚文案因此不算城市入口）。 */
const CJK_CITY_NAME_PATTERN = /^[\u4e00-\u9fff]{2,4}$/

/**
 * 页面里的锚点；href 不在第一个属性上也认。
 *
 * 两处长度上限是**防御性的**：被投喂畸形 HTML（`<a` 后面一直没有 `>` / `</a>`）时，
 * 无上限的 `[^>]*?` 与 `[\s\S]*?` 会退化成二次扫描。
 */
const ANCHOR_PATTERN = /<a\b[^>]{0,4000}?href\s*=\s*["']([^"']*)["'][^>]{0,4000}>([\s\S]{0,2000}?)<\/a>/gi

export interface CityListEntry {
  /** 页面上的城市名（业务城市）。 */
  name: string
  /** 页面公布的站点城市标识（进域名的那一段）。 */
  key: string
}

export interface UnusableCityEntry {
  name: string
  href: string
  /** 为什么它不能当站点城市标识用。 */
  reason: string
}

export interface CityListSnapshot {
  page: string
  fetchedAt: string
  entries: readonly CityListEntry[]
  unusable: readonly UnusableCityEntry[]
}

/** 取数通道的返回（结构上兼容 `MarketFetchResult`，这里不依赖 browser 层）。 */
export interface CityListResponse {
  ok: boolean
  status: number
  body: string
  error: string
}

export type CityListTransport = (url: string, options: { signal?: AbortSignal }) => Promise<CityListResponse>

export type CityListLoad =
  | { ok: true; snapshot: CityListSnapshot }
  | { ok: false; page: string; error: string }

export interface LoadCityListOptions {
  /** 取数通道（生产注入 `fetchTransport`，测试用内存替身）。 */
  transport?: CityListTransport
  /**
   * 城市列表页地址；缺省 `LIANJIA_CITY_LIST_PAGE`。
   *
   * 这是**插件内部**的事实：只由 Host 传常量页，不要接到模型提交的字段上。
   */
  page?: string
  /** 取数时刻（测试注入以获得确定性）。 */
  now?: () => string
  /** 忽略进程内缓存，强制重新取数。 */
  fresh?: boolean
}

const cache = new Map<string, Promise<CityListLoad>>()

/** 清空进程内缓存（测试与"强制重新核对"用）。 */
export function clearCityListCache(): void {
  cache.clear()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 数字实体解码：页面是不可信输入，畸形码点不能把整个解析炸掉。 */
function fromCodePoint(raw: string, radix: number): string {
  const code = Number.parseInt(raw, radix)
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch (error) {
    void error
    return ''
  }
}

function decodeHtml(value: string): string {
  return text(value)
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCodePoint(code, 16))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}

/** 锚点文本：去掉内层标签，折叠空白。 */
function anchorText(inner: string): string {
  return decodeHtml(text(inner).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * 一个城市名锚点的三种去向。
 *
 * `unusable` 只收**看起来就是城市入口、但表达不成单段域名**的链接（多段域名、或单段路径
 * `you.lianjia.com/qh`）；行政区 / 小区 / 页脚这类多段路径的链接是 `other` —— 它们本来就不是
 * 城市入口，混进 `unusable` 会让这份诊断说谎。
 */
type HrefVerdict =
  | { kind: 'entry'; key: string }
  | { kind: 'unusable'; reason: string }
  | { kind: 'other'; reason: string }

/** 把 href 收窄成 `{标识}.lianjia.com/` 的城市入口。 */
function siteKeyOfHref(href: string): HrefVerdict {
  const raw = text(href).trim()
  if (raw === '') return { kind: 'other', reason: '链接为空' }
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  let url: URL
  try {
    url = new URL(absolute)
  } catch (error) {
    void error
    return { kind: 'other', reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'other', reason: '不是 http(s) 链接' }
  const host = url.hostname.toLowerCase()
  if (host === CITY_HOST_SUFFIX.slice(1) || !host.endsWith(CITY_HOST_SUFFIX)) {
    return { kind: 'other', reason: `不是链家城市站点的链接：${host}` }
  }
  const labels = host.slice(0, -CITY_HOST_SUFFIX.length).split('.')
  if (labels.length !== 1) return { kind: 'unusable', reason: `城市标识不是单段域名：${host}` }
  const key = labels[0]
  if (!SITE_KEY_PATTERN.test(key)) return { kind: 'unusable', reason: `域名第一段不是合法的城市标识：${key}` }
  if (url.search !== '' || url.hash !== '') return { kind: 'other', reason: '链接带查询串或锚点' }
  const path = url.pathname
  if (path === '' || path === '/') return { kind: 'entry', key }
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length <= 1) return { kind: 'unusable', reason: '链接指向具体页面，不是城市入口' }
  return { kind: 'other', reason: '链接指向站内页面，不是城市入口' }
}

/**
 * 从城市列表页的 HTML 里建映射。
 *
 * 纯函数：不取数、不缓存，便于对真实页面结构做回归（`entries` 保持页面顺序、第一次出现优先）。
 */
export function parseCityListPage(html: string, page: string, fetchedAt: string): CityListSnapshot {
  const entries: CityListEntry[] = []
  const unusable: UnusableCityEntry[] = []
  const seenEntries = new Set<string>()
  const seenUnusable = new Set<string>()
  for (const match of text(html).matchAll(ANCHOR_PATTERN)) {
    const name = anchorText(match[2])
    if (!CJK_CITY_NAME_PATTERN.test(name)) continue
    const href = decodeHtml(match[1]).trim()
    const resolved = siteKeyOfHref(href)
    if (resolved.kind === 'other') continue
    if (resolved.kind === 'unusable') {
      const id = `${name}\u0000${href}`
      if (seenUnusable.has(id)) continue
      seenUnusable.add(id)
      unusable.push({ name, href, reason: resolved.reason })
      continue
    }
    const id = `${name}\u0000${resolved.key}`
    if (seenEntries.has(id)) continue
    seenEntries.add(id)
    entries.push({ name, key: resolved.key })
  }
  return { page: text(page), fetchedAt: text(fetchedAt), entries, unusable }
}

/**
 * 读取（或复用缓存里的）城市列表。
 *
 * 返回失败而不是抛错：城市解析不出来是**可选能力的缺口**，由调用方决定怎么降级。
 */
export function loadCityList(options: LoadCityListOptions = {}): Promise<CityListLoad> {
  const page = text(options.page).trim() || LIANJIA_CITY_LIST_PAGE
  const cached = cache.get(page)
  if (cached !== undefined && options.fresh !== true) return cached
  const pending = fetchCityList(page, options).then((result) => {
    // 失败不缓存：一次网络抖动不该锁死整个进程的城市解析。
    if (!result.ok) cache.delete(page)
    return result
  })
  cache.set(page, pending)
  return pending
}

async function fetchCityList(page: string, options: LoadCityListOptions): Promise<CityListLoad> {
  const transport = options.transport
  if (transport === undefined) {
    return { ok: false, page, error: `本部署没有可用的取数通道，无法读取城市列表 ${page}` }
  }
  let response: CityListResponse
  try {
    response = await transport(page, {})
  } catch (error) {
    return { ok: false, page, error: `读取城市列表失败（网络错误或超时）：${messageOf(error)}` }
  }
  const failed = text(response?.error)
  if (response?.ok !== true) {
    return { ok: false, page, error: `读取城市列表失败：${failed || `HTTP ${String(response?.status ?? 0)}`}` }
  }
  const snapshot = parseCityListPage(text(response.body), page, text(options.now?.() ?? new Date().toISOString()))
  if (snapshot.entries.length === 0) {
    return { ok: false, page, error: `城市列表页没有解析出任何城市标识（页面结构可能已改版）：${page}` }
  }
  return { ok: true, snapshot }
}
