import { text } from '../../../../shared/utils/value.ts'
import type { MarketProviderId } from '../browser/login-state.ts'
import { providerLabel } from '../browser/login-state.ts'
import type { RawListing } from '../browser/provider.ts'
import { canonicalListingUrl } from './candidates.ts'

/**
 * 外部案例的**字段标准化**与"挂牌 / 成交"纪律。
 *
 * ## 为什么这一层必须有
 *
 * 三个站点的字段名各不相同（`totalPrice` / `price` / `售价` …），而估值计算只认一套字段。
 * 标准化放在插件里（而不是交给模型）：字段一旦由模型自由映射，"180 万"被读成"单价 1.8 万"
 * 这类错误就只在最终数字上体现，没有任何地方能拦住。
 *
 * ## 挂牌价 ≠ 成交价（硬纪律）
 *
 * 市场法要的是**成交**可比实例。挂牌价是**卖方要价**，系统性高于成交价；把它当成交价
 * 会把估值整体抬高。所以：
 * - 每条案例都带 `transactionType`；
 * - **只有**页面明确写了"成交 / 已成交 / 成交价"才标 `成交`；
 * - 出现"挂牌 / 售价 / 报价 / 要价 / 询价"标 `挂牌` 或 `询价`；
 * - 什么都没有 → `未知`（**不是** `成交`）—— 缺省朝安全的一侧倒。
 *
 * `caseIsComparable` 只在 `transactionType === '成交'` 时允许直接用作市场法可比实例；
 * 挂牌案例必须由人工调整后才可用（那一步在 Skill 里，插件不替它决定）。
 */

export type TransactionType = '挂牌' | '成交' | '询价' | '未知'

/** 判定词表（按"越明确越优先"的顺序排列）。 */
const TRANSACTION_RULES: Array<{ type: TransactionType; patterns: RegExp[] }> = [
  // 先认"成交"：页面同时出现"成交价 180 万（挂牌价 200 万）"时必须算成交。
  // `\bsold\b`（词边界）而不是 `/sold/`：后者会把 "unsold" 也读成成交。
  { type: '成交', patterns: [/成交价/, /已成交/, /成交总价/, /成交单价/, /\bsold\b/i] },
  { type: '挂牌', patterns: [/挂牌价/, /挂牌/, /售价/, /报价/, /要价/, /总价/, /万\/套/, /\blisting\b/i] },
  { type: '询价', patterns: [/询价/, /面议/, /价格待定/] },
]

/** 一条标准化后的估值案例。字段名与 `估值案例.json` 的键一致（下划线风格）。 */
export interface ValuationCase {
  /** 来源平台 id 与展示名。 */
  source: MarketProviderId
  sourceLabel: string
  url: string
  title: string
  /** 小区 / 地址。 */
  community: string
  purpose: string
  propertyNature: string
  /** 建筑面积（㎡）；拿不到时为 `null`（绝不填 0）。 */
  buildingArea: number | null
  floor: string
  totalFloors: string
  builtYear: string
  decoration: string
  /** 价格（元）；拿不到时为 `null`。 */
  price: number | null
  /** 单价（元/㎡）；由价格与面积算，缺一为 `null`。 */
  unitPrice: number | null
  transactionType: TransactionType
  /** 页面/资料里给出的发布时间或交易时间；拿不到为空串。 */
  publishedAt: string
  /** 抓取时刻（ISO）。 */
  capturedAt: string
  /** 证据文件（相对案例目录）；还没有证据时为空串。 */
  evidence: string
  /**
   * **页面截图**（§7.4）：相对案例目录的路径；没有截图能力时为空串。
   *
   * 与 `evidence` 分开：HTML 字节 / 指纹 / JSON-LD 都不是截图。
   */
  screenshot: string
  /** 截图指纹（`sha256:<hex>`）；没有时为空串。 */
  screenshotDigest: string
  /** 截图采集时刻（ISO）；没有时为空串。 */
  screenshotCapturedAt: string
  /** 保留理由（空串 = 还没判定）。 */
  keepReason: string
  /** 剔除理由（空串 = 未剔除）。 */
  dropReason: string
  /** 标准化时的观察（字段缺失、价格无法解析…）。 */
  notes: string[]
}

/** 字段别名表：站点字段名 → 我们的字段。键一律小写去分隔符后匹配。 */
const ALIASES: Record<string, string[]> = {
  /** 案例链接：JSON-LD 用 `url`，各家站点另有自己的写法。 */
  url: ['url', 'link', 'linkurl', '详情链接', '房源链接'],
  title: ['title', 'name', '标题', '房源标题'],
  community: ['community', 'communityname', 'streetaddress', 'addresslocality', 'address',
    '小区', '小区名称', 'residential', '地址', '坐落'],
  purpose: ['purpose', 'usage', '用途', '房屋用途', '物业类型'],
  propertyNature: ['propertynature', 'propertytype', '房屋性质', '产权性质', '权属类型'],
  // `floorsize` 必须在这里：它是 schema.org（JSON-LD）里建筑面积的规范字段名，
  // 而 JSON-LD 正是本插件**唯一**会去读的结构化来源。漏了它 → 面积永远拿不到 →
  // 单价永远算不出来 → 市场法直接失去唯一的可比指标（而且不会报错，只会静默为 null）。
  buildingArea: ['buildingarea', 'area', 'floorsize', 'size', '建筑面积', '面积', '建面'],
  floor: ['floor', '所在楼层', '楼层', 'floorlevel', 'floornumber'],
  totalFloors: ['totalfloors', 'totalfloor', 'numberoffloorlevels', 'buildingfloors', '总楼层', '总层数', '楼层总数'],
  builtYear: ['builtyear', 'yearbuilt', 'builtage', '建成年代', '建成年份', '建筑年代', 'year'],
  decoration: ['decoration', 'fitment', 'itemcondition', '装修', '装修情况'],
  price: ['price', 'totalprice', '总价', '售价', '挂牌价', '成交价', '价格'],
  unitPrice: ['unitprice', 'priceper', '单价', '均价'],
  transactionType: ['transactiontype', 'tradetype', '交易类型', '交易性质'],
  publishedAt: ['publishedat', 'publishtime', 'listtime', 'dateposted', 'datepublished', '发布时间', '挂牌时间', '成交时间', '交易时间'],
  /** 页面声明的标价货币。不参与换算，只用来**提醒人工核对**（见 `normalizeCase`）。 */
  currency: ['pricecurrency', 'currency', '币种', '货币'],
}

/** 视为人民币的写法（其余一律提醒人工核对）。 */
const CNY_MARKERS = ['cny', 'rmb', '元', '人民币', '¥', '￥']

/**
 * 全部别名（归一化之后），供"JSON-LD 读出来的键必须都能被识别"的防漂移断言使用。
 *
 * 为什么要暴露它：JSON-LD 那边产出的键名与本表的别名是**两份**列表，漂移的症状是
 * "某个字段静默为 null" —— 不报错、不缺数据的样子，只有最终数字不对。有一条断言盯着，
 * 就不会再出现 `floorSize` 这种漏项。
 */
export function knownFieldAliases(): string[] {
  return Object.values(ALIASES).flat().map((alias) => normalizeFieldName(alias))
}

/** 归一化字段名：小写、去掉空格与下划线/连字符。 */
export function normalizeFieldName(name: unknown): string {
  return text(name).toLowerCase().replace(/[\s_-]+/g, '')
}

/** 在原始字段里按别名找一个值（**第一个非空**命中）。 */
export function pickField(fields: Record<string, string>, key: string): string {
  const wanted = ALIASES[key] ?? []
  const normalized = new Map<string, string>()
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const name = normalizeFieldName(rawKey)
    const value = text(rawValue).trim()
    if (value !== '' && !normalized.has(name)) normalized.set(name, value)
  }
  for (const alias of wanted) {
    const hit = normalized.get(normalizeFieldName(alias))
    if (hit !== undefined) return hit
  }
  return ''
}

/**
 * 解析价格：接受 `180万` / `1,800,000` / `1800000元` / `1.8万/㎡`。
 *
 * 单位靠**词**判定，不靠数量级猜（"180" 既可能是 180 万也可能是 180 元）：
 * 带"万"乘 10000，带"亿"乘 1e8，其余按元。解析不出来返回 `null` —— 不猜。
 */
export function parsePrice(value: unknown): number | null {
  const raw = text(value).trim()
  if (raw === '') return null
  const match = raw.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)/)
  if (match === null) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (/亿/.test(raw)) return Math.round(amount * 1e8)
  if (/万/.test(raw)) return Math.round(amount * 1e4)
  // 带"元"或纯数字：按元。三位数（"180"）这种明显是万元口径的写法**不猜**，只在带"万"时才换算。
  return Math.round(amount)
}

/** 解析面积（㎡）；解析不出来返回 `null`。 */
export function parseArea(value: unknown): number | null {
  const raw = text(value).trim()
  if (raw === '') return null
  const match = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  if (match === null) return null
  const area = Number(match[1])
  return Number.isFinite(area) && area > 0 ? area : null
}

/** 判定交易类型。**缺省是 `未知`**，不是 `成交`。 */
export function transactionTypeOf(...sources: unknown[]): TransactionType {
  const haystack = sources.map((item) => text(item)).join(' ')
  if (haystack.trim() === '') return '未知'
  for (const rule of TRANSACTION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) return rule.type
  }
  return '未知'
}

/**
 * Explicit transaction type from a dedicated field value, else `null`.
 *
 * Empty values are not facts and unknown wording is not guessed.
 */
export function explicitTransactionTypeOf(value: unknown): TransactionType | null {
  const raw = text(value).trim()
  if (raw === '') return null
  // Negative wording first: 未成交 / 未售出 / unsold are not 成交.
  if (/未成交|未售出|尚未成交|流拍|unsold/i.test(raw)) return '挂牌'
  if (/成交/.test(raw)) return '成交'
  if (/挂牌|出售|在售/.test(raw)) return '挂牌'
  if (/询价|面议|价格待定/.test(raw)) return '询价'
  if (/未知|不详|暂无/.test(raw)) return '未知'
  return null
}

/**
 * 单价：优先用页面给的单价，否则由总价 / 面积算。
 *
 * 两条都不成立时返回 `null`（**不填 0**："没有单价"与"单价为零"在后续校验里完全不同）。
 */
export function unitPriceOf(price: number | null, area: number | null, explicit?: unknown): number | null {
  const given = parsePrice(explicit)
  if (given !== null) return given
  if (price === null || area === null || area <= 0) return null
  return Math.round(price / area)
}

export interface NormalizeOptions {
  /** 抓取时刻（ISO）；缺省用 `now`。 */
  capturedAt?: string
  now?: Date
}

/** 一条原始记录 → 标准化案例。 */
export function normalizeCase(raw: RawListing, options: NormalizeOptions = {}): ValuationCase {
  const fields = raw.fields ?? {}
  const title = text(raw.title) || pickField(fields, 'title')
  const priceRaw = pickField(fields, 'price')
  const price = parsePrice(priceRaw)
  const area = parseArea(pickField(fields, 'buildingArea'))
  const notes: string[] = []

  if (area === null) notes.push('页面没有给出可解析的建筑面积')
  if (price === null) notes.push('页面没有给出可解析的价格')

  // Explicit transaction type wins; only nonempty field values are facts (never empty keys).
  const explicit = explicitTransactionTypeOf(pickField(fields, 'transactionType'))
  const nonEmptyFields = Object.entries(fields)
    .filter(([, value]) => text(value).trim() !== '')
    .map(([key, value]) => `${key} ${text(value)}`)
  const transactionType = explicit ?? transactionTypeOf(title, priceRaw, ...nonEmptyFields)
  if (transactionType === '未知') notes.push('页面未标明挂牌/成交：按「未知」处理，不得直接当作成交可比实例')

  const unitPrice = unitPriceOf(price, area, pickField(fields, 'unitPrice'))
  if (unitPrice === null && price !== null) notes.push('单价缺失：需要面积才能换算')

  // 货币只看**页面声明**：本工具不做汇率换算，所以非人民币标价必须提醒人工，
  // 而不是默默按元参与计算（那会把港币/美元价格当成人民币，误差是数量级的）。
  const currency = pickField(fields, 'currency')
  if (currency !== '' && !CNY_MARKERS.some((marker) => currency.toLowerCase().includes(marker))) {
    notes.push(`页面标价货币为「${currency}」：本工具不做汇率换算，请人工核对后再采用这个价格`)
  }

  return {
    source: raw.source,
    sourceLabel: providerLabel(raw.source),
    // 链接优先用 provider 给的那一条；JSON-LD 里声明的 `url` 作为兜底（别把案例出处丢了）。
    url: text(raw.url) || pickField(fields, 'url'),
    title,
    community: pickField(fields, 'community'),
    purpose: pickField(fields, 'purpose'),
    propertyNature: pickField(fields, 'propertyNature'),
    buildingArea: area,
    floor: pickField(fields, 'floor'),
    totalFloors: pickField(fields, 'totalFloors'),
    builtYear: pickField(fields, 'builtYear'),
    decoration: pickField(fields, 'decoration'),
    price,
    unitPrice,
    transactionType,
    publishedAt: pickField(fields, 'publishedAt'),
    capturedAt: text(options.capturedAt) || (options.now ?? new Date()).toISOString(),
    evidence: '',
    screenshot: '',
    screenshotDigest: '',
    screenshotCapturedAt: '',
    keepReason: '',
    dropReason: '',
    notes,
  }
}

/**
 * 这条案例能不能**直接**用作市场法可比实例。
 *
 * 只有明确的成交案例可以；挂牌与询价都必须先做价格修正（那一步在 Skill 里，
 * 而且要留下修正依据）。`未知` 同样不可以 —— 缺省朝安全一侧倒。
 */
/**
 * **跨站去重**的同一套房源指纹（§7.3：链家与房天下可能重复展示同一房源，不能算两个案例）。
 *
 * 为什么不能只按 URL 去重：同一套房在房天下与链家是**两条不同的 URL**，按 URL 去重等于没去。
 * 所以指纹取"可跨站比较的那几个事实"：小区/地址（归一化）+ 建筑面积 + 价格档。
 *
 * 三点口径：
 * - **面积与价格都要有**：拿不到就不用指纹去合并 —— 靠"小区相同"合并会把同小区的不同房源
 *   误判成一套（比重复更危险：案例凭空少了一条）；
 * - 价格按**万元档**取整（`/10000` 后取 1 位小数）：三个站点对同一价格的四舍五入不同，
 *   精确到元会把同一套算成两套；同时 1 位小数足以区分同小区不同总价的房源；
 * - 小区名归一化去掉空白与括号内容（"阳光小区(3期)" 与 "阳光小区" 视为同一个）——
 *   站点对同一小区的写法常带后缀，而那是营销文字不是身份。
 */
export function crossSiteKey(item: ValuationCase): string {
  if (item.buildingArea === null || item.price === null) return ''
  const community = item.community
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (community === '') return ''
  return `${community}|${String(Math.round(item.buildingArea * 10) / 10)}|${String(Math.round(item.price / 1000) / 10)}`
}

/**
 * 对**全部来源**的标准化案例做跨站去重：只有同一 canonical URL 才算同一套房源。
 *
 * 弱事实（小区 + 面积 + 价格）相同**只是疑似重复**：来自不同 URL 的记录一律保留，
 * 只在两边的 `notes` 里留一句痕迹。合并时保留先出现的那一条并注明与谁重复。
 */
export function dedupeAcrossSources(cases: readonly ValuationCase[]): ValuationCase[] {
  const byCanonical = new Map<string, ValuationCase>()
  const out: ValuationCase[] = []
  for (const item of cases) {
    const canonical = canonicalListingUrl(item.url)
    if (canonical === '') {
      // 没有可用 URL：照常保留，不靠弱事实合并。
      out.push(item)
      continue
    }
    const first = byCanonical.get(canonical)
    if (first === undefined) {
      byCanonical.set(canonical, item)
      out.push(item)
      continue
    }
    first.notes = [...first.notes, `与 ${item.sourceLabel} 的同一房源重复（${item.url}）：已按同一 canonical URL 合并为一条`]
  }

  // Weak facts are a suspicion only: mark both, never merge different canonical URLs.
  const byWeak = new Map<string, ValuationCase>()
  for (const item of out) {
    const weak = crossSiteKey(item)
    if (weak === '') continue
    const first = byWeak.get(weak)
    if (first === undefined) {
      byWeak.set(weak, item)
      continue
    }
    if (canonicalListingUrl(first.url) === canonicalListingUrl(item.url)) continue
    first.notes = [...first.notes, `弱事实与 ${item.sourceLabel}（${item.url}）相同：仅标记疑似重复，未合并`]
    item.notes = [...item.notes, `弱事实与 ${first.sourceLabel}（${first.url}）相同：仅标记疑似重复，未合并`]
  }
  return out
}

export function caseIsComparable(item: ValuationCase): boolean {
  return item.transactionType === '成交' && item.unitPrice !== null && item.buildingArea !== null
}

/** 案例数量统计（结果与界面共用）。 */
export function caseCounts(cases: readonly ValuationCase[]): Record<TransactionType | 'total' | 'comparable', number> {
  const counts = { 挂牌: 0, 成交: 0, 询价: 0, 未知: 0, total: cases.length, comparable: 0 }
  for (const item of cases) {
    counts[item.transactionType] += 1
    if (caseIsComparable(item)) counts.comparable += 1
  }
  return counts
}
