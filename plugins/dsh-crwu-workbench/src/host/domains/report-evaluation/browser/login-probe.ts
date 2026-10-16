import { text } from '../../../../shared/utils/value.ts'
import type { LoginState } from './login-state.ts'

/**
 * `LoginState` 在**外部案例来源**上的确切含义。
 *
 * 这三个字读起来像"插件知道你的账号有没有登录"，而事实是：插件**不读 Cookie、不碰凭据**，
 * 所以它无法知道账号状态。这里回答的是另一个问题 —— **站点是否放行公开检索**：
 *
 * | `state` | 含义（**只是访问结论**） | 用户能做什么 |
 * | --- | --- | --- |
 * | `authenticated` | 公开检索页放行（200 且没有登录墙 / 验证码特征） | 什么都不用做 |
 * | `unauthenticated` | 被登录墙挡住 | 用默认浏览器登录该站，再点「重新检查」 |
 * | `unknown` | 网络不可达、超时、要求验证码、站点错误 | 看详情按**真实类别**处置 |
 *
 * ## ⚠️ `authenticated` 不是"已登录"
 *
 * 「公开页返回 200」只说明**这一页可访问**。把它读成"凭据有效 / 账号已登录"会直接导致两种
 * 错误做法：拿状态当凭据事实去"修账号"，以及把验证码挡住说成"你没登录"。
 *
 * 所以 `classifyProbe` 把一次探测拆成**三件彼此独立的事实**（设计稿 §11.2）：
 *
 * 1. `login`：登录/凭据事实 —— 只有页面**明确**是登录墙才敢说 `signed-out`；
 * 2. `readability`：当前页可读性 —— 这一页到底读到了什么；
 * 3. `retrieval`：本次检索能力 —— 这一次探测支不支持发起检索。
 *
 * `state` 只是这三条派生出来的**访问结论**，供面板门禁继续使用（线协议仍是三态）。
 */

/** 判定用的特征串（命中任一即认为页面要求人工介入）。 */
const LOGIN_WALL_PATTERNS = [
  /请先登录/, /登录后查看/, /立即登录/, /用户登录/, /passport\./i,
  /sign\s*in\s*to\s*continue/i, /please\s*log\s*in/i, /登录可见/,
]

const CAPTCHA_PATTERNS = [
  /验证码/, /滑动验证/, /安全验证/, /人机验证/, /captcha/i, /geetest/i, /verify\s*you\s*are\s*human/i,
]

/** 页面看起来要求登录（登录墙）。 */
export function looksLikeLoginWall(body: unknown): boolean {
  const html = text(body)
  if (html === '') return false
  return LOGIN_WALL_PATTERNS.some((pattern) => pattern.test(html))
}

/** 页面看起来要求验证码 / 人机校验。 */
export function looksLikeCaptcha(body: unknown): boolean {
  const html = text(body)
  if (html === '') return false
  return CAPTCHA_PATTERNS.some((pattern) => pattern.test(html))
}

// ── ④ Network / DNS facts, kept apart from login and captcha facts ─────────
//
// A real run could not tell whether search.fang.com was unreachable because of the site, DNS, a
// proxy, or a local boundary. Only what the transport reports is recorded: error code,
// phase, address kind, refusing boundary. A missing address stays missing, and no
// boundary is relaxed to make a case pass.

/** Which phase failed (`''` = the network layer did not fail, or there are no facts). */
export type NetworkPhase =
  | '' | 'dns' | 'connect' | 'tls' | 'timeout' | 'boundary' | 'redirect' | 'read' | 'unknown'

/** Address kind, decided from literal addresses only; no DNS result is guessed. */
export type NetworkAddressKind = '' | 'public' | 'private' | 'loopback' | 'link-local' | 'reserved' | 'unknown'

/** Which local boundary refused (`''` = not a boundary refusal). */
export type NetworkRefusedBy = '' | 'host-allow-list' | 'network-boundary'

/** Network facts of one fetch (structured; `host` is a host name, never a full URL). */
export interface NetworkFacts {
  /**
   * Whether the network layer completed (a body was read).
   *
   * With `source: 'none'` it only means "no network failure was recorded", not "the
   * network was proven to work".
   */
  ok: boolean
  /** Where the facts come from: transport / recovered from text / none. */
  source: 'transport' | 'derived' | 'none'
  /** Error code, e.g. `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT`. */
  errorCode: string
  /** Error name, e.g. `AbortError` / `ConnectTimeoutError`. */
  errorName: string
  phase: NetworkPhase
  addressKind: NetworkAddressKind
  /** Resolved (or boundary-refused) address; empty when it is not available. */
  address: string
  host: string
  refusedBy: NetworkRefusedBy
}

/** No network facts at all (neither success nor failure was observed). */
export function noNetworkFacts(ok = true): NetworkFacts {
  return {
    ok, source: 'none', errorCode: '', errorName: '', phase: '',
    addressKind: '', address: '', host: '', refusedBy: '',
  }
}

const NETWORK_PHASES: readonly NetworkPhase[] = [
  '', 'dns', 'connect', 'tls', 'timeout', 'boundary', 'redirect', 'read', 'unknown',
]
const ADDRESS_KINDS: readonly NetworkAddressKind[] = [
  '', 'public', 'private', 'loopback', 'link-local', 'reserved', 'unknown',
]
const REFUSED_BY: readonly NetworkRefusedBy[] = ['', 'host-allow-list', 'network-boundary']

/** Phase wording; single source for both the clause and its reader. */
const PHASE_LABELS: Record<Exclude<NetworkPhase, ''>, string> = {
  dns: 'DNS 解析失败',
  connect: '连接失败（解析到的地址连不上）',
  tls: 'TLS / 证书失败',
  timeout: '请求超时或被中止',
  boundary: '被本地边界拒绝',
  redirect: '被重定向到允许清单之外的站点',
  read: '响应读取失败',
  unknown: '传输层失败，阶段无法判定',
}

/** Address-kind wording; single source. `reserved` covers 198.18.0.0/15 (proxy fake-IP). */
const ADDRESS_KIND_LABELS: Record<Exclude<NetworkAddressKind, ''>, string> = {
  public: '公网',
  private: '内网',
  loopback: '回环',
  'link-local': '链路本地',
  reserved: '保留 / 基准测试网段',
  unknown: '无法判定',
}

/** Boundary wording; single source. */
const REFUSED_BY_LABELS: Record<Exclude<NetworkRefusedBy, ''>, string> = {
  'host-allow-list': '允许清单边界',
  'network-boundary': '非公网地址边界',
}

/** Fixed prefix of the network-fact clause (the receipt is read back through it). */
export const NETWORK_FACT_PREFIX = '网络/DNS 事实：'

/** Fixed ending that marks the clause as NOT a login or captcha fact. */
export const NETWORK_FACT_SUFFIX = '；这不是登录或验证码事实。'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Kind(octets: readonly number[]): NetworkAddressKind {
  const [a, b, c] = octets
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'
  // RFC 2544 benchmarking range: the default fake-IP range of mihomo-style proxies.
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'
  if (a === 192 && b === 0 && c === 2) return 'reserved'
  if (a === 198 && b === 51 && c === 100) return 'reserved'
  if (a === 203 && b === 0 && c === 113) return 'reserved'
  if (a === 0 || a >= 224) return 'reserved'
  return 'public'
}

function ipv6Kind(value: string): NetworkAddressKind {
  const lower = value.toLowerCase()
  if (!lower.includes(':') || !/^[0-9a-f:]+$/.test(lower)) return ''
  if ((lower.match(/::/g) ?? []).length > 1) return ''
  const groups = lower.split(':').filter((one) => one !== '')
  if (groups.some((one) => one.length > 4)) return ''
  if (lower.includes('::') ? groups.length > 7 : groups.length !== 8) return ''
  if (lower === '::1') return 'loopback'
  if (lower === '::') return 'reserved'
  if (/^fe[89ab]/.test(lower)) return 'link-local'
  if (/^f[cd]/.test(lower)) return 'private'
  if (/^2001:db8/.test(lower)) return 'reserved'
  return 'public'
}

/**
 * Normalize `host[:port]` (including `[v6]:port` and `%zone`) down to the address.
 *
 * `URL.host` carries the port, but the address kind is about the address:
 * `127.0.0.1:8080` must still read as loopback.
 */
export function normalizeHostAddress(value: unknown): string {
  const raw = text(value).trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw)
  if (bracketed !== null) return bracketed[1].split('%')[0]
  const withPort = /^([^:]+):\d{1,5}$/.exec(raw)
  if (withPort !== null) return withPort[1]
  return raw.split('%')[0]
}

/** Kind of a literal address; a domain, an empty or a broken address stays `''` / `unknown`. */
export function addressKindOf(value: unknown): NetworkAddressKind {
  const raw = normalizeHostAddress(value)
  if (raw === '') return ''
  const v4 = IPV4.exec(raw)
  if (v4 !== null) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map((one) => Number(one))
    if (octets.some((one) => one > 255)) return 'unknown'
    return ipv4Kind(octets)
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped !== null) return addressKindOf(mapped[1])
  return ipv6Kind(raw)
}

const IPV4_IN_TEXT = /(?:\d{1,3}\.){3}\d{1,3}/
const IPV6_IN_TEXT = /[0-9a-f]*:[0-9a-f:]*:[0-9a-f:]*/i

/** First literal address in a text (empty when there is none; a host name is never guessed). */
export function addressInText(value: unknown): string {
  const raw = text(value)
  const v4 = IPV4_IN_TEXT.exec(raw)
  if (v4 !== null && addressKindOf(v4[0]) !== '' && addressKindOf(v4[0]) !== 'unknown') return v4[0]
  const v6 = IPV6_IN_TEXT.exec(raw)
  if (v6 !== null) {
    const candidate = v6[0].replace(/^\[|\]$/g, '')
    const kind = addressKindOf(candidate)
    if (kind !== '' && kind !== 'unknown') return candidate
  }
  return ''
}

function isPhase(value: unknown): value is NetworkPhase {
  return (NETWORK_PHASES as readonly string[]).includes(text(value))
}

function isAddressKind(value: unknown): value is NetworkAddressKind {
  return (ADDRESS_KINDS as readonly string[]).includes(text(value))
}

function isRefusedBy(value: unknown): value is NetworkRefusedBy {
  return (REFUSED_BY as readonly string[]).includes(text(value))
}

/**
 * Narrow network facts of any shape into `NetworkFacts`.
 *
 * The facts ride on the transport result, whose shape belongs to another module; no
 * unvalidated field is trusted (a wrong `phase` becomes a wrong line in a report).
 */
export function readNetworkFacts(source: unknown): NetworkFacts | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return undefined
  const carried = text(record.source)
  return {
    ok: record.ok,
    source: carried === 'transport' || carried === 'derived' ? carried : 'none',
    errorCode: text(record.errorCode),
    errorName: text(record.errorName),
    phase: isPhase(record.phase) ? (text(record.phase) as NetworkPhase) : '',
    addressKind: isAddressKind(record.addressKind) ? (text(record.addressKind) as NetworkAddressKind) : '',
    address: text(record.address),
    host: text(record.host),
    refusedBy: isRefusedBy(record.refusedBy) ? (text(record.refusedBy) as NetworkRefusedBy) : '',
  }
}

/** Human clause for the facts (empty without a failure, so normal receipts stay quiet). */
export function networkFactClause(network: NetworkFacts | undefined): string {
  if (network === undefined || network.ok) return ''
  const phase = network.phase === '' ? 'unknown' : network.phase
  const parts = [PHASE_LABELS[phase]]
  if (network.errorCode !== '') parts.push(`错误码 ${network.errorCode}`)
  if (network.address !== '') parts.push(`地址 ${network.address}`)
  if (network.addressKind !== '') parts.push(`地址类别 ${ADDRESS_KIND_LABELS[network.addressKind]}`)
  if (network.host !== '' && network.host !== network.address) parts.push(`主机 ${network.host}`)
  if (network.refusedBy !== '') parts.push(`边界 ${REFUSED_BY_LABELS[network.refusedBy]}`)
  return `${NETWORK_FACT_PREFIX}${parts.join('；')}${NETWORK_FACT_SUFFIX}`
}

/**
 * Read the network facts back out of the detail clause.
 *
 * Same reason as {@link probeCategoryOfDetail}: the Tool output contract is frozen, so the
 * structured field cannot travel and the clause must. Labels come from the single-source
 * tables (`PHASE_LABELS` / `ADDRESS_KIND_LABELS` / `REFUSED_BY_LABELS`).
 */
export function networkFactsOfDetail(detail: unknown): NetworkFacts | undefined {
  const raw = text(detail)
  const at = raw.indexOf(NETWORK_FACT_PREFIX)
  if (at < 0) return undefined
  const body = raw.slice(at + NETWORK_FACT_PREFIX.length).split(NETWORK_FACT_SUFFIX)[0]
  const segments = body.split('；').map((one) => one.trim()).filter((one) => one !== '')
  if (segments.length === 0) return undefined
  const network: NetworkFacts = { ...noNetworkFacts(false), source: 'derived', phase: 'unknown' }
  const label = segments[0]
  const phase = (Object.keys(PHASE_LABELS) as Array<Exclude<NetworkPhase, ''>>)
    .find((key) => PHASE_LABELS[key] === label)
  if (phase !== undefined) network.phase = phase
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('错误码 ')) network.errorCode = segment.slice(4).trim()
    else if (segment.startsWith('地址类别 ')) {
      const kind = (Object.keys(ADDRESS_KIND_LABELS) as Array<Exclude<NetworkAddressKind, ''>>)
        .find((key) => ADDRESS_KIND_LABELS[key] === segment.slice(5).trim())
      if (kind !== undefined) network.addressKind = kind
    } else if (segment.startsWith('地址 ')) network.address = segment.slice(3).trim()
    else if (segment.startsWith('主机 ')) network.host = segment.slice(3).trim()
    else if (segment.startsWith('边界 ')) {
      const refused = (Object.keys(REFUSED_BY_LABELS) as Array<Exclude<NetworkRefusedBy, ''>>)
        .find((key) => REFUSED_BY_LABELS[key] === segment.slice(3).trim())
      if (refused !== undefined) network.refusedBy = refused
    }
  }
  return network
}

/** ① **登录 / 凭据事实**。 */
export type LoginFact = 'signed-out' | 'not-observed'

/** ② **当前页可读性**。 */
export type PageReadability = 'readable' | 'blocked' | 'unreachable'

/** ③ **本次检索能力**。 */
export type RetrievalAbility =
  | 'public-page-ok'
  | 'needs-login'
  | 'needs-challenge'
  | 'unreachable'
  | 'http-error'

/** 一次探测的类别（**判据只有这一处**）。 */
export type ProbeCategory = 'unreachable' | 'needs-challenge' | 'needs-login' | 'http-error' | 'public-page-ok'

/**
 * 每个类别的固定说明。
 *
 * `detail` / `nextAction` 都从这一份生成，**回认类别时也只认这一份**：
 * 这样"这一页为什么不可用"就只有一个判据，不会出现"生成文案的地方改了、按文案分流的地方没改"。
 */
export const PROBE_TEXTS: Record<ProbeCategory, {
  detail: string
  nextAction: string
  login: LoginFact
  readability: PageReadability
  retrieval: RetrievalAbility
  captcha: boolean
}> = {
  unreachable: {
    detail: '无法访问该来源：网络不可达或超时',
    nextAction: '检查本机网络 / 代理后点「重新检查」；这不是登录问题。',
    login: 'not-observed', readability: 'unreachable', retrieval: 'unreachable', captcha: false,
  },
  'needs-challenge': {
    detail: '该来源要求验证码 / 人机校验：请在默认浏览器打开该站点并人工完成，然后点「重新检查」。插件不会绕过验证。',
    nextAction: '在默认浏览器打开该站点人工完成验证，然后点「重新检查」；**不要**把它当登录失败。',
    login: 'not-observed', readability: 'readable', retrieval: 'needs-challenge', captcha: true,
  },
  'needs-login': {
    detail: '该来源提示需要登录后才能检索：请在默认浏览器登录后点「重新检查」。',
    nextAction: '在默认浏览器登录该来源，然后点「重新检查」。',
    login: 'signed-out', readability: 'blocked', retrieval: 'needs-login', captcha: false,
  },
  'http-error': {
    detail: '该来源返回了错误状态码',
    nextAction: '等站点恢复或按状态码排查后点「重新检查」；这不是登录问题。',
    login: 'not-observed', readability: 'blocked', retrieval: 'http-error', captcha: false,
  },
  'public-page-ok': {
    detail: '公开检索页正常返回：这只说明该页可访问，**不代表**账号已登录，也不代表本次检索一定能取到房源。',
    nextAction: '无需登录动作；直接发起检索，检索结果按实际页面分类。',
    login: 'not-observed', readability: 'readable', retrieval: 'public-page-ok', captcha: false,
  },
}

/**
 * 由**说明文案**回认类别。
 *
 * `providers.ts` 的 `preflight()` 只回"访问结论 + 说明"，三条独立事实无法从它那里直接拿到；
 * 而说明**只能**由 {@link PROBE_TEXTS} 生成，所以这里按同一份文案回认是可靠的 ——
 * 它不是"猜错误原因"，而是把已经丢掉的类别从唯一来源里取回来。
 */
export function probeCategoryOfDetail(detail: unknown): ProbeCategory | '' {
  const raw = text(detail)
  if (raw === '') return ''
  // 前缀而不是全等：网络类说明会把真实原因（错误文本）接在后面。
  if (raw.startsWith(UNREACHABLE_PREFIX)) return 'unreachable'
  for (const category of ['needs-challenge', 'needs-login', 'public-page-ok'] as const) {
    if (raw === PROBE_TEXTS[category].detail) return category
  }
  if (raw.startsWith(HTTP_ERROR_PREFIX) || raw.startsWith('没有拿到 HTTP 状态码')) return 'http-error'
  return ''
}

export interface ProbeFacts {
  ok: boolean
  status: number
  body: string
  error?: string
  /** ④ Network / DNS facts (captured by the transport; otherwise read back from known codes). */
  network?: NetworkFacts
}

export interface ProbeVerdict {
  /** ① 登录 / 凭据事实（**不**把"公开页 200"说成已登录）。 */
  login: LoginFact
  /** ② 当前页可读性。 */
  readability: PageReadability
  /** ③ 本次检索能力。 */
  retrieval: RetrievalAbility
  /**
   * ④ Network / DNS facts, kept apart from login and captcha facts.
   *
   * `network.ok === false` means the failure happened in the network layer (DNS / connect /
   * timeout / TLS / local boundary), and then `login` is `not-observed` and `captcha` is
   * `false`: a network failure is never reported as "not logged in" or "needs a challenge".
   */
  network: NetworkFacts
  /**
   * 派生的**访问结论**（面板门禁继续用三态线协议；`providers.ts` 的既有调用点也读它）。
   *
   * `authenticated` 只表示"公开检索页放行"，**不表示**账号已登录 —— 需要"登录状态"时读 `login`。
   * 字段名沿用线协议的历史叫法；语义以本条注释与上面的表为准。
   */
  state: LoginState
  /** 这一页为什么可用 / 不可用（每个类别的固定说明）。 */
  detail: string
  /** 需要人工在浏览器完成验证（插件**不**做任何绕过）。 */
  captcha: boolean
  /** 按**真实类别**给的下一步（不一律"去登录"）。 */
  nextAction: string
}

/** 访问结论的人话（界面用；不写"已登录"）。 */
export function accessLabel(state: LoginState): string {
  switch (state) {
    case 'authenticated': return '公开页可访问'
    case 'unauthenticated': return '需要登录'
    default: return '无法检查'
  }
}

/** 访问结论（三态）→ Tool 回执里的明确取值（**刻意不叫** `authenticated`）。 */
export function accessVerdictOf(state: LoginState): 'public-page-open' | 'login-wall' | 'unknown' {
  return state === 'authenticated' ? 'public-page-open' : state === 'unauthenticated' ? 'login-wall' : 'unknown'
}

/** 网络类说明的固定前缀（真实原因接在后面，所以回认时按前缀）。 */
const UNREACHABLE_PREFIX = '无法访问该来源：'

/** 站点错误状态码说明的固定前缀。 */
const HTTP_ERROR_PREFIX = '该来源返回 HTTP '

/**
 * Known error codes to phases (single source: the transport and text recovery both read it).
 *
 * Only codes and exact boundary wording are recognized; a vague message yields `unknown`
 * rather than an invented phase.
 */
const ERROR_CODE_PHASES: ReadonlyArray<{ pattern: RegExp; phase: NetworkPhase }> = [
  { pattern: /^(ENOTFOUND|EAI_AGAIN|ENONAME|ENODATA)$/, phase: 'dns' },
  { pattern: /^(ERR_TLS_[A-Z_]+|CERT_[A-Z_]+)$/, phase: 'tls' },
  { pattern: /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/, phase: 'tls' },
  { pattern: /^(ETIMEDOUT|ESOCKETTIMEDOUT|ABORT_ERR|ERR_CANCELED|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/, phase: 'timeout' },
  { pattern: /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE)$/, phase: 'connect' },
]

/** Codes recognized verbatim inside a text (so ordinary words are not read as codes). */
const KNOWN_NETWORK_CODES: readonly string[] = [
  'ENOTFOUND', 'EAI_AGAIN', 'ENONAME', 'ENODATA',
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR', 'ERR_CANCELED',
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EPIPE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]

const ERROR_CODE_PATTERN = new RegExp(
  [...KNOWN_NETWORK_CODES, 'ERR_TLS_[A-Z_]+', 'CERT_[A-Z_]+', 'UND_ERR_[A-Z_]+'].join('|'))

/** Exact wording of the deployment boundary (`internal/platform/browser/action.go`). */
export const BOUNDARY_REFUSAL_TEXT = /(拒绝本机或内网地址|拒绝本机地址|只允许\s*http\/https\s*地址)/

/** Error code to phase. */
export function networkPhaseOfErrorCode(value: unknown): NetworkPhase {
  const code = text(value)
  if (code === '') return ''
  return ERROR_CODE_PHASES.find((one) => one.pattern.test(code))?.phase ?? ''
}

/**
 * Recover network facts from an error text (fallback when only text is available).
 *
 * Only known codes or the boundary's exact wording are used; anything else stays `unknown`.
 */
export function networkFactsOfErrorText(value: unknown, host = ''): NetworkFacts {
  const raw = text(value)
  // No error text: only "it failed" is known, so the phase stays unknown.
  if (raw === '') return { ...noNetworkFacts(false), phase: 'unknown' }
  const code = ERROR_CODE_PATTERN.exec(raw.toUpperCase())?.[0] ?? ''
  const address = addressInText(raw)
  if (BOUNDARY_REFUSAL_TEXT.test(raw)) {
    return {
      ...noNetworkFacts(false), source: 'derived', phase: 'boundary',
      addressKind: addressKindOf(address), address, host, refusedBy: 'network-boundary',
    }
  }
  const phase = networkPhaseOfErrorCode(code)
  return {
    ...noNetworkFacts(false), source: 'derived', phase: phase === '' ? 'unknown' : phase,
    errorCode: code, addressKind: addressKindOf(address), address, host,
  }
}

/** Facts of this probe: the transport's structured facts first, text recovery as fallback. */
function networkFactsFromProbe(facts: ProbeFacts): NetworkFacts {
  const carried = readNetworkFacts(facts.network)
  if (carried !== undefined) return carried
  if (facts.ok) return noNetworkFacts(true)
  return networkFactsOfErrorText(facts.error)
}

/**
 * Turn one probe's facts into the independent facts.
 *
 * Priority: network failure > captcha > login wall > status code > normal. A network
 * failure comes first because "cannot connect" and "was blocked" call for different
 * actions, and page signatures on an unreachable page are worthless anyway. The reverse
 * also holds: once the network layer failed, the captcha / login branches are unreachable.
 */
export function classifyProbe(facts: ProbeFacts): ProbeVerdict {
  const network = networkFactsFromProbe(facts)
  const of = (category: ProbeCategory, state: LoginState, detail?: string): ProbeVerdict => ({
    ...PROBE_TEXTS[category],
    ...(detail === undefined ? {} : { detail }),
    state,
    network,
  })
  // Only a response the transport itself attests to counts as "we reached the site".
  const responded = network.ok && network.source === 'transport'
  if (!facts.ok && !responded) {
    const clause = networkFactClause(network)
    const reason = text(facts.error) || clause || '网络不可达或超时'
    const detail = clause === '' || reason.includes(clause)
      ? `${UNREACHABLE_PREFIX}${reason}`
      : `${UNREACHABLE_PREFIX}${reason} —— ${clause}`
    return of('unreachable', 'unknown', detail)
  }
  // With a transport-attested response in hand, a status code is NOT a network fact: a
  // site-side 403 / challenge page is classified by the page. Network failures and
  // boundary refusals cannot reach this branch (their `network.ok` is false).
  if (looksLikeCaptcha(facts.body)) return of('needs-challenge', 'unknown')
  if (looksLikeLoginWall(facts.body)) return of('needs-login', 'unauthenticated')
  if (facts.status >= 400 || facts.status === 0) {
    return of('http-error', 'unknown',
      facts.status === 0 ? '没有拿到 HTTP 状态码：无法判断站点是否放行公开检索。' : `该来源返回 HTTP ${facts.status}。`)
  }
  return of('public-page-ok', 'authenticated')
}
