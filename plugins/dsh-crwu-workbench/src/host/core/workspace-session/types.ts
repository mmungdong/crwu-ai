import type { WorkbenchState } from '../state/types.ts'

/**
 * 工作区会话的统一身份与失败判据（协议 32）。
 *
 * 为什么要有这一层：插件里原先有**四条**各自建会话的路径（审核根、审核子会话、报告讨论、
 * 本地审核），每条都自己决定"会话落在哪个目录"。于是同一个工作区选择在不同路径上含义不同 ——
 * 一条用 `workspaceId`、一条用 `cwd`、一条两者都用、一条干脆不传，让 DSH 落到部署默认目录。
 * 用户看到的就是"会话没创建在我选的工作区下面"。
 *
 * 这里把三件事收敛成**唯一**口径：
 *   1. 唯一的工作区来源是【环境信息】里的 `env.workspace`（落盘在 `WorkbenchState`）；
 *   2. 唯一合法的会话创建方式是 `workspaceId`（Host 走 `sessionController.create`）；
 *   3. 创建之后**必须回读**会话 cwd 与工作区成员关系，任一条不成立就当作失败。
 *
 * 绝不允许的降级（曾经真的这么写过）：`cwd: ''`、`cwd: caseRoot`、什么都不传。
 */

/** 插件选定、且已经与 DSH 工作区注册表核对过的工作区。 */
export interface SelectedWorkspace {
  /** DSH 工作区注册表里的 id。 */
  id: string
  /** 工作区目录（注册表里的规范路径）。 */
  path: string
  /** 展示名。 */
  title: string
}

/**
 * 失败的**原因分类**。
 *
 * 分类而不是只给一句话：界面要按原因派活（"去环境信息选一个" vs "重启 profile"），
 * 测试也要能钉住"是哪一条判据拦下的"，而不是去匹配中文措辞。
 */
export type WorkspaceFailureReason =
  /** 环境里根本没有选中工作区。 */
  | 'no-workspace'
  /** 选过的工作区目录丢了（`workspaceMissing`）。 */
  | 'workspace-missing'
  /** 环境自检还没完成，工作区结论不可信。 */
  | 'workspace-unchecked'
  /** 选中的 id 在注册表里找不到。 */
  | 'workspace-unregistered'
  /** 注册表里的路径与选中路径不是同一个目录。 */
  | 'workspace-path-mismatch'
  /** 路径存在，但不是目录。 */
  | 'workspace-not-a-directory'
  /** 需要的工作区服务不可用。 */
  | 'services-unavailable'
  /** 建会话本身失败。 */
  | 'session-create-failed'
  /** 会话建好了，但没能挂到工作区下。 */
  | 'session-attach-failed'
  /** 挂载之后回读成员关系失败。 */
  | 'session-membership-missing'
  /** 会话 cwd 与工作区路径不一致。 */
  | 'session-cwd-mismatch'
  /** 会话的 Agent 不在运行中。 */
  | 'session-agent-missing'

/** 统一的失败形状：`reason` 给代码看，`error` 给人看。 */
export interface WorkspaceSessionFailure {
  ok: false
  reason: WorkspaceFailureReason
  error: string
}

/** 工作区解析成功。 */
export interface WorkspaceResolved {
  ok: true
  workspace: SelectedWorkspace
}

export type WorkspaceResolution = WorkspaceResolved | WorkspaceSessionFailure

/** 会话创建成功：`sessionId` 已经确认归属 `workspace`。 */
export interface WorkspaceSessionCreated {
  ok: true
  sessionId: string
  workspace: SelectedWorkspace
  /**
   * 本进程里那个真实的 Agent（`ctx.agents.get(sessionId)`）。
   *
   * 远程/未装配的部署可能拿不到 —— 那时为 `undefined`，调用方按需要自己判。
   */
  agent: unknown
  /**
   * 非阻塞的观察（改名失败、显式挂载被 DSH 自己那次覆盖等）。
   *
   * 与失败分开：这些都不影响"会话已正确落在工作区下"这个结论，但界面/诊断应当说出来 ——
   * 名字没写上，下次按名字找回会话就会失败。
   */
  notes: string[]
}

export type WorkspaceSessionResult = WorkspaceSessionCreated | WorkspaceSessionFailure

/** 会话可用性结论（复用旧会话之前必须问一次）。 */
export interface SessionVerdict {
  ok: boolean
  reason: string
}

/** 建会话的入参。 */
export interface CreateWorkspaceSessionInput {
  /** 会话标题；空串表示不改名。 */
  title: string
  /**
   * 业务来源：审核根 / 报告讨论 / 本地审核 / 估值。
   *
   * 只用于诊断与 preset 提示，**不进**会话元数据（DSH 的 `CreateSessionRequest` 没有这个字段，
   * 硬塞进去会被静默丢掉）。
   */
  source: string
  /** 指定会话 id（审核根要自己 mint 一个稳定 id）；缺省由 DSH 生成。 */
  sessionId?: string
  /** preset 提示；空串表示跟随部署默认。 */
  presetHint?: string
}

/** 契约检查用的 Host 侧别名。 */
export type WorkspaceSessionState = Pick<
  WorkbenchState,
  'workspaceChosen' | 'workspaceMissing' | 'workspaceId' | 'workspacePath' | 'workspaceTitle' | 'caseRoot'
>
