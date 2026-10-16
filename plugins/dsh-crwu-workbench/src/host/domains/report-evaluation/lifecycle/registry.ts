import { text } from '../../../../shared/utils/value.ts'
import {
  advance,
  emptyArtifacts,
  emptyProgress,
  isTerminalPhase,
  type ProviderState,
  type RecordPatch,
  type ValuationPhase,
  type ValuationRecord,
} from './state.ts'
import type { ValuationMethod } from '../scope.ts'

/**
 * 进程内的**估值轮次注册表**。
 *
 * 三个约束：
 *
 * 1. **随插件生命周期**：实例在 `apply()` 里造出来交给操作表与 Tool 闭包，插件卸载即消失。
 *    跨进程重启后旧会话拿不到任何轮次 —— 那是刻意的（重启后宿主记录不可信）。
 * 2. **有界**：员工可能连开很多轮而不结束。超过上限按 `updatedAt` 淘汰最旧的；
 *    被淘汰的轮次**不是**"已完成"，所以淘汰时把它标成 `failed` 并写明原因，
 *    而不是让它悄悄消失（界面上一条正在跑的轮次凭空不见比一条失败的更糟）。
 * 3. **只增不改身份**：`valuationId` 是主键；同一个 id 重复 `open` 视为编程错误（抛错），
 *    因为"复用同一个 id 开两轮"必然导致两轮抢同一个案例目录。
 */

export interface RegistryOptions {
  /** 上限；缺省 32。 */
  maxEntries?: number
  /** 时钟（测试可注入）。 */
  now?: () => number
}

export interface OpenOutcome {
  ok: boolean
  error: string
  record?: ValuationRecord
}

export class ValuationLifecycles {
  private readonly records = new Map<string, ValuationRecord>()
  private readonly maxEntries: number
  private readonly clock: () => number

  // 显式字段而不是构造函数参数属性：测试用 Node 原生**剥离类型**加载 `.ts`，
  // 参数属性不在剥离范围内（会直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
  constructor(options: RegistryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 32)
    this.clock = options.now ?? (() => Date.now())
  }

  /** 开一轮：`draft` 起步（资料还没提取）。同 id 重复开是错误。 */
  open(input: {
    valuationId: string
    casePath: string
    workspaceId: string
    workspacePath: string
    method: ValuationMethod
    baseDate: string
    digest: string
    supplementalPrompt?: string
    sessionId?: string
  }): OpenOutcome {
    const valuationId = text(input.valuationId).trim()
    if (valuationId === '') return { ok: false, error: '缺少估值 ID：不能开一轮没有身份的估值' }
    if (this.records.has(valuationId)) {
      return { ok: false, error: `估值 ID 已被占用：${valuationId}（同一 ID 不能开两轮 —— 两轮会抢同一个案例目录）` }
    }
    const now = this.clock()
    const record: ValuationRecord = {
      valuationId,
      phase: 'draft',
      casePath: text(input.casePath),
      sessionId: text(input.sessionId),
      workspaceId: text(input.workspaceId),
      workspacePath: text(input.workspacePath),
      method: input.method,
      baseDate: text(input.baseDate),
      supplementalPrompt: text(input.supplementalPrompt),
      digest: text(input.digest),
      createdAt: now,
      updatedAt: now,
      progress: emptyProgress(),
      providerStates: {},
      error: '',
      capabilityGaps: [],
      artifacts: emptyArtifacts(),
    }
    this.records.set(valuationId, record)
    this.prune()
    return { ok: true, error: '', record }
  }

  get(valuationId: string): ValuationRecord | undefined {
    return this.records.get(text(valuationId))
  }

  /** 按会话反查（子会话调 Tool 时用它确认"我这一轮"）。 */
  bySession(sessionId: string): ValuationRecord | undefined {
    const id = text(sessionId)
    if (id === '') return undefined
    for (const record of this.records.values()) {
      if (record.sessionId === id) return record
    }
    return undefined
  }

  /** 最新的在前（界面只需要最近几轮）。 */
  list(): ValuationRecord[] {
    return [...this.records.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get size(): number {
    return this.records.size
  }

  /** 推进一轮；非法转移不改动记录。 */
  update(valuationId: string, to: ValuationPhase, patch: RecordPatch = {}): { ok: boolean; error: string; record?: ValuationRecord } {
    const record = this.get(valuationId)
    if (record === undefined) return { ok: false, error: `没有这一轮估值：${text(valuationId) || '（空 ID）'}` }
    const outcome = advance(record, to, patch, this.clock())
    if (!outcome.ok) return { ok: false, error: outcome.reason, record }
    this.records.set(record.valuationId, outcome.record)
    return { ok: true, error: '', record: outcome.record }
  }

  /**
   * 取消一轮。
   *
   * 终态不可取消（已经完成的轮次"取消"没有意义，反而会把交付件的状态说成未完成）。
   */
  cancel(valuationId: string, reason = '用户取消了本轮估值'): { ok: boolean; error: string; record?: ValuationRecord } {
    return this.update(valuationId, 'cancelled', { error: text(reason) })
  }

  /** 记一次来源状态（`ValuationRecord.providerStates` 就来自它）。 */
  setProviderState(valuationId: string, providerId: string, state: ProviderState): { ok: boolean; error: string } {
    const record = this.get(valuationId)
    if (record === undefined) return { ok: false, error: `没有这一轮估值：${text(valuationId)}` }
    this.records.set(record.valuationId, {
      ...record,
      providerStates: { ...record.providerStates, [text(providerId)]: state },
      updatedAt: this.clock(),
    })
    return { ok: true, error: '' }
  }

  /**
   * 记一次**交付校验**的结论（§9）。
   *
   * 单独一个方法而不是复用 `update`：调用方（`crwu_valuation_artifact_validate`）手上
   * 没有、也不该有轮次阶段的概念 —— 它只知道自己跑过两道校验、结论是什么。
   */
  setValidation(
    valuationId: string,
    passed: boolean,
    problems: readonly string[] = [],
  ): { ok: boolean; error: string } {
    const record = this.get(valuationId)
    if (record === undefined) return { ok: false, error: `没有这一轮估值：${text(valuationId)}` }
    const written = this.update(valuationId, record.phase, {
      validationPassed: passed,
      validationProblems: problems,
    })
    return { ok: written.ok, error: written.error }
  }

  /** 记一条能力缺口（去重）。 */
  addCapabilityGap(valuationId: string, gap: string): { ok: boolean; error: string } {
    const item = text(gap).trim()
    if (item === '') return { ok: true, error: '' }
    const record = this.get(valuationId)
    if (record === undefined) return { ok: false, error: `没有这一轮估值：${text(valuationId)}` }
    if (record.capabilityGaps.includes(item)) return { ok: true, error: '' }
    this.records.set(record.valuationId, {
      ...record,
      capabilityGaps: [...record.capabilityGaps, item],
      updatedAt: this.clock(),
    })
    return { ok: true, error: '' }
  }

  /** 释放一轮（用户关掉结果页 / 插件收尾）。已结束的轮次释放后不再可查。 */
  close(valuationId: string): boolean {
    return this.records.delete(text(valuationId))
  }

  /**
   * 有界淘汰：**先删终态**（它们已经没用了），全都是未结束的轮次时删最旧的那一个。
   *
   * ⚠️ 这里必须真的**删除**，不能"只标成失败"：标记不减少条目数，循环会一路把每一轮都标成
   * 失败（写这条时就是这么错的，用例当场抓住）。被淘汰的轮次在注册表里表现为
   * `known: false` —— 界面据此说"宿主没有这一轮的记录（重启或已被更新的轮次挤掉）"，
   * 那比留一条被改得面目全非的记录更诚实。
   */
  private prune(): void {
    while (this.records.size > this.maxEntries) {
      let victim: ValuationRecord | undefined
      for (const record of this.records.values()) {
        if (!isTerminalPhase(record.phase)) continue
        if (victim === undefined || record.updatedAt < victim.updatedAt) victim = record
      }
      if (victim === undefined) {
        for (const record of this.records.values()) {
          if (victim === undefined || record.updatedAt < victim.updatedAt) victim = record
        }
      }
      if (victim === undefined) return
      this.records.delete(victim.valuationId)
    }
  }
}
