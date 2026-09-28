/**
 * 更新徽标 / 面板的**纯** View Model。
 *
 * 这里没有任何副作用：不碰 fetch、不读时钟（时间由 `nowMs` 传入）、不碰 window / localStorage /
 * React。业务规则（能不能装、为什么不能装、徽标说什么、哪句话该显示）只在这一处算清楚，
 * Task 6 的组件照着画，**不允许**组件再拼一套"候选是否过期 / 是否正在装"的竞态逻辑。
 *
 * 用户可见中文全部来自 `zh-CN.ts`；同时给出稳定 code（`installBlockedReason` /
 * `installErrorKind`），便于 Task 6 映射更细的文案或做诊断。
 *
 * 2026-09-28 审查修正：错误按**动作**分派（检查 / 安装 / 取消），且"正在安装"取
 * "本地在飞 **或** Host 事实说 installing"，所以刷新页面后也能正确显示安装中并允许取消。
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
 * 安装按钮被禁用的**稳定原因**（优先级固定，见 `updateViewModelOf`）。
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
  /** 徽标后缀（`有更新` / `待重启` / `正在更新…` …）；无后缀时为空串。 */
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
  /** 正在安装：本地请求在飞，或 Host 事实说 `installing`（刷新后恢复的那条路径）。 */
  installing: boolean
  cancelling: boolean
  awaitingRestart: boolean
  showUpdated: boolean
  installStage: UpdateInstallStage | null
  /** 用户主动**检查**失败（后台检查失败、以及安装 / 取消失败都不走这个开关）。 */
  showManualCheckError: boolean
  manualCheckErrorText: string
  /** 安装失败：Host 判定的 `failed`，或安装请求本身的传输 / 协议失败。 */
  showInstallError: boolean
  installErrorText: string
  /** 取消失败：只有取消这个动作自己失败时才显示（不会说成"检查失败"）。 */
  showCancelError: boolean
  cancelErrorText: string
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
  const error = snapshot.error

  const candidate = check !== null && check.status === 'available' ? check.candidate : null
  const awaitingRestart = install !== null && install.status === 'awaiting-restart'
  const showUpdated = install !== null && install.status === 'updated'
  // 安装活动有两个来源：本地请求在飞（点下去到响应回来之间），或 Host 事实说在装
  // （刷新页面后本地没有任何请求在飞，只有 Host 知道）。两者取或，缺一个就会出现
  // 「装到一半刷新页面 → 显示成普通有更新、还能再点安装」。
  const installing = snapshot.installing || (install !== null && install.status === 'installing')
  const cancelling = snapshot.cancelling
  const checking = snapshot.checking || (check !== null && check.status === 'checking')
  const unsupported = check !== null && check.status === 'unsupported' ? check.reason : null
  const candidateExpired = candidate !== null && !isFresh(candidate.expiresAt, nowMs)

  // 优先级（固定；有测试钉住）：
  // 1. 等待重启：磁盘已经改了，重启前不许再动 profile（设计 §9）；
  // 2. 正在安装 / 取消；
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
  } else if (installing || cancelling) {
    // 正在装（含刷新后从 Host 恢复的 installing）：徽标必须说"正在更新"，
    // 不能落回下面的"有更新"。
    badgeSuffix = zhCN.updateBadgeInstalling
    badgeTone = 'accent'
  } else if (checking) {
    badgeSuffix = zhCN.updateBadgeChecking
  } else if (candidate !== null) {
    badgeSuffix = zhCN.updateBadgeUpdate
    badgeTone = 'accent'
  }
  if (badgeSuffix !== '') {
    badgeText = `${versionLabel}${zhCN.updateBadgeSeparator}${badgeSuffix}`
  }

  // 错误按动作分派：只有"用户主动检查失败"才走检查那句；安装 / 取消各自说自己那句。
  const showManualCheckError =
    (error !== null && error.action === 'check' && error.origin === 'manual') ||
    (check !== null && check.status === 'error' && snapshot.checkOrigin === 'manual')
  const showInstallError =
    (install !== null && install.status === 'failed') || (error !== null && error.action === 'install')
  const showCancelError = error !== null && error.action === 'cancel'

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
    showManualCheckError,
    manualCheckErrorText: showManualCheckError ? zhCN.updateCheckFailedManual : '',
    showInstallError,
    installErrorText: showInstallError ? zhCN.updateInstallFailed : '',
    showCancelError,
    cancelErrorText: showCancelError ? zhCN.updateCancelFailed : '',
    installErrorKind: install !== null && install.status === 'failed' ? install.kind : null,
  }
}
