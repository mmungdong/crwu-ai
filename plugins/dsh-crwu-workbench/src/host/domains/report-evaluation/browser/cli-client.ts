import { text } from '../../../../shared/utils/value.ts'
import type { LocalAccessSource } from '../../../core/access/operations.ts'
import type { ProfileQueue } from './profile-queue.ts'

/**
 * `crwu browser` 的 **Host 侧适配器**（设计稿 §8.2 / §8.3）。
 *
 * ## 三条职责边界
 *
 * 1. **argv 由这里构造**。模型只能给 `siteId` / `keyword` / `city` / 业务 ID；URL、输出路径、
 *    端口、profile、脚本路径一律由 Host 拼。这是"来源白名单"真正的落点 —— 让模型拼 URL
 *    等于允许它把浏览器导航到任意地址。
 * 2. **envelope 解析不信任退出码**。CLI 的契约是 stdout 上的 `{ok,data}`；非零退出仍然可能带着
 *    合法的逐站结果（例如"三家有两家没登录"）。只有 stdout 本身畸形才降级成"逐站 unknown"，
 *    而且**不抛裸 JSON 错误** —— 那会让界面显示一句与真实原因无关的话。
 * 3. **同一 profile 串行**。所有方法都经 `ProfileQueue`，因为一个 profile 只有一个真实浏览器。
 *
 * 这里**不读 Cookie、不碰凭据、不认识验证码解法**：CLI 回答什么，这里就记什么。
 */

/** 一个来源的登录状态。取值集合与 CLI 的三态一致。 */
export type CliSiteState = 'authenticated' | 'unauthenticated' | 'unknown'

export interface SiteStatusView {
  siteId: string
  label: string
  state: CliSiteState
  reason: string
  /**
   * 受保护页的**页面判定**（`ok` / `login-wall` / `captcha` / `blocked`；未读页面时为空）。
   *
   * 它是"为什么这个来源现在不能用"的**结构化**答案：`captcha` 要去做有界恢复、
   * `blocked` 是风控、只有 `login-wall` 才该引导登录。靠匹配 `reason` 的中文文案来分流
   * 会在文案改动时静默失效。
   */
  verdict: string
  /** 受保护页地址（站点清单里的公开配置）：需要人工过验证时打开它。 */
  protectedUrl: string
  /** 凭据到期时间（RFC3339）；会话 cookie 时为空。 */
  expiresAt: string
  /** 凭据没有自己的到期时间（关掉浏览器即失效）。 */
  sessionCookie: boolean
}

export interface CliOutput {
  ok: boolean
  error: string
  exitCode: number | null
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
}

/** 执行一条 crwu 命令（生产是 `runCrwu` 的薄包装；测试用内存替身）。 */
export type CrwuRunner = (
  argv: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<CliOutput>

/** 一次页面取数/截图的 CLI 结果。 */
export interface PageOutcome {
  ok: boolean
  failureKind: string
  verdict: string
  finalUrl: string
  title: string
  file: string
  digest: string
  bytes: number
  status: number
  error: string
}

export type RecoveryState = 'recovered' | 'waiting-user' | 'unsupported' | 'cancelled' | 'unavailable' | 'failed'

export interface RecoveryPageValidation {
  finalUrl: string
  title: string
  hostMatches: boolean
  readable: boolean
  challengeVisible: boolean
  loginWall: boolean
  blocked: boolean
  overlaySelectors: string[]
  reason: string
}

/** 一次有界恢复的结果。判定只看 `state`，不看退出码。 */
export interface RecoveryOutcome {
  recoveryId: string
  retrievalTaskId: string
  providerId: string
  strategyId: string
  strategyVersion: string
  attempts: number
  beforeKind: string
  afterKind: string
  state: RecoveryState
  reasonCode: string
  nextEligibleAt: string
  pageValidation: RecoveryPageValidation
  strategies: string[]
  notes: string[]
}

export interface LoginOutcome {
  ok: boolean
  error: string
  sites: SiteStatusView[]
  aborted: boolean
}

export interface PageRequest {
  url: string
  out: string
  dump?: string
  waitMs?: number
  scroll?: boolean
  fullPage?: boolean
}

export interface RecoverRequest {
  providerId: string
  url: string
  retrievalTaskId: string
  recoveryId: string
  strategy?: 'auto' | 'cooldown-renavigate' | 'geetest-v3-canvas'
  attempts?: number
  windowMs?: number
  cooldownMs?: number
  scriptTimeoutMs?: number
}

export interface BrowserClientDeps {
  run: CrwuRunner
  /** Skill 自带的站点清单（包内路径）。模型提交不了它。 */
  sitesPath: string
  queue: ProfileQueue
  source: LocalAccessSource
  workdir: string
  /** profile 键：不同 profile 互不阻塞；缺省是 CLI 的共享默认 profile。 */
  profileKey?: string
  timeoutMs?: {
    status?: number
    login?: number
    open?: number
    page?: number
    recover?: number
  }
}

export interface BrowserStatusResult {
  ok: boolean
  error: string
  sites: SiteStatusView[]
  unavailable: boolean
}

export interface BrowserClient {
  /**
   * **只读凭据**的登录状态（协议 37 起）：从 CLI 的持久 profile 里读 cookie 与**到期时间**，
   * 不打开可见窗口、不加载任何页面。
   *
   * 为什么这样才对：门禁每次进页面都要问一次"登录了吗"，而落地页读一次意味着一次真实导航
   * （被人机验证/风控看见）。凭据本身就带着答案（在不在、什么时候过期），读它没有副作用。
   */
  status(siteIds: readonly string[], signal?: AbortSignal): Promise<BrowserStatusResult>
  /**
   * 读**受保护页**的登录状态（`--verify-page`）。
   *
   * 只有"登录窗口本来就开着"的那条链路才用它 —— 它要拿页面判定（`verdict`）来区分
   * "登录失败"和"登录成功了但页面要人机验证"（`waiting-user`）。门禁预检**不用**它。
   */
  statusVerified(siteIds: readonly string[], signal?: AbortSignal): Promise<BrowserStatusResult>
  login(siteId: string, signal?: AbortSignal): Promise<LoginOutcome>
  /**
   * 在**同一个 profile** 的可见窗口里打开该来源的受保护页，让员工自己完成人机验证。
   *
   * 只接受 `siteId`：URL 由 CLI 从站点清单里取，调用方提交不了任意地址。`opened` 只表示
   * 窗口已打开，**不表示验证完成** —— 验证结果只由下一次 `status` 回答。
   */
  openVerification(siteId: string, signal?: AbortSignal): Promise<{ ok: boolean; error: string; opened: boolean }>
  fetch(request: PageRequest, signal?: AbortSignal): Promise<PageOutcome>
  shot(request: PageRequest, signal?: AbortSignal): Promise<PageOutcome>
  recover(request: RecoverRequest, signal?: AbortSignal): Promise<RecoveryOutcome>
  /** 站点清单路径（界面与诊断用；不含凭据）。 */
  sites(): string
}

/** 把 stdout 解析成 envelope。畸形时 `parsed = false`，**不抛错**。 */
export function parseEnvelope(stdout: string): { parsed: boolean; ok: boolean; data: Record<string, unknown> | null } {
  const raw = text(stdout).trim()
  if (raw === '') return { parsed: false, ok: false, data: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { parsed: false, ok: false, data: null }
    }
    const record = value as Record<string, unknown>
    const data = record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : null
    return { parsed: true, ok: record.ok === true, data }
  } catch {
    return { parsed: false, ok: false, data: null }
  }
}

function siteStateOf(value: unknown): CliSiteState {
  const raw = text(value)
  return raw === 'authenticated' || raw === 'unauthenticated' ? raw : 'unknown'
}

/** 安全原因：只回人话，不回原始命令、Cookie 或路径。 */
function safeReason(value: unknown, fallback: string): string {
  const raw = text(value).trim()
  if (raw === '') return fallback
  return raw.replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * 从一次 `status` 调用的输出推出逐站状态。
 *
 * 关键判据：**非零退出但 stdout 是合法 `{ok,data}` 时仍然解析**。CLI 在"有站点未登录"时
 * 故意返回非零退出，而那时逐站原因正是最有用的事实；只看退出码会把它整条丢掉。
 * stdout 畸形时才降级：每个被问到过的站点都是 `unknown`，并说明原因是"命令输出读不出来"。
 */
export function statusFromEnvelope(
  output: Pick<CliOutput, 'stdout' | 'exitCode' | 'stderr' | 'error' | 'aborted' | 'timedOut'>,
  requested: readonly string[] = [],
): { ok: boolean; error: string; sites: SiteStatusView[]; unavailable: boolean; parsed: boolean } {
  const envelope = parseEnvelope(output.stdout)
  const fallbackReason = output.aborted
    ? '浏览器检查被取消'
    : output.timedOut
      ? '浏览器检查超时：无法确认登录状态'
      : safeReason(output.stderr, safeReason(output.error, '无法读取浏览器状态输出'))

  if (!envelope.parsed || envelope.data === null) {
    return {
      ok: false,
      error: fallbackReason,
      unavailable: true,
      parsed: false,
      sites: requested.map((siteId) => ({
        siteId, label: '', state: 'unknown', reason: fallbackReason,
        verdict: '', protectedUrl: '', expiresAt: '', sessionCookie: false,
      })),
    }
  }

  const rawSites = Array.isArray(envelope.data.sites) ? envelope.data.sites : []
  const sites: SiteStatusView[] = []
  for (const item of rawSites) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const siteId = text(record.id)
    if (siteId === '') continue
    const state = siteStateOf(record.state)
    sites.push({
      siteId,
      label: text(record.label),
      state,
      // 原因**在已登录时也要带回来**：协议 37 起 CLI 在凭据模式下把"什么时候过期"写在这句人话里，
      // 而界面正是靠它显示"已登录（到期 …）"。以前这里把已登录的原因清空，等于丢掉了有效期。
      reason: safeReason(record.reason, ''),
      verdict: text(record.verdict),
      protectedUrl: text(record.protectedUrl),
      expiresAt: text(record.expiresAt),
      sessionCookie: record.sessionCookie === true,
    })
  }

  // 命令报了成功却没回任何站点：那不是一个"全部已登录"的结论，而是输出不完整。
  if (sites.length === 0) {
    const reason = '浏览器状态输出里没有任何站点：无法判断登录状态'
    return {
      ok: false, error: reason, unavailable: true, parsed: true,
      sites: requested.map((siteId) => ({
        siteId, label: '', state: 'unknown', reason,
        verdict: '', protectedUrl: '', expiresAt: '', sessionCookie: false,
      })),
    }
  }

  return {
    ok: envelope.ok && sites.every((site) => site.state === 'authenticated'),
    error: envelope.ok ? '' : safeReason(output.stderr || output.error, '有站点未处于已登录状态'),
    sites,
    unavailable: false,
    parsed: true,
  }
}

/** 从一次 `recover` 调用的输出推出恢复结论。畸形输出 → `failed` / `output-unreadable`。 */
export function recoveryFromEnvelope(output: Pick<CliOutput, 'stdout' | 'exitCode' | 'stderr' | 'error'>): RecoveryOutcome {
  const envelope = parseEnvelope(output.stdout)
  const empty: RecoveryPageValidation = {
    finalUrl: '', title: '', hostMatches: false, readable: false,
    challengeVisible: false, loginWall: false, blocked: false, overlaySelectors: [], reason: '',
  }
  if (!envelope.parsed || envelope.data === null) {
    return {
      recoveryId: '', retrievalTaskId: '', providerId: '', strategyId: '', strategyVersion: '',
      attempts: 0, beforeKind: '', afterKind: '',
      state: 'failed', reasonCode: 'output-unreadable',
      nextEligibleAt: '', strategies: [], notes: [],
      pageValidation: { ...empty, reason: safeReason(output.stderr || output.error, '恢复命令的输出不是合法 JSON') },
    }
  }
  const data = envelope.data
  const validation = data.pageValidation !== null && typeof data.pageValidation === 'object'
    ? data.pageValidation as Record<string, unknown>
    : {}
  const state = text(data.state)
  const allowed: readonly string[] = ['recovered', 'waiting-user', 'unsupported', 'cancelled', 'unavailable', 'failed']
  return {
    recoveryId: text(data.recoveryId),
    retrievalTaskId: text(data.retrievalTaskId),
    providerId: text(data.providerId),
    strategyId: text(data.strategyId),
    strategyVersion: text(data.strategyVersion),
    attempts: typeof data.attempts === 'number' && Number.isFinite(data.attempts) ? data.attempts : 0,
    beforeKind: text(data.beforeKind),
    afterKind: text(data.afterKind),
    state: (allowed.includes(state) ? state : 'failed') as RecoveryState,
    reasonCode: text(data.reasonCode),
    nextEligibleAt: text(data.nextEligibleAt),
    strategies: Array.isArray(data.strategies) ? data.strategies.map((item) => text(item)).filter((item) => item !== '') : [],
    notes: Array.isArray(data.notes) ? data.notes.map((item) => text(item)).slice(0, 12) : [],
    pageValidation: {
      finalUrl: text(validation.finalUrl),
      title: text(validation.title),
      hostMatches: validation.hostMatches === true,
      readable: validation.readable === true,
      challengeVisible: validation.challengeVisible === true,
      loginWall: validation.loginWall === true,
      blocked: validation.blocked === true,
      overlaySelectors: Array.isArray(validation.overlaySelectors)
        ? validation.overlaySelectors.map((item) => text(item)).slice(0, 8)
        : [],
      reason: safeReason(validation.reason, ''),
    },
  }
}

/** 从一次 `fetch` / `shot` 的输出推出页面结果。 */
export function pageOutcomeFromEnvelope(output: Pick<CliOutput, 'stdout' | 'exitCode' | 'stderr' | 'error'>): PageOutcome {
  const envelope = parseEnvelope(output.stdout)
  const data = envelope.data ?? {}
  return {
    ok: envelope.ok && data.ok === true,
    failureKind: text(data.failureKind),
    verdict: text(data.verdict),
    finalUrl: text(data.finalUrl),
    title: text(data.title),
    file: text(data.file),
    digest: text(data.digest),
    bytes: typeof data.bytes === 'number' && Number.isFinite(data.bytes) ? data.bytes : 0,
    status: typeof data.status === 'number' && Number.isFinite(data.status) ? data.status : 0,
    error: safeReason(data.error || output.stderr || output.error, ''),
  }
}

/** 缩成单段：每一段都必须是合法参数，否则整条命令不该发出去。 */
function requireSegment(value: unknown): string {
  const raw = text(value).trim()
  if (raw === '' || raw.includes('..') || /[\\/]/.test(raw)) {
    throw new Error('浏览器命令参数不合法：必须是单段标识')
  }
  return raw
}

function requireHttpUrl(value: unknown): string {
  const raw = text(value).trim()
  if (!/^https?:\/\//i.test(raw)) throw new Error('浏览器命令参数不合法：URL 必须是 http/https 绝对地址')
  return raw
}

function requireAbsent(value: unknown): string {
  const raw = text(value).trim()
  if (raw === '') throw new Error('浏览器命令参数不合法：输出路径不能为空')
  return raw
}

export function createBrowserClient(deps: BrowserClientDeps): BrowserClient {
  const profileKey = text(deps.profileKey) || 'crwu:browser:default'
  const sitesPath = requireAbsent(deps.sitesPath)
  const run = async (
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<CliOutput> => {
    // 全部浏览器调用都过同一个 profile 队列：一个 profile 只有一个真实浏览器。
    return await deps.queue.run(profileKey, signal, async () => await deps.run(argv, {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }))
  }
  const baseArgv = (): string[] => ['crwu', 'browser']
  const withSites = (argv: string[]): string[] => [...argv, '--sites', sitesPath]

  /**
   * 一次登录状态读取。
   *
   * `verifyPage` 决定这条命令会不会**加载页面**：默认只读 profile 里的凭据与到期时间
   * （CLI 侧不打开可见窗口），只有登录那条链路才额外读受保护页拿页面判定。
   */
  const readStatus = async (
    siteIds: readonly string[],
    verifyPage: boolean,
    signal: AbortSignal | undefined,
  ): Promise<BrowserStatusResult> => {
    const ids = siteIds.map((id) => requireSegment(id))
    const argv = withSites([...baseArgv(), 'status'])
    if (verifyPage) argv.push('--verify-page')
    for (const id of ids) argv.push('--site', id)
    const output = await run(argv, deps.timeoutMs?.status ?? 120_000, signal)
    const parsed = statusFromEnvelope(output, ids)
    return { ok: parsed.ok, error: parsed.error, sites: parsed.sites, unavailable: parsed.unavailable }
  }

  return {
    sites: () => sitesPath,

    async status(siteIds, signal) {
      return await readStatus(siteIds, false, signal)
    },

    async statusVerified(siteIds, signal) {
      return await readStatus(siteIds, true, signal)
    },

    async login(siteId, signal) {
      const id = requireSegment(siteId)
      const argv = withSites([...baseArgv(), 'login', '--site', id])
      const output = await run(argv, deps.timeoutMs?.login ?? 6 * 60_000, signal)
      const parsed = statusFromEnvelope(output, [id])
      return {
        ok: output.ok && parsed.ok,
        error: output.aborted ? '登录被取消' : parsed.error,
        sites: parsed.sites,
        aborted: output.aborted,
      }
    },

    async openVerification(siteId, signal) {
      const id = requireSegment(siteId)
      const argv = withSites([...baseArgv(), 'open', '--site', id])
      // 这条命令**不等**员工完成验证（打开就返回），所以超时按"起浏览器"这一档给。
      const output = await run(argv, deps.timeoutMs?.open ?? 90_000, signal)
      const parsed = parseEnvelope(output.stdout)
      const opened = parsed.parsed && parsed.ok && parsed.data?.opened === true
      const reason = output.aborted
        ? '打开验证窗口已取消'
        : (opened ? '' : safeReason(parsed.data?.error ?? output.error, '打开验证窗口失败'))
      return { ok: opened, error: reason, opened }
    },

    async fetch(request, signal) {
      // 取数固定复用自有后台窗口：窗口不抢焦点、同一 profile 串行复用同一张渲染页。
      // `--background` 不是模型输入，Host 永远写死 true。
      const argv = [...baseArgv(), 'fetch', '--background=true', '--url', requireHttpUrl(request.url), '--out', requireAbsent(request.out)]
      if (text(request.dump) !== '') argv.push('--dump', text(request.dump))
      if (typeof request.waitMs === 'number') argv.push('--wait-ms', String(Math.max(0, Math.floor(request.waitMs))))
      if (request.scroll === true) argv.push('--scroll')
      const output = await run(argv, deps.timeoutMs?.page ?? 120_000, signal)
      return pageOutcomeFromEnvelope(output)
    },

    async shot(request, signal) {
      // 截图同样固定复用自有后台窗口；`--background` 不是模型输入。
      const argv = [...baseArgv(), 'shot', '--background=true', '--url', requireHttpUrl(request.url), '--out', requireAbsent(request.out)]
      if (text(request.dump) !== '') argv.push('--dump', text(request.dump))
      if (typeof request.waitMs === 'number') argv.push('--wait-ms', String(Math.max(0, Math.floor(request.waitMs))))
      if (request.scroll === true) argv.push('--scroll')
      if (request.fullPage === false) argv.push('--full-page=false')
      const output = await run(argv, deps.timeoutMs?.page ?? 180_000, signal)
      return pageOutcomeFromEnvelope(output)
    },

    async recover(request, signal) {
      const argv = withSites([
        ...baseArgv(), 'recover',
        '--site', requireSegment(request.providerId),
        '--url', requireHttpUrl(request.url),
        '--task-id', requireSegment(request.retrievalTaskId),
      ])
      if (text(request.strategy) !== '') argv.push('--strategy', text(request.strategy))
      if (typeof request.attempts === 'number') argv.push('--attempts', String(Math.max(1, Math.floor(request.attempts))))
      if (typeof request.windowMs === 'number') argv.push('--window-ms', String(Math.max(1000, Math.floor(request.windowMs))))
      // 显式传 0：告诉 CLI「冷却由 Host 协调器管理」，别在命令行进程里睡几十秒。
      argv.push('--cooldown-ms', String(Math.max(0, Math.floor(request.cooldownMs ?? 0))))
      if (typeof request.scriptTimeoutMs === 'number') {
        argv.push('--script-timeout-ms', String(Math.max(1000, Math.floor(request.scriptTimeoutMs))))
      }
      const output = await run(argv, deps.timeoutMs?.recover ?? 150_000, signal)
      const outcome = recoveryFromEnvelope(output)
      return {
        ...outcome,
        recoveryId: outcome.recoveryId || request.recoveryId,
        retrievalTaskId: outcome.retrievalTaskId || request.retrievalTaskId,
        providerId: outcome.providerId || request.providerId,
      }
    },
  }
}
