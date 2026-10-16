import { text } from '../../../../shared/utils/value.ts'
import {
  BOUNDARY_REFUSAL_TEXT, addressInText, addressKindOf, looksLikeCaptcha, looksLikeLoginWall,
  normalizeHostAddress, networkPhaseOfErrorCode, noNetworkFacts,
  type NetworkAddressKind, type NetworkFacts, type NetworkPhase, type NetworkRefusedBy,
} from './login-probe.ts'
import type { MarketFailureKind, MarketFetchResult, MarketTransport } from './provider.ts'

/**
 * 默认的**抓取通道**：全局 `fetch`，不读 Cookie、不带凭据、不伪装身份。
 *
 * ## 三条边界（都在这里落定，调用方不能绕过）
 *
 * 1. **不接受调用方提交的 URL**：URL 由 `providers.ts` 的模板拼出来，模型只能提交
 *    来源 id + 关键字 + 城市 + 页数。所以这一层拿到的都是白名单站点的 URL。
 * 2. **不跟随到别的站点**：重定向的最终 URL 落在别的 host 时如实记 `error` 并当失败 ——
 *    否则一个 302 就能把插件带到任意站点（那是白名单的漏口）。
 * 3. **不绕过任何验证**：识别到验证码 / 登录墙只**标记**，交给上层决定"提示用户人工处理"。
 *    换 UA、打码、代填一律不做。
 *
 * 响应体有上限：一个页面几百 KB 是常态，但被投喂几十 MB 的响应会把进程拖住。
 *
 * ## Structured network facts on failure
 *
 * A real search.fang.com failure could not be attributed to the site, DNS, a proxy or a local
 * boundary from a bare "network error". Every failure therefore carries `network`
 * (error code / phase / address kind / refusing boundary) next to the login and captcha
 * facts. The facts come from the thrown error itself (`cause` chain, `AggregateError`,
 * code and address fields); no extra DNS lookup is performed.
 */

/** 单个响应的读取上限（字符数）。 */
export const MARKET_BODY_MAX = 4 * 1024 * 1024

export interface FetchTransportOptions {
  /** 允许访问的 host 后缀（白名单；空数组 = 不限制，**只用于测试**）。 */
  allowedHosts?: readonly string[]
  /** 读取上限（字符数）。 */
  bodyMax?: number
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** User-Agent。默认明确标注为工作台抓取，**不伪装成浏览器**。 */
  userAgent?: string
}

export const MARKET_USER_AGENT = 'crwu-workbench/valuation (+https://example.invalid/crwu)'

/** host 是否在允许清单里（后缀匹配，避免 `evil-fang.com` 命中 `fang.com` 的错觉）。 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  const target = text(host).toLowerCase()
  return allowed.some((suffix) => {
    const want = text(suffix).toLowerCase()
    if (want === '') return false
    return target === want || target.endsWith(`.${want}`)
  })
}

/**
 * 由一次响应的**事实**推出失败类别（`''` = 成功）。
 *
 * 顺序即优先级：**验证码 > 登录墙 > 状态码**。验证码放最前是因为被验证码挡住时页面里
 * 往往也带着登录表单的痕迹，把它说成"需要登录"会让用户反复登录而永远过不去。
 */
export function classifyFetchFailure(facts: {
  ok: boolean
  status: number
  captcha?: boolean
  loginRequired?: boolean
}): MarketFailureKind {
  if (facts.ok) return ''
  if (facts.captcha === true) return 'captcha'
  if (facts.loginRequired === true) return 'login'
  if (facts.status === 429 || facts.status === 403) return 'rate-limited'
  if (facts.status === 401) return 'login'
  if (facts.status === 404 || facts.status === 410) return 'not-found'
  if (facts.status >= 500 || facts.status === 0) return 'server-error'
  return 'unknown'
}

/** 失败类别的人话（写进重试记录与缺口，让事后能分清"站点没有案例"与"被风控拦了"）。 */
export function failureKindLabel(kind: MarketFailureKind): string {
  switch (kind) {
    case 'login': return '需要登录'
    case 'captcha': return '验证码 / 人机校验'
    case 'rate-limited': return '被限流或被风控拦下'
    case 'not-found': return '页面失效'
    case 'server-error': return '站点返回错误'
    case 'network': return '网络错误或超时'
    case 'blocked': return '被拦到白名单之外'
    case 'unreadable': return '响应读不出来'
    case 'unknown': return '无法判断的失败'
    default: return ''
  }
}

/** 从 URL 里取 host（失败返回空串）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch (error) {
    void error
    return ''
  }
}

/** Result plus network facts (an additive extension; no existing key of `MarketFetchResult` changes). */
export type MarketFetchResultWithNetwork = MarketFetchResult & { network: NetworkFacts }

/** Facts for a completed request (a body was read), success or failure alike. */
export function networkFactsOk(host = ''): NetworkFacts {
  return { ...noNetworkFacts(true), source: 'transport', host }
}

/** Facts of a local boundary refusal (host allow-list / deployment non-public-address boundary). */
export function networkFactsOfBoundary(
  host: string, refusedBy: NetworkRefusedBy, address = host,
): NetworkFacts {
  const addr = normalizeHostAddress(address)
  return {
    ...noNetworkFacts(false), source: 'transport', phase: 'boundary',
    addressKind: addressKindOf(addr), address: addr, host, refusedBy,
  }
}

/** Facts of a phase failure (redirect / body read). */
function networkFactsOfPhase(phase: NetworkPhase, host: string, address = ''): NetworkFacts {
  const addr = normalizeHostAddress(address)
  return {
    ...noNetworkFacts(false), source: 'transport', phase,
    addressKind: addressKindOf(addr), address: addr, host,
  }
}

interface ErrorProbe {
  name: string
  code: string
  message: string
  address: string
}

/**
 * Flatten an error object into a chain: `cause` links plus `AggregateError.errors`.
 *
 * undici wraps the real reason in `TypeError: fetch failed` (`ENOTFOUND` /
 * `UND_ERR_CONNECT_TIMEOUT` / `ECONNREFUSED` live on `cause`), so reading only the outer
 * error records every failure the same way. Bounded: depth 4, at most 8 entries.
 */
function probeErrors(root: unknown): ErrorProbe[] {
  const out: ErrorProbe[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 4 || seen.has(value) || out.length >= 8) return
    seen.add(value)
    const record = value as Record<string, unknown>
    out.push({
      name: text(record.name),
      code: text(record.code),
      message: text(record.message),
      address: text(record.address),
    })
    if (Array.isArray(record.errors)) for (const one of record.errors.slice(0, 8)) visit(one, depth + 1)
    visit(record.cause, depth + 1)
  }
  visit(root, 0)
  return out
}

/** Structured facts of one fetch failure (code / phase / address / refusing boundary). */
export function networkFactsFromError(error: unknown, context: { host?: string } = {}): NetworkFacts {
  const host = text(context.host)
  const probes = probeErrors(error)
  const outerText = error instanceof Error ? `${error.name} ${error.message}` : text(error)
  const messages = [outerText, ...probes.map((one) => one.message)].join(' ')
  const codes = [text((error as { code?: unknown } | null)?.code), ...probes.map((one) => one.code)]
    .filter((one) => one !== '')

  const boundary = BOUNDARY_REFUSAL_TEXT.test(messages)
  const addressed = probes.find((one) => one.address !== '')?.address ?? ''
  const address = addressed !== '' ? addressed : addressInText(messages)
  const carried = codes.find((one) => networkPhaseOfErrorCode(one) !== '') ?? ''
  const codePhase = networkPhaseOfErrorCode(carried)
  const named = probes.find((one) => one.name === 'AbortError' || one.name.endsWith('TimeoutError'))
  const phase: NetworkPhase = boundary ? 'boundary' : codePhase !== '' ? codePhase : named === undefined ? 'unknown' : 'timeout'
  const chosen = probes.find((one) => one.code !== '' && one.code === carried)
    ?? probes.find((one) => one.name !== '')
  return {
    ok: false,
    source: 'transport',
    errorCode: carried,
    errorName: chosen?.name !== undefined && chosen.name !== '' ? chosen.name : error instanceof Error ? error.name : '',
    phase,
    addressKind: addressKindOf(address),
    address,
    host,
    refusedBy: boundary ? 'network-boundary' : '',
  }
}

/** Non-public check, so "boundary refused a local/private address" stays distinct from "host not listed". */
function isNonPublicAddressKind(kind: NetworkAddressKind): boolean {
  return kind === 'private' || kind === 'loopback' || kind === 'link-local' || kind === 'reserved'
}

export function fetchTransport(options: FetchTransportOptions = {}): MarketTransport {
  const allowed = options.allowedHosts ?? []
  const bodyMax = options.bodyMax ?? MARKET_BODY_MAX
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const userAgent = options.userAgent ?? MARKET_USER_AGENT

  return async (url: string, { signal }: { signal?: AbortSignal } = {}): Promise<MarketFetchResultWithNetwork> => {
    const empty = (network: NetworkFacts): Omit<MarketFetchResultWithNetwork, 'error'> => ({
      ok: false, status: 0, body: '', contentType: '', url, loginRequired: false, captcha: false,
      failureKind: 'blocked' as MarketFailureKind, network,
    })
    const host = hostOf(url)
    // Invalid URL: refused locally, but the exact boundary cannot be named.
    if (host === '') {
      return { ...empty(networkFactsOfBoundary('', '')), error: `不是一条合法的 URL：${url}` }
    }
    if (!hostAllowed(host, allowed)) {
      const kind = addressKindOf(host)
      return {
        ...empty(networkFactsOfBoundary(host, 'host-allow-list')),
        // Name the local boundary refusal instead of blaming the site.
        error: isNonPublicAddressKind(kind)
          ? `本地边界拒绝了本机 / 内网地址：${host}（不在允许清单里）`
          : `目标站点不在允许清单里：${host}`,
      }
    }
    if (typeof doFetch !== 'function') {
      return {
        ...empty({ ...noNetworkFacts(false), source: 'transport', phase: 'unknown', host }),
        error: '本部署没有可用的 fetch：无法访问外部来源',
      }
    }

    let response: Response
    try {
      response = await doFetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          // 明确标注抓取来源，不伪装浏览器：站点要封就封这个 UA，那是它自己的判断。
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      const network = networkFactsFromError(error, { host })
      return {
        ...empty(network), failureKind: 'network',
        // A boundary refusal is not a "network error"; saying so keeps the follow-up honest.
        error: `${network.refusedBy === '' ? '请求失败（网络错误或超时）' : '请求被本地边界拒绝'}：${
          error instanceof Error ? error.message : String(error)}`,
      }
    }

    // 重定向到白名单之外 → 失败（见边界 2）。
    const finalUrl = text((response as { url?: unknown }).url) || url
    const finalHost = hostOf(finalUrl)
    if (finalHost !== '' && !hostAllowed(finalHost, allowed)) {
      return {
        ...empty(networkFactsOfPhase('redirect', host, finalHost)), status: response.status,
        error: `页面被重定向到允许清单之外的站点：${finalHost}`,
      }
    }

    let body = ''
    try {
      body = (await response.text()).slice(0, bodyMax)
    } catch (error) {
      return {
        ...empty(networkFactsOfPhase('read', host)), status: response.status, url: finalUrl,
        failureKind: 'unreadable',
        error: `读取响应失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const captcha = looksLikeCaptcha(body)
    const loginRequired = looksLikeLoginWall(body)
    const failureKind = classifyFetchFailure({ ok: response.ok, status: response.status, captcha, loginRequired })
    return {
      ok: response.ok,
      status: response.status,
      body,
      contentType: text(response.headers?.get?.('content-type')),
      url: finalUrl,
      loginRequired,
      captcha,
      failureKind,
      // 失败信息里带上类别：两次重试的记录因此可区分（§7.3），而不是两行一样的"HTTP 403"。
      error: response.ok ? '' : `${failureKindLabel(failureKind)}（HTTP ${String(response.status)}）`,
      // A response arrived: a site-side status / challenge is not a network fact (and vice versa).
      network: networkFactsOk(host),
    }
  }
}
