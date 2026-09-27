import type { Context } from '@deepseek-ai/cordis'
import { ifindCredentialView, readIfindSecret } from './store.ts'
import { defaultIfindTransport, probeIfind, type IfindProbeResult, type IfindTransport } from './mcp.ts'
import type { IfindCheck } from '../environment/probe.ts'

/**
 * 把 iFinD 凭据的事实**翻译成环境自检的一项**。
 *
 * 三条硬规则：
 *
 * 1. **每次环境校验都真的验一次**（2026-09-26 改）：早期的实现默认不探（只有保存后或
 *    显式刷新才探），于是环境页上的「已保存、未验证」既不能回答"现在能不能用"，
 *    也容易让人以为已经验过。现在 `probe` 默认 **true**。
 * 2. **验证 = 真的取一次数据**，不是只走 `initialize + tools/list`：认证通过不代表账号能取数
 *    （配额、权益、参数校验都可能失败）。结论分两截：`ok`（认证）与 `dataVerified`（真的拿到数据）。
 * 3. **iFinD 是必需项**（2026-09-26 产品口径覆盖了旧的 OPT-006-R1 · F-008）：`required` 直接
 *    来自环境清单（`crwu.env-manifest.v4` 的 `ifind.required`，现为 `true`），未通过就是阻塞项 ——
 *    进必需项分母、关闭 global / auditCore / externalData 能力、并让统一导航拦回环境页。
 *
 * ## 为什么要一个短 TTL 缓存
 *
 * 环境自检会被面板反复触发（打开面板、切模块、授权后刷新、点「重新检查」），
 * 每次都打一次外部网络既慢又容易被上游限流。所以 30 秒内复用上一次结论；
 * **用户点「重新检查」传 `force: true` 时一定重探**（那是他明确要求"现在再验一次"）。
 * 缓存只挂在插件实例上，随 Cordis 生命周期释放。
 */
export const IFIND_PROBE_TTL_MS = 30_000

export interface IfindEnvOptions {
  /**
   * 真跑一次校验。**默认 true**（每次环境校验都验）；只有明确传 `false` 才跳过。
   * 留这个开关是为了单测能构造"只读文件"的用例，以及未来需要"只看配置不看网络"的场景。
   */
  probe?: boolean
  /** 忽略缓存、强制重探（用户点「重新检查」时传）。 */
  force?: boolean
  /** 传输替身（测试用）；缺省走 `fetch`（正常 TLS 校验）。 */
  transport?: IfindTransport
  /** 探测超时（测试用短超时）。 */
  timeoutMs?: number
  signal?: AbortSignal
  /** 清单声明的 `ifind.required`（现为 true）；缺省按 true 处理（必需项是当前产品口径）。 */
  required?: boolean
  /** 「获取 API-Key」的官方入口（从清单带过来，只用于界面上的链接）。 */
  applyUrl?: string
  /** 探测结果缓存（插件实例级）；不传就不缓存。 */
  cache?: IfindProbeCache
}

export interface IfindProbeCacheEntry {
  at: number
  result: IfindProbeResult
}

/** 探测结果缓存：键是**明文指纹**（不落盘、不进日志，只用于判断"凭据有没有换"）。 */
export interface IfindProbeCache {
  get(key: string, now: number): IfindProbeResult | null
  set(key: string, result: IfindProbeResult, now: number): void
  /** 命中 / 未命中计数（诊断与测试用；`hits > 0` = 这一次没有打上游）。 */
  readonly stats?: { hits: number; misses: number }
}

/** 指纹：拿凭据做一次轻量散列，避免把明文当 key 存进内存表。 */
export function credentialFingerprint(secret: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < secret.length; index += 1) {
    hash ^= secret.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${(hash >>> 0).toString(36)}-${String(secret.length)}`
}

/**
 * 一个极小的 TTL 缓存（单条）。
 *
 * 为什么单条就够：一台机器同一时刻只会有**一份** iFinD 凭据在用。凭据换了指纹就变，
 * 旧条目自然失效 —— 不需要 LRU，也不需要持久化（进程内即可）。
 */
export function createIfindProbeCache(ttlMs = IFIND_PROBE_TTL_MS, now: () => number = () => Date.now()): IfindProbeCache {
  let entry: (IfindProbeCacheEntry & { key: string }) | null = null
  const stats = { hits: 0, misses: 0 }
  const cache: IfindProbeCache = {
    get(key, at) {
      // 计数只为测试与诊断：`hits` > 0 就说明这一次没有打上游。
      if (entry === null || entry.key !== key || at - entry.at >= ttlMs) {
        stats.misses += 1
        return null
      }
      stats.hits += 1
      return entry.result
    },
    set(key, result, at) {
      entry = { key, result, at }
    },
  }
  return Object.assign(cache, { stats })
}

/** 一次探测结论 → 环境自检的一项（脱敏：只回长度、工具数与一小段数据摘要）。 */
function checkOf(view: Awaited<ReturnType<typeof ifindCredentialView>>, probe: IfindProbeResult,
                 applyUrl: string, required: boolean): IfindCheck {
  return {
    path: view.path,
    required,
    ok: probe.ok,
    // 认证通过但**没取到数据**时必须落到 `unverified`：界面上"未验证"是琥珀色、
    // 并给出"点重新验证 / 找管理员确认权益"的处置；`unreachable` 会被读成服务故障。
    // `errorKind` 仍然如实保留（credential / entitlement / infrastructure），所以归因不会丢。
    state: probe.ok && probe.dataVerified !== true ? 'unverified' : probe.state,
    errorKind: probe.errorKind === 'unconfigured' ? '' : probe.errorKind,
    reason: probe.error,
    tokenLength: view.length,
    checkedAt: probe.checkedAt,
    toolCount: probe.toolCount,
    dataVerified: probe.dataVerified,
    dataTool: probe.dataTool,
    dataSample: probe.dataSample,
    applyUrl,
  }
}

export async function ifindEnvCheck(
  ctx: Context,
  home: string,
  options: IfindEnvOptions = {},
): Promise<IfindCheck> {
  const view = await ifindCredentialView(ctx, home)
  const required = options.required !== false
  const base: IfindCheck = {
    path: view.path,
    required,
    ok: false,
    state: view.exists ? (view.state === 'invalid' ? 'invalid' : 'unverified') : 'unconfigured',
    errorKind: '',
    reason: view.reason,
    tokenLength: view.length,
    checkedAt: '',
    toolCount: 0,
    dataVerified: false,
    dataTool: '',
    dataSample: '',
    applyUrl: options.applyUrl ?? '',
  }
  if (!view.exists) {
    return { ...base, state: 'unconfigured', reason: view.reason || '还没有保存 iFinD API-Key', errorKind: '' }
  }
  if (view.state === 'invalid') {
    return { ...base, state: 'invalid', errorKind: 'credential', reason: view.reason }
  }
  // 默认就验；只有明确 `probe: false` 才跳过（例如"只看配置状态"的诊断路径）。
  if (options.probe === false) return base

  // 真探：读一次明文（**只在 Host 内部**），走与取数 Tool 同一份协议实现。
  const secret = await readIfindSecret(ctx, home)
  if (!secret.ok) {
    return { ...base, state: secret.state === 'invalid' ? 'invalid' : 'unreachable', errorKind: secret.errorKind, reason: secret.reason }
  }
  const fingerprint = credentialFingerprint(secret.secret)
  const now = Date.now()
  if (options.force !== true && options.cache !== undefined) {
    const cached = options.cache.get(fingerprint, now)
    if (cached !== null) return checkOf(view, cached, options.applyUrl ?? '', required)
  }
  const probe = await probeIfind(options.transport ?? defaultIfindTransport(), secret.secret, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // 环境校验要的是"能不能取到数据"，所以每次都真的取一次。
    data: true,
  })
  options.cache?.set(fingerprint, probe, now)
  return checkOf(view, probe, options.applyUrl ?? '', required)
}
