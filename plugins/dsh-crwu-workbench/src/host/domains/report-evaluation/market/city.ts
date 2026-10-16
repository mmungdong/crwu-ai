import { text } from '../../../../shared/utils/value.ts'
import { providerCityVerdict } from './city-sources.ts'
import {
  LIANJIA_CITY_LIST_PAGE,
  SITE_KEY_PATTERN,
  loadCityList,
  type CityListEntry,
  type LoadCityListOptions,
} from './city-list.ts'

/**
 * 城市：**业务城市 → 站点城市标识**的收窄与校验（设计稿 §8.2，计划 Task 8；分析 P7）。
 *
 * ## 为什么单独一层
 *
 * 链家的检索 URL 形如 `https://{city}.lianjia.com/ershoufang/…` —— 城市标识会进**域名**。
 * 把中文城市名原样代进去，得到的是 `https://北京.lianjia.com/…`：DNS 解析不了、页面取不到，
 * 而调用方看到的却是"这个来源没有案例"。更糟的是这类错误**看起来像业务结论**
 * （"北京没有房源"），没人会去查 URL。
 *
 * ## 三件事，三种输入
 *
 * 1. **形状闸门**（`validateSiteCity` / `isSafeCityCode`）：只放行单段 DNS 标签
 *    （`^[a-z]{2,10}$`）—— 它会进域名，这是最后一道，不能放宽；
 * 2. **业务城市 → 标识**（`resolveBusinessCity`）：模型提交的是业务身份（`北京`），
 *    标识由站点自己公布的城市列表推出（`market/city-list.ts`），**不在代码里建表**；
 *    拿不准（未知 / 一个名字对上多个标识 / 页面读不到）就返回 `unresolved` + 候选清单，
 *    绝不静默退到 `bj`；
 * 3. **知识规则里的标识**（`resolveSiteCity`）：选例规则由业务侧给出，同一城市在不同站点
 *    写法可能不同，所以支持按来源覆盖。这一条是**同步**的，不做拼音转换、不做模糊匹配。
 */

/** 站点城市标识的形状：小写拉丁字母，长度有界（会进域名的第一段标签）。 */
export const SITE_CITY_PATTERN = SITE_KEY_PATTERN

export interface CityResolution {
  ok: boolean
  /** 可安全放进域名的城市标识（失败时为空串）。 */
  code: string
  error: string
}

/** 收窄一个城市值。 */
export function validateSiteCity(value: unknown): CityResolution {
  const raw = text(value).trim()
  if (raw === '') return { ok: false, code: '', error: '城市标识为空' }
  // 非 ASCII（中文城市名是最常见的一种）不能进域名：它必须先经 `resolveBusinessCity` 解析成标识。
  if (!/^[\x20-\x7e]+$/.test(raw)) {
    return {
      ok: false, code: '',
      error: `城市标识「${raw}」含非 ASCII 字符：它会进入站点域名，必须换成站点自己的城市标识（例如 bj / sh）`,
    }
  }
  const lower = raw.toLowerCase()
  if (!SITE_CITY_PATTERN.test(lower)) {
    return {
      ok: false, code: '',
      error: `城市标识「${raw}」不是合法的站点城市标识（只允许 2~10 个小写字母）`,
    }
  }
  return { ok: true, code: lower, error: '' }
}

/** 一条选例规则里与城市有关的部分（业务值来自知识快照）。 */
export interface CityRuleLike {
  /** 默认城市标识（对所有来源生效）。 */
  city: string
  /** 按来源覆盖的城市标识（同一城市在不同站点的写法可能不同）。 */
  cityByProvider?: Record<string, string>
}

/**
 * 解析某个来源这次要用的城市标识。
 *
 * 顺序：来源覆盖 → 默认 → 失败。**不做拼音转换、不做模糊匹配** ——
 * 猜出来的标识会安静地指向另一个城市，而结果页看起来完全正常。
 */
export function resolveSiteCity(rule: CityRuleLike | null, providerId: string): CityResolution {
  if (rule === null) return { ok: false, code: '', error: '没有可用的选例规则：拿不到城市标识' }
  const override = rule.cityByProvider?.[text(providerId)]
  const candidate = text(override) !== '' ? override : rule.city
  const resolved = validateSiteCity(candidate)
  if (!resolved.ok) {
    return {
      ok: false, code: '',
      error: `${resolved.error}（来源 ${text(providerId) || '(空)'}）`,
    }
  }
  return resolved
}

/** 候选（站点公布的城市名 → 标识），用于 `unresolved` 时让调用方改用列表里的名字。 */
export interface CityCandidate {
  name: string
  key: string
}

export type ResolveBusinessCityOptions = LoadCityListOptions

export interface BusinessCityResolution {
  /**
   * 显式状态：调用方据此判断"能不能拼 URL"以及**该怎么处置**，不靠 `reason` 是否为空。
   *
   * - `resolved`：拿到可安全放进域名的标识；
   * - `not-covered`：**站点自己公布的列表里没有这个城市** —— 这是"该来源不覆盖"，
   *   要按来源处置（跳过这一家、继续替代来源），**不是**整个业务输入非法；
   * - `invalid`：提交的城市值本身不可用（空 / 形状不合规）—— 这是调用方的输入问题；
   * - `unavailable`：城市列表读不出来（网络 / 页面）—— 基础设施问题，不是"没有这个城市"。
   */
  status: 'resolved' | 'not-covered' | 'invalid' | 'unavailable'
  ok: boolean
  /** 提交的原值（原样回显，便于对账）。 */
  input: string
  /** 可安全放进域名的站点城市标识；未解析时为空串。 */
  code: string
  /** 怎么得到这个标识的。 */
  via: 'site-key' | 'published-list' | ''
  /** 未解析时的人话原因。 */
  reason: string
  /** 未解析时可重试的候选（来自站点公布的城市列表）。 */
  candidates: readonly CityCandidate[]
  /** 需要查阅的城市列表页。 */
  page: string
}

/** `北京市` / `三亚市` 这类行政后缀：只去掉一个尾字，不做别的猜测。 */
function withoutCitySuffix(name: string): string {
  return name.length > 2 && name.endsWith('市') ? name.slice(0, -1) : name
}

function candidatesOf(entries: readonly CityListEntry[]): CityCandidate[] {
  return entries.map((entry) => ({ name: entry.name, key: entry.key }))
}

function resolved(input: string, code: string, via: 'site-key' | 'published-list', page: string): BusinessCityResolution {
  return { status: 'resolved', ok: true, input, code, via, reason: '', candidates: [], page }
}

function notResolved(
  status: 'not-covered' | 'invalid' | 'unavailable',
  input: string,
  reason: string,
  page: string,
  candidates: readonly CityCandidate[] = [],
): BusinessCityResolution {
  return { status, ok: false, input, code: '', via: '', reason, candidates, page }
}

/**
 * 把提交的业务城市解析成站点城市标识。
 *
 * - 已经是站点标识（`bj` / `BJ`）→ 原样通过，**不取数**（现有调用方与测试不受影响）；
 * - 业务城市名（`北京`）→ 从站点公布的城市列表解析；
 * - 未知 / 歧义 / 页面读不到 → `unresolved` + 候选清单 + 要查阅的页面。
 *
 * 返回失败而不是抛错：城市解析不出来是**必须让调用方看见并处置**的状态，不能吞成"没有案例"。
 */
export async function resolveBusinessCity(
  value: unknown,
  options: ResolveBusinessCityOptions = {},
): Promise<BusinessCityResolution> {
  const raw = text(value).trim()
  const page = text(options.page).trim() || LIANJIA_CITY_LIST_PAGE
  if (raw === '') {
    return notResolved('invalid', raw, `城市为空：请提交业务城市（例如 北京）`, page)
  }
  // 纯 ASCII 就是"已经给了站点标识"：形状闸门通过就放行，不打网络。
  if (/^[\x20-\x7e]+$/.test(raw)) {
    const shaped = validateSiteCity(raw)
    if (shaped.ok) return resolved(raw, shaped.code, 'site-key', page)
    return notResolved('invalid', raw, `${shaped.error}；请提交业务城市（例如 北京）`, page)
  }

  const loaded = await loadCityList(options)
  if (!loaded.ok) {
    return notResolved('unavailable', raw,
      `${loaded.error}；请直接用该站点的城市标识（例如 bj），或核对 ${page}`, page)
  }
  const snapshot = loaded.snapshot
  const wanted = [raw, withoutCitySuffix(raw)]
  const matched = snapshot.entries.filter((entry) => wanted.includes(entry.name))
  const keys: string[] = []
  for (const entry of matched) if (!keys.includes(entry.key)) keys.push(entry.key)
  if (keys.length === 1) {
    return resolved(raw, keys[0], 'published-list', snapshot.page)
  }
  if (keys.length === 0) {
    // **"该来源不覆盖"**：这是链家自己公布的列表，没有这个城市 = 链家不做这个地区。
    // 处置是"这一家跳过、改用替代来源"，不是"整个业务输入非法"。
    return notResolved(
      'not-covered',
      raw,
      `城市「${raw}」不在 ${snapshot.page} 公布的列表里：**该来源不覆盖这个地区**，`
      + '本轮跳过这一家、改用其他来源；提交站点城市标识（例如 bj）也可以，但不要擅自换成别的城市。',
      snapshot.page,
      candidatesOf(snapshot.entries),
    )
  }
  return notResolved(
    'not-covered',
    raw,
    `城市「${raw}」在 ${snapshot.page} 上对应多个城市标识（${keys.join(' / ')}），无法确定是哪一个：`
      + '**该来源无法确定地区**，本轮跳过这一家；请直接提交站点城市标识',
    snapshot.page,
    candidatesOf(snapshot.entries),
  )
}

/**
 * 某个来源能不能用这次解析出来的城市。
 *
 * 这是"**各来源独立解析地区**"的落点（协议 39）：判定交给 `city-sources.ts` 那张逐来源登记表。
 *
 * - 解析成功 → 所有来源都能用这个标识（它已经过形状闸门，可以安全放进 URL）；
 * - **该来源不覆盖** → 只有**自己那份城市表已适配**的来源才可能得到这个结论
 *   （目前只有链家），处置是跳过它、改用替代来源；
 * - **尚未适配** → 能力缺口（"我们还没接这张表"），**不能**写成"该来源不覆盖这个地区"：
 *   那会让员工以为这家不做这个地区，从此不再尝试它。
 *
 * 返回 `not-covered` / `unsupported` 时**不要**给它拼 URL：换一个城市是编造，而"用错城市"
 * 的结论看起来完全正常。
 */
export function providerCityStatus(
  resolution: BusinessCityResolution,
  providerId: string,
  options: { coveredBy?: string } = {},
): { status: 'ok' | 'not-covered' | 'unsupported'; code: string; reason: string; sourcePage: string; evidence: string } {
  if (resolution.status === 'resolved') {
    return { status: 'ok', code: resolution.code, reason: '', sourcePage: '', evidence: '' }
  }
  // 输入非法 / 城市表读不出来：对所有来源都是同一件事，如实说清（不是"这家不做这个地区"）。
  if (resolution.status === 'invalid' || resolution.status === 'unavailable') {
    return { status: 'unsupported', code: '', reason: resolution.reason, sourcePage: '', evidence: '' }
  }
  // `not-covered`：把"哪一份列表里没有它"交给逐来源判定。
  return providerCityVerdict({
    providerId,
    resolvedCode: '',
    uncovered: true,
    coveredBy: text(options.coveredBy) || 'lianjia',
    input: resolution.input,
  })
}

/** 城市标识是否可以安全地放进域名（调用方拼 URL 前的最后一道）。 */
export function isSafeCityCode(value: unknown): boolean {
  return SITE_CITY_PATTERN.test(text(value))
}
