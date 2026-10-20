import * as React from 'react'
import { ValuationIntakePane } from './ValuationIntakePane.tsx'
import { ValuationConfirmationDrawer } from './ValuationConfirmationDrawer.tsx'
import { Button } from '../../../ui/components/index.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import { VALUATION_CLASSES as V } from '../model/styles.ts'
import {
  canReturnToEdit,
  handoffNoteOf,
  handoffRetryLabelOf,
  handoffTitleOf,
  keepsIntakeMounted,
  showsConfirmationDrawer,
  showsIntakeForm,
  type ValuationMethodChoice,
  type ValuationPageState,
} from '../model/valuation-state.ts'

/**
 * 「估值」通用页的模块外壳（协议 39 · 设计稿 §3）。
 *
 * ```text
 * 输入工作面（资料 → 共用条件 → 资产类型与方法 → 能力区） → 只读确认抽屉 → 交接父会话 → 跳转
 * ```
 *
 * ## 它是**哑**的：只按阶段选择显示哪一块
 *
 * 所有状态与动作都由 controller 提供。这样"只读确认抽屉"只有一处判据：阶段是
 * `confirmation` / `creating-session` 时才渲染抽屉，而抽屉的 props 里没有任何 `onChange`。
 *
 * ## 进页面**不做任何探测**（协议 39）
 *
 * 旧实现挂载即调一次案例来源检查，并把"正在检查 / 未登录"当成整页门禁 —— 于是没登录的员工
 * 连资料都整理不了。现在登录是可选用能力：页面直接是草稿，能力状态在**能力区**与
 * **确认抽屉打开时**各自更新一次。
 *
 * ## 输入工作面在抽屉打开时**隐藏但不卸载**（UX-16）
 *
 * 卸载整个表单会丢掉展开状态、查看全部状态、滚动位置与焦点锚点。保留它 + 抽屉负责 `inert`
 * 既满足"背景不可访问"，又让"焦点回到原「确认」按钮"变成把焦点还给**同一个**元素。
 */

export interface ReportEvaluationController {
  getState: () => ValuationPageState
  subscribe: (listener: (state: ValuationPageState) => void) => () => void
  /** 查一次案例来源能力状态（可选能力；进页面**不**自动调用）。 */
  checkAuth: () => void
  recheckAuth: () => void
  login: (siteId: string) => void
  cancelLogin: (jobId: string) => void
  openVerification: (siteId: string) => void
  pickFiles: () => void
  pickFolder: () => void
  removeSelection: (path: string) => void
  excludeFile: (path: string) => void
  reincludeFile: (path: string) => void
  undoRemoval: () => void
  rescan: () => void
  /** 选资产类型（空串 = 还没选）。 */
  setAssetType: (assetType: string) => void
  /** 选评估方法（空串 = 还没选；未知枚举由状态机拒绝）。 */
  setMethod: (method: ValuationMethodChoice) => void
  /** 改评估目的（空串 = 未指定）。 */
  setPurpose: (value: string) => void
  /** 改价值类型（空串 = 未指定）。 */
  setValueType: (value: string) => void
  setBaseDate: (value: string) => void
  setPrompt: (value: string) => void
  /** 选一份本机 .xlsx 计算表模板（可选）。 */
  pickTemplate: () => void
  clearTemplate: () => void
  preparePreview: () => void
  backToEdit: () => void
  confirm: () => void
  openCreatedSession: () => void
  invalidate: () => void
  /** Optional: reset to a fresh local draft after the workflow confirmed a clear. */
  resetDraft?: () => void
  markStale: () => void
}

export interface ReportEvaluationPaneProps {
  controller: ReportEvaluationController
}

/**
 * 交接结果屏（建会话失败 / 已建好但指令没发出 / 结果未知）。
 *
 * 标题与解释来自**结构化事实**（`creationDisposition`），不是一句泛化的阶段话；
 * 「返回修改」只有在 Host 明确说"没有创建"时才出现（UX-06 / UX-17）。
 */
function HandoffPanel(props: {
  state: ValuationPageState
  onRetry: () => void
  onOpen: () => void
  onBack: () => void
}): React.ReactElement {
  const { state } = props
  const sessionExists = state.parentSessionId !== ''
  const kind = state.creationDisposition === 'not-created'
    ? 'not-created'
    : (state.creationDisposition === 'created' || sessionExists ? 'created' : 'unknown')
  return <section className={V.handoff} data-valuation-handoff={state.phase} data-valuation-handoff-kind={kind}>
    <h3 className="crwu-valuation-handoff-title">{handoffTitleOf(state)}</h3>
    <p className="crwu-valuation-handoff-note">{handoffNoteOf(state)}</p>
    {state.error === '' ? null : <p className="crwu-valuation-error" role="alert">{state.error}</p>}
    {kind === 'unknown'
      ? <p className="crwu-valuation-hint" data-valuation-handoff-frozen="true">{zhCN.valuationHandoffFrozen}</p>
      : null}
    <div className="crwu-valuation-handoff-actions">
      {/* 已有会话：只重新导航（不再创建）；结果未知时先恢复同一轮。 */}
      {kind === 'created'
        ? <Button variant="secondary" className={V.btn} onClick={props.onOpen}>
          {zhCN.valuationSessionOpenRetry}
        </Button>
        : null}
      {canReturnToEdit(state)
        ? <Button variant="secondary" className={V.btn} onClick={props.onBack}>
          {zhCN.valuationDrawerBack}
        </Button>
        : null}
      <Button variant="primary" className={`${V.btn} ${V.btnPrimary}`} onClick={props.onRetry}>
        {handoffRetryLabelOf(state)}
      </Button>
    </div>
  </section>
}

export function ReportEvaluationPane(props: ReportEvaluationPaneProps): React.ReactElement {
  const controller = props.controller
  const state = React.useSyncExternalStore
    ? React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
    : useFallbackState(controller)

  React.useEffect(() => {
    // 离开这一页（切目录 / 面板卸载）：在途页面请求作废 + 清理瞬时状态
    //（检查中 → 可重查；准备中 → 可编辑草稿），回来不会永久卡住（UX-05）。
    //
    // ⚠️ **挂载时不做任何来源探测**（协议 39）：进页面就是草稿，资料随时可整理；
    // 能力状态由能力区的「检查来源状态」与确认抽屉打开时各自更新。
    return () => { controller.invalidate() }
  }, [controller])

  const creating = state.phase === 'creating-session'
  /** 抽屉关闭后焦点回到「确认」：输入工作面一直挂载着，所以把**同一个**元素还给它。 */
  const confirmButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const wantsDrawer = showsConfirmationDrawer(state.phase) && state.preview !== null
  /**
   * 抽屉打开时**独立查一次**来源能力状态（不阻塞抽屉，也不改阶段）。
   *
   * 为什么放在抽屉而不是进页面：员工已经决定要开始了，这时他需要知道的"来源现在是什么状态"
   * 才是有用的事实；进页面就查只会让他先等一次与当下无关的探测。
   */
  React.useEffect(() => {
    if (!wantsDrawer) return
    controller.recheckAuth()
  }, [wantsDrawer, controller])

  /**
   * 抽屉的**呈现生命周期**（设计稿 §10.4 / §14.1）。
   *
   * 阶段一变就把抽屉卸载掉，退出动画根本不会播（父层直接换树）。这里自己管
   * `presented` / `closing`：先加 `-out` 类播 150ms，动画结束才真正卸载。
   * `prefers-reduced-motion` 下**立即**卸载 —— 减少动画模式不能变成"多等 150ms"。
   */
  const [presented, setPresented] = React.useState(wantsDrawer)
  const [closing, setClosing] = React.useState(false)
  /**
   * 退出动画期间**继续显示同一份内容**。
   *
   * 「返回修改」会把 `state.preview` 清空（下一次「确认」是全新一轮），但抽屉还要淡出 150ms ——
   * 只按 `preview !== null` 判断的话，抽屉在点下去的那一帧就被卸载，退出动画根本不会播
   * （真实浏览器实测：`-out` 类从未出现）。
   */
  const lastPreviewRef = React.useRef(state.preview)
  if (state.preview !== null) lastPreviewRef.current = state.preview
  const drawerPreview = state.preview ?? lastPreviewRef.current
  React.useEffect(() => {
    if (wantsDrawer) {
      setClosing(false)
      setPresented(true)
      return
    }
    if (!presented) return
    const reduced = (globalThis as {
      matchMedia?: (query: string) => { matches?: boolean }
    }).matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    if (reduced) { setPresented(false); return }
    setClosing(true)
    const handle = setTimeout(() => { setPresented(false); setClosing(false) }, 150)
    return () => { clearTimeout(handle) }
  }, [wantsDrawer, presented])

  return <div className={V.pane} data-valuation-phase={state.phase}>
    {/* 阶段提示只留给 stale-host（旧宿主）；其余阶段由按钮、局部状态区与抽屉标题表达，
        不再叠一条"还没有开始 / 会话还没有创建成功"的泛化句（设计稿 §5.3 / UX-17）。 */}
    {state.phase === 'stale-host'
      ? <p className={V.error} role="alert">{zhCN.valuationPhaseStale}</p>
      : null}

    {/* 已登录但来源被挑战：**不阻塞**，只说明"验证在取数时处理"。 */}
    {showsIntakeForm(state.phase)
      ? <ChallengeNotices rows={state.login.rows} />
      : null}

    {/* 输入工作面：草稿/准备阶段显示；确认与创建阶段**隐藏但保留**（表单展示记忆）。
        资产类型、方法选项与**能力区**都长在这张工作面里（页面上到下的顺序就是任务顺序）。 */}
    {keepsIntakeMounted(state.phase)
      ? <div
        className="crwu-valuation-intake-host"
        hidden={!showsIntakeForm(state.phase)}
        data-valuation-intake-host="true"
      >
        <ValuationIntakePane
          state={state}
          onPickFiles={controller.pickFiles}
          onPickFolder={controller.pickFolder}
          onRemoveSelection={controller.removeSelection}
          onExcludeFile={controller.excludeFile}
          onReincludeFile={controller.reincludeFile}
          onUndoRemoval={controller.undoRemoval}
          onRescan={controller.rescan}
          onAssetTypeChange={controller.setAssetType}
          onMethodChange={controller.setMethod}
          onCheckCapability={controller.recheckAuth}
          onLoginSite={controller.login}
          onVerifySite={controller.openVerification}
          onCancelLogin={controller.cancelLogin}
          onBaseDateChange={controller.setBaseDate}
          onPurposeChange={controller.setPurpose}
          onValueTypeChange={controller.setValueType}
          onPromptChange={controller.setPrompt}
          onPickTemplate={controller.pickTemplate}
          onClearTemplate={controller.clearTemplate}
          onConfirm={controller.preparePreview}
          onBackToEdit={controller.backToEdit}
          primaryRef={confirmButtonRef}
        />
      </div>
      : null}

    {/* 抽屉在确认与"正在创建会话"两种阶段都开着：主操作按钮自己变成
        「正在创建会话…」，这样点下去的一瞬间用户看到的是**同一颗按钮**在变。 */}
    {presented && drawerPreview !== null
      ? <ValuationConfirmationDrawer
        open
        closing={closing}
        preview={drawerPreview}
        state={state}
        creating={creating}
        slow={state.slowWait === 'create'}
        onBack={controller.backToEdit}
        onConfirm={controller.confirm}
        onCheckCapability={controller.recheckAuth}
        onLoginSite={controller.login}
        onVerifySite={controller.openVerification}
        onCancelLogin={controller.cancelLogin}
        returnFocusTo={confirmButtonRef}
      />
      : null}

    {/* 自动打开失败：会话**已经建好了**，只提供"打开估值会话"（重试只导航、不再创建）。 */}
    {state.phase === 'handed-off' && state.openFailed
      ? <section className={V.handoff} data-valuation-handoff="open-failed">
        <h3 className="crwu-valuation-handoff-title">{zhCN.valuationSessionOpenFailed}</h3>
        <p className="crwu-valuation-handoff-note">{zhCN.valuationHandoffCreatedNote}</p>
        {state.error === '' ? null : <p className={V.error} role="alert">{state.error}</p>}
        <div className="crwu-valuation-handoff-actions">
          <Button variant="primary" className={`${V.btn} ${V.btnPrimary}`} onClick={controller.openCreatedSession}>
            {zhCN.valuationSessionOpenRetry}
          </Button>
        </div>
      </section>
      : null}

    {state.phase === 'handoff-failed'
      ? <HandoffPanel
        state={state}
        onRetry={controller.confirm}
        onOpen={controller.openCreatedSession}
        onBack={controller.backToEdit}
      />
      : null}

    {/* 再次进入房地产时的**中性**最近会话入口：不读执行进度、不读交付件。 */}
    {state.phase === 'draft' && state.recentSessionId !== ''
      ? <p className="crwu-valuation-recent">
        <span>{zhCN.valuationRecentSession}</span>
        <Button
          variant="text"
          className="crwu-valuation-more"
          onClick={controller.openCreatedSession}
        >{zhCN.valuationSessionOpenRetry}</Button>
      </p>
      : null}

    {state.notice === ''
      ? null
      : <p className={V.notice} role="status">{state.notice}</p>}
  </div>
}

/**
 * 已登录、但来源当前被人机验证挡住的**提示行**。
 *
 * 为什么不做成阻塞：那时候员工确实已经登录（凭据有效期可以作证），而验证是页面访问问题 ——
 * 取数流程会先自动尝试恢复，必要时才请他完成验证。门禁因此按"能进去"处理，但仍要说清这件事，
 * 否则员工第一次取数时会被一个他没见过的东西挡住。
 */
function ChallengeNotices(props: { rows: ValuationPageState['login']['rows'] }): React.ReactElement | null {
  const notices = props.rows
    .filter((row) => row.state === 'authenticated' && (row.verdict === 'captcha' || row.verdict === 'blocked'))
    .map((row) => {
      const label = row.label === '' ? row.siteId : row.label
      const validity = row.sessionCookie || row.expiresAt === ''
        ? (row.sessionCookie ? zhCN.valuationAuthValiditySession : zhCN.valuationAuthValidityUnknown)
        : zhCN.valuationAuthValidityUntil.replace('{time}', row.expiresAt)
      return zhCN.valuationAuthChallengeNotice
        .replace('{label}', label)
        .replace('{validity}', validity)
    })
  if (notices.length === 0) return null
  return <ul className="crwu-valuation-challenge-notes" data-valuation-challenge-notes="true">
    {notices.map((text) => <li key={text} role="status">{text}</li>)}
  </ul>
}

/**
 * 没有 `useSyncExternalStore` 时的退路（注入式渲染器 / 更老的 React）。
 *
 * 它**只在挂载时读一次**：这类宿主本来就不会有异步状态推进（测试与静态渲染）。
 */
function useFallbackState(controller: ReportEvaluationController): ValuationPageState {
  const [state, setState] = React.useState(controller.getState)
  React.useEffect(() => controller.subscribe(setState), [controller])
  return state
}
