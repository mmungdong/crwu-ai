import { text } from '../../../../shared/utils/value.ts'
import type { MarketProviderId } from '../browser/login-state.ts'
import type { RawListing } from '../browser/provider.ts'

/**
 * 从页面 HTML 里**保守地**取出结构化房源记录。
 *
 * ## 为什么只认 JSON-LD / 明确的嵌入式 JSON
 *
 * 三个站点都没有公开、稳定的房源检索 API。可用的选择是：
 *
 * | 做法 | 结果 |
 * | --- | --- |
 * | 按 CSS 选择器抓 DOM | 站点改版即静默失效；更糟的是**抓错**（把小区均价当成这套房的价） |
 * | 按 JSON-LD / `__NEXT_DATA__` 取结构化字段 | 有就是有，没有就是没有 —— 不存在"猜出半个字段" |
 * | 让模型读页面自由发挥 | 正好违反"不许编造案例" |
 *
 * 所以这里只做第二种：页面里**明确**声明了结构化数据就取，否则返回空清单 + 一条缺口文案。
 * 空清单不是失败 —— 站点可能真的没有这类数据，如实说"页面结构无法解析"即可。
 *
 * ## 与站点解耦
 *
 * 这一层不认识"房天下"或"链家"：它只认识"页面里的 `RealEstateListing`/`Residence` 形状"。
 * 站点注入由 `providers.ts` 的 URL 模板决定。这样站点改版时改的是 URL 模板，
 * 而不是在解析器里加一堆 `if (site === ...)`。
 */

/**
 * 一条 JSON-LD 对象里我们**会消费**的键。
 *
 * 判据是"下游有没有字段接它"：只在页面里出现、而标准化表不认的键一律**不收** ——
 * 收了就是死数据，而且会让"产出的键必须都被消费"这条断言失去意义
 * （有一条断言盯着这个：产出的每个键都要能在 `normalize.ts` 的别名表里找到）。
 */
const LISTING_KEYS = [
  'name', 'url', 'address', 'streetAddress', 'addressLocality',
  'floorSize', 'numberOfFloorLevels', 'floorLevel',
  'price', 'priceCurrency', 'datePosted', 'datePublished',
  'yearBuilt', 'itemCondition',
] as const

/** 我们认为"像房源记录"的类型名（大小写不敏感的部分匹配）。 */
const LISTING_TYPES = ['realestatelisting', 'residence', 'product', 'offer', 'house', 'apartment', 'singlefamilyresidence']

function isListingType(value: unknown): boolean {
  const raw = text(value).toLowerCase()
  return raw !== '' && LISTING_TYPES.some((type) => raw.includes(type))
}

function flatten(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return flatten(value[0])
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    // 常见嵌套：`{ value: 100, unitText: '㎡' }` / `{ "@type": "PostalAddress", streetAddress: '…' }`
    for (const key of ['value', 'name', 'streetAddress', 'addressLocality', 'text']) {
      if (record[key] !== undefined) return flatten(record[key])
    }
    return ''
  }
  return ''
}

/** 把一个 JSON-LD 对象收成 `fields`；不是房源形状时返回 `null`。 */
export function listingFieldsOf(node: unknown): Record<string, string> | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null
  const record = node as Record<string, unknown>
  if (!isListingType(record['@type']) && !isListingType(record.type)) return null
  const fields: Record<string, string> = {}
  for (const key of LISTING_KEYS) {
    if (record[key] === undefined) continue
    const value = flatten(record[key])
    if (value !== '') fields[key] = value
  }
  // 价格是最关键的字段：一个"房源"连价格都没有，多半是页面上的推荐位/广告位。
  if (!Object.keys(fields).some((key) => /price/i.test(key))) return null
  return fields
}

/** 递归收集 JSON-LD 里的房源对象（含 `@graph` 嵌套）。 */
function collectListings(node: unknown, out: Record<string, string>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectListings(item, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  const fields = listingFieldsOf(record)
  if (fields !== null) {
    out.push(fields)
    return
  }
  if (Array.isArray(record['@graph'])) collectListings(record['@graph'], out)
  if (Array.isArray(record.itemListElement)) collectListings(record.itemListElement, out)
}

/**
 * 取出 `<script type="application/ld+json">` 里的房源记录。
 *
 * 解析失败的块**跳过并记一条观察**（不抛错、不编数据）：页面里混一块坏 JSON 是常态，
 * 因为它就丢掉整页结果才是真正的损失。
 */
export function listingsFromJsonLd(html: string, source: MarketProviderId): { listings: RawListing[]; notes: string[] } {
  const listings: RawListing[] = []
  const notes: string[] = []
  const body = text(html)
  const blocks = [...body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  let parsed = 0
  let broken = 0
  for (const block of blocks) {
    const raw = text(block[1]).trim()
    if (raw === '') continue
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      broken += 1
      void error
      continue
    }
    parsed += 1
    const found: Record<string, string>[] = []
    collectListings(payload, found)
    for (const fields of found) {
      listings.push({
        source,
        url: fields.url ?? '',
        title: fields.name ?? '',
        fields,
      })
    }
  }
  if (blocks.length === 0) notes.push('页面里没有 JSON-LD 结构化数据')
  else if (broken > 0) notes.push(`页面里有 ${broken} 块 JSON-LD 无法解析（已跳过）`)
  if (blocks.length > 0 && parsed > 0 && listings.length === 0) {
    notes.push('页面有 JSON-LD，但没有房源形状的记录：无法据此提取案例（不猜测）')
  }
  return { listings, notes }
}

/** 去重：同一 URL 只留一条（分页与"推荐位"常常重复同一套房）。 */
export function dedupeListings(listings: readonly RawListing[]): RawListing[] {
  const seen = new Set<string>()
  const out: RawListing[] = []
  for (const item of listings) {
    const key = text(item.url) || text(item.title)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
