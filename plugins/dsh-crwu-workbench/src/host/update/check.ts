/**
 * 更新检查策略：**能不能查、要不要查、查到的结果算不算数**。
 *
 * 这一层不安装任何东西、不写状态文件、不注册 RPC，也不碰 Context —— 全部依赖注入，
 * 因此可以在单元测试里用注入时钟完整走一遍 6 小时缓存与 10 分钟退避，而不创建真实定时器。
 *
 * 四条政策（对应设计文档 §5、§9）：
 * 1. **不支持就直说**：本地开发安装（`dev`）、Plugin Manager 不可用、profile 使用企业/私有源，
 *    一律 `unsupported`，且**不访问任何公共源**；这三种情况**不写进失败退避**（它们不是网络故障，
 *    员工修好 profile 后下一次自动检查就要生效）。
 * 2. **失败不能伪装成"已是最新"**：只有"至少一个源成功 + 拿到的最高合法稳定版不高于当前版本"
 *    才允许 `up-to-date`；源全失败、当前版本非法、发现结果自相矛盾都归为 `error`。
 * 3. **旧结果照旧**：自动刷新失败时保留最近一次成功结论（`checkedAt` / `expiresAt` 一字不改），
 *    但**授权安装**必须按当前时钟重判 `expiresAt`，过期候选只作历史展示。
 * 4. **不给 Client 任何原始信息**：状态里没有 registry 地址、没有认证信息、没有 `Error.message`。
 */
import { compare, prerelease, valid } from 'semver'

import {
  UPDATE_FAILURE_BACKOFF_MS,
  UPDATE_SOURCES,
  UPDATE_SUCCESS_TTL_MS,
} from '../../shared/update/consts.ts'
import { discoverLatestVersion } from './registry.ts'
import type {
  UpdateCandidate,
  UpdateCheckErrorKind,
  UpdateCheckState,
  UpdateUnsupportedReason,
} from '../../shared/update/types.ts'
import type {
  RegistryFailure,
  RegistrySourceOutcome,
  UpdateChecker,
  UpdateCheckOptions,
  UpdateCheckPorts,
  UpdateDiscovery,
  UpdateDiscoveryFn,
} from './types.ts'
import type { PluginRegistries } from '@deepseek-ai/dsh-plugin-manager'

/**
 * 允许自助更新的公共 registry（规范形式），直接取自 Task 1 的固定发现源 —— 不再维护第二张表。
 *
 * 用的不是 Plugin Manager 的 registry 工具（那是它的内部策略，不在本插件的契约里），
 * 只是"这两个固定地址 + 最小安全识别"。
 */
const PUBLIC_REGISTRIES: readonly (string | null)[] = UPDATE_SOURCES.map((source) =>
  publicRegistryKey(source.registryUrl),
)

/**
 * 把一个地址规范化成可比较的 registry 根（scheme + host + 根路径，主机小写、结尾带 `/`）。
 *
 * 返回 `null` 表示"绝不可能是那两个固定公共源"，覆盖：
 * 解析失败（裸主机名）、非 http(s)、带用户名/密码、带查询或片段、非根路径、端口不同。
 * 这么严是因为它决定"要不要访问公共源"与"要不要允许自助安装"：宁可判成企业源走人工，
 * 也不能把 `registry.npmjs.org.evil.example` 或 `https://user:pass@registry.npmjs.org/` 当成公共源。
 */
function publicRegistryKey(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // 相对地址 / 裸主机名：无从确认，按不可信处理。
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.search !== '' || parsed.hash !== '') return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  // WHATWG 解析器已把主机名小写化；这里只补结尾斜杠。
  return `${parsed.protocol}//${parsed.host}/`
}

function isPublicRegistry(value: string): boolean {
  const key = publicRegistryKey(value)
  return key !== null && PUBLIC_REGISTRIES.includes(key)
}

/**
 * profile 是否只由公共 registry 组成。
 *
 * 只要**任何一处**出现非公共地址（显式 primary、pnpm 实际解析出的 `resolved`、fallback 列表），
 * 就判为不可自助更新：既不绕过企业源去问公共 registry，也不把私有地址带出这一层。
 */
function isPublicProfile(profile: PluginRegistries): boolean {
  if (profile.registry === null) {
    // 没有显式 primary：pnpm 实际用的是 `resolved`；读不出来（null）就 fail closed。
    if (profile.resolved === null) return false
    if (!isPublicRegistry(profile.resolved)) return false
  } else if (!isPublicRegistry(profile.registry)) {
    return false
  }
  // pnpm 自己配置里的地址同样必须是公共源：否则 profile 可能从它那里取包。
  if (profile.resolved !== null && !isPublicRegistry(profile.resolved)) return false
  return profile.fallbackRegistries.every((registry) => isPublicRegistry(registry))
}

/**
 * 失败归因 → 线协议错误分类（确定性优先级，最"可归因"的排在前面）。
 *
 * - 全部源都 404 才算 `not-found`：只有一个源说"没有这个包"时，更可能是那个源没同步；
 * - 有源超时 → `timeout`（重试有意义）；
 * - 有源网络/HTTP 故障 → `network`；
 * - 有源正文超限 → `too-large`；
 * - 有源返回非法 JSON / 非法元数据 → `invalid-metadata`；
 * - 归因拿不到（列表为空、全是未知形态）→ `unknown`。
 */
function classifyFailures(failures: readonly RegistryFailure[]): UpdateCheckErrorKind {
  if (failures.length === 0) return 'unknown'
  if (failures.every((failure) => failure.kind === 'http' && failure.status === 404)) return 'not-found'
  if (failures.some((failure) => failure.kind === 'timeout')) return 'timeout'
  if (failures.some((failure) => failure.kind === 'network' || failure.kind === 'http')) return 'network'
  if (failures.some((failure) => failure.kind === 'too-large')) return 'too-large'
  if (failures.some((failure) => failure.kind === 'invalid-json' || failure.kind === 'invalid-metadata')) {
    return 'invalid-metadata'
  }
  return 'unknown'
}

/** 成功源里最高的**合法稳定版**；拿不到（缺失 / 非法 / 预发布）返回 null，交由调用方 fail closed。 */
function highestStableVersion(successes: readonly RegistrySourceOutcome[]): string | null {
  let best: string | null = null
  for (const source of successes) {
    const raw = source.latestVersion
    if (raw === undefined) continue
    const version = valid(raw)
    if (version === null) continue
    if (prerelease(version) !== null) continue
    if (best === null || compare(version, best) > 0) best = version
  }
  return best
}

/** 支持门禁结论：能查 / 不能查（带稳定原因）/ 这次判定本身失败（可退避重试）。 */
type SupportVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unsupported'; readonly reason: UpdateUnsupportedReason }
  | { readonly kind: 'failed' }

/**
 * 创建一个**实例级**检查器。
 *
 * 缓存、失败退避与单飞都活在这个闭包里：没有模块级可变状态，因此同一进程里两个插件实例
 * （或两次测试）互不影响，也不会把上一次的 profile 结论带给下一次。
 */
export function createUpdateChecker(ports: UpdateCheckPorts): UpdateChecker {
  /** 对外结论（唯一写入点是下面的几个 store/record 函数）。 */
  let state: UpdateCheckState = { status: 'idle' }
  /** 最近一次**成功**结论 + 它的授权窗口（过期后仍可作历史展示）。 */
  let success: { readonly state: UpdateCheckState; readonly expiresAtMs: number } | null = null
  /** 最近一次**上游/基础设施失败**：只作退避判据，unsupported 不写它。 */
  let failure: { readonly kind: UpdateCheckErrorKind; readonly checkedAt: string; readonly atMs: number } | null = null
  /** 单飞：同一实例上并发的检查共享同一次上游往返。 */
  let inflight: Promise<UpdateCheckState> | null = null

  const discover: UpdateDiscoveryFn =
    ports.discover ??
    ((currentVersion) =>
      // 缺省发现就是 Task 1 的固定两源实现；真实 fetch 在这里才第一次出现。
      discoverLatestVersion(currentVersion, { fetch: (url, init) => fetch(url, init), now: ports.now }))

  /** 读一次 profile 策略；`failed` 表示这次判定没做成（可退避重试，不等于企业源）。 */
  async function supportVerdict(): Promise<SupportVerdict> {
    if (ports.buildKind === 'dev') return { kind: 'unsupported', reason: 'development-install' }
    if (ports.registries === undefined) return { kind: 'unsupported', reason: 'manager-unavailable' }
    let profile: PluginRegistries
    try {
      profile = await ports.registries()
    } catch {
      // pnpm/profile 读不出来是**基础设施失败**，不是"企业源"：按可重试失败处理，
      // 这样 profile 一时的读取故障不会把自助更新永久关掉。
      return { kind: 'failed' }
    }
    return isPublicProfile(profile) ? { kind: 'ok' } : { kind: 'unsupported', reason: 'enterprise-registry' }
  }

  /** 6 小时内的成功结论：命中即不读 profile、不打上游。 */
  function cacheHit(): UpdateCheckState | null {
    if (success === null) return null
    return ports.now().getTime() < success.expiresAtMs ? success.state : null
  }

  /** 10 分钟失败退避窗口内不再访问上游。 */
  function inBackoff(): boolean {
    if (failure === null) return false
    return ports.now().getTime() - failure.atMs < UPDATE_FAILURE_BACKOFF_MS
  }

  /** 进入"正在检查"：把上一次的候选作为 `cached` 带出去，界面不至于瞬间丢失"有更新"。 */
  function markChecking(): void {
    const cached =
      success !== null && success.state.status === 'available' ? success.state.candidate : undefined
    state = cached === undefined ? { status: 'checking' } : { status: 'checking', cached }
  }

  function storeAvailable(candidate: UpdateCandidate): UpdateCheckState {
    const expiresAtMs = expiryOf(candidate)
    const next: UpdateCheckState = { status: 'available', candidate, checkedAt: candidate.checkedAt }
    success = { state: next, expiresAtMs }
    failure = null
    state = next
    return next
  }

  /** 授权窗口以候选自己的 `expiresAt` 为准（Task 1 已用 `UPDATE_SUCCESS_TTL_MS` 算好）。 */
  function expiryOf(candidate: UpdateCandidate): number {
    const declared = Date.parse(candidate.expiresAt)
    if (!Number.isNaN(declared)) return declared
    const checkedAt = Date.parse(candidate.checkedAt)
    return (Number.isNaN(checkedAt) ? ports.now().getTime() : checkedAt) + UPDATE_SUCCESS_TTL_MS
  }

  function storeUpToDate(): UpdateCheckState {
    const at = ports.now()
    const next: UpdateCheckState = { status: 'up-to-date', checkedAt: at.toISOString() }
    success = { state: next, expiresAtMs: at.getTime() + UPDATE_SUCCESS_TTL_MS }
    failure = null
    state = next
    return next
  }

  /**
   * 记一次失败并给出**这次要对外报的结论**。
   *
   * 自动检查失败时保留最近一次成功结论（后台失败不打断用户，§9）；手动检查失败必须看得见，
   * 所以 `force` 一律落到 `error`。两种情况都会写退避时间戳，但都不会刷新成功结论的有效期。
   */
  function recordFailure(kind: UpdateCheckErrorKind, force: boolean): UpdateCheckState {
    const at = ports.now()
    failure = { kind, checkedAt: at.toISOString(), atMs: at.getTime() }
    if (!force && success !== null) {
      state = success.state
      return state
    }
    const next: UpdateCheckState = { status: 'error', kind, checkedAt: failure.checkedAt }
    state = next
    return next
  }

  /** 把一次发现结果落到结论上；判据全部在这里，且**不信任**发现结果自洽。 */
  function apply(discovery: UpdateDiscovery, force: boolean): UpdateCheckState {
    const successes = discovery.sources.filter((source) => source.latestVersion !== undefined)
    // 一个可用版本都没有（两个源都失败）→ 错误，绝不是"已是最新"。
    if (discovery.candidate === undefined && successes.length === 0) {
      const failures = discovery.sources.flatMap((source) =>
        source.failure === undefined ? [] : [source.failure],
      )
      return recordFailure(classifyFailures(failures), force)
    }
    // 当前版本不是合法 SemVer：无从比较，fail closed（尤其**不能**报"已是最新"）。
    const current = valid(ports.version)
    if (current === null) return recordFailure('unknown', force)

    if (discovery.candidate !== undefined) {
      // 候选自身也要过一遍：非法或并不高于当前版本时不能变成 available（防降级）。
      const target = valid(discovery.candidate.targetVersion)
      if (target === null || compare(target, current) <= 0) return recordFailure('unknown', force)
      return storeAvailable(discovery.candidate)
    }

    // 没有候选：只有"至少一个源成功，且拿到的最高稳定版不高于当前版本"才允许 up-to-date。
    const highest = highestStableVersion(successes)
    if (highest === null || compare(highest, current) > 0) return recordFailure('unknown', force)
    return storeUpToDate()
  }

  async function run(force: boolean): Promise<UpdateCheckState> {
    const verdict = await supportVerdict()
    if (verdict.kind === 'unsupported') {
      // 不支持时清掉全部授权痕迹：profile 可能刚从公共源切到企业源。
      success = null
      failure = null
      state = { status: 'unsupported', reason: verdict.reason }
      return state
    }
    if (verdict.kind === 'failed') return recordFailure('unknown', force)

    let discovery: UpdateDiscovery
    try {
      discovery = await discover(ports.version)
    } catch {
      // 注入点抛出（正常实现不会）也只算一次失败：异常消息不进任何返回值。
      return recordFailure('unknown', force)
    }
    return apply(discovery, force)
  }

  return {
    status() {
      return state
    },

    async check(options: UpdateCheckOptions = {}) {
      const force = options.force === true
      // 单飞：并发调用（含"自动 + 手动"同时到达）共享同一次上游往返，得到同一结论。
      if (inflight !== null) return inflight
      if (!force) {
        const cached = cacheHit()
        if (cached !== null) return cached
        // 退避窗口内不碰上游：返回上一次的结论（保留的旧成功结果，或上一次的错误）。
        if (inBackoff()) return state
      }
      markChecking()
      const promise = run(force)
      inflight = promise
      try {
        return await promise
      } finally {
        inflight = null
      }
    },

    installableCandidate() {
      if (success === null || success.state.status !== 'available') return undefined
      const candidate = success.state.candidate
      // 授权判据是**此刻**重判 expiresAt：过期候选只能展示，不能被安装服务取走。
      return Date.parse(candidate.expiresAt) > ports.now().getTime() ? candidate : undefined
    },
  }
}
