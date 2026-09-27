import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { clampText } from '../tools/outcome.ts'

/**
 * iFinD MCP 的**协议层**：初始化、列工具、调用工具，以及模型可见输出的净化器。
 *
 * 为什么从 `tools/ifind.ts` 拆出来：同一条协议现在有两个消费者 ——
 * ① 模型可见的取数 Tool（`crwu_audit_ifind_query`）；② 环境页的**真实认证探测**
 * （`ifind-probe`：「保存后立刻验证」。认证成功才允许显示「已认证」，这不是靠读文件长度
 * 就能得出的结论）。两者必须用**同一份**协议实现，否则会出现「探测说已认证、取数说 401」。
 *
 * 本模块不读凭据、不落盘、不认识 Tool 参数：它只接收明文密钥与公开的业务参数。
 */

/** serverType 固定枚举（模型只能从中选）。 */
export const IFIND_SERVER_TYPES = [
  'stock', 'fund', 'edb', 'news', 'bond', 'global_stock', 'index', 'future',
] as const

export type IfindServerType = typeof IFIND_SERVER_TYPES[number]

/** 服务根地址：Host 内部固定表，模型不可提交。 */
export const IFIND_SERVICE_BASE = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers'

/** serverType → 上游 MCP 服务路径（Host 内部固定表）。 */
export const IFIND_SERVER_PATHS: Record<IfindServerType, string> = {
  stock: 'hexin-ifind-ds-stock-mcp',
  fund: 'hexin-ifind-ds-fund-mcp',
  edb: 'hexin-ifind-ds-edb-mcp',
  news: 'hexin-ifind-ds-news-mcp',
  bond: 'hexin-ifind-ds-bond-mcp',
  global_stock: 'hexin-ifind-ds-global-stock-mcp',
  index: 'hexin-ifind-ds-index-mcp',
  future: 'hexin-ifind-ds-futures-mcp',
}

/** 单次请求超时（毫秒）：与已验证的第三方脚本一致（60s）。 */
export const IFIND_TIMEOUT_MS = 60_000

/** `list_tools` 的**模型可见**上限（R2）：异常上游不得无限撑大模型上下文。 */
export const IFIND_TOOLS_MAX = 60
export const IFIND_TOOL_DESC_MAX = 400

/**
 * 我们优先声明的 MCP 协议版本。
 *
 * 依据是官方 1.4.0 客户端（`ifind-finance-data-1.4.0`）实际使用的 `2025-03-26`。
 * **不再静默假设 `2024-11-05` 永远有效**：那个版本号是照抄旧脚本得来的，而上游已经换代。
 * 协商规则（见 `negotiateProtocol`）：服务端回什么版本就用什么版本，但只接受**受支持的集合**；
 * 回一个我们不认识的版本时按协议错误处理，而不是"假装成功"。
 */
export const IFIND_PROTOCOL_VERSION = '2025-03-26'

/** 服务端可能回、我们明确支持（并能正确处理响应形状）的协议版本。 */
export const IFIND_SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2024-11-05'] as const

/**
 * 协议版本协商。
 *
 * 返回 `ok:false` 的两种情况必须分开：上游**没回**版本（消息里可能只是省略了）与上游回了
 * 一个**我们不支持**的版本。前者按"沿用我们声明的版本"处理（MCP 允许省略），后者是硬失败 ——
 * 静默降级到某个旧版本正好会踩中「响应的形状变了而我们不知道」这类问题。
 */
export function negotiateProtocol(serverVersion: unknown): { ok: boolean; version: string; error: string } {
  const value = typeof serverVersion === 'string' ? serverVersion.trim() : ''
  if (value === '') return { ok: true, version: IFIND_PROTOCOL_VERSION, error: '' }
  if ((IFIND_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value)) {
    return { ok: true, version: value, error: '' }
  }
  return {
    ok: false,
    version: value,
    error: `iFinD 服务声明的 MCP 协议版本不受支持：${value}`
      + `（本插件支持 ${IFIND_SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}）`,
  }
}

/** 原型污染键：任意层级出现即拒绝（与上游脚本同一份黑名单）。 */
export const IFIND_BLOCKED_KEYS = ['__proto__', 'prototype', 'constructor'] as const

export interface IfindTransportRequest {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface IfindTransportResponse {
  status: number
  headers?: Record<string, string>
  body: string
}

/** 最小可注入传输：实现可以是 `fetch`，也可以是测试替身。 */
export interface IfindTransport {
  post(request: IfindTransportRequest): Promise<IfindTransportResponse>
}

/**
 * 默认传输：全局 `fetch`，**正常 TLS 校验**。
 *
 * 明确不提供任何"关闭校验"的开关（不接受 verify 参数，也不读任何关校验的环境开关）：
 * 关闭校验会让取数结果可被中间人替换，而审核结论依赖这些数值。
 */
export function defaultIfindTransport(): IfindTransport {
  return {
    async post(request) {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: response.status, headers, body: await response.text() }
    },
  }
}

/** 逐层校验 params 是 JSON 安全值：只允许 null / boolean / 有限数字 / string / 数组 / 普通对象。 */
export function validateIfindParams(value: unknown): { ok: boolean; error: string } {
  const blocked = new Set<string>(IFIND_BLOCKED_KEYS)
  const walk = (node: unknown, depth: number): string => {
    if (depth > 32) return 'params 嵌套过深'
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return ''
    if (typeof node === 'number') {
      return Number.isFinite(node) ? '' : 'params 含非有限数字'
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const bad = walk(item, depth + 1)
        if (bad !== '') return bad
      }
      return ''
    }
    if (typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return 'params 只接受普通对象'
      for (const [key, item] of Object.entries(node)) {
        if (blocked.has(key)) return `params 含禁用键 ${key}`
        const bad = walk(item, depth + 1)
        if (bad !== '') return bad
      }
      return ''
    }
    return `params 含非 JSON 类型（${typeof node}）`
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'params 必须是 JSON 对象' }
  }
  const error = walk(value, 0)
  return error === '' ? { ok: true, error: '' } : { ok: false, error }
}

/**
 * 模型可见输出的**边界净化器**（OPT-006-R1/R2 · P0）。
 *
 * 两条硬要求：
 * 1. **精确秘密**（本次令牌、MCP session id）在**任意字符串**里逐字替换 —— 上游把 session id
 *    塞进 `note`/`description` 这类普通字段是最容易漏的一条泄露路径；
 * 2. **敏感字段名按完整字段名匹配**（大小写与 `_`/`-` 变体归一后比较），**禁止**无边界的
 *    `/session|secret/i` 子串匹配 —— 那会把 `tradingSession`、`sessionCount`、`secretariat`
 *    这类正常业务字段误删。
 *
 * 秘密集合是**可变**的：initialize 拿到的 session id 必须加进来，之后所有出口都受它保护。
 * 构造结果用**无原型对象**并丢弃 `__proto__`/`prototype`/`constructor`，避免原型污染。
 */
export function makeIfindRedactor(secrets: readonly string[] = []) {
  const literals = new Set<string>()
  const note = (values: readonly string[]): void => {
    for (const value of values) {
      const trimmed = value.trim()
      if (trimmed.length >= 8) literals.add(trimmed)
    }
  }
  note(secrets)
  const SECRET_FIELDS = new Set([
    'authorization', 'authtoken', 'accesstoken', 'refreshtoken', 'apikey', 'secret',
    'password', 'credential', 'credentials', 'cookie', 'setcookie', 'session', 'sessionid',
    'mcpsessionid',
  ])
  const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
  const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '')
  const scrub = (value: string): string => {
    let out = value
    for (const literal of literals) out = out.split(literal).join('[凭据已净化]')
    // `Authorization: Bearer …` 这类整段（即使令牌本身不在字面集合里）也抹掉。
    out = out.replace(/(authorization|bearer)\s*[:=]?\s*[^\s,;"}]+/gi, '[凭据已净化]')
    return out
  }
  const walk = (value: unknown, depth: number): JsonValue => {
    if (depth > 32) return null
    if (typeof value === 'string') return scrub(value)
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'boolean' || value === null) return value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (typeof value === 'object') {
      const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
      for (const [key, item] of Object.entries(value)) {
        if (DANGEROUS_KEYS.has(key)) continue
        if (SECRET_FIELDS.has(normalizeKey(key))) continue
        out[scrub(key)] = walk(item, depth + 1)
      }
      return out
    }
    return null
  }
  return {
    /** 净化一个模型可见值。 */
    redact: (value: unknown): JsonValue => walk(value, 0),
    /** 运行中新发现的秘密（session id 等）加入保护集合。 */
    protect: (values: readonly string[]): void => note(values),
  }
}

/** 一次 MCP 会话。 */
export interface IfindSession {
  sessionId: string
  /** 协商后的协议版本（`initialize` 的返回值）。 */
  protocolVersion: string
}

export type IfindAbortSource = () => 'none' | 'external' | 'timeout'

export type RpcOutcome =
  | { ok: true; data: Record<string, unknown>; headers: Record<string, string>; status: number }
  | { ok: false; errorKind: 'infrastructure' | 'cli' | 'cancelled'; error: string }

/**
 * 单次 JSON-RPC 往返。
 *
 * 分类只看调用方**显式记录**的取消来源（`/abort/i` 兜底已删除：来源不明的 AbortError
 * 不得伪装成"用户取消"）。
 */
export async function rpc(
  transport: IfindTransport,
  url: string,
  token: string,
  session: IfindSession | null,
  body: Record<string, unknown>,
  signal: AbortSignal,
  redact: (value: unknown) => JsonValue,
  timeoutMs: number,
  abortSource: IfindAbortSource,
): Promise<RpcOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: token,
  }
  if (session !== null) headers['Mcp-Session-Id'] = session.sessionId
  let response: IfindTransportResponse
  try {
    response = await transport.post({
      url, headers, body: JSON.stringify(body), timeoutMs, signal,
    })
  } catch (error) {
    const source = abortSource()
    if (source === 'timeout') return { ok: false, errorKind: 'infrastructure', error: '调用 iFinD 服务超时' }
    if (source === 'external') return { ok: false, errorKind: 'cancelled', error: '调用已取消' }
    const message = error instanceof Error ? error.message : String(error)
    const safe = String(redact(message))
    return { ok: false, errorKind: 'infrastructure', error: `取数请求失败：${clampText(safe, 200)}` }
  }
  const sourceAfter = abortSource()
  if (sourceAfter === 'timeout') return { ok: false, errorKind: 'infrastructure', error: '调用 iFinD 服务超时' }
  if (sourceAfter === 'external') return { ok: false, errorKind: 'cancelled', error: '调用已取消' }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, errorKind: 'infrastructure', error: `iFinD 服务返回 HTTP ${response.status}` }
  }
  if (response.body.trim() === '') return { ok: true, data: {}, headers: response.headers ?? {}, status: response.status }
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch (error) {
    void error
    return { ok: false, errorKind: 'infrastructure', error: 'iFinD 服务返回的不是合法 JSON（协议错误）' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errorKind: 'infrastructure', error: 'iFinD 服务返回了非对象 JSON（协议错误）' }
  }
  const doc = parsed as Record<string, unknown>
  // 带 id 的请求必须是 JSON-RPC 2.0，且响应 id 与请求 id 一致；否则不得当作成功。
  if (body.id !== undefined) {
    if (doc.jsonrpc !== '2.0') {
      return { ok: false, errorKind: 'infrastructure', error: 'iFinD 响应不是 JSON-RPC 2.0（协议错误）' }
    }
    if (doc.id !== body.id) {
      return { ok: false, errorKind: 'infrastructure',
        error: `iFinD 响应 id 与请求不一致（协议错误）：期望 ${String(body.id)}，收到 ${String(doc.id)}` }
    }
  }
  if (doc.error !== undefined && doc.error !== null) {
    const detail = doc.error !== null && typeof doc.error === 'object'
      ? String((doc.error as Record<string, unknown>).message ?? JSON.stringify(doc.error))
      : String(doc.error)
    const safeDetail = String(redact(detail))
    return { ok: false, errorKind: 'cli', error: `iFinD 服务返回错误：${clampText(safeDetail, 300)}` }
  }
  return { ok: true, data: doc, headers: response.headers ?? {}, status: response.status }
}

/**
 * 一次完整会话的前两步：`initialize` → `notifications/initialized`。
 *
 * 返回的 `session` 必须原样传给后续请求（`Mcp-Session-Id` 是上游的会话凭据，同时也是
 * 净化器的保护对象）。
 */
export async function openIfindSession(
  transport: IfindTransport,
  url: string,
  token: string,
  signal: AbortSignal,
  timeoutMs: number,
  abortSource: IfindAbortSource,
): Promise<{ ok: true; session: IfindSession; redactor: ReturnType<typeof makeIfindRedactor> }
          | { ok: false; errorKind: 'infrastructure' | 'cli' | 'cancelled'; error: string }> {
  const redactor = makeIfindRedactor([token])
  const timedOut = (): boolean => abortSource() === 'timeout'
  const init = await rpc(transport, url, token, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: IFIND_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'crwu-audit-host', version: '1.0.0' },
    },
  }, signal, redactor.redact, timeoutMs, abortSource)
  if (!init.ok) {
    return { ok: false, errorKind: timedOut() ? 'infrastructure' : init.errorKind,
      error: timedOut() ? '调用 iFinD 服务超时' : init.error }
  }
  const negotiated = negotiateProtocol((init.data.result as Record<string, unknown> | undefined)?.protocolVersion)
  if (!negotiated.ok) return { ok: false, errorKind: 'infrastructure', error: negotiated.error }
  const sessionId = init.headers['mcp-session-id'] ?? init.headers['Mcp-Session-Id'] ?? ''
  if (sessionId === '') {
    return { ok: false, errorKind: 'infrastructure', error: 'iFinD initialize 成功但未返回 Mcp-Session-Id（协议错误）' }
  }
  // R2：session id 也是秘密，必须进保护集合（上游会把它塞进普通字段）。
  redactor.protect([sessionId])
  const session: IfindSession = { sessionId, protocolVersion: negotiated.version }
  const initialized = await rpc(transport, url, token, session,
    { jsonrpc: '2.0', method: 'notifications/initialized' }, signal, redactor.redact, timeoutMs, abortSource)
  if (!initialized.ok) {
    return { ok: false, errorKind: timedOut() ? 'infrastructure' : initialized.errorKind,
      error: timedOut() ? '调用 iFinD 服务超时' : `iFinD initialized 通知失败：${initialized.error}` }
  }
  return { ok: true, session, redactor }
}

export interface IfindToolRow {
  name: string
  description: string
  /** 上游给的 `inputSchema`（**原样**保留；净化在出口做）。 */
  inputSchema: unknown
}

/** `tools/list`：返回**完整**的工具行（含 inputSchema），模型可见清单由调用方裁剪。 */
export async function listIfindTools(
  transport: IfindTransport,
  url: string,
  token: string,
  session: IfindSession,
  signal: AbortSignal,
  timeoutMs: number,
  abortSource: IfindAbortSource,
): Promise<{ ok: true; tools: IfindToolRow[]; redact: (value: unknown) => JsonValue }
          | { ok: false; errorKind: 'infrastructure' | 'cli' | 'cancelled'; error: string }> {
  const redactor = makeIfindRedactor([token, session.sessionId])
  const listed = await rpc(transport, url, token, session,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, signal, redactor.redact, timeoutMs, abortSource)
  if (!listed.ok) {
    const timedOut = abortSource() === 'timeout'
    return { ok: false, errorKind: timedOut ? 'infrastructure' : listed.errorKind,
      error: timedOut ? '调用 iFinD 服务超时' : listed.error }
  }
  const result = listed.data.result
  const rows = result !== null && typeof result === 'object'
    ? (result as Record<string, unknown>).tools
    : undefined
  if (!Array.isArray(rows)) {
    return { ok: false, errorKind: 'infrastructure', error: 'iFinD tools/list 返回形状不符（协议错误）' }
  }
  const tools = rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    .map((row) => ({
      name: String(row.name ?? ''),
      description: String(row.description ?? ''),
      inputSchema: row.inputSchema ?? null,
    }))
    .filter((row) => row.name !== '')
  return { ok: true, tools, redact: redactor.redact }
}

// ── 认证探测（环境页「保存后立刻验证」的真实依据） ─────────────────────────

/** 探测失败归类：凭据 / 权益 / 基础设施，以及"没配置"。 */
export type IfindProbeErrorKind = '' | 'credential' | 'entitlement' | 'infrastructure' | 'unconfigured'

export interface IfindProbeResult {
  /** 认证成功（真的走完 initialize + tools/list (+ 取数)）。 */
  ok: boolean
  /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
  state: string
  errorKind: IfindProbeErrorKind
  error: string
  /** 工具清单的条数（旁证：不是只看 HTTP 200）。 */
  toolCount: number
  /** 工具名（**只回名字**，不把 schema 带回环境自检）。 */
  toolNames: string[]
  /** 协商后的协议版本。 */
  protocolVersion: string
  /** 探测时刻（ISO）。 */
  checkedAt: string
  /**
   * **真的取到数据了吗**（`tools/call` 成功返回了内容）。
   *
   * 为什么必须与 `ok` 分开：`initialize + tools/list` 成功只证明"认证通过"，
   * 而员工关心的是"这个 API-Key 现在能不能取到数据"。上游完全可能认证通过、列得出工具，
   * 却在真正取数时因为配额 / 权益 / 参数校验失败 —— 只报"已认证"会让人以为能用。
   */
  dataVerified: boolean
  /** 取数用的工具名（证明用的哪个工具，便于排查）；没取数时是空串。 */
  dataTool: string
  /** 取数结果的一小段**脱敏**摘要（最多几百字符，用于人工核对"确实有数据"）。 */
  dataSample: string
}

/** 上游说"没有权限 / 权益不足"时的指纹（403 与 JSON-RPC 消息两层都要认）。 */
const ENTITLEMENT_PATTERNS = [/权益/, /无权限/, /权限不足/, /not\s*entitled/i, /permission\s*denied/i, /forbidden/i]
/** 上游说"凭据不对"时的指纹（401 与消息两层）。 */
const CREDENTIAL_PATTERNS = [/未授权/, /认证失败/, /令牌/, /token/i, /unauthor/i, /invalid.*(key|token|credential)/i, /signature/i]

/**
 * 一次真实校验：`initialize` → `notifications/initialized` → `tools/list(stock)`
 * → （`data: true` 时）**真的 `tools/call` 取一次数据**。
 *
 * 分类顺序是刻意的：**先看 HTTP 状态码，再看上游消息**。401/403 是最权威的信号；
 * 只有状态码看不出问题时才去消息里找指纹。这样"网络超时"与"密钥错误"永远不会混为一谈
 * ——把前者报成后者会把员工指去重新申请一份好密钥。
 *
 * `data` 默认 **true**（2026-09-26 起）：环境自检要回答的是"现在能不能取到数据"，
 * 而不是"认证过不过"。取数步骤与认证步骤**分开归因** —— 只有取数成功才 `dataVerified: true`。
 */
export async function probeIfind(
  transport: IfindTransport,
  token: string,
  options: { serverType?: IfindServerType; timeoutMs?: number; signal?: AbortSignal; data?: boolean } = {},
): Promise<IfindProbeResult> {
  const checkedAt = new Date().toISOString()
  const serverType: IfindServerType = options.serverType ?? 'stock'
  const url = `${IFIND_SERVICE_BASE}/${IFIND_SERVER_PATHS[serverType]}`
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : IFIND_TIMEOUT_MS

  if (typeof token !== 'string' || token.trim() === '') {
    return {
      ok: false, state: 'unconfigured', errorKind: 'unconfigured', error: '还没有保存 iFinD API-Key',
      toolCount: 0, toolNames: [], protocolVersion: '', checkedAt,
      dataVerified: false, dataTool: '', dataSample: '',
    }
  }

  // 自建 linked controller：不依赖 `AbortSignal.any`（旧运行时没有它时内部超时必须仍能取消）。
  const linked = new AbortController()
  let abortSource: 'none' | 'external' | 'timeout' = 'none'
  const abortWith = (source: 'external' | 'timeout'): void => {
    if (abortSource === 'none') abortSource = source
    if (!linked.signal.aborted) linked.abort()
  }
  const onExternalAbort = (): void => abortWith('external')
  const external = options.signal
  if (external !== undefined) {
    if (external.aborted) onExternalAbort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => abortWith('timeout'), timeoutMs)
  const source = (): 'none' | 'external' | 'timeout' => abortSource
  const cleanup = (): void => {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }

  const fail = (state: string, errorKind: IfindProbeErrorKind, error: string,
                protocolVersion = '', extra: Partial<IfindProbeResult> = {}): IfindProbeResult =>
    ({ ok: false, state, errorKind, error, toolCount: 0, toolNames: [], protocolVersion, checkedAt,
      dataVerified: false, dataTool: '', dataSample: '', ...extra })

  try {
    // ① 先直连一次 HTTP，用来拿**权威状态码**（401/403 的区分只能在这一层做）。
    const opened = await openIfindSession(transport, url, token, linked.signal, timeoutMs, source)
    if (!opened.ok) {
      if (source() === 'external') return fail('unreachable', 'infrastructure', '调用已取消', '')
      const classified = classifyFailure(opened.error, '会话初始化')
      return fail(classified.state, classified.errorKind, classified.message, '')
    }
    const listed = await listIfindTools(transport, url, token, opened.session, linked.signal, timeoutMs, source)
    if (!listed.ok) {
      if (source() === 'external') return fail('unreachable', 'infrastructure', '调用已取消', opened.session.protocolVersion)
      const classified = classifyFailure(listed.error, '工具清单')
      return fail(classified.state, classified.errorKind, classified.message, opened.session.protocolVersion)
    }
    if (listed.tools.length === 0) {
      return fail('unreachable', 'entitlement', 'API-Key 通过认证，但当前账号在该服务下没有任何可用工具（权益受限）',
        opened.session.protocolVersion)
    }
    const toolNames = listed.tools.slice(0, IFIND_TOOLS_MAX).map((tool) => tool.name.slice(0, 200))
    const authOk: IfindProbeResult = {
      ok: true, state: 'authenticated', errorKind: '', error: '',
      toolCount: listed.tools.length,
      toolNames,
      protocolVersion: opened.session.protocolVersion,
      checkedAt,
      dataVerified: false, dataTool: '', dataSample: '',
    }
    // 只要认证（`describe_tool` / 取数 Tool 自己的会话路径不需要替它多打一次数据请求）。
    if (options.data === false) return authOk

    /**
     * 取数阶段的失败：**保留 `ok: true`**（凭据确实通过了认证），只把 `dataVerified` 留在 false。
     *
     * 这个区分是有意义的：界面据此说「认证通过，但这次没取到数据」+ 按 errorKind 给处置
     * （权益 → 找管理员；网络 → 稍后重试），而不是笼统的「验证失败」。
     * `state` 落到 `unverified`（"还没验成"）而不是 `unreachable`（"服务故障"）。
     */
    const dataFail = (base: IfindProbeResult, state: string, errorKind: IfindProbeErrorKind,
                      error: string, dataTool: string): IfindProbeResult =>
      ({ ...base, state: 'unverified', errorKind, error, dataVerified: false, dataTool })

    // ② 真实取数：认证通过 ≠ 能取到数据，所以这里真的调一次工具。
    const picked = pickProbeTool(listed.tools)
    if (picked === null) {
      // 凭据本身是好的（会话与工具清单都过了）→ `ok` 保留为 true，只把 `dataVerified` 留在 false；
      // 界面上这是"认证通过、没取到数据"，而不是"认证失败"。
      return dataFail(authOk, 'unreachable', 'entitlement',
        'API-Key 通过认证，但当前账号的工具里没有可安全试取的取数工具（只有写/批量类工具）—— 数据权益可能未开通',
        '')
    }
    const called = await rpc(transport, url, token, opened.session, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: picked.name, arguments: picked.args },
    }, linked.signal, listed.redact, timeoutMs, source)
    if (!called.ok) {
      const timedOut = source() === 'timeout'
      if (source() === 'external') {
        return dataFail(authOk, 'unreachable', 'infrastructure', '调用已取消', picked.name)
      }
      const classified = classifyFailure(called.error, '取数')
      return dataFail(authOk, classified.state, classified.errorKind, classified.message, picked.name)
    }
    const verdict = readToolsCallResult(called.data.result, listed.redact)
    if (!verdict.ok) {
      const classified = classifyFailure(verdict.error, '取数')
      return dataFail(authOk, classified.state, classified.errorKind,
        `取数失败（工具 ${picked.name}）：${verdict.error}`, picked.name)
    }
    return {
      ...authOk,
      dataVerified: true,
      dataTool: picked.name,
      dataSample: verdict.sample,
    }
  } catch (error) {
    // 传输层抛错：按基础设施归类（网络/服务不可达），绝不说成"密钥错误"。
    const message = error instanceof Error ? error.message : String(error)
    return fail('unreachable', 'infrastructure', `iFinD 服务不可达：${clampText(String(makeIfindRedactor([token]).redact(message)), 200)}`, '')
  } finally {
    cleanup()
  }
}

/**
 * 试取数据用的默认参数（按参数名挑一个"一定查得到东西"的经典标的）。
 *
 * 这是一份**候选表**而不是一个写死的 body：不同工具的参数名不同（`query` / `code` /
 * `stockCode`…），挑不中就把最好填的那个必填字段留空字符串 —— 上游若因此报参数错误，
 * 会如实显示成"取数失败"，而不是被我们伪装成成功或伪装成密钥错误。
 */
const IFIND_PROBE_VALUES: Record<string, string> = {
  query: '贵州茅台',
  keyword: '贵州茅台',
  key: '贵州茅台',
  search: '贵州茅台',
  code: '600519.SH',
  stockcode: '600519.SH',
  stock_code: '600519.SH',
  symbol: '600519.SH',
  secu_code: '600519.SH',
  secucode: '600519.SH',
  thscode: '600519.SH',
  ths_code: '600519.SH',
  ticker: '600519.SH',
  indicator: '收盘价',
  indicators: '收盘价',
  date: '2026-01-02',
  startdate: '2026-01-01',
  enddate: '2026-01-31',
}

/** 名字里带这些词的工具**不试**：它们要么写、要么批量、要么需要真实 ID/文件。 */
const IFIND_PROBE_SKIP = /(delete|remove|update|set|create|add|modify|write|insert|save|edit|publish|submit|batch|subscribe|upload|download|import|export|parse|convert)/i

export interface IfindProbeTool {
  name: string
  args: Record<string, unknown>
}

/**
 * 从真实工具清单里挑一个**安全、只读、单参数**的工具试取数据。
 *
 * 判据（顺序即优先级）：
 * 1. 名字不在跳过表里（写/批量/导入导出类一律不碰）；
 * 2. `inputSchema.properties` 里**必填项 ≤ 1** —— 必填越多越可能因为缺参数而失败，
 *    那不是"API-Key 不能取数"的证据；
 * 3. 参数名能在候选表里找到，或必填项就一个（那就把它填成经典标的）；
 * 4. **不要有任何"开关"型参数**（boolean）—— 猜错语义容易调成写操作。
 *
 * 一个都挑不出来时返回 `null`，调用方按"权益不可用"如实报（不是成功）。
 */
export function pickProbeTool(tools: readonly IfindToolRow[]): IfindProbeTool | null {
  for (const tool of tools) {
    if (tool.name === '' || IFIND_PROBE_SKIP.test(tool.name)) continue
    const schema = tool.inputSchema
    const properties = schema !== null && typeof schema === 'object'
      ? (schema as Record<string, unknown>).properties
      : undefined
    if (properties === undefined || properties === null || typeof properties !== 'object') continue
    const keys = Object.keys(properties as Record<string, unknown>)
    if (keys.length === 0 || keys.length > 8) continue
    const requiredRaw = schema !== null && typeof schema === 'object'
      ? (schema as Record<string, unknown>).required
      : undefined
    const required = Array.isArray(requiredRaw) ? requiredRaw.map((item) => String(item)) : []
    if (required.length > 1) continue
    // 有 boolean / 数组 / 对象参数就跳过：语义猜不准。
    const flat = keys.filter((key) => {
      const prop = (properties as Record<string, unknown>)[key]
      const type = prop !== null && typeof prop === 'object'
        ? String((prop as Record<string, unknown>).type ?? '')
        : ''
      return type === 'boolean' || type === 'array' || type === 'object'
    })
    if (flat.length > 0) continue

    const args: Record<string, unknown> = {}
    let filled = true
    for (const key of required) {
      const value = IFIND_PROBE_VALUES[key.toLowerCase()]
      if (value === undefined) { filled = false; break }
      args[key] = value
    }
    if (!filled) continue
    if (required.length === 0) {
      // 没有必填项：从可选字段里挑第一个能填经典值的。
      const pick = keys.find((key) => IFIND_PROBE_VALUES[key.toLowerCase()] !== undefined)
      if (pick === undefined) continue
      args[pick] = IFIND_PROBE_VALUES[pick.toLowerCase()]
    }
    return { name: tool.name, args }
  }
  return null
}

/**
 * 读 `tools/call` 的结果：**只有真的带回内容才算取数成功**。
 *
 * 三种情况分开：
 * - `isError: true` → 上游明确报错（可能是参数、也可能是权益）→ 交给上面的消息指纹分类；
 * - 没有任何内容 → 不算成功（空响应对"能取数"没有证明力）；
 * - 有内容 → 取数成功，`sample` 是**脱敏后的短摘要**（只用于人工核对，不整段回传）。
 */
export function readToolsCallResult(result: unknown, redact: (input: unknown) => JsonValue):
  { ok: true; sample: string } | { ok: false; error: string } {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: 'tools/call 返回形状不符（协议错误）' }
  }
  const record = result as Record<string, unknown>
  const content = Array.isArray(record.content) ? record.content : []
  const texts = content
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => String(item.text ?? ''))
    .filter((text) => text !== '')
  const joined = texts.join('\n')
  if (record.isError === true) {
    const detail = joined === '' ? '上游把这次取数判为失败（isError）' : clampText(joined, 300)
    return { ok: false, error: String(redact(detail)) }
  }
  if (content.length === 0) return { ok: false, error: '上游返回了空内容（没有取到任何数据）' }
  if (joined === '') return { ok: false, error: '上游返回的内容没有可读文本（协议形状变化？）' }
  return { ok: true, sample: clampText(String(redact(joined)), 300) }
}

/** 从 `iFinD 服务返回 HTTP 401` 这类文案里取状态码。 */
function httpStatusOf(message: string): number {
  const match = /HTTP\s+(\d{3})/.exec(message)
  return match === null ? 0 : Number(match[1])
}

/**
 * 失败归因：**先看状态码，再看消息指纹**，最后落到"基础设施"。
 *
 * 抽成一个函数是因为它要在**四个**阶段复用（会话初始化 / 工具清单 / 取数 RPC / 取数内容）——
 * 只在第一阶段区分 401 与 403 是不够的：上游完全可能认证与列工具都正常，**在真正取数时**
 * 才因为权益或凭据过期拒绝（实测这类"后置失败"很常见）。四个阶段归因不一致，
 * 员工就会看到"取数失败"这种既不能重填也不能找管理员的笼统提示。
 *
 * `stage` 只用于拼人话前缀（"取数失败：…"），不改变归类。
 */
export function classifyFailure(message: string, stage = ''):
  { state: string; errorKind: IfindProbeErrorKind; message: string } {
  const prefix = stage === '' ? '' : `${stage}失败：`
  const code = httpStatusOf(message)
  if (code === 401) {
    return { state: 'invalid', errorKind: 'credential',
      message: `${prefix}iFinD 拒绝了这份 API-Key（HTTP 401）：请确认 API-Key 是否正确、是否已过期` }
  }
  if (code === 403) {
    return { state: 'unreachable', errorKind: 'entitlement',
      message: `${prefix}API-Key 有效，但当前账号没有该数据服务的权益（HTTP 403）—— 请联系管理员开通` }
  }
  for (const pattern of ENTITLEMENT_PATTERNS) {
    if (pattern.test(message)) return { state: 'unreachable', errorKind: 'entitlement', message: `${prefix}${message}` }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(message)) return { state: 'invalid', errorKind: 'credential', message: `${prefix}${message}` }
  }
  return { state: 'unreachable', errorKind: 'infrastructure', message: `${prefix}${message}` }
}

// ── 参数 schema 的模型可见裁剪（`describe_tool`）────────────────────────────

/** 单个工具 schema 的模型可见上限（深度 / 单字符串长度 / 字符总量）。 */
export const IFIND_SCHEMA_MAX_DEPTH = 6
export const IFIND_SCHEMA_STR_MAX = 400
export const IFIND_SCHEMA_TEXT_MAX = 6_000

/**
 * 把真实 `inputSchema` 裁剪成**限深、限长、脱敏**的可读结构。
 *
 * 为什么需要它：只回工具名与描述时，模型知道"有这个工具"却不知道参数怎么填，于是要么放弃，
 * 要么凭名字猜参数（猜出来的调用会被上游拒绝，浪费一次审批与一次往返）。
 *
 * 三条限制都是硬要求：
 * - **限深**：上游的 schema 可能嵌套极深，整棵带进上下文会挤掉真正要看的材料；
 * - **限长**：单个字段的 `description` 偶有整段文档，逐字段截断；
 * - **脱敏**：**每个对象节点都过一次净化器** —— 它既按精确字段名丢掉 `authorization` /
 *   `auth_token` 这类键（任意深度），也把 token / session id 从字符串里抹掉。
 *   只在最外层净化是不够的：穷举的 `properties` 里嵌套几层就会出现示例值。
 */
export function trimIfindSchema(value: unknown, redact: (input: unknown) => JsonValue): JsonValue {
  const walk = (node: unknown, depth: number): JsonValue => {
    if (depth > IFIND_SCHEMA_MAX_DEPTH) return '[已截断：层级过深]'
    if (typeof node === 'string') return clampText(node, IFIND_SCHEMA_STR_MAX)
    if (typeof node === 'number') return Number.isFinite(node) ? node : null
    if (typeof node === 'boolean' || node === null) return node
    if (Array.isArray(node)) return node.slice(0, 64).map((item) => walk(item, depth + 1))
    if (typeof node === 'object') {
      const out: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
        out[key] = walk(item, depth + 1)
      }
      // 净化器会丢掉敏感键、抹掉字符串里的秘密，并返回无原型对象。
      return redact(out)
    }
    return null
  }
  const trimmed = walk(value, 0)
  const text = JSON.stringify(trimmed) ?? 'null'
  if (text.length <= IFIND_SCHEMA_TEXT_MAX) return trimmed
  return { truncated: true, truncatedText: clampText(text, IFIND_SCHEMA_TEXT_MAX) }
}
