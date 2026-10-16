import { text } from '../../../../shared/utils/value.ts'
import { LIANJIA_CITY_LIST_PAGE } from './city-list.ts'
import { MARKET_PROVIDER_IDS, isMarketProviderId, providerLabel, type MarketProviderId } from '../browser/login-state.ts'

/**
 * **各来源的城市表**（协议 39 · 设计稿 §8.2「各来源独立解析地区」）。
 *
 * ## 为什么单独一张表
 *
 * 城市标识进的是**来源自己的寻址面**：链家 / 安居客 / 58 同城把它放在**子域名**
 * （`https://{city}.lianjia.com/…`），房天下放在**查询参数**（`?city=…`）。两者对"合法取值"
 * 的要求不同，而且每家的城市清单**只有那家自己公布**。
 *
 * 于是：解析业务城市名必须**逐来源**做。把链家公布的列表当成所有来源的映射，
 * 会在另外两家上得到"看起来解析成功、实际指向另一个城市（或 404）"的结果 ——
 * 这类错误读起来完全正常，只有对着 URL 才看得出来。
 *
 * ## `adapted` 是这张表的核心字段
 *
 * - `adapted: true`：这份城市表**已适配**（有归档字节或实测依据），解析不出来就是
 *   **"该来源不覆盖这个地区"** —— 按来源处置（跳过它、改用替代来源）；
 * - `adapted: false`：只有公开的路径约定、**尚未适配** —— 解析不出来是**能力缺口**，
 *   不能写成"该来源不覆盖这个地区"：那会把"我们还没做"说成"这家不做"。
 *
 * 两者混同的后果是：员工看到"58同城不覆盖北京"，于是不再尝试 58 —— 而其实只是没适配。
 */

/** 城市标识进 URL 的方式（决定它能不能含中文）。 */
export type CityPlacement = 'subdomain' | 'query'

export interface CityListSource {
  providerId: MarketProviderId
  /** 站点**自己公布**的城市列表页（`adapted: false` 时是待核对的目标页）。 */
  page: string
  placement: CityPlacement
  /** 依据：归档真实字节 / 只有公开路径约定。 */
  evidence: 'archived-capture' | 'public-pattern'
  /** 这份城市表**是否已适配**（能否据它把业务城市名解析成来源自己的标识）。 */
  adapted: boolean
  /** 依据说明（进能力缺口与报告的技术过程）。 */
  note: string
}

/**
 * 逐来源的城市表登记。
 *
 * ⚠️ 只有链家那一条是 `adapted: true`：它的城市列表页有 2026-10-13 归档的真实字节依据。
 * 其余三条是 `adapted: false` —— 它们的城市列表页**没有被取过**，所以本轮不据它们解析；
 * 需要该来源时请提交**该来源自己的城市标识**（例如 `bj`），或先补一条实测依据。
 */
export const CITY_LIST_SOURCES: readonly CityListSource[] = [
  {
    providerId: 'lianjia',
    page: LIANJIA_CITY_LIST_PAGE,
    placement: 'subdomain',
    evidence: 'archived-capture',
    adapted: true,
    note: '链家公布的城市列表（`https://www.lianjia.com/city/`）：有归档的真实页面字节作依据，'
      + '可据它把业务城市名解析成链家的城市标识。',
  },
  {
    providerId: 'anjuke',
    page: 'https://www.anjuke.com/sale/',
    placement: 'subdomain',
    evidence: 'public-pattern',
    adapted: false,
    note: '安居客的城市在子域名上，但它的城市列表页**没有被取过**：本轮不据它解析业务城市名。'
      + '需要该来源时请提交安居客自己的城市标识（例如 bj）。',
  },
  {
    providerId: 'wuba',
    page: 'https://www.58.com/',
    placement: 'subdomain',
    evidence: 'public-pattern',
    adapted: false,
    note: '58 同城的城市在子域名上，但它的城市列表页**没有被取过**：本轮不据它解析业务城市名。'
      + '需要该来源时请提交 58 自己的城市标识（例如 bj）。',
  },
  {
    providerId: 'fang',
    page: 'https://search.fang.com/house/',
    placement: 'query',
    evidence: 'public-pattern',
    adapted: false,
    note: '房天下的城市走**查询参数**（`?city=…`），它的城市取值表**没有被取过**：'
      + '本轮不据它解析业务城市名。需要该来源时请提交房天下自己的城市标识（例如 bj）。',
  },
]

/** 这个来源登记了城市表没有（`null` = 表里根本没有它）。 */
export function cityListSourceOf(providerId: unknown): CityListSource | null {
  const raw = text(providerId)
  if (!isMarketProviderId(raw)) return null
  return CITY_LIST_SOURCES.find((item) => item.providerId === raw) ?? null
}

/** 已适配的城市表清单（进程启动即可核对"哪些来源能按城市名解析"）。 */
export function adaptedCitySourceIds(): string[] {
  return CITY_LIST_SOURCES.filter((item) => item.adapted).map((item) => item.providerId)
}

/** 未适配清单（取数层据此如实报能力缺口，而不是报"该来源不覆盖"）。 */
export function unadaptedCitySourceIds(): string[] {
  return CITY_LIST_SOURCES.filter((item) => !item.adapted).map((item) => item.providerId)
}

/**
 * 某个来源的城市解析结论（**逐来源**，不共用一份映射）。
 *
 * 三种结果分开说：`ok`（可拼 URL）/ `not-covered`（该来源不覆盖）/ `unsupported`（还没适配）。
 */
export interface ProviderCityVerdict {
  status: 'ok' | 'not-covered' | 'unsupported'
  /** 可安全放进 URL 的城市标识（只有 `ok` 时非空）。 */
  code: string
  reason: string
  /** 城市表来源的展示名（`ok` 时也回，便于报告写清"这个标识是哪来的"）。 */
  sourcePage: string
  evidence: string
}

/**
 * 由**已适配**的城市表判定逐来源结论。
 *
 * `resolution` 是已适配城市表给出的结果（目前只有链家那一条）。
 * 一个来源只有在**它自己的表已适配**时，才可能得到 `not-covered`。
 */
export function providerCityVerdict(input: {
  providerId: unknown
  /** 已适配城市表解析出的站点标识（解析失败为空串）。 */
  resolvedCode: string
  /** 已适配城市表的分辨结论：是不是"这份列表里没有这个城市"。 */
  uncovered: boolean
  /** 已适配城市表的归属来源 id。 */
  coveredBy: string
  /** 提交的业务城市原值（回显进原因）。 */
  input: string
}): ProviderCityVerdict {
  const providerId = text(input.providerId)
  const source = cityListSourceOf(providerId)
  const label = isMarketProviderId(providerId) ? providerLabel(providerId) : providerId
  const coveredBySource = cityListSourceOf(input.coveredBy)
  const coveredByLabel = isMarketProviderId(input.coveredBy) ? providerLabel(input.coveredBy) : text(input.coveredBy)

  if (input.resolvedCode !== '') {
    return {
      status: 'ok',
      code: input.resolvedCode,
      reason: '',
      sourcePage: coveredBySource?.page ?? '',
      // 标识可能来自"提交时就是站点标识"，那时没有城市表参与：如实说明来源。
      evidence: coveredBySource === null ? 'submitted-site-key' : coveredBySource.evidence,
    }
  }

  if (source === null) {
    return {
      status: 'unsupported', code: '',
      reason: `${label}还没有登记城市表：无法把业务城市「${input.input}」解析成它的城市标识。`
        + '请提交该来源自己的城市标识（例如 bj），不要猜。',
      sourcePage: '', evidence: '',
    }
  }

  // **只有自己那份表已适配**，才谈得上"该来源不覆盖这个地区"。
  if (source.adapted && input.uncovered && source.providerId === input.coveredBy) {
    return {
      status: 'not-covered', code: '',
      reason: `城市「${input.input}」不在 ${source.page} 公布的列表里：**该来源不覆盖这个地区**，`
        + '本轮跳过这一家、改用其他来源。',
      sourcePage: source.page, evidence: source.evidence,
    }
  }

  if (source.adapted) {
    // 自己的表已适配，但这次的结论不是来自它（例如另一个来源的列表说没有这个城市）：
    // 不能把别家的覆盖范围套到这一家头上。
    return {
      status: 'unsupported', code: '',
      reason: `${label}的城市表已适配，但本次没有据它解析出标识（解析依据是 ${coveredByLabel} 的列表）：`
        + `请提交${label}自己的城市标识（例如 bj）后重试。`,
      sourcePage: source.page, evidence: source.evidence,
    }
  }

  return {
    status: 'unsupported', code: '',
    reason: `${label}的城市表**尚未适配**（${source.note}）`
      + `业务城市「${input.input}」无法解析成它的城市标识。这是**能力缺口**（这张表还没接），`
      + `不是"${label}不覆盖这个地区"；请提交${label}自己的城市标识（例如 bj）后重试，`
      + '或在授权环境取一次它的城市列表页并补一条实测依据。',
    sourcePage: source.page, evidence: source.evidence,
  }
}

/** 全部来源的城市表状况（供面板 / 诊断核对"哪几家能按城市名解析"）。 */
export function citySourceFacts(): Array<{ providerId: string; adapted: boolean; evidence: string; page: string }> {
  return MARKET_PROVIDER_IDS.map((id) => {
    const source = cityListSourceOf(id)
    return {
      providerId: id,
      adapted: source?.adapted === true,
      evidence: source?.evidence ?? '',
      page: source?.page ?? '',
    }
  })
}
