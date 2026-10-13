/**
 * 本地审核（协议 28）的线协议视图：扫描结果、逐件状态、一次性交接。
 */

export interface LocalAuditItemView {
  path: string
  name: string
  /** `file` | `directory`。 */
  kind: string
  /** 文件字节数；文件夹为 0。 */
  sizeBytes: number
  /** 展开后的普通文件数：文件为 1，文件夹为递归结果（0 = 里面没有普通文件）。 */
  fileCount: number
  /** `scanned` | `unreadable` | `skipped` | `over-limit`（Host 原文，界面据此选图标与颜色）。 */
  status: string
  reason: string
}

/** 逐件跳过的**普通文件**（不是选择项）：文件夹展开后读不了/不适用那些。 */

export interface LocalAuditSkippedView {
  /** 展示名（相对用户所选入口的相对路径）。 */
  relativePath: string
  name: string
  reason: string
}

/** 进快照的普通文件（展示名 + 相对路径；绝对路径不出现）。 */

export interface LocalAuditFileView {
  relativePath: string
  name: string
}

/**
 * `local-audit-status` 的应答：**本次选择**展开后的状态。
 *
 * 它只服务当前准备流程（选完就扫、改完再扫），不是全局 sidecar，也不代表任何历史。
 */
/**
 * 扫描结果里的**一个文件**（界面「展开到文件级」那一行）。
 *
 * 有了它，员工在开始之前就能看见**到底会审哪些文件**、并能逐个移除 ——
 * 而不是只看见一个文件夹名和一句"展开后共 N 个文件"。
 *
 * 与 `LocalAuditFileView` 的区别：那个是**快照内部**的形态（只有展示名 + 相对路径，
 * 会进清单、可能被模型读到）；这个多带 `path` 与 `parentPath`，只在**界面**上用。
 */

export interface LocalAuditScannedFileView {
  /** 它属于哪个已选入口（文件夹的绝对路径）—— 界面据此把文件挂在那个文件夹行下面。 */
  parentPath: string
  /** 完整绝对路径：**只用于关掉某一个文件**（排除清单的键），不进提示词、不进快照清单。 */
  path: string
  name: string
  /** 相对所选入口的展示路径。 */
  relativePath: string
  sizeBytes: number
}

export interface LocalAuditScanView {
  ok: boolean
  error: string
  errorKind: string
  /** 去重后的普通文件总数（实际会被审核的数量）。 */
  fileCount: number
  /** 单次上限（30）；仅在 `overLimit` 为真时有意义。 */
  limit: number
  overLimit: boolean
  /** 快照阶段预期能读到的文件数（`fileCount` 去掉已知不可读项）。 */
  readableCount: number
  skippedCount: number
  items: LocalAuditItemView[]
  /**
   * 展开后的文件级清单（已扣掉排除项）；`parentPath` 指回上面的入口。
   *
   * 界面在扫描完成后**必须逐行展示完整文件名**（用户 2026-10-11 口径），
   * 每一行右侧一枚 X 表示"移除这个文件"。
   */
  files: LocalAuditScannedFileView[]
  skipped: LocalAuditSkippedView[]
}

/**
 * `local-audit-start` 的应答：一次性 handoff + **可复制的固定提示词**。
 *
 * `prompt` 是给用户复制/或由客户端直接发给新会话的那一段：只含 `handoffId`、展示名、相对路径、
 * 快照状态、固定审核要求与用户补充提示词 —— **不含**原始绝对路径、凭据、OSS 地址、氚云信息。
 */

export interface LocalAuditStartView {
  ok: boolean
  error: string
  errorKind: string
  handoffId: string
  prompt: string
  /** 已提供（进快照）的文件数。 */
  providedCount: number
  skippedCount: number
  /** handoff 过期时刻（epoch ms；0 = 不适用）。 */
  expiresAt: number
  /**
   * 新会话的 **cwd**：员工选定的工作空间（逐字）。
   *
   * DSH 按 cwd 把会话归到工作空间下（cwd 不等于工作空间路径就会落「未分组」），
   * 而它同时是会话的沙箱边界 —— 案例目录就在它之内，所以对话里的案例内工具写得进去。
   *
   * ⚠️ 只回给客户端，**不进提示词**。
   */
  workspacePath: string
  /**
   * 本轮案例目录：`<工作空间>/本地审核/<handoffId>`。
   *
   * 交付件（HTML / JSON）就落在这里，员工在自己的工作空间里找得到。
   * 同样**只回给客户端**，不进提示词（提示词里只有 `handoffId`、展示名与快照内相对路径）。
   */
  casePath: string
  files: LocalAuditFileView[]
  skipped: LocalAuditSkippedView[]
}

/** 最小权限修复的结果（协议 18 · 子项目 D3）。 */
