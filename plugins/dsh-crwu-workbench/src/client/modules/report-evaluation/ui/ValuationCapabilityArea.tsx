import * as React from 'react'
import { zhCN } from '../../../locales/zh-CN.ts'
import { Button } from '../../../ui/components/index.ts'
import { useInstanceId } from '../../../ui/components/ids.ts'
import { ChevronDownIcon, InfoIcon } from '../../../ui/icons.tsx'
import { VALUATION_CLASSES as V } from '../model/styles.ts'
import type { LoginJobView, SiteRowView } from '../../../../shared/contracts/report-evaluation.ts'
import type { ValuationLoginState, ValuationPageState } from '../model/valuation-state.ts'

/**
 * **信息获取辅助**区（协议 39 起；旧名是"案例来源" / 更早的"局部门禁屏"）。
 *
 * ## 它不再是门禁，也不叫"案例来源"
 *
 * 旧实现把这一块做成整页拦截：必需来源没全部 `authenticated` 就不给进正文。
 * 现在的口径（2026-10-15 已确认）是：**登录是可选用能力**。未登录 / 未知 / 该站失败
 * 都只如实展示，不阻止填写与整轮启动；原因随来源策略交给父会话。
 *
 * 对外名字统一成「信息获取辅助」：它描述的是"补充公开信息的能力"，不是"必需能力"，
 * 也不是"案例"（案例是估值证据里的业务概念，不在这里）。内部业务 Tool 的名字不动。
 *
 * ## Panel shape (2026-10-16 UI polish)
 *
 * It is a lightweight inset panel inside the work paper: source name + state badge + actions stay
 * directly visible; long reasons, the check time and finished login jobs fold into "status
 * details". Folding only animates opacity + offset, never height; each mount owns its instance id,
 * so two panels on one page never share a details region.
 *
 * ## 七条不许含糊的口径
 *
 * 1. **始终有一条可见的紧凑摘要行**：链家 + 状态 + 该做的动作直接可见，
 *    详细原因、检查时刻与登录任务说明**按需展开**（唯一入口不藏在折叠层里）；
 * 2. **没有"未登录空态"**：还没查过就说"尚未检查"，不给登录按钮假装已经知道；
 * 3. **`unknown`（网络 / 风控 / 查不出来）与 `unauthenticated`（确实没登录）分开**：
 *    前者的处置是"重新检查"，后者才是"去登录"；
 * 4. **被人机验证挡住 ≠ 未登录**：那里唯一有意义的动作是「去验证」
 *    （Host 的受控操作，复用同一个 profile），**不给**登录入口；
 * 5. **登录任务五种状态各有各的话与动作**（running 可取消 / waiting-user 可去验证 /
 *    成功 / 失败 / 已取消），不再混成一句"已结束"；
 * 6. **检查时刻必须跟着结论一起走**：一次检查成功不等于整轮始终可用，
 *    所以这一区同时展示 `gate.checkedAt`（缺失时显示"尚未检查"，不编一个时刻）；
 * 7. **错误按归属渲染**：这里只说**这次检查**的失败（`login.error`）。
 *    文件校验 / 交接失败属于别处，不许在这里再出现一次。
 */

export interface ValuationCapabilityAreaProps {
  /** 整页状态（辅助区要用 `login` 与 `slowWait`）。 */
  state: ValuationPageState
  /**
   * 交接已经开始（`creating-session`）：**不再发起**新的登录 / 验证 / 检查。
   *
   * 这时抽屉里的条件已经冻结，"顺手点一下登录"只会让"正在按什么输入创建"变得说不清；
   * 已经在跑的那条任务仍按原机制管理（可取消、可按 jobId 同步），不受这里影响。
   */
  locked?: boolean
  onRecheck: () => void
  onLogin: (siteId: string) => void
  onCancelLogin: (jobId: string) => void
  /** 打开受控的验证窗口（只提交 siteId）。 */
  onVerify: (siteId: string) => void
}

/** 登录任务状态 → 文案与动作（**五种分开**，不落进"已结束"这一句）。 */
export const JOB_TEXT: Record<LoginJobView['state'], string> = {
  running: zhCN.valuationAuthJobRunning,
  'waiting-user': zhCN.valuationAuthJobWaiting,
  succeeded: zhCN.valuationAuthJobSucceeded,
  failed: zhCN.valuationAuthJobFailed,
  cancelled: zhCN.valuationAuthJobCancelled,
}

/** 一次登录任务的进行/结束提示（`role="status"`）。 */
function JobRow(props: {
  job: LoginJobView
  label: string
  locked: boolean
  onCancel: (jobId: string) => void
  onVerify: (siteId: string) => void
}): React.ReactElement {
  const { job } = props
  const text = (JOB_TEXT[job.state] ?? zhCN.valuationAuthJobFailed).replace('{label}', props.label)
  return <div className={V.authJob} role="status" data-valuation-login-job={job.jobId}
    data-valuation-login-job-state={job.state}>
    <span className={V.authJobText}>
      {text}
      {job.detail === '' ? '' : ` · ${job.detail}`}
    </span>
    {/* 取消/去验证是**在途任务**的处置，创建期间仍然可用 —— 被冻结的是"新发起"。 */}
    {job.state === 'running'
      ? <Button variant="secondary" className={V.btn} onClick={() => { props.onCancel(job.jobId) }}>
        {zhCN.valuationAuthLoginCancel}
      </Button>
      : null}
    {/* 登录成功但页面要验证：给的是「去验证」，**不是**"登录失败"、也不是"重新登录"。 */}
    {job.state === 'waiting-user'
      ? <Button variant="secondary" className={V.btn} onClick={() => { props.onVerify(job.siteId) }}>
        {zhCN.valuationCapabilityGoVerify}
      </Button>
      : null}
  </div>
}

/** 逐站状态的人话兜底（Host 的 `stateLabel` 缺字段时用，不渲染一片空白）。 */
const STATE_LABELS: Record<string, string> = {
  authenticated: zhCN.valuationAuthStateReady,
  unauthenticated: zhCN.valuationAuthStateMissing,
  unknown: zhCN.valuationAuthStateUnknown,
}

/**
 * 摘要行上的**短结论**。
 *
 * 被人机验证挡住时**保留登录事实**但换一句短结论（"需要页面验证"）：
 * 那既不是未登录，也不是"无法检查"。
 */
function shortStateOf(row: SiteRowView): string {
  const challenged = row.challenge !== undefined && row.challenge.detected === true
    && row.challenge.state !== 'recovered'
  if (challenged) return zhCN.valuationCapabilityShortChallenge
  if (row.state === 'unknown') {
    return row.stateLabel === '' ? zhCN.valuationCapabilityShortUnknown : row.stateLabel
  }
  return row.stateLabel === '' ? (STATE_LABELS[row.state] ?? zhCN.valuationAuthStateUnknown) : row.stateLabel
}

/**
 * 挑战（人机验证）处置的进度说明。
 *
 * 三档分开：还没试过 / 自动试过但没过 / 已经恢复。它们说的是**同一件事的三个阶段**，
 * 所以都留在展开区（摘要行只给"需要页面验证"这一条短结论）。
 */
function challengeTextOf(challenge: NonNullable<SiteRowView['challenge']>, label: string): string {
  if (challenge.state === 'recovered') {
    return zhCN.valuationAuthChallengeRecovered.replace('{label}', label)
  }
  return (challenge.attempted ? zhCN.valuationAuthChallengeWaiting : zhCN.valuationAuthChallengeChecking)
    .replace('{label}', label)
}

/** 一个来源一行：名称 / 短结论 / 该做的动作。长原因留在展开区。 */
function SiteRow(props: {
  row: SiteRowView
  locked: boolean
  onLogin: (siteId: string) => void
  onVerify: (siteId: string) => void
}): React.ReactElement {
  const { row } = props
  const label = row.label === '' ? row.siteId : row.label
  const challenge = row.challenge
  const challenged = challenge !== undefined && challenge.detected === true
  // 被人机验证挡住时**只**给「去验证」：引导登录是错的处置，员工本来就已经登录了。
  const canLogin = row.state === 'unauthenticated' && !challenged
  // 验证入口只在"真的检测到挑战"时出现（`detected`），不是有 verifyUrl 就给。
  const canVerify = challenged && challenge.state !== 'recovered'
  return <li
    className="crwu-valuation-auth-site"
    data-valuation-site={row.siteId}
    data-valuation-site-state={row.state}
    {...(challenged ? { 'data-valuation-site-challenge': challenge.state || 'detected' } : {})}
  >
    <span className="crwu-valuation-auth-site-name">{label}</span>
    <span className={V.capabilityState} data-valuation-site-state-label={row.state}>{shortStateOf(row)}</span>
    <span className="crwu-valuation-auth-site-actions">
      {canVerify
        ? <Button
          variant="secondary"
          className={V.btn}
          data-valuation-capability-action="verify"
          disabled={props.locked}
          onClick={() => { props.onVerify(row.siteId) }}
        >{zhCN.valuationCapabilityGoVerify}</Button>
        : null}
      {canLogin
        ? <Button
          variant="secondary"
          className={V.btn}
          data-valuation-capability-action="login"
          disabled={props.locked}
          onClick={() => { props.onLogin(row.siteId) }}
        >{zhCN.valuationAuthLoginGo.replace('{label}', label)}</Button>
        : null}
    </span>
  </li>
}

/**
 * 检查时刻的人话。
 *
 * 空串 = **没有时刻**（还没查过 / 旧宿主不回这个字段）：显示"尚未检查"，
 * 不许把它当成"刚检查过且正常"。
 */
export function checkedAtTextOf(checkedAt: string): string {
  const raw = checkedAt.trim()
  if (raw === '') return zhCN.valuationCapabilityNeverChecked
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return zhCN.valuationCapabilityNeverChecked
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
  return zhCN.valuationCapabilityCheckedAt.replace('{time}', stamp)
}

/** 这一区当前的"大状态"（测试锚点与样式挂钩，不参与文案）。 */
export function capabilityModeOf(login: ValuationLoginState): string {
  if (login.check === 'checking') return 'checking'
  if (login.check === 'idle') return 'idle'
  if (login.error !== '') return 'failed'
  return 'ready'
}

export function ValuationCapabilityArea(props: ValuationCapabilityAreaProps): React.ReactElement {
  const { state } = props
  const login: ValuationLoginState = state.login
  const rows = login.rows
  const checking = login.check === 'checking'
  const job = login.job
  const jobLabel = rows.find((row) => row.siteId === job?.siteId)?.label ?? job?.siteId ?? ''
  const anyChallenged = rows.some((row) => row.challenge?.detected === true
    && row.challenge.state !== 'recovered')
  const checkedAt = checkedAtTextOf(login.gate?.checkedAt ?? '')
  /** Long reasons / check time / finished login jobs unfold on demand (summary row always stays). */
  const [expanded, setExpanded] = React.useState(false)
  // Per-instance ids: two capability panels on one page must not share a details region.
  const detailsId = useInstanceId('crwu-valuation-capability')
  const detailsToggleId = `${detailsId}-toggle`

  const idle = login.check === 'idle'
  // 两个判据取或：抽屉显式传 `creating`，阶段本身也说明了"已经在交接路上"。
  // 于是"创建期间还能顺手点一下登录"在这一层**写不出来**，不靠调用方记得传参。
  const locked = props.locked === true || state.phase === 'creating-session'
  const sessionStarted = rows.length > 0 || login.gate !== null
  // 还没查过：说"还没检查"，并给一次主动检查 —— 不假装知道状态，也不假装必须检查。
  // 摘要行仍然在：状态词 + 唯一的可执行动作都直接可见（不藏在折叠层里）。
  const summaryRows = rows.length > 0 ? rows : [null]
  // Cancel / verify on an active job is actionable now, so that row stays directly visible;
  // terminal jobs stay in the details.
  const activeJob = job !== null && (job.state === 'running' || job.state === 'waiting-user') ? job : null
  const idleState = checking
    ? zhCN.valuationAuthChecking
    : (login.error !== '' ? zhCN.valuationCapabilityShortFailed : zhCN.valuationCapabilityIdle)

  return <section
    className={V.capabilityArea}
    data-valuation-capability={capabilityModeOf(login)}
    data-valuation-capability-description="true"
  >
    {/* Panel head: info icon + description on the left, always-visible actions on the right. */}
    <div className="crwu-valuation-auth-head">
      <span className="crwu-valuation-auth-icon" aria-hidden="true"><InfoIcon size={15} /></span>
      <span className="crwu-valuation-auth-head-text">
        {/* It is optional: "not logged in does not block the valuation". */}
        <span className="crwu-valuation-hint crwu-valuation-auth-desc">{zhCN.valuationCapabilityDescription}</span>
      </span>
      <span className="crwu-valuation-auth-head-actions">
        {/* Recheck / check: directly visible, no need to open the details first. */}
        <Button
          variant="text"
          size="sm"
          className={V.btn}
          data-valuation-capability-action="recheck"
          disabled={checking || locked}
          loading={checking}
          onClick={props.onRecheck}
        >{checking ? zhCN.valuationAuthCheckBusy : (sessionStarted ? zhCN.valuationAuthRecheck : zhCN.valuationCapabilityCheck)}</Button>
        {/* Details disclosure: the region id is per instance, so two panels never share one. */}
        <Button
          variant="text"
          size="sm"
          id={detailsToggleId}
          className="crwu-valuation-auth-details-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => { setExpanded(!expanded) }}
        >
          <ChevronDownIcon size={14} className="crwu-valuation-auth-chevron" />
          <span>{expanded ? zhCN.valuationCapabilityDetailsHide : zhCN.valuationCapabilityDetails}</span>
        </Button>
      </span>
    </div>

    {/* Compact source / state / action row: always visible, never folded into the details. */}
    <ul className={V.capabilitySummary} data-valuation-capability-summary="true">
      {summaryRows.map((row, index) => row === null
        ? <li key="idle" className="crwu-valuation-auth-site" data-valuation-site-status="idle">
          <span className="crwu-valuation-auth-site-name">{zhCN.valuationCapabilitySourceName}</span>
          <span className={V.capabilityState}>{idleState}</span>
        </li>
        : <SiteRow
          key={row.siteId === '' ? `site-${String(index)}` : row.siteId}
          row={row}
          locked={locked}
          onLogin={props.onLogin}
          onVerify={props.onVerify}
        />)}
    </ul>

    {/* 未登录时的降级事实：运行阶段实际会用到的平台（不在启动前伪造覆盖结论）。 */}
    {rows.some((row) => row.state === 'unauthenticated')
      ? <p className="crwu-valuation-hint" data-valuation-auth-fallback="true">
        {zhCN.valuationAuthFallbackHint}
      </p>
      : null}

    {/* Active login jobs stay visible: their "cancel / verify" is actionable right now. */}
    {activeJob === null ? null : <JobRow
      job={activeJob}
      label={jobLabel}
      locked={locked}
      onCancel={props.onCancelLogin}
      onVerify={props.onVerify}
    />}

    {/* Details: compact status rows (host reason / this check's error / challenge / check time). */}
    <div
      className={V.capabilityDetails}
      id={detailsId}
      role="region"
      aria-labelledby={detailsToggleId}
      hidden={!expanded}
    >
      <div className="crwu-valuation-auth-details-inner">
        {/* 结论与原因来自 Host（`gate.reason`）；页面不自己编一句。 */}
        {login.gate === null || login.gate.reason === ''
          ? null
          : <p className="crwu-valuation-auth-reason" role="status">{login.gate.reason}</p>}
        {/* 这次检查**没查成**：只在这里说一次，并且**不**归因成"未登录"。 */}
        {login.error === ''
          ? null
          : <p className="crwu-valuation-error" role="alert" data-valuation-auth-error="true">{login.error}</p>}
        {login.gate?.unavailable === true
          ? <p className="crwu-valuation-hint">{zhCN.valuationAuthUnavailableHint}</p>
          : null}
        {login.gate?.unavailable !== true && rows.some((row) => row.state === 'unauthenticated')
          ? <p className="crwu-valuation-hint">{zhCN.valuationAuthRetryHint}</p>
          : null}
        {login.gate?.unavailable !== true
          && rows.some((row) => row.state === 'unknown' && row.challenge?.detected !== true)
          ? <p className="crwu-valuation-hint">{zhCN.valuationAuthUnknownHint}</p>
          : null}
        {/* 逐站的长原因与挑战进度（摘要行只给短结论，避免一行里塞三段话）。 */}
        {rows.some((row) => row.reason !== '' || row.challenge?.detected === true)
          ? <ul className="crwu-valuation-auth-reasons">
            {rows.filter((row) => row.reason !== '' || row.challenge?.detected === true)
              .map((row) => <li key={row.siteId}>
                <span className="crwu-valuation-auth-site-name">{row.label === '' ? row.siteId : row.label}</span>
                {row.challenge?.detected === true
                  ? <span className="crwu-valuation-auth-site-challenge" role="status">
                    {challengeTextOf(row.challenge, row.label === '' ? row.siteId : row.label)}
                  </span>
                  : null}
                {/* 有挑战说明时不再重复整段 reason（那是同一件事的两种说法）。 */}
                {row.reason === '' || row.challenge?.detected === true
                  ? null
                  : <span className="crwu-valuation-auth-site-reason">{row.reason}</span>}
              </li>)}
          </ul>
          : null}
        {/* Finished login jobs stay in the details; the active row is directly visible above. */}
        {job === null || activeJob !== null ? null : <JobRow
          job={job}
          label={jobLabel}
          locked={locked}
          onCancel={props.onCancelLogin}
          onVerify={props.onVerify}
        />}
        {anyChallenged
          ? <p className="crwu-valuation-hint" data-valuation-verify-hint="true">{zhCN.valuationAuthVerifyHint}</p>
          : null}
        {/* ≥15 秒：说明"检查仍在进行 + 可以稍后重新检查"，**不假报失败**。 */}
        {checking && state.slowWait === 'auth'
          ? <p className="crwu-valuation-hint" data-valuation-slow-wait="auth">{zhCN.valuationAuthCheckSlow}</p>
          : null}
        {/* Checked-at: this snapshot is the fact as of that instant. */}
        <p className="crwu-valuation-hint" data-valuation-capability-checked-at={login.gate?.checkedAt ?? ''}>
          {checkedAt}
        </p>
      </div>
    </div>

    {/* 检查期间的持久状态文字（spinner 之外还要有一句话）。 */}
    {checking && sessionStarted
      ? <p className="crwu-valuation-auth-status" role="status">
        <span className="crwu-valuation-spinner" aria-hidden="true" />
        {zhCN.valuationAuthChecking}
      </p>
      : null}
    {idle && sessionStarted
      ? <p className="crwu-valuation-hint">{zhCN.valuationCapabilityIdle}</p>
      : null}
  </section>
}
