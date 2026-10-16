import { text } from '../../../../shared/utils/value.ts'

/**
 * 检索**预算**（协议 39：设计稿 §5.2）。
 *
 * ## 为什么预算必须在 Host 这一侧、而且必须持久
 *
 * 已确认的业务口径是：**同一来源、同一分组、同一检索轮次**最多 10 页列表、最多 20 条达标候选，
 * 任一触顶即停。把这条只写进提示词，等于把上限交给模型自觉：换一个关键字、换个筛选、重试一次
 * 或过一次验证码，都可以在"新一轮"的名义下重新开始 —— 而它看起来完全正常。
 *
 * 所以：
 *
 * 1. **计数在 Host**（这里），由工具在每次取数前后读写；
 * 2. **持久到方案目录**（`取数预算.json`），跨调用、跨进程重启都算数；
 * 3. **换词 / 换页 / 重复调用 / 验证码恢复都不重置**：预算的键里**没有**关键字、没有页码、
 *    没有尝试次数 —— 只有「项目 / 方案 / 分组 / 来源 / 轮次」；
 * 4. **同源重复条目不算新候选**：按来源内的身份指纹去重，重复出现不加计数。
 *
 * ## 它不是达标判据
 *
 * "达标"由本轮知识正文定义（相似性、价格性质、面积区间…），Host 不写死业务阈值。
 * 这里的计数是**去重后的候选条数**：宁可把预算算得保守一点（先记满，再由 Agent 剔除），
 * 也不允许用"我先把它们都标成不达标"来无限翻页。
 */

/** 同组同轮每来源的页数上限。 */
export const MARKET_PAGE_LIMIT = 10
/** 同组同轮每来源的候选条数上限。 */
export const MARKET_CANDIDATE_LIMIT = 20

/** 预算是"上限"不是"目标"：足够支持选组时可以提前停。 */
export const BUDGET_FILE = '取数预算.json'

/** 一个来源在某个轮次里已经用掉的预算。 */
export interface ProviderBudget {
  /** 已经成功取回的**列表页**数（失败的页不占页数，它们在尝试上限里计）。 */
  pages: number
  /** 已经计入的候选条数（同源重复条目不重复计）。 */
  candidates: number
  /** 已经见过的候选身份指纹（用来识别"同一条又出现一次"）。 */
  seen: string[]
}

/** 一个（项目 / 方案 / 分组）的预算账本。 */
export interface MarketBudget {
  schemaVersion: 'crwu.valuation.retrieval-budget.v1'
  projectId: string
  planId: string
  /** 分组：按估值对象与样本用途分（出售 / 租金分开）。 */
  group: string
  /** 检索轮次：只有"用户要求补搜或换规则"才开新一轮。 */
  round: number
  /** 业务城市：不同城市绝不共用一份预算（旧账缺省时按不匹配处理）。 */
  city?: string
  providers: Record<string, ProviderBudget>
  updatedAt: string
}

export function emptyBudget(input: {
  projectId: string
  planId: string
  group: string
  round?: number
  city?: string
  updatedAt: string
}): MarketBudget {
  const city = text(input.city)
  return {
    schemaVersion: 'crwu.valuation.retrieval-budget.v1',
    projectId: text(input.projectId),
    planId: text(input.planId),
    group: text(input.group) || 'sale',
    round: Number.isFinite(input.round) ? Math.max(1, Math.trunc(input.round as number)) : 1,
    ...(city === '' ? {} : { city }),
    providers: {},
    updatedAt: text(input.updatedAt),
  }
}

function budgetProviderOf(budget: MarketBudget, providerId: string): ProviderBudget {
  return budget.providers[providerId] ?? { pages: 0, candidates: 0, seen: [] }
}

/** 这一次还能不能翻下一页。 */
export interface PageAllowance {
  allowed: boolean
  /** `''` = 可以继续；否则是触顶原因（`page-limit` / `candidate-limit`）。 */
  stoppedBy: '' | 'page-limit' | 'candidate-limit'
  pagesUsed: number
  candidatesUsed: number
  pageLimit: number
  candidateLimit: number
  reason: string
}

/**
 * 下一个分页**还能不能取**。
 *
 * 判据只有两条（页数、候选数），任一触顶即停；预算里**不含**关键字与页码，
 * 所以换词 / 重复调用 / 验证恢复都读到同一份账。
 */
export function pageAllowanceOf(
  budget: MarketBudget,
  providerId: string,
  limits: { pageLimit?: number; candidateLimit?: number } = {},
): PageAllowance {
  const pageLimit = limits.pageLimit ?? MARKET_PAGE_LIMIT
  const candidateLimit = limits.candidateLimit ?? MARKET_CANDIDATE_LIMIT
  const used = budgetProviderOf(budget, providerId)
  if (used.candidates >= candidateLimit) {
    return {
      allowed: false, stoppedBy: 'candidate-limit',
      pagesUsed: used.pages, candidatesUsed: used.candidates, pageLimit, candidateLimit,
      reason: `该来源在本分组本轮已经有 ${String(used.candidates)} 条候选（上限 ${String(candidateLimit)} 条）：`
        + '按"任一上限触顶即停"停止翻页。上限不是目标，已足以支持选组时本来也该提前停。',
    }
  }
  if (used.pages >= pageLimit) {
    return {
      allowed: false, stoppedBy: 'page-limit',
      pagesUsed: used.pages, candidatesUsed: used.candidates, pageLimit, candidateLimit,
      reason: `该来源在本分组本轮已经翻了 ${String(used.pages)} 页（上限 ${String(pageLimit)} 页）：`
        + '按"任一上限触顶即停"停止翻页。',
    }
  }
  return {
    allowed: true, stoppedBy: '',
    pagesUsed: used.pages, candidatesUsed: used.candidates, pageLimit, candidateLimit,
    reason: '',
  }
}

/**
 * 记一页的成果。
 *
 * `fingerprints` 是**本页**经知识评估合格且事实门禁通过的候选身份（来源内身份；同一条房源
 * 在不同页或不同排序下会换 URL）。已经在 `seen` 里的不重复计数。
 */
export function recordPage(
  budget: MarketBudget,
  providerId: string,
  fingerprints: readonly string[],
  updatedAt: string,
): { budget: MarketBudget; added: number } {
  const used = budgetProviderOf(budget, providerId)
  const recorded = qualifiedOnly(budget, providerId, fingerprints, updatedAt)
  const entry = recorded.budget.providers[providerId] ?? { pages: used.pages, candidates: used.candidates, seen: [] }
  return {
    budget: {
      ...recorded.budget,
      providers: { ...recorded.budget.providers, [providerId]: { ...entry, pages: used.pages + 1 } },
    },
    added: recorded.added,
  }
}

/**
 * 记一批**合格候选**而不推进页数（命中已落盘列表快照时的补记）。
 *
 * 只有"知识评估 qualified + 事实门禁通过"的身份才会被传入 —— near-miss / 未评估 /
 * 缺证据的不占合格名额。
 */
export function recordQualified(
  budget: MarketBudget,
  providerId: string,
  fingerprints: readonly string[],
  updatedAt: string,
): { budget: MarketBudget; added: number } {
  return qualifiedOnly(budget, providerId, fingerprints, updatedAt)
}

function qualifiedOnly(
  budget: MarketBudget,
  providerId: string,
  fingerprints: readonly string[],
  updatedAt: string,
): { budget: MarketBudget; added: number } {
  const used = budgetProviderOf(budget, providerId)
  const seen = new Set(used.seen)
  let added = 0
  for (const raw of fingerprints) {
    const key = text(raw).trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    added += 1
  }
  return {
    budget: {
      ...budget,
      providers: {
        ...budget.providers,
        [providerId]: { pages: used.pages, candidates: used.candidates + added, seen: [...seen] },
      },
      updatedAt: text(updatedAt),
    },
    added,
  }
}

/** 从落盘的 JSON 里读回预算；形状不对时返回 `null`（调用方重建并如实说明）。 */
export function budgetFromJson(value: unknown): MarketBudget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 'crwu.valuation.retrieval-budget.v1') return null
  const providers: Record<string, ProviderBudget> = {}
  const source = raw.providers
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [id, item] of Object.entries(source as Record<string, unknown>)) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      providers[id] = {
        pages: typeof entry.pages === 'number' && Number.isFinite(entry.pages) ? Math.max(0, Math.trunc(entry.pages)) : 0,
        candidates: typeof entry.candidates === 'number' && Number.isFinite(entry.candidates)
          ? Math.max(0, Math.trunc(entry.candidates)) : 0,
        seen: Array.isArray(entry.seen) ? entry.seen.map((one) => text(one)).filter((one) => one !== '') : [],
      }
    }
  }
  const round = typeof raw.round === 'number' && Number.isFinite(raw.round) ? Math.max(1, Math.trunc(raw.round)) : 1
  const city = text(raw.city)
  return {
    schemaVersion: 'crwu.valuation.retrieval-budget.v1',
    projectId: text(raw.projectId),
    planId: text(raw.planId),
    group: text(raw.group) || 'sale',
    round,
    ...(city === '' ? {} : { city }),
    providers,
    updatedAt: text(raw.updatedAt),
  }
}

/**
 * 预算账本是否属于**同一个分组与轮次**。
 *
 * 分组 / 轮次 / 方案 / 项目任一不同，都不能拿旧账继续用（那会把别的对象的预算算进来），
 * 也不能因为换了一个关键字就重开账（那正是"换词绕过预算"）。所以**关键字不在这里**。
 */
export function budgetMatches(
  budget: MarketBudget,
  input: { projectId: string; planId: string; group: string; round: number; city?: string },
): boolean {
  const wantedCity = text(input.city)
  // City is part of the identity when the caller declares one; a legacy budget without a city
  // must not be silently reused for a different city.
  if (wantedCity !== '' && (budget.city ?? '') !== wantedCity) return false
  return budget.projectId === text(input.projectId)
    && budget.planId === text(input.planId)
    && budget.group === (text(input.group) || 'sale')
    && budget.round === Math.max(1, Math.trunc(input.round))
}
