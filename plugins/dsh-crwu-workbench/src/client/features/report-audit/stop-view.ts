/**
 * 停止审核的**展示口径**（F2）。
 *
 * 为什么是纯函数：这段口径决定"用户看到什么、哪些按钮能点"，而它必须能被单测穷举
 *（requested / aborting / waiting / quiesced / timeout / failed / 缺字段）。放进组件里就只能靠
 * 渲染测试间接覆盖，且很容易在改样式时被顺带改坏。
 *
 * ⚠️ 三条硬口径：
 * 1. `canStartNext` **只信 Host**（`stop.canStartNext`）；字段缺失按"未知"处理，
 *    **绝不**由 `status !== 'running'` 之类的客户端推断得出；
 * 2. timeout / failed **不许**显示成"已停止"，也不许让"重新审核"变得可点；
 * 3. 等待期间必须有阶段文案与已等待时长，不许退回笼统的"处理中"。
 */
import type { AuditStopPhase, AuditStopView } from '../../../shared/types.ts'
import { zhCN } from '../../locales/zh-CN.ts'

export type StopTone = 'info' | 'warn' | 'error' | 'success'

export interface StopActions {
  /** 「继续等待」：只是刷新状态，不会再发起停止。 */
  keepWaiting: boolean
  /** 「再次停止」：允许再发一次 stop RPC（Host 侧幂等）。 */
  stopAgain: boolean
  openSession: boolean
  copyDiagnostics: boolean
}

export interface StopPresentation {
  phase: AuditStopPhase
  /** 宿主是否回报了停止状态。false = 未知（旧宿主），不许推断。 */
  known: boolean
  tone: StopTone
  /** 阶段主文案。 */
  label: string
  /** 后果说明（"不能启动新的审核" / "已保留占用"这类）。 */
  hint: string
  /** 是否处于等待中（决定要不要转圈/禁用并发按钮）。 */
  busy: boolean
  /** 停止按钮是否应当禁用（等待期间禁用：Host 也幂等，但界面不该鼓励连点）。 */
  stopDisabled: boolean
  /** 能不能启动下一条 —— 只信 Host。 */
  canStartNext: boolean
  /** 已等待时长文案（空 = 不显示）。 */
  elapsedText: string
  /** 等待预算文案。 */
  waitHint: string
  /** 非阻塞观察（Host 回报的 notes，例如"dispose 超时但 Agent 已不在运行"）。 */
  notes: string[]
  actions: StopActions
}

const PHASE_LABEL: Record<AuditStopPhase, string> = {
  idle: '',
  requested: zhCN.stopPhaseRequested,
  aborting: zhCN.stopPhaseAborting,
  'waiting-quiescence': zhCN.stopPhaseWaiting,
  quiesced: zhCN.stopPhaseQuiesced,
  timeout: zhCN.stopPhaseTimeout,
  failed: zhCN.stopPhaseFailed,
}

const BUSY_PHASES: AuditStopPhase[] = ['requested', 'aborting', 'waiting-quiescence']

/** 等待超过这个秒数就把文案换成"仍在等待…，请勿启动新的审核"。 */
const STILL_WAITING_AFTER_MS = 3_000

export function stopPresentationOf(input: {
  stop?: AuditStopView | undefined
  /** 界面本地记下的"我刚点过停止"的时刻（0 = 没点过）。 */
  requestedAt?: number
  /** 当前时间（调用方注入，便于测试）。 */
  now: number
}): StopPresentation {
  const stop = input.stop
  const known = stop !== undefined
  const localRequested = typeof input.requestedAt === 'number' ? input.requestedAt : 0
  const requestedAt = Math.max(stop?.requestedAt ?? 0, localRequested)
  const elapsedMs = requestedAt === 0 ? 0 : Math.max(stop?.elapsedMs ?? 0, input.now - requestedAt)
  const elapsedSeconds = Math.floor(elapsedMs / 1_000)

  // 阶段：宿主没回报时，用"本地刚点过停止"兜住那一刻的即时反馈（F1 的 100ms 要求）。
  // 本地兜底**只**能把 idle 提升到 requested，绝不允许声称 quiesced。
  const rawPhase: AuditStopPhase = known ? (stop.phase ?? 'idle') : 'idle'
  const phase: AuditStopPhase = rawPhase === 'idle' && localRequested !== 0 ? 'requested' : rawPhase

  const busy = BUSY_PHASES.includes(phase)
  const stillWaiting = busy && elapsedMs >= STILL_WAITING_AFTER_MS
  const label = stillWaiting && phase === 'waiting-quiescence'
    ? zhCN.stopPhaseStillWaiting
    : PHASE_LABEL[phase]

  const tone: StopTone = phase === 'quiesced'
    ? 'success'
    : (phase === 'timeout' || phase === 'failed' ? 'error' : (busy ? 'info' : 'warn'))

  const hint = phase === 'timeout' || phase === 'failed'
    ? `${stop?.error === undefined || stop.error === '' ? '' : `${stop.error} `}${zhCN.stopNoRestartHint}${zhCN.stopKeptHint}`
    : (busy ? zhCN.stopNoRestartHint : (known ? '' : zhCN.stopUnknownHint))

  return {
    phase,
    known,
    tone,
    label,
    hint,
    busy,
    stopDisabled: busy,
    // **只信 Host**：缺字段 → false（未知不等于可以启动）。
    canStartNext: stop?.canStartNext === true,
    elapsedText: busy && elapsedSeconds > 0 ? `${zhCN.stopElapsedPrefix}${elapsedSeconds}${zhCN.stopElapsedSuffix}` : '',
    waitHint: busy ? zhCN.stopWaitBudget : '',
    notes: Array.isArray(stop?.notes) ? stop.notes : [],
    actions: {
      // 动作集按用户口径分开（F2）：timeout 给"继续等待 / 再次停止"，
      // failed 只给"打开当前会话 / 复制诊断" —— 重试停止仍可用主按钮（它没有被禁用）。
      keepWaiting: phase === 'timeout',
      stopAgain: phase === 'timeout',
      openSession: phase === 'timeout' || phase === 'failed',
      copyDiagnostics: phase === 'timeout' || phase === 'failed',
    },
  }
}
