import type { AuditStopPhase } from '../../shared/types.ts'
import type { ChildHandle } from '../audit/spawn.ts'
import type { EnvManifest } from '../environment/manifest-default.ts'
import type { LocalAccessConsentView } from '../../shared/access/types.ts'

/** 单条审核运行记录。 */
export interface AuditRecord {
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
  /**
   * **本轮的案例目录**（Host 权威，创建记录时就写死）。
   *
   * 它同时是**审核 scope 的核心**：案例内的任何 Tool 都必须证明自己的 `caseDir` 与它
   * **规范解析后精确相等**（不是"在工作空间之下"）—— 只判包含关系时，S1 的子会话可以传
   * `/work/S2`，或传工作空间根再读 `S2/文件`，于是能读别的案例、把别的案例的交付件传上 OSS。
   */
  casePath: string
  /** 本轮的 `attemptId`（快照与路由标识）；scope 不完整（空串）时案例内 Tool 一律拒绝。 */
  attemptId: string
  /**
   * true = **待接管的 scope**：`subagents.start()` 还没返回、childId 未知的那一小段窗口。
   *
   * 为什么必须有它（2026-09-29 用户复查的 P1）：子会话在 `start()` 返回**之前**就已经发布，
   * 它的 prompt 也随之开始跑 —— 那段窗口里如果权威记录还不存在，
   * 面板类 Tool 的身份拒绝（`isAuditChild`）会失效，而案例内 Tool 又会随机 fail closed。
   * 所以 Host 在**创建子会话之前**先落一条 pending 记录（父会话 id = 审核根），
   * 窗口内按"父会话 = 审核根"把这轮 scope 认出来；`start()` 返回后再把真 childId 写上去。
   */
  pending?: boolean
  /**
   * true = **退役记录**：这条审核已经失败/被停，但 Host **没能确认**子会话已经停下来
   *（`stopChild().quiesced === false`）。
   *
   * 语义是"只拒绝、不放行"：`auditScopeFor` 不再为它发放 scope（案例内 Tool 一律失败），
   * 但 `isAuditChild` 仍然认它（面板类 Tool 继续拒绝），而且**句柄与占用都保留** ——
   * 直到确认静默为止。任何"没确认停下来就删身份"的实现都会留下
   * "旧子会话继续写案例目录、而 Host 已经不认识它"的状态（2026-09-29 第三轮复查的 P1）。
   */
  retired?: boolean
  /**
   * 停止阶段（F1）。**持久化**：进程重启后界面仍要能看到"上次停到哪一步"，
   * 而不是退回"正在跑"（那会让用户又点一次停止，或在没确认静默时就发起下一条）。
   */
  stopPhase?: AuditStopPhase
  /** 发起停止的时刻（epoch ms）。 */
  stopRequestedAt?: number
  /** Host 算好的已等待时长（客户端不自己算：时钟不同源）。 */
  stopElapsedMs?: number
  /** 是否已确认静默（只有它为真才允许启动下一条）。 */
  quiesced?: boolean
  /** abort / cancel 是否真的发出去过。 */
  stopAborted?: boolean
  /** dispose 是否真的完成了。 */
  stopDisposed?: boolean
  /** 停止失败的阻塞性原因。 */
  stopError?: string
  /** 停止过程的非阻塞观察。 */
  stopNotes?: string[]
  /**
   * 本轮**可信输入快照**里登记的附件 `fileId` 白名单（`crwu_h3yun_file_get` 只认这些）。
   *
   * 空数组 = 本轮没有附件；它**不是**"什么都允许" —— 任何不在表里的 fileId 都在起进程之前拒绝。
   */
  allowedAttachmentIds: string[]
  /** 被本次重启替换掉的旧 childId（界面据此提示「已重启」）。 */
  replacedChildId?: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  childAlive?: boolean
  adopted?: boolean
  /** 该记录对应的密钥上传状态；`uploading` 是运行态，只在新记录里出现，不落盘。 */
  uploading?: boolean
  /** 界面上显示的当前活动（子代理 activity），仅当次查询有效。 */
  activity?: string
}

/** Host 插件实例的进程内状态。 */
/** 一次审核发起失败的全部可留档事实（脱敏：不含命令原文、不含凭据）。 */
export interface AuditFailureRecord {
  /** ISO 时刻。 */
  at: string
  /** 失败的一句话（与界面看到的一致）。 */
  reason: string
  /** 发起阶段：门禁 / 工作空间 / 案例目录 / 根会话 / 策略 / 预检 / 快照 / 子会话。 */
  stage: string
  /** 失败归因（`infrastructure` / `sandbox` / `permission` / `policy` / `capability-gap` …）。 */
  errorKind: string
  seqNo: string
  objectId: string
  caseDir: string
  attemptId: string
  /** 上下文备注（含被降级吞掉的事实，如「没能挂到工作空间」）。 */
  notes: string[]
}

export interface WorkbenchState {
  /** 当前有效清单：激活时由内置清单叠加 YAML，env 自检后再补入远程环境信息。 */
  manifest: EnvManifest
  caseRoot: string
  workspacePath: string
  workspaceTitle: string
  workspaceSource: string
  workspaceChosen: boolean
  /** 用户选过、但目录已经不在了：阻塞项，界面要求重选（不回落清单偏好）。 */
  workspaceMissing: boolean
  /** 工作空间注册表里的 id（用于回写与显示）。 */
  workspaceId: string
  /** 审核记录是否已从磁盘恢复（每个实例一次）。 */
  registryLoaded: boolean
  /**
   * **最近一次审核发起失败的全部信息**（落盘，跨重启还在）。
   *
   * 为什么要有它（2026-09-30）：`audit-start` 的失败详情只出现在那次 RPC 的返回里 ——
   * 界面上是一句话，进程一重启就没了。真机连挂三次，每次都要靠"复现 + 读代码"倒推是哪一步、
   * 什么归因、沙箱事实是什么。这张记录把那一句话背后**所有结构化事实**留在磁盘上：
   * 阶段、归因、notes（含"没能挂到工作空间"这类被吞掉的降级）、案例目录、attemptId、时刻。
   * 成功发起审核时清空。
   */
  lastAuditFailure?: AuditFailureRecord
  /** 正在创建中的任务标识；非空即拒绝新的创建请求（防重复点击并发起两条）。 */
  startingKey: string
  /** childId → 活的进程内句柄；绝不进任何 JSON 返回值。 */
  runs: Record<string, ChildHandle>
  /**
   * childId → **停止流程正在进行**（进程内，不落盘）。
   *
   * 用途只有两个：重复点「停止」时**幂等**（不启动第二条停止流程，也不重复 abort），
   * 以及"没确认静默之前不许启动下一条审核"。
   * 跨重启的事实由记录里的 `stopPhase` 负责（见 `AuditRecord`）。
   */
  stopInFlight: Record<string, Promise<void>>
  parentSessionId: string
  /**
   * 审核根会话（子代理的挂载点）。
   *
   * 稳定优先：可用就一直用它，所有审核子代理整齐挂在同一棵树下；不可用就新建一个
   * （用户已确认接受分叉）。落盘是为了跨进程复用同一个根。
   */
  /**
   * 审核根会话钩子。**标识是案例目录**（`casePath`），不是工作空间。
   *
   * 2026-09-29 用户复查 P1 的第 4 条：审核根的 cwd 若是整个工作空间，子会话继承到的
   * `workspace-write` 边界就是工作空间 —— 通用 shell / fs 于是能改**同工作空间的其他案例**，
   * 与"只能写自己的案例目录"不一致。所以一个根只服务**一个案例目录**；
   * `casePath === ''` 的旧记录（工作空间级根）一律判为**过期**，不复用。
   */
  auditRoot: { workspacePath: string; casePath: string; sessionId: string; title: string; assignedAt: string }
  /**
   * 本机访问授权收据（协议 18）。**一次授权、长期有效**：写入
   * `~/.dsh/crwu-workbench.json`，重启 profile 后仍生效（2026-09-22 用户口径）。
   *
   * 存的是**整条收据的视图**而不是一个布尔值：范围（capability 清单）、版本与授权时刻都要能
   * 回答「这次同意到底覆盖了什么、是不是本版的范围」。判据一律走
   * `host/access/consent.ts` 的 `localAccessGranted()`，各处不要自己比字符串。
   *
   * 不是 `granted` 时：凭据类操作一律不放行，环境自检把「需要授权」算作阻塞项，插件不可用。
   */
  localAccess: LocalAccessConsentView
  /** 氚云表单「报告审核」的 code，首次定位后缓存（定位一次要 60 秒）。 */
  formCode: string
  /** 表单显示名，界面用。 */
  formName: string
  audits: Record<string, AuditRecord>
  activeKey: string
  activeChildId: string
  activeSince: number
}
