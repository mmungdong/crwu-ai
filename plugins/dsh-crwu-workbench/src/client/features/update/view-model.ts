/**
 * 更新徽标 / 面板的**纯** View Model。
 *
 * 这里没有任何副作用：不碰 fetch、不读时钟（时间由 `nowMs` 传入）、不碰 window / localStorage /
 * React。业务规则（能不能装、为什么不能装、徽标说什么）只在这一处算清楚，Task 6 的组件照着画，
 * **不允许**组件再拼一套"候选是否过期 / 是否正在装"的竞态逻辑。
 *
 * 用户可见中文全部来自 `zh-CN.ts`；同时给出稳定 code（`installBlockedReason` /
 * `installErrorKind`），便于 Task 6 映射更细的文案或做诊断。
 */
import { zhCN } from '../../locales/zh-CN.ts'
import type { UpdateSnapshot } from './update-store.ts'
import type {
  UpdateInstallErrorKind,
  UpdateInstallStage,
  UpdateSourceKind,
} from '../../../shared/update/types.ts'

/** 徽标语气：Task 6 把它映射到 DSH 主题 token，不在这里决定颜色值。 */
export type UpdateBadgeTone = 'neutral' | 'accent' | 'warn' | 'success'

/**
 * 安装按钮被禁用的**稳定原因**（优先级固定，见 `blockReasonOf`）。
 */
export type UpdateInstallBlockReason =
  | 'development-install'
  | 'enterprise-registry'
  | 'manager-unavailable'
  | 'candidate-expired'
  | 'audit-active'
  | 'install-active'
  | 'awaiting-restart'
  | 'no-candidate'

export interface UpdateViewModelInput {
  snapshot: UpdateSnapshot
  /** 当前**运行**的版本（Host 构建常量经 boot 传来）。 */
  currentVersion: string
  /** 是否有审核任务在跑（active 或 starting，由上层折算）。 */
  auditBusy: boolean
  /** 当前时间（毫秒）。过期判据只认它，View Model 不读时钟。 */
  nowMs: number
}

export interface UpdateViewModel {
  /** 徽标整句（已含版本号与分隔符）。 */
  badgeText: string
  /** 徽标后缀（`有更新` / `待重启` …）；无后缀时为空串。 */
  badgeSuffix: string
  badgeTone: UpdateBadgeTone
  hasCandidate: boolean
  currentVersion: string
  /** 无候选时为空串。 */
  targetVersion: string
  /** 无发布时间时为空串。 */
  publishedAt: string
  sourceKind: UpdateSourceKind | null
  canCheck: boolean
  canInstall: boolean
  canCancel: boolean
  /** 不能安装的稳定原因；可以安装时为 null。 */
  installBlockedReason: UpdateInstallBlockReason | null
  /** 原因对应的中文（可以安装时为空串）。 */
  installBlockedText: string
  checking: boolean
  installing: boolean
  cancelling: boolean
  awaitingRestart: boolean
  showUpdated: boolean
  installStage: UpdateInstallStage | null
  /** 用户手动检查失败（后台失败不露出来）。 */
  showManualError: boolean
  manualErrorText: string
  showInstallError: boolean
  installErrorText: string
  /** 安装失败的稳定分类（Task 6 想按类给不同文案时用它）。 */
  installErrorKind: UpdateInstallErrorKind | null
}

const BLOCK_TEXTS: Record<UpdateInstallBlockReason, string> = {
  'development-install': zhCN.updateReasonDevelopment,
  'enterprise-registry': zhCN.updateReasonEnterprise,
  'manager-unavailable': zhCN.updateReasonManagerUnavailable,
  'candidate-expired': zhCN.updateReasonCandidateExpired,
  'audit-active': zhCN.updateReasonAuditActive,
  'install-active': zhCN.updateReasonInstallActive,
  'awaiting-restart': zhCN.updateReasonAwaitingRestart,
  'no-candidate': zhCN.updateReasonNoCandidate,
}

/** `expiresAt` 有效且还没到期才算新鲜；非法时间一律按已过期处理（fail closed）。 */
function isFresh(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt)
  return !Number.isNaN(at) && at > nowMs
}

export function updateViewModelOf(input: UpdateViewModelInput): UpdateViewModel {
  const { snapshot, currentVersion, auditBusy, nowMs } = input
  const check = snapshot.check
  const install = snapshot.install

  const candidate = check !== null && check.status === 'available' ? check.candidate : null
  const awaitingRestart = install !== null && install.status === 'awaiting-restart'
  const showUpdated = install !== null && install.status === 'updated'
  const installing = snapshot.busy === 'installing'
  const cancelling = snapshot.busy === 'cancelling'
  const checking = snapshot.busy === 'checking' || (check !== null && check.status === 'checking')
  const unsupported = check !== null && check.status === 'unsupported' ? check.reason : null
  const candidateExpired = candidate !== null && !isFresh(candidate.expiresAt, nowMs)

  // 优先级（固定；有测试钉住）：
  // 1. 等待重启：磁盘已经改了，重启前不许再动 profile（设计 §9）；
  // 2. 正在安装/取消；
  // 3. **能力型**不支持（dev / 企业源 / 没有 Plugin Manager）—— 它们比"临时占用"更根本，
  //    否则 dev 安装里碰上一次审核就会提示"等审核结束就能装"，而那永远装不了；
  // 4. 审核占用（临时）；
  // 5. 候选过期 / 没有候选。
  const blocked: UpdateInstallBlockReason | null = awaitingRestart
    ? 'awaiting-restart'
    : installing || cancelling
      ? 'install-active'
      : unsupported === 'development-install'
        ? 'development-install'
        : unsupported === 'enterprise-registry'
          ? 'enterprise-registry'
          : unsupported === 'manager-unavailable'
            ? 'manager-unavailable'
            : auditBusy
              ? 'audit-active'
              : candidate === null
                ? 'no-candidate'
                : candidateExpired
                  ? 'candidate-expired'
                  : null

  const versionLabel = `v${currentVersion}`
  let badgeSuffix = ''
  let badgeTone: UpdateBadgeTone = 'neutral'
  let badgeText = versionLabel
  if (unsupported === 'development-install') {
    // dev 形态不显示版本号标签（与侧栏那枚小标签同一个口径）。
    badgeText = zhCN.buildTagDev
  } else if (showUpdated) {
    badgeSuffix = zhCN.updateBadgeUpdated
    badgeTone = 'success'
  } else if (awaitingRestart) {
    badgeSuffix = zhCN.updateBadgeAwaitingRestart
    badgeTone = 'warn'
  } else if (checking) {
    badgeSuffix = zhCN.updateBadgeChecking
  } else if (candidate !== null) {
    badgeSuffix = zhCN.updateBadgeUpdate
    badgeTone = 'accent'
  }
  if (badgeSuffix !== '') {
    badgeText = `${versionLabel}${zhCN.updateBadgeSeparator}${badgeSuffix}`
  }

  // 手动检查失败可见：客户端侧传输/协议失败（origin=manual）或 Host 判定的检查错误但由用户触发。
  const showManualError =
    snapshot.error?.origin === 'manual' ||
    (check !== null && check.status === 'error' && snapshot.checkOrigin === 'manual')
  const showInstallError = install !== null && install.status === 'failed'

  return {
    badgeText,
    badgeSuffix,
    badgeTone,
    hasCandidate: candidate !== null,
    currentVersion,
    targetVersion: candidate === null ? '' : candidate.targetVersion,
    publishedAt: candidate === null || candidate.publishedAt === undefined ? '' : candidate.publishedAt,
    sourceKind: candidate === null ? null : candidate.sourceKind,
    // 检查在"能力型不支持"时没有意义（Host 连 registry 都不会问），也不允许在检查进行中重复点。
    canCheck: !checking && unsupported === null,
    canInstall: blocked === null,
    canCancel: installing || cancelling,
    installBlockedReason: blocked,
    installBlockedText: blocked === null ? '' : BLOCK_TEXTS[blocked],
    checking,
    installing,
    cancelling,
    awaitingRestart,
    showUpdated,
    installStage: install !== null && install.status === 'installing' ? install.stage : null,
    showManualError,
    manualErrorText: showManualError ? zhCN.updateCheckFailedManual : '',
    showInstallError,
    installErrorText: showInstallError ? zhCN.updateInstallFailed : '',
    installErrorKind: install !== null && install.status === 'failed' ? install.kind : null,
  }
}
