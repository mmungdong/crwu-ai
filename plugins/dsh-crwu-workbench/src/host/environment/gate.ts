import { text } from '../../shared/utils/value.ts'
import type { EnvironmentStateView } from '../../shared/environment/model.ts'
import { statusProceedable } from '../../shared/environment/model.ts'

/**
 * Host 侧的**能力门禁**。
 *
 * ## 为什么不能只靠 Client
 *
 * 界面上的门禁只负责体验（别让员工白点一次），它拦不住任何真实调用：同源 HTTP 路由是公开契约，
 * 任何客户端、任何脚本都能直接 POST `audit-start`。所以**真实性判据必须在 Host 这一侧**，
 * 而且必须与界面用的是**同一个模型**（`shared/environment/model.ts`）—— 两套判据迟早会漂移，
 * 表现就是"界面说没配好、Host 放行"或者反过来。
 *
 * ## 为什么不当场重跑一次完整自检
 *
 * 一次自检要：stat 三个二进制 + 解析 DSH 运行时（一次 Tool 调用）+ 跑 `crwu h3yun session status`
 * + 跑 `dws auth status`（要提权）+ 列一次 OSS。把它挂在每个敏感操作前面，既慢又会反复打外部服务
 * （还会撞上审批弹窗）。
 *
 * 所以这里用的是**带失效策略的快照**：
 *
 * - 快照由 `env` / 能力检查落盘在插件实例里（进程内存，随 Cordis 生命周期释放）；
 * - `isFresh(now)` 按 TTL（默认 60s）判断；过期就**重新跑一次自检**（不是"当作通过"）；
 * - `invalidate()` 在会改变环境事实的操作后调用（授权、选工作空间、保存 AK/SK、登录）；
 * - 任何拿不到快照、或自检本身失败的情况一律 **fail closed**（拒绝执行并说明原因）。
 */

/** 快照默认有效期（毫秒）。60s 是"员工刚点完按钮再点下一个"的尺度。 */
export const GATE_SNAPSHOT_TTL_MS = 60_000

export interface CapabilitySnapshot {
  state: EnvironmentStateView
  /** 快照落盘时刻（`Date.now()`）。 */
  at: number
  /** 要不要把刷新参数透给自检（界面「重新检查」传 true）。 */
  refresh: boolean
}

/** 跑一次自检：返回 `null` 表示自检本身没跑成（调用方必须按不放行处理）。 */
export type EnvironmentLoader = (options: { refresh: boolean }) => Promise<EnvironmentStateView | null>

export interface CapabilityGate {
  /** 拿快照；过期或缺失时按需重跑一次自检。 */
  snapshot(options?: { force?: boolean }): Promise<CapabilitySnapshot | null>
  /** 显式作废（授权、选工作空间、保存凭据、登录成功之后调用）。 */
  invalidate(): void
  /** 只读当前快照（不发请求）；测试与诊断用。 */
  peek(): CapabilitySnapshot | null
}

export function createCapabilityGate(
  load: EnvironmentLoader,
  options: { ttlMs?: number; now?: () => number } = {},
): CapabilityGate {
  const ttl = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : GATE_SNAPSHOT_TTL_MS
  const now = options.now ?? (() => Date.now())
  let cached: CapabilitySnapshot | null = null
  // 并发去重：两个操作同时进来只跑一次自检（否则一次冷启动会打出两轮 shell 探测）。
  let inflight: Promise<CapabilitySnapshot | null> | null = null

  return {
    peek: () => cached,
    invalidate: () => { cached = null },
    async snapshot(request = {}) {
      const at = now()
      if (request.force !== true && cached !== null && at - cached.at < ttl) return cached
      if (inflight !== null) return await inflight
      inflight = (async () => {
        try {
          const state = await load({ refresh: request.force === true })
          if (state === null) return null
          cached = { state, at: now(), refresh: request.force === true }
          return cached
        } catch (error) {
          // 自检抛错 = 拿不到事实：**不缓存**，让下一次调用还能重试。
          void error
          return null
        } finally {
          inflight = null
        }
      })()
      return await inflight
    },
  }
}

/** 敏感操作要判的能力。 */
export type GateCapability = 'global' | 'auditCore' | 'delivery'

export interface GateDecision {
  allowed: boolean
  /** 拒绝原因（人话，含归属与处置）。 */
  reason: string
  /** 依据的总状态（拿不到快照时是 `check-failed`）。 */
  status: string
}

const CAPABILITY_LABEL: Record<GateCapability, string> = {
  global: '工作台尚未就绪',
  auditCore: '报告审核尚未就绪',
  delivery: '交付回传尚未就绪',
}

/**
 * 判定一次敏感操作能不能做。
 *
 * `check-failed` / `unknown`（含"拿不到快照"）**一律拒绝**：宁可让员工点一次「重新检查」，
 * 也不能在一次系统故障上放行真实写入（审核会写案例目录、传 OSS）。
 */
export function decideCapability(
  snapshot: CapabilitySnapshot | null,
  capability: GateCapability,
): GateDecision {
  if (snapshot === null) {
    return { allowed: false, status: 'check-failed',
      reason: '环境自检没有跑成，无法确认运行条件：请在环境信息页点「重新检查环境」后重试。' }
  }
  const state = snapshot.state
  if (!statusProceedable(state.status)) {
    const blockers = state.blocked.length === 0 ? '' : `：${state.blocked.join('；')}`
    return { allowed: false, status: state.status,
      reason: `${CAPABILITY_LABEL[capability]}（当前状态：${state.status}）${blockers}。请在环境信息页逐项处理。` }
  }
  if (state.capabilities[capability] !== true) {
    const scopes: Record<GateCapability, string> = {
      global: 'global', auditCore: 'audit', delivery: 'delivery',
    }
    const blockers = state.issues
      .filter((issue) => issue.blocking === true && issue.scope === scopes[capability])
      .map((issue) => issue.message)
    return { allowed: false, status: state.status,
      reason: `${CAPABILITY_LABEL[capability]}${blockers.length === 0 ? '' : `：${blockers.join('；')}`}。请在环境信息页逐项处理。` }
  }
  return { allowed: true, reason: '', status: state.status }
}

/**
 * 敏感操作的**必需判据表**（一处声明，改动时不会漏掉某个操作）。
 *
 * `audit-start` 至少覆盖：工作空间、凭据授权、包内能力、DSH Runtime、必需 Tool、氚云、钉钉、
 * OSS —— 这些都在 `env` 的必需项里，所以判 `auditCore` 一项就够。这正是"不为每个操作重复跑
 * 一遍昂贵自检"能成立的原因：判据是**同一份快照**。
 *
 * ## 有意**不**在这里的操作（改之前先想清楚）
 *
 * - `audit-stop` / `audit-release`：停止审核与释放占用锁是**安全出口**。环境刚坏（AK 被撤、
 *   登录过期）时更要能停能放，判门禁会把人锁死在外面，只能重启 profile。
 * - `oss-cred-save` / `ifind-credential-save` / `trust` / `workspace`：它们是**修复动作本身**，
 *   判门禁会形成"配不好就不让配"的死锁。
 * - `oss-upload` 判 `delivery` 是刻意保留的：上传要真的写远端对象，不能靠界面自律。
 */
export const OPERATION_CAPABILITY: Record<string, GateCapability> = {
  'audit-start': 'auditCore',
  'oss-upload': 'delivery',
}

/** 取一个操作的门禁要求；不敏感的操作返回 null（不做判断）。 */
export function capabilityForOperation(operation: string): GateCapability | null {
  return OPERATION_CAPABILITY[text(operation)] ?? null
}

/**
 * 把门禁接到宿主的一个操作上。
 *
 * 返回 `null` 表示放行；否则返回**给客户端看的失败信封**（与既有操作一致的形状）。
 */
export async function guardOperation(
  gate: CapabilityGate,
  operation: string,
): Promise<Record<string, unknown> | null> {
  const capability = capabilityForOperation(operation)
  if (capability === null) return null
  const decision = decideCapability(await gate.snapshot(), capability)
  if (decision.allowed) return null
  return { ok: false, error: decision.reason, gateStatus: decision.status, gateBlocked: true }
}
