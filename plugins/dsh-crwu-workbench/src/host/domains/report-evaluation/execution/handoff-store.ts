import { text } from '../../../../shared/utils/value.ts'
import type { CreationDisposition } from '../../../../shared/contracts/report-evaluation.ts'
import type { FailureEnvelope, HandoffReceipt } from '../../../../shared/contracts/valuation-project.ts'
import { canonicalJson } from '../../../tools/common/snapshot.ts'

/**
 * 父会话交接的**持久化状态机**（计划 Task 2 · 设计稿 §5）。
 *
 * ## 为什么必须有它，而不是"建完会话就完了"
 *
 * 员工双击「开始估值」、或者 RPC 超时后点「重试」时，宿主看到的是**两次独立调用**。
 * 没有状态机的话，两次调用都会各自 `createSession(...)` —— 结果是两条空会话、
 * 两条固定指令，而界面上只显示一条。所以：
 *
 * - **同一 requestId 互斥**：第二次调用等第一次的结果（拿到的是同一份回执）；
 * - **同一 previewId 只能成功交接一次**：换一个 requestId 再来会被拒（让员工重新准备资料，
 *   而不是悄悄开第二条会话）；
 * - **状态先在内存里同步落定，再整份持久化**：落盘失败就**不前进**（回滚），
 *   于是"宿主说 handed-off"永远意味着磁盘上也写着 handed-off。
 *
 * ## 三条状态
 *
 * | 状态 | 含义 | 重试时的行为 |
 * | --- | --- | --- |
 * | `pending` | 已认领，还没建出父会话 | 重建（上一轮什么都没落下） |
 * | `created` | 父会话已建好，指令还没被确认受理 | **复用**同一个 `parentSessionId` |
 * | `dispatched` | 指令已受理（终态） | 直接回同一份回执（`reused: true`） |
 *
 * ## 一个必须说清楚的口径：这里的"原子"
 *
 * Broker 的封闭操作表里**没有**改名/替换操作，所以做不到"写临时文件再 rename"那种文件系统级原子。
 * 这里做的是：**整份文档一次写完 + 回读校验 + 只有成功才推进内存状态**。
 * 也就是说不会出现"内存说 dispatched、磁盘停在 pending"，但**不会**保证磁盘上那一份
 * 在任何时刻都不曾是半截文件（writeText 是同一次调用完成的）。这个上限是本任务如实记下的缺口。
 */

/** 交接记录在项目目录里的固定文件名。 */
export const HANDOFF_RECORD_FILE = '交接记录.json'

/** 交接记录的 Schema 版本（`交接记录.json` 是给维护者看的，不参与模型可见合同）。 */
export const HANDOFF_RECORD_SCHEMA_VERSION = 'crwu.valuation.handoff.v1'

export type HandoffState = 'pending' | 'created' | 'dispatched'

export interface HandoffRecord {
  schemaVersion: string
  requestId: string
  previewId: string
  /** 项目目录名（Host 铸号）。与 `previewId` 同值：一个预览就是一个项目。 */
  projectId: string
  state: HandoffState
  /** 父估值会话 id；`pending` 时是空串。 */
  parentSessionId: string
  /** 指令被受理后的回执；`dispatched` 时非空。 */
  receipt: HandoffReceipt | null
  claimedAt: string
  updatedAt: string
}

/** 交接成功：`HandoffReceipt` + 操作信封。 */
export interface HandoffSuccess {
  ok: true
  errorKind: ''
  error: string
  projectId: string
  parentSessionId: string
  dispatchAccepted: boolean
  reused: boolean
  /** 成功的交接必然是"已创建"。 */
  creationDisposition: CreationDisposition
}

/** 交接失败。**会话可能已经建好**（发送失败 / 超时），所以两个 id 都要带回来。 */
export interface HandoffFailure {
  ok: false
  errorKind: FailureEnvelope['errorKind']
  error: string
  projectId: string
  parentSessionId: string
  dispatchAccepted: false
  reused: boolean
  /**
   * 权威创建判据（协议 37）：**只有**确定本次处理已终止且没有已建/在途会话时才 `not-created`。
   * 回执丢失、异常与"可能已经建了"一律 `unknown` —— 界面据此决定能不能「返回修改」。
   */
  creationDisposition: CreationDisposition
}

export type HandoffOutcome = HandoffSuccess | HandoffFailure

/** 认领结果：`own: true` 表示这次调用负责跑完整条交接事务。 */
export type ClaimOutcome =
  | { ok: true; own: true; record: HandoffRecord; settle: (outcome: HandoffOutcome) => void }
  | { ok: true; own: false; record: HandoffRecord; settled: Promise<HandoffOutcome> }
  | { ok: false; errorKind: FailureEnvelope['errorKind']; error: string }

export interface HandoffStoreOptions {
  /**
   * 整份记录写入项目目录（由 Host 派生路径；**回读校验由实现负责**）。
   *
   * 只在这里出现文件系统，是因为状态机本身要能被直接单测（注入内存替身）。
   */
  persist(input: { projectId: string; content: string }): Promise<{ ok: boolean; error: string }>
  now(): Date
}

interface Deferred {
  promise: Promise<HandoffOutcome>
  settle: (outcome: HandoffOutcome) => void
}

/** 由回执还原"那一次成功交接"的结论（重放同一 requestId 时用）。 */
export function outcomeOfReceipt(record: HandoffRecord): HandoffSuccess {
  const receipt = record.receipt
  return {
    ok: true,
    errorKind: '',
    error: '',
    projectId: record.projectId,
    parentSessionId: record.parentSessionId,
    dispatchAccepted: true,
    reused: receipt === null ? true : receipt.reused,
    creationDisposition: 'created',
  }
}

export class HandoffStore {
  private readonly byRequest = new Map<string, HandoffRecord>()
  private readonly byPreview = new Map<string, string>()
  private readonly inflight = new Map<string, Deferred>()
  private readonly options: HandoffStoreOptions

  constructor(options: HandoffStoreOptions) {
    this.options = options
  }

  get(requestId: string): HandoffRecord | undefined {
    return requestId === '' ? undefined : this.byRequest.get(requestId)
  }

  /** `previewId → requestId`（回答"这个预览是不是已经交接过了"）。 */
  requestOfPreview(previewId: string): string | undefined {
    return previewId === '' ? undefined : this.byPreview.get(previewId)
  }

  get size(): number {
    return this.byRequest.size
  }

  /**
   * 认领一次交接。
   *
   * ⚠️ 内存里的注册是**同步**完成的（`async` 函数体在第一个 `await` 之前是同步执行的），
   * 所以两次并发调用不可能同时成为 owner —— 那正是"双击只建一条会话"的判据所在。
   */
  async claim(requestId: unknown, previewId: unknown): Promise<ClaimOutcome> {
    const id = text(requestId).trim()
    const preview = text(previewId).trim()
    if (id === '' || preview === '') {
      return { ok: false, errorKind: 'input-invalid', error: '缺少 requestId / previewId：交接必须能追溯到一次预览。' }
    }

    const existing = this.byRequest.get(id)
    if (existing !== undefined) {
      if (existing.previewId !== preview) {
        return {
          ok: false, errorKind: 'conflict',
          error: '同一个 requestId 已经用在了另一个预览上：请返回修改并重新确认（不会按旧预览启动）。',
        }
      }
      const running = this.inflight.get(id)
      if (running !== undefined) return { ok: true, own: false, record: existing, settled: running.promise }
      if (existing.state === 'dispatched') {
        return { ok: true, own: false, record: existing, settled: Promise.resolve(outcomeOfReceipt(existing)) }
      }
      // 上一轮停在 pending / created（进程内还留着记录）：这一次接着跑，复用已建好的会话。
      // `settle` 必须走 `this.settle`（它同时负责"没建出会话的 pending 记录要丢掉"）——
      // 只唤醒等待者的话，一次失败会把这份预览永久挡成"已经交接过"。
      this.openDeferred(id)
      return { ok: true, own: true, record: existing, settle: (outcome) => this.settle(id, outcome) }
    }

    const holder = this.byPreview.get(preview)
    if (holder !== undefined && holder !== id) {
      return {
        ok: false, errorKind: 'conflict',
        error: '这个预览已经（或正在）被交接：同一份预览只能成功交接一次，请返回修改并重新确认。',
      }
    }

    const now = this.options.now().toISOString()
    const record: HandoffRecord = {
      schemaVersion: HANDOFF_RECORD_SCHEMA_VERSION,
      requestId: id,
      previewId: preview,
      projectId: preview,
      state: 'pending',
      parentSessionId: '',
      receipt: null,
      claimedAt: now,
      updatedAt: now,
    }
    this.byRequest.set(id, record)
    this.byPreview.set(preview, id)
    const deferred = this.openDeferred(id)
    // spec §5 步骤 3：**先落 pending 记录**，再去建会话。
    const written = await this.persistRecord(record)
    if (!written.ok) {
      this.byRequest.delete(id)
      this.byPreview.delete(preview)
      const outcome: HandoffFailure = {
        ok: false, errorKind: 'infrastructure',
        error: `交接记录落盘失败：${written.error}`,
        projectId: preview, parentSessionId: '', dispatchAccepted: false, reused: false,
        // 认领记录都没落盘 → 这条请求没有开始过，不会留下会话。
        creationDisposition: 'not-created',
      }
      deferred.settle(outcome)
      return { ok: false, errorKind: 'infrastructure', error: outcome.error }
    }
    return { ok: true, own: true, record, settle: (outcome) => this.settle(id, outcome) }
  }

  /** `pending → created`：父会话已经建好并回读确认。 */
  async bindSession(projectId: unknown, sessionId: unknown): Promise<{ ok: boolean; error: string }> {
    const record = this.byProject(projectId)
    if (record === undefined) return { ok: false, error: `没有这个项目的交接记录：${text(projectId)}` }
    const session = text(sessionId).trim()
    if (session === '') return { ok: false, error: '父会话 id 为空：不能把空会话写进交接记录' }
    if (record.state === 'dispatched') return { ok: true, error: '' }
    return await this.commit(record, { ...record, state: 'created', parentSessionId: session })
  }

  /** `created → dispatched`：固定指令已被受理（终态）。 */
  async acceptDispatch(projectId: unknown, receipt: HandoffReceipt): Promise<{ ok: boolean; error: string }> {
    const record = this.byProject(projectId)
    if (record === undefined) return { ok: false, error: `没有这个项目的交接记录：${text(projectId)}` }
    const parentSessionId = text(receipt?.parentSessionId).trim() || record.parentSessionId
    if (parentSessionId === '') return { ok: false, error: '回执里没有父会话 id：不能把"已受理"落在一条没有会话的记录上' }
    return await this.commit(record, {
      ...record,
      state: 'dispatched',
      parentSessionId,
      receipt: { ...receipt, parentSessionId, dispatchAccepted: true },
    })
  }

  /**
   * 结束一次事务：唤醒等待同一 requestId 的并发调用。
   *
   * 什么都没落下的 `pending`（建会话之前就失败了）**直接丢掉记录** —— 否则同一个 requestId
   * 再试一次会被自己刚才那次失败的尝试挡成 `conflict`，而"这个 preview 已经被交接"也是假的。
   * 已经建出会话的 `created` 保留：重试必须复用那条会话。
   */
  settle(requestId: unknown, outcome: HandoffOutcome): void {
    const id = text(requestId).trim()
    const record = this.byRequest.get(id)
    if (record !== undefined && record.state === 'pending') {
      this.byRequest.delete(id)
      if (this.byPreview.get(record.previewId) === id) this.byPreview.delete(record.previewId)
    }
    const deferred = this.inflight.get(id)
    if (deferred !== undefined) deferred.settle(outcome)
  }

  private byProject(projectId: unknown): HandoffRecord | undefined {
    const key = text(projectId).trim()
    if (key === '') return undefined
    for (const record of this.byRequest.values()) {
      if (record.projectId === key) return record
    }
    return undefined
  }

  private openDeferred(requestId: string): Deferred {
    let resolveOnce: (outcome: HandoffOutcome) => void = () => {}
    const promise = new Promise<HandoffOutcome>((resolve) => { resolveOnce = resolve })
    let settled = false
    const deferred: Deferred = {
      promise,
      settle: (outcome) => {
        if (settled) return
        settled = true
        this.inflight.delete(requestId)
        resolveOnce(outcome)
      },
    }
    this.inflight.set(requestId, deferred)
    return deferred
  }

  /** 只有**持久化成功**才推进内存里的那一份（失败保留原状态并如实回报）。 */
  private async commit(previous: HandoffRecord, next: HandoffRecord): Promise<{ ok: boolean; error: string }> {
    const written = await this.persistRecord({ ...next, updatedAt: this.options.now().toISOString() })
    if (!written.ok) return written
    const current = this.byRequest.get(previous.requestId)
    this.byRequest.set(previous.requestId, current === undefined ? next : { ...current, ...next })
    const stored = this.byRequest.get(previous.requestId)
    if (stored !== undefined) this.byPreview.set(stored.previewId, stored.requestId)
    return { ok: true, error: '' }
  }

  private async persistRecord(record: HandoffRecord): Promise<{ ok: boolean; error: string }> {
    try {
      return await this.options.persist({ projectId: record.projectId, content: canonicalJson(record) })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
