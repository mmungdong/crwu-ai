import { text } from '../../../../shared/utils/value.ts'
import type { ValuationMethod } from '../scope.ts'

/**
 * 估值的**页面 / 轮次状态机**（协议 32）。
 *
 * ```text
 * draft → extracting → confirmation → queued → running → completed
 *                                              ↘ failed / cancelled
 *                                              ↘ browser-login-required → running
 * ```
 *
 * ## 为什么要有显式的转移表
 *
 * 这套状态同时被三个消费者读：面板（阶段条与按钮）、结果页（交付件齐不齐）、
 * 以及用户自己（"现在到底在等谁"）。没有转移表时，任何一处写入都能把状态改成任何值 ——
 * 典型后果是"已经失败的轮次被后续心跳改回 running"，于是界面永远转圈。
 *
 * 所以：**非法转移一律拒绝并给出原因**，由调用方决定是忽略还是报错；
 * 拒绝而不是静默接受，是因为静默接受正是上面那个故障的成因。
 *
 * ⚠️ `stale-host` **不由 Host 返回**：它是客户端发现协议代数不匹配时的页面结论
 *（见 `phaseWithHostProtocol`）。放进枚举是为了让两侧说同一套词，而不是让 Host 去猜。
 */

export type ValuationPhase =
  | 'draft'
  | 'extracting'
  | 'confirmation'
  | 'queued'
  | 'running'
  | 'browser-login-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale-host'

/** 终态：不再接受任何转移（重来要开新一轮）。 */
export const TERMINAL_PHASES: readonly ValuationPhase[] = ['completed', 'failed', 'cancelled']

/** 允许的转移（`→` 右侧是可达状态）。 */
const TRANSITIONS: Record<ValuationPhase, readonly ValuationPhase[]> = {
  draft: ['extracting', 'failed', 'cancelled'],
  // 提取结束进"确认抽屉"；资料一份都没解析出来时直接失败（没有输入就没有估值）。
  extracting: ['confirmation', 'failed', 'cancelled'],
  // 抽屉里"返回修改"回到 draft（重新生成快照）；确认后进 queued。
  confirmation: ['queued', 'draft', 'failed', 'cancelled'],
  queued: ['running', 'failed', 'cancelled'],
  running: ['running', 'completed', 'failed', 'cancelled', 'browser-login-required'],
  // 用户在默认浏览器登录之后"重新检查并继续"→ 回到 running。
  'browser-login-required': ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  // 过期的宿主只能回到草稿：用户重启后用新的宿主重来。
  'stale-host': ['draft'],
}

export function isTerminalPhase(phase: ValuationPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

export interface TransitionCheck {
  ok: boolean
  reason: string
}

/** 这一步转移合法吗。 */
export function canAdvance(from: ValuationPhase, to: ValuationPhase): TransitionCheck {
  if (from === to && !isTerminalPhase(from)) return { ok: true, reason: '' }
  const allowed = TRANSITIONS[from] ?? []
  if (allowed.includes(to)) return { ok: true, reason: '' }
  if (isTerminalPhase(from)) return { ok: false, reason: `已经是终态「${from}」：不再接受状态变化（要重来请开新一轮估值）` }
  return { ok: false, reason: `不允许从「${from}」转到「${to}」（允许：${allowed.join('、') || '无'}）` }
}

/**
 * 按宿主协议代数修正页面阶段。
 *
 * 两侧是**分开加载**的：客户端产物刷新页面就换新，宿主产物只有重启 profile 才换。
 * 协议不一致时页面上的一切事实都不可信，所以整个页面进入 `stale-host` ——
 * 那时唯一该做的事是提示用户重启，而不是继续显示旧的进度。
 */
export function phaseWithHostProtocol(phase: ValuationPhase, protocolMatches: boolean): ValuationPhase {
  return protocolMatches ? phase : 'stale-host'
}

export interface ValuationProgress {
  /** 当前阶段（人话，例如「检索可比案例」）。 */
  stage: string
  /** 这一阶段正在做什么。 */
  detail: string
  completed: number
  total: number
}

export function emptyProgress(): ValuationProgress {
  return { stage: '', detail: '', completed: 0, total: 0 }
}

/**
 * 进度归一化。
 *
 * `completed` 不许超过 `total`：跑过头会让进度条超过 100%，而那是"页面在编进度"的第一个信号。
 * `total <= 0` 时按"不确定总数"处理（都归 0），而不是显示 `3/0`。
 */
export function normalizeProgress(value: Partial<ValuationProgress> | undefined): ValuationProgress {
  const total = typeof value?.total === 'number' && Number.isFinite(value.total) && value.total > 0
    ? Math.trunc(value.total) : 0
  const completedRaw = typeof value?.completed === 'number' && Number.isFinite(value.completed)
    ? Math.trunc(value.completed) : 0
  const completed = total === 0 ? 0 : Math.max(0, Math.min(completedRaw, total))
  return {
    stage: text(value?.stage),
    detail: text(value?.detail),
    completed,
    total,
  }
}

/** 外部来源的运行状态（写进 `valuation-status`，界面据此显示"即将访问的数据源"）。 */
export interface ProviderState {
  state: string
  attempts: number
  detail: string
}

/** 交付件三件套的存在性（结果页与"能不能收工"都读它）。 */
export interface ArtifactPresence {
  html: boolean
  xlsx: boolean
  json: boolean
}

export function emptyArtifacts(): ArtifactPresence {
  return { html: false, xlsx: false, json: false }
}

/** 一轮估值的**进程内**记录。 */
export interface ValuationRecord {
  valuationId: string
  phase: ValuationPhase
  /** `<已选工作区>/<估值 ID>`。 */
  casePath: string
  /** 估值子会话；还没建时为空串。 */
  sessionId: string
  workspaceId: string
  workspacePath: string
  /** 用户选择的方法（`auto` 表示由 AI 判定）。 */
  method: ValuationMethod
  /** 用户确认的基准日；未指定是空串。 */
  baseDate: string
  /**
   * 用户写的补充要求（冻结输入的一部分）。
   *
   * 记在这里是为了**能核对**：`估值输入.json` 是案例目录里的普通文件，估值会话有写权限 ——
   * 不把当时那一份留在宿主内存里，"文件被改过"这件事就永远发现不了。
   */
  supplementalPrompt: string
  /** 冻结输入快照的指纹（确认抽屉确认那一刻算出来的）。 */
  digest: string
  createdAt: number
  updatedAt: number
  progress: ValuationProgress
  providerStates: Record<string, ProviderState>
  error: string
  capabilityGaps: string[]
  artifacts: ArtifactPresence
  /**
   * **交付校验**（工作簿契约 + 结果口径）的结论。
   *
   * §9 要求 `completed` 不能只看"三个文件在不在"：模板被改坏、报告与结果数字对不上，
   * 都必须挡住。校验由子会话调 `crwu_valuation_artifact_validate` 跑（那里才有 Broker 与
   * Python 装配），结论写回这里 —— 于是**完成门槛读得到它**，而不是只能相信模型说"我验过了"。
   *
   * 三态：`undefined` = 还没跑过；`true` = 两道校验都过；`false` = 没过（原因在
   * `validationProblems`，逐条来自校验脚本）。
   */
  validationPassed?: boolean
  /** 校验没通过时的逐条原因（人话，来自两个校验脚本的 stdout）。 */
  validationProblems?: readonly string[]
}

export interface RecordPatch {
  progress?: Partial<ValuationProgress>
  providerStates?: Record<string, ProviderState>
  error?: string
  capabilityGaps?: readonly string[]
  artifacts?: Partial<ArtifactPresence>
  sessionId?: string
  /**
   * 输入快照指纹。
   *
   * 它在**提取完成**时才知道（清单要算完才有指纹），而轮次必须在提取**开始前**就登记 ——
   * 否则提取过程中「取消提取」没有一条记录可取消。所以指纹是后补的，不是开轮次时给的。
   */
  digest?: string
  /** 交付校验的结论（说明见 `ValuationRecord.validationPassed`）。 */
  validationPassed?: boolean
  /** 校验没通过时的逐条原因（人话，来自两个校验脚本的 stdout）。 */
  validationProblems?: readonly string[]
}

export interface AdvanceOutcome {
  ok: boolean
  reason: string
  record: ValuationRecord
}

/**
 * 推进一轮估值。
 *
 * 非法转移**不改动记录**并返回原因（`record` 原样返回），于是调用方可以如实告诉用户
 * "这一轮已经结束了"，而不是把一个已完成的轮次改回 running。
 */
export function advance(record: ValuationRecord, to: ValuationPhase, patch: RecordPatch = {}, now = Date.now()): AdvanceOutcome {
  const check = canAdvance(record.phase, to)
  if (!check.ok) return { ok: false, reason: check.reason, record }
  const gaps = patch.capabilityGaps === undefined
    ? record.capabilityGaps
    : dedupe([...record.capabilityGaps, ...patch.capabilityGaps])
  return {
    ok: true,
    reason: '',
    record: {
      ...record,
      phase: to,
      progress: patch.progress === undefined ? record.progress : normalizeProgress({ ...record.progress, ...patch.progress }),
      providerStates: patch.providerStates === undefined ? record.providerStates : { ...record.providerStates, ...patch.providerStates },
      // `error` 只在**显式**给出时改写：进入 running 不该把上一次的失败理由抹掉，
      // 否则用户看到的是"在跑"，而真实原因是上一轮失败了。
      error: patch.error === undefined ? (isTerminalPhase(to) || to === 'running' ? '' : record.error) : patch.error,
      capabilityGaps: gaps,
      artifacts: patch.artifacts === undefined ? record.artifacts : { ...record.artifacts, ...patch.artifacts },
      sessionId: text(patch.sessionId) || record.sessionId,
      digest: text(patch.digest) || record.digest,
      validationPassed: patch.validationPassed ?? record.validationPassed,
      validationProblems: patch.validationProblems === undefined
        ? record.validationProblems
        : [...patch.validationProblems],
      updatedAt: now,
    },
  }
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const item = text(value).trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
