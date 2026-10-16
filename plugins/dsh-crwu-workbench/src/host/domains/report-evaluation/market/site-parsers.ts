import { text } from '../../../../shared/utils/value.ts'
import type { MarketProviderId } from '../browser/login-state.ts'
import type { RawListing } from '../browser/provider.ts'
import { dedupeListings, listingsFromJsonLd } from './jsonld.ts'

/**
 * 站点页面的**固定解析器**（设计稿 §8.2，计划 Task 8）。
 *
 * ## 为什么必须有固定解析器，而不是"只认 JSON-LD"
 *
 * JSON-LD 是首选：有就是有、没有就是没有，不存在"猜出半个字段"。但实测里链家的
 * **列表页**并不总是带 JSON-LD，而列表页恰恰是"有哪些候选案例"的唯一来源。所以这里补一层
 * **固定选择器**，并且**写死在这一层**：
 *
 * - Agent 不能提交选择器，也不能"现场推一个试试" —— 那正是"反复试错抓网页"（明确禁止）；
 * - 站点改版时改的是**这一个文件**，而不是让模型每次重新猜。
 *
 * 选择器与字段位置来自 2026-10-13 归档的逐字实测（`session.v4.jsonl` L925/L930，见
 * `docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md` §2.4）：
 * 列表容器 `ul.sellListContent`（链家列表页结构），列表项 `<li class="clear LOGCLICKDATA">`，
 * 详情链接 `a[href*="/ershoufang/"]`，小区在 `.positionInfo a`，
 * 价格 / 面积 / 户型写在列表项正文里；详情页字段锚点是 `.introContent` / `.baseAttribute`。
 *
 * ## 0 命中 = `template-stale`，不是"没有案例"
 *
 * 这是本文件最重要的一条：一个**看起来是结果页**的页面里一条房源都解析不出来，只可能是
 * 模板过期（站点改版）。报成"这个小区没有房源"会让结论建立在一个错误的"无案例"事实上。
 *
 * - 页面像结果页却 0 条 → `template-stale`；
 * - 页面压根不像结果页（空态 / 导航页）→ `no-results`，那是**站点在回答**；
 * - 登录墙 / 挑战由调用方的页面分类负责，不在这里判。
 *
 * ⚠️ **真实验收边界**：本文件的 fixture 是按上面实测选择器**构造**的脱敏 DOM，不是对
 * 线上页面的字节复制。因此它只证明"选择器与字段口径能被解析"，**不证明**站点当前可用；
 * 真实站点的解析与截图仍需员工在授权环境验收一次。
 */

/** 页面解析的失败类别。`''` = 成功。 */
export type ParseFailureKind = '' | 'template-stale' | 'no-results' | 'unreadable'

export interface SitePageInput {
  providerId: MarketProviderId
  /** 渲染后的 DOM。 */
  body: string
  /** 最终 URL（跟随重定向之后）。 */
  finalUrl: string
}

export interface SitePageResult {
  listings: RawListing[]
  failureKind: ParseFailureKind
  /** 人话观察（进 capabilityGaps 与报告的技术过程）。 */
  notes: string[]
  /** 这次用的是哪条通道：`json-ld` 优先，`dom` 是兜底。 */
  channel: 'json-ld' | 'dom' | 'none'
}

/**
 * 结果页的列表容器类名。
 *
 * 链家的列表结构：这里合的是选择器，站点身份（域名、受保护页、
 * 登录状态）仍由各 provider 的定义各自验证。
 */
export const LIST_CONTAINER_CLASSES = ['sellListContent', 'listContent', 'sellListContentList'] as const

/** 详情页里"这条房源是什么"的字段锚点类名。 */
export const DETAIL_ANCHOR_CLASSES = ['introContent', 'overview', 'baseAttribute', 'transaction', 'baseInformation'] as const

/** HTML 里有没有出现某个 class（保守的"有没有这个结构"判定，不是完整 CSS 引擎）。 */
export function hasClass(body: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`class\\s*=\\s*["'][^"']*\\b${escaped}\\b`, 'i').test(text(body))
}

/** 提取一段 HTML 的可见文本（去脚本/样式、压空白、解码常见实体）。 */
export function textOf(html: string): string {
  return text(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 第一个 `<a>` 的某个属性值（找不到返回空串）。 */
function firstAttribute(block: string, attribute: string): string {
  for (const match of text(block).matchAll(/<a\b[^>]*>/gi)) {
    const found = new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, 'i').exec(match[0])
    if (found !== null && text(found[1]).trim() !== '') return text(found[1]).trim()
  }
  return ''
}

/** 类名为 `className` 的元素里的第一段文本（`<div class="title">…</div>` 之类的锚点）。 */
export function elementTextByClass(body: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<([a-z]+)\\b[^>]*class\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  )
  const match = pattern.exec(text(body))
  return match === null ? '' : textOf(match[2])
}

function numberBefore(haystack: string, pattern: RegExp): string {
  const match = pattern.exec(haystack)
  return match === null ? '' : text(match[1]).replace(/,/g, '')
}

/**
 * Value of the first `|`-separated layer that fully matches `pattern`.
 *
 * List rows split their facts into `|` layers (`3室2厅 | 157平米 | 南 西南 西 | 简装 | 高楼层 (共24层)`),
 * so a layer boundary — not the surrounding text — is what tells one fact from the next. Scanning the
 * whole block with a loose regex instead truncates multi-word values: 朝向 `南 西南 西` collapses to `西`.
 */
function layerValue(plain: string, pattern: RegExp): string {
  for (const layer of plain.split(/[|｜]/)) {
    const value = layer.trim()
    if (value !== '' && pattern.test(value)) return value
  }
  return ''
}

/** 从 URL 里取房源 ID（链家详情页是 `/<数字>.html`）。 */
export function listingIdOf(url: string): string {
  const match = /(\d{6,})\.html/.exec(text(url))
  return match === null ? '' : match[1]
}

/**
 * 把一条列表项解析成原始记录。
 *
 * 键名与 `normalize.ts` 的别名表对齐（那里有一致性断言：产出的键必须都被消费）。
 * 没有价格的一律返回 `null`：页面上的推荐位与广告位也没有价格，靠这个把它们挡在外面。
 */
export function listingFromListItem(itemHtml: string, source: MarketProviderId, baseUrl: string): RawListing | null {
  const block = text(itemHtml)
  const plain = textOf(block)
  const href = firstAttribute(block, 'href')
  let url = href
  if (url !== '' && !/^https?:\/\//i.test(url) && baseUrl !== '') {
    try {
      url = new URL(url, baseUrl).toString()
    } catch {
      url = ''
    }
  } else if (url !== '' && !/^https?:\/\//i.test(url)) {
    url = ''
  }

  // 标题优先取 `.title` 锚点里的文字；取不到再退到整块正文的前 60 字。
  const title = text(elementTextByClass(block, 'title')) || plain.slice(0, 60)

  const fields: Record<string, string> = {}
  // Keep the unit word with the number: `normalize.parsePrice` converts by unit word, so a bare
  // `1100` means 1100 元 — the total price would lose a factor of 10,000.
  const totalPrice = /([\d,]+(?:\.\d+)?)\s*万/.exec(plain)
  if (totalPrice !== null) fields.price = `${totalPrice[1].replace(/,/g, '')}万`
  // Unit prices are rendered as `元/平`, `元/平米` and `元/㎡` depending on the site and the layout.
  const unitPrice = /([\d,]+)\s*元\s*\/?\s*(?:平|㎡)/.exec(plain)
  if (unitPrice !== null) fields.unitPrice = `${unitPrice[1].replace(/,/g, '')}元`
  const area = numberBefore(plain, /([\d.]+)\s*(?:平米|㎡|平方米)/)
  if (area !== '') fields.area = area
  const layout = /(\d室\d厅(?:\d卫)?)/.exec(plain)?.[1] ?? ''
  if (layout !== '') fields.layout = layout
  // `floor` and `totalFloors` are separate fields in the case contract, so keep them separate here.
  // Both spellings are live: 链家 renders `高楼层 (共24层)`, 贝壳 renders `低楼层/共18层`.
  const floor = /(低楼层|中楼层|高楼层|地下室|顶层|底层)\s*[（(]?\/?\s*共?\s*(\d+)\s*层/.exec(plain)
  if (floor !== null) {
    fields.floor = floor[1]
    fields.totalFloors = floor[2]
  } else {
    const bareFloor = /(低楼层|中楼层|高楼层|地下室|顶层|底层)/.exec(plain)
    if (bareFloor !== null) fields.floor = bareFloor[1]
  }
  const orientation = layerValue(plain, /^[东南西北](?:\s*[东南西北]){0,3}$/)
  if (orientation !== '') fields.orientation = orientation
  const decoration = layerValue(plain, /^(精装|简装|毛坯|豪华装修|中装)$/)
  if (decoration !== '') fields.decoration = decoration
  const builtYear = /(\d{4})\s*年\s*(?:建|建成)/.exec(plain)?.[1] ?? ''
  if (builtYear !== '') fields.builtYear = builtYear

  const community = text(elementTextByClass(block, 'positionInfo')) || text(elementTextByClass(block, 'communityName'))
  if (community !== '') fields.community = community.split(/\s+/)[0]

  const listingId = listingIdOf(url)
  if (listingId !== '') fields.listingId = listingId
  if (totalPrice === null && unitPrice === null) return null
  return { source, url, title, fields }
}

/** 页面里有没有"这是结果页"的结构证据。 */
export function looksLikeListPage(body: string): boolean {
  return LIST_CONTAINER_CLASSES.some((className) => hasClass(body, className))
}

/**
 * 切出列表项候选块。
 *
 * 用非贪婪的 `<li>…</li>` 切分而不是上 HTML 解析器：这一层的输入是"我们自己的固定通道
 * 取回的渲染 DOM"，列表项之间**不嵌套**（实测的链家列表都是平铺的 `<li class="clear">`）。
 * 真要做通用 HTML 解析就得引依赖，而这条链路上"多一个依赖"比"少解析一层"贵得多。
 */
export function listItemBlocks(body: string): string[] {
  const html = text(body)
  if (!looksLikeListPage(html) && !/<li\b[^>]*class\s*=\s*["'][^"']*\bclear\b/i.test(html)) return []
  return [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map((match) => match[0])
}

/**
 * 解析一页。
 *
 * 顺序固定：**JSON-LD 优先**（权威结构化声明），没有可用记录时再用固定 DOM 选择器兜底。
 * 两条通道都空时按"页面像不像结果页"给出 `template-stale`（模板过期）或 `no-results`
 * （站点确实回答了"没有"）。
 */
export function parseSitePage(input: SitePageInput): SitePageResult {
  const body = text(input.body)
  const notes: string[] = []
  if (body.trim() === '') {
    return { listings: [], failureKind: 'unreadable', notes: ['页面正文为空：无法解析'], channel: 'none' }
  }

  const jsonld = listingsFromJsonLd(body, input.providerId)
  if (jsonld.listings.length > 0) {
    return {
      listings: dedupeListings(jsonld.listings),
      failureKind: '',
      notes: [...jsonld.notes],
      channel: 'json-ld',
    }
  }
  notes.push(...jsonld.notes)

  const listings: RawListing[] = []
  for (const block of listItemBlocks(body)) {
    const listing = listingFromListItem(block, input.providerId, input.finalUrl)
    if (listing !== null) listings.push(listing)
  }
  const deduped = dedupeListings(listings)
  if (deduped.length > 0) {
    notes.push(`JSON-LD 没有房源记录，改用固定选择器解析出 ${String(deduped.length)} 条`)
    return { listings: deduped, failureKind: '', notes, channel: 'dom' }
  }

  if (looksLikeListPage(body)) {
    // 结果页结构在、却一条房源都没解析出来：**模板过期**，绝不是"这个小区没有房源"。
    notes.push('页面有结果页结构，但固定选择器 0 命中：站点模板可能已改版（template-stale）')
    return { listings: [], failureKind: 'template-stale', notes, channel: 'dom' }
  }
  notes.push('页面不像结果页（可能是空态或导航页）：站点确实回答了"没有结果"')
  return { listings: [], failureKind: 'no-results', notes, channel: 'none' }
}

/**
 * 详情页是否真的是一条房源详情（Host 在恢复成功后做**房源级**校验）。
 *
 * 判据是"有详情字段锚点 **或** 正文里能读到价格/面积"，并且**最终 URL 的房源 ID 必须与原任务一致**。
 * 只看 HTTP 200 或"挑战消失"都不算 —— 那正是"挑战没了、页面是空的"这类假成功。
 */
export function looksLikeDetailPage(
  body: string,
  expectedListingId: string,
  finalUrl: string,
): { ok: boolean; reason: string } {
  const html = text(body)
  if (html.trim() === '') return { ok: false, reason: '详情页正文为空' }
  const id = listingIdOf(finalUrl)
  if (text(expectedListingId) !== '' && id !== '' && id !== text(expectedListingId)) {
    return { ok: false, reason: `最终 URL 的房源 ID（${id}）与原任务（${expectedListingId}）不一致` }
  }
  const anchor = DETAIL_ANCHOR_CLASSES.some((className) => hasClass(html, className))
  const plain = textOf(html)
  const hasPrice = /[\d,]+(?:\.\d+)?\s*万|[\d,]+\s*元\s*\/?\s*平/.test(plain)
  const hasArea = /[\d.]+\s*(?:平米|㎡|平方米)/.test(plain)
  if (!anchor && !hasPrice && !hasArea) {
    return { ok: false, reason: '页面里既没有详情字段锚点，也没有价格或面积：不像房源详情页' }
  }
  return { ok: true, reason: '' }
}
