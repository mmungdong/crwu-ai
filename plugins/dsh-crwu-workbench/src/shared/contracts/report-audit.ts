/**
 * 报告审核的线协议类型（待审核列表、审核视图、云端交付件、审核根与占用门禁）。
 */

/** 一行氚云待审核记录。 */
export interface TaskRow {
  name: string
  project: string
  business: string
  risk: string
  reviewLevel: string
  reviewState: string
  currentNode: string
  seqNo: string
  status: string
  statusName: string
  modifiedAt: string
  id: string
  idTail: string
}

/**
 * 审核停止的**阶段**（F1 的状态机，Host 与 Client 用同一套枚举）。
 *
 * - `idle`：没发起过停止
 * - `requested`：已收到停止请求，还没发出 abort
 * - `aborting`：abort / cancel 已发出，等子会话退出
 * - `waiting-quiescence`：dispose 未完成，或 Agent 仍显示 running
 * - `quiesced`：已确认停下（dispose 完成，或 Agent 已不在 running）
 * - `timeout`：有界等待到点，仍无法确认静默
 * - `failed`：停止过程发生基础设施 / 持久化错误
 */

export type AuditStopPhase =
  | 'idle' | 'requested' | 'aborting' | 'waiting-quiescence' | 'quiesced' | 'timeout' | 'failed'

/**
 * 停止状态的线上视图。
 *
 * ⚠️ 客户端拿到**缺失字段**时必须按"未知"处理，**不许**自行推断成 stopped / quiesced
 *（2026-09-29 第三轮复查的 F4）：只有 Host 能回答"是不是真的停下了"。
 */

export interface AuditStopView {
  phase: AuditStopPhase
  /** 发起停止的时刻（epoch ms，0 = 没发起过）。 */
  requestedAt: number
  /** 已经等了多久（由 Host 计算，客户端不自己算 —— 时钟不同源）。 */
  elapsedMs: number
  /** 是否已确认静默。**只有它决定"能不能启动下一条"**。 */
  quiesced: boolean
  /** abort / cancel 是否真的发出去过（诊断用，不许写死）。 */
  aborted: boolean
  /** dispose 是否真的完成了（超时不算）。 */
  disposed: boolean
  /** 阻塞性错误（phase = failed 时的原因）。 */
  error: string
  /** 非阻塞观察（例如"dispose 超时但 Agent 已不在运行"）。 */
  notes: string[]
  /** 能不能启动下一条审核 —— **只能由 Host 判定**。 */
  canStartNext: boolean
}

/** 一条审核记录的线上视图。 */

export interface AuditView {
  key: string
  childId: string
  seqNo: string
  project: string
  objectId: string
  startedAt: string
  parentSessionId: string
  status: string
  ended: boolean
  stopped: boolean
  stopReason: string
  endReason: string
  casePath: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  adopted?: boolean
  childAlive?: boolean
  activity?: string
  /**
   * 停止状态（F4）。缺失 = 未知（旧宿主 / 老记录），客户端按"不知道"处理。
   */
  stop?: AuditStopView
}

/** 云端一个流水号下的交付件。 */

export interface CloudItem {
  seqNo: string
  /**
   * 该流水号下的**全部**云端对象。`size` / `lastModified` / `etag` 来自 `ossutil ls` 的
   * 长格式（一次列举就有；旧宿主不传这三个字段时客户端按缺失处理）。
   * ETag 是"审核结果有没有重新生成过"的客观依据，所以别再用 `--short-format` 把它丢掉。
   */
  files: Array<{ key: string; name: string; size?: number; lastModified?: string; etag?: string }>
  htmlKey: string
  jsonKey: string
}

export type OssBatchItemResult =
  | { ok: true; error: ''; item: CloudItem | null }
  | { ok: false; error: string; errorKind: 'access' | 'config' | 'command' | 'truncated' | 'invalid-result' | 'timeout' | 'cancelled'; item: null }

export interface OssBatchIndexResult {
  ok: boolean
  error: string
  results: Record<string, OssBatchItemResult>
}

/**
 * 随插件发布的组件（`crwu` / `dws` / `ossutil`）的检查结果。
 *
 * 它们**不是 PATH 命令**：只按包内 `bin/<平台>/<文件>` 与包内 `bin/manifest.json` 核对，
 * 所以这里没有 `command` / `versionText` 这类字段（旧线协议的 `EnvCheckView` 就是混装的产物）。
 */

export interface AuditRootView {
  sessionId: string
  title: string
  workspacePath: string
  /** 这条根服务的**案例目录**（协议 19 起：根的 cwd 与沙箱边界都是它）。 */
  casePath: string
  assignedAt: string
  /** 现在还可用吗；不可用会在下次发起审核时自动新建一个（旧的树保留）。 */
  usable: boolean
  reason: string
  /**
   * 审核根的沙箱模式与审批策略（协议 18 · 子项目 C）。
   *
   * 空串 = 还没建根 / 读不到。⑧ 上显示它们，验收里也要求"根与子会话都显示
   * workspace-write / never" —— 只写提示词不算数，得看得见。
   */
  sandboxMode?: string
  approvalPolicy?: string
}

/** 占用门禁。 */

export interface ActiveView {
  key: string
  childId: string
  since: number
}

/** 当前会话（父会话）的事实：只用于显示与 preset 提示，不决定审核父级。 */
