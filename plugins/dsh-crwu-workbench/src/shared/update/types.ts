/**
 * Host 与 Client 共用的自助更新线协议。
 *
 * 只用**闭合判别联合**表达状态：界面按 `status` 分派，不靠多个布尔量拼隐含状态。
 *
 * 安全边界（这几条是契约的一部分，不是风格）：
 * - 不出现 registry URL、认证信息、Token、命令、完整日志；
 * - 不出现"由 Client 选择的安装版本"：安装目标只能来自 Host 自己检查出的候选；
 * - 不出现 registry 原始元数据，只有下方这些规范化字段。
 */

/** 公开发现源的类别。枚举里**没有**私有源：企业私有源不进入自助更新。 */
export type UpdateSourceKind = 'npmmirror' | 'npm'

/** Host 检查出的候选版本；只有这些规范化字段会进线协议。 */
export interface UpdateCandidate {
  currentVersion: string
  targetVersion: string
  sourceKind: UpdateSourceKind
  /** `time[version]` 存在且可解析时的发布时间（ISO 字符串）。 */
  publishedAt?: string
  checkedAt: string
  /** 候选的授权期限：过期候选只能作历史展示，**不能**授权安装。 */
  expiresAt: string
}

/** 不支持自助更新的原因（每一种都有对应的界面说法）。 */
export type UpdateUnsupportedReason =
  | 'development-install'
  | 'manager-unavailable'
  | 'enterprise-registry'

/** 检查失败的稳定分类：用户文案按它分派，不解析底层错误消息。 */
export type UpdateCheckErrorKind =
  | 'network'
  | 'timeout'
  | 'not-found'
  | 'invalid-metadata'
  | 'too-large'
  | 'unknown'

export type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking'; cached?: UpdateCandidate }
  | { status: 'up-to-date'; checkedAt: string }
  | { status: 'available'; candidate: UpdateCandidate; checkedAt: string }
  | { status: 'unsupported'; reason: UpdateUnsupportedReason }
  | { status: 'error'; kind: UpdateCheckErrorKind; checkedAt: string }

/**
 * 安装阶段只允许**可证实**的离散阶段：界面不得把它渲染成百分比进度。
 * `cancelling` 也是阶段之一（"正在取消"），而不是一个假的完成度。
 */
export type UpdateInstallStage = 'connecting' | 'downloading' | 'installing' | 'cancelling'

/** 安装失败的稳定分类（对应设计文档的错误分类表）。 */
export type UpdateInstallErrorKind =
  | 'source-unavailable'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'disk-full'
  | 'permission'
  | 'integrity'
  | 'build-blocked'
  | 'incompatible-version'
  | 'audit-active'
  | 'busy'
  | 'cancelled'
  | 'unknown'

/**
 * 安装与重启恢复状态。
 *
 * `awaiting-restart` 是"profile 已经改了、但当前进程还在跑旧代码"的唯一表达；
 * 失败与取消**不会**进入它（否则界面会提示用户为一个没装上的版本重启）。
 */
export type UpdateInstallState =
  | { status: 'idle' }
  | { status: 'installing'; stage: UpdateInstallStage; targetVersion: string; startedAt: string }
  | { status: 'awaiting-restart'; targetVersion: string; installedAt: string }
  | { status: 'failed'; kind: UpdateInstallErrorKind; targetVersion?: string }
  | { status: 'cancelled'; targetVersion?: string }
  /** 重启后核对实际运行版本成功的一次性提示。 */
  | { status: 'updated'; version: string }

/**
 * 四个 `update-*` 操作**统一**的返回信封（协议 16）。
 *
 * `ok` 说的是"这个操作执行了"，不是"检查/安装成功"：检查失败、安装失败都在 `check` / `install`
 * 的闭合联合里，界面按它们分派文案。四个操作都返回同一形状，Client 只需要一套收窄逻辑。
 */
export interface UpdateStatusPayload {
  ok: true
  check: UpdateCheckState
  install: UpdateInstallState
}

/**
 * 边界拒绝信封：只在调用方破坏了操作契约时出现（例如给 `update-install` 传了任何参数）。
 *
 * 它**不带**状态快照，因为拒绝路径不调用 checker、store 或 Plugin Manager —— 这也是
 * "参数注入不影响任何东西"的可观察证据。`error` 是固定文案，绝不回显调用方输入。
 */
export interface UpdateRejectionPayload {
  ok: false
  error: string
}

export type UpdateOperationPayload = UpdateStatusPayload | UpdateRejectionPayload
