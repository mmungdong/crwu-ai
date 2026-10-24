import * as React from 'react'
import { BrandMark } from '../ui/BrandMark.tsx'
import { Notice } from '../ui/primitives.tsx'
import { Button } from '../ui/primitives.tsx'
import { SideDrawer } from '../ui/SideDrawer.tsx'
import { BUILD_TAG_CLASSES, WORKBENCH_CLASSES as C } from './consts.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { zhCN } from '../locales/zh-CN.ts'
import { WORKBENCH_PROTOCOL } from '../../shared/consts.ts'
import { environmentStateOf, gatingOf, workbenchApi } from '../modules/report-audit/api.ts'
import { createReportPageLoader } from '../modules/report-audit/model/page-loader.ts'
import type { AuditView, CloudItem, DwsDeviceLoginView, DwsLocalDoctorView, DwsLocalRepairView, TaskRow } from '../../shared/types.ts'
import { openChildSession } from './open-session.ts'
import { discussionPortOf } from './services.ts'
import type { ClientServices } from './services.ts'
import { EnvironmentPane } from '../modules/environment/ui/EnvironmentPane.tsx'
import { createEnvStatusStore, useEnvStatus, type EnvStatusStore } from '../modules/environment/model/status.ts'
import { createDeviceLoginStore, loginManualOpenLines, type DeviceLoginStore } from '../modules/environment/model/device-login.ts'
import { AuditInfoDrawer } from '../modules/report-audit/ui/AuditInfoDrawer.tsx'
import { ReportPane } from '../modules/report-audit/ui/ReportPane.tsx'
import { openReportNotice, openSessionTarget, openSignedUrl } from '../modules/report-audit/model/row.ts'
import { LocalAuditPane } from '../modules/local-audit/ui/LocalAuditPane.tsx'
import type { LocalAuditController } from '../modules/local-audit/controller.ts'
import type { WorkspaceCleanupController } from '../modules/environment/model/workspace-cleanup.ts'
import { LOCAL_AUDIT_CLASSES } from '../modules/local-audit/consts.ts'
import {
  childNodes,
  enabledChildIds,
  moduleOfParent,
  nextTabKey,
  nodeById,
  pageIdentityOf,
  parentIdList,
  parentNodes,
  parentTabIdOf,
  tabIdOf,
  TAB_PANEL_ID,
  type PageId,
} from './navigation.ts'
import {
  createReportEvaluationPaneController,
  createValuationExperienceController,
  createValuationWorkflowController,
  reportEvaluationPaneServices,
  type ReportEvaluationController,
  type ValuationExperienceController,
  valuationWorkflowPort,
  type ValuationWorkflowController,
} from '../modules/report-evaluation/index.ts'
import { AssetAssessmentWorkflow, type AssetWorkflowStep } from '../modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx'
import { openValuationSession } from '../modules/report-evaluation/session/open-session.ts'
import { hostPickerCapabilities } from '../modules/local-audit/pick.ts'
import { WorkbenchLoading } from './LoadingPane.tsx'
import { createModuleStore, useModule, type ModuleStore } from './module-store.ts'
import { CRWU_SCOPE_PROPS } from '../styles/scope.ts'
import type { ModuleId } from './modules.ts'
import type { NavigateResult } from '../../shared/environment/model.ts'
import { buildTagOf, createBuildStore, currentVersionOf, hostIsStale, hostPermissionSchemaStale, useBuild, type BuildStore } from './build-store.ts'
import { consentGranted, consentRequestCapabilities } from '../modules/environment/model/local-access.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../shared/access/types.ts'
import { UpdateDialog } from '../modules/update/ui/UpdateDialog.tsx'
import { useUpdateDialog, useUpdateStore } from '../modules/update/model/react.ts'
import { updateViewModelOf, type UpdateBadgeTone } from '../modules/update/model/view-model.ts'
import type { UpdateDialogStore } from '../modules/update/model/dialog-store.ts'
import type { UpdateStore } from '../modules/update/model/update-store.ts'
import { greetingLine } from './greeting.ts'

/**
 * 工作台外壳。
 *
 * 职责只有三件：拉数据、把状态分发给下面三个模块、把用户操作翻译成 RPC。
 * **所有业务规则都不在这** —— 它们在 `report-audit/row.ts`（可独立测试）与 Host 侧。
 *
 * 结构（2026-09-22 重构）：
 * - 头部：标题 + 宿主版本徽章（吸顶不再需要，滚动已经交给正文区）；
 * - 正文：当前模块的内容（环境信息 / 报告审核 / 报告评估占位）；
 * - 底部：**常驻**的模块切换条 —— 无论正文滚到哪，三个模块都点得到。
 *
 * 视图与门禁（用户要求的行为，别改回去）：
 * - 进入工作台先跑一次环境自检，自检期间停在加载态；
 * - **自检通过就直接进报告审核**；
 * - 不通过就停在环境信息页；在报告审核页里则被门禁挡住（说明 + 重新自检 + 回环境信息）；
 * - 环境结论来自 `envStatus` store：侧栏底部那枚入口与这里看到的是同一个。
 *
 * 轮询策略：只在报告审核模块处于激活状态时按 10 秒轮询 `audit-status`，卸载时清掉定时器。
 * 轮询本身不是新鲜事，但**必须可释放**：否则切走面板后请求还在跑。
 */

const POLL_INTERVAL_MS = 10_000

/** 哪条登录在飞：两条钉钉路都占 `~/.dws` 锁，氚云不占 —— 界面要区别对待。 */
type LoginKind = 'h3yun' | 'dingtalk'

/** 一次登录命令的返回形状。 */
interface LoginCallResult {
  ok: boolean
  error?: string
  timedOut?: boolean
  stdoutTail?: string
  stderrTail?: string
  sandboxBlocked?: boolean
  opened?: boolean
  openError?: string
  url?: string
  cancelled?: boolean
}

type LoginCall = () => Promise<LoginCallResult>

export interface WorkbenchPanelProps {
  /** 由 apply 注入的浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  /** 由 apply 创建的环境状态 store；侧栏入口与这里共用同一份。 */
  envStatus?: EnvStatusStore
  /** 由 apply 创建的「跑的是哪一份插件」store；侧栏入口与这里共用同一份。 */
  build?: BuildStore
  /** 由 apply 创建的模块状态；侧栏那张分组卡上的三个子项与这里的三页是同一个模块。 */
  modules?: ModuleStore
  /** 由 apply 创建的更新状态；侧栏那枚版本徽标与这里的更新面板共用同一份。 */
  update?: UpdateStore
  /** 由 apply 创建的更新面板开关状态（侧栏徽标点开的就是它）。 */
  updateDialog?: UpdateDialogStore
  /**
   * 「本地审核」那一页的状态机草稿（选择 / 提示词 / 已准备的 handoff）。
   *
   * 由 `apply()` 创建、随 props 下发：它必须**跨页签与跨模块存活** —— 用户点一下「报告审核」
   * 看一眼再回来，刚才选的文件与提示词不能没。缺省（单测直接渲染组件）就地建一份。
   */
  localAudit?: LocalAuditController
  /**
   * 「报告评估」那一页的估值控制器（协议 32）。
   *
   * 与 `localAudit` 同一条理由：它握着选择、方法、基准日、补充要求与轮次状态，
   * 必须跨模块切换存活 —— 用户点去报告审核再回来，填的东西不能没。
   * 缺省（单测直接渲染组件）时页面显示"暂不可用"，而不是抛错。
   */
  evaluation?: ReportEvaluationController
  /** 估值页新交互的控制器（资料草稿与六步工作面）；缺省时就地建一份。 */
  experience?: ValuationExperienceController
  /**
   * 「估值」工作流的图控制器（协议 43）。
   *
   * 与 `evaluation` 同一条理由：它握着当前项目、节点详情与轮询计时器，必须跨模块切换存活。
   * 缺省（单测直接渲染组件）时就地建一份，保证页面在任何挂载方式下都能渲染。
   */
  workflow?: ValuationWorkflowController
  /** 「清理工作空间」的状态机（协议 49）；缺省时环境页不渲染该入口。 */
  cleanup?: WorkspaceCleanupController
  /** 当前平台：决定等待重启说明里的 macOS 提示。 */
  platform?: 'mac' | 'other'
  /** 过期判据用的时钟；缺省本机时钟（测试注入固定值）。 */
  now?: () => number
}

/** 更新徽标的语气 → 附加类（与侧栏入口共用同一套）。 */
const UPDATE_TONE_CLASSES: Record<UpdateBadgeTone, string> = {
  neutral: '',
  accent: C.updateBadgeAccent,
  warn: C.updateBadgeWarn,
  success: C.updateBadgeOk,
}

export function WorkbenchPanel(props: WorkbenchPanelProps): React.ReactElement {
  // 估值控制器：单测直接渲染面板时可以不给（那一页退化成"暂不可用"），
  // 生产形态由 `apply()` 注入一份跨模块存活的实例。
  // 缺省时就地建一份（与本地审核同一条口径）：这一页在任何挂载方式下都要能渲染，
  // 而不是因为少了一个 prop 变成空白。`apply()` 注入的那一份是**跨模块存活**的实例。
  //
  // 兜底那一份放在 ref 里：写在渲染表达式里的话，每次重渲染都是新控制器 ——
  // 用户填的方法 / 基准日 / 补充要求下一次渲染就没了（轮询的依赖也会跟着抖）。
  // 环境状态 store：没从 apply 传进来时（单测直接渲染组件）就地建一个（组件实例级，不是模块单例）。
  const fallback = React.useRef<EnvStatusStore | null>(null)
  if (fallback.current === null) fallback.current = createEnvStatusStore()
  const envStatus = props.envStatus ?? fallback.current
  // 估值兜底控制器：同样放 ref（每次重渲染新建一个会把用户填的方法/基准日/补充要求丢掉）。
  //
  // 图工作流控制器先建：兜底估值控制器的 `onHandoff` 要刷新的是**同一个** workflow 控制器，
  // 不是另建一个运行时，也不允许在这里创建会话。
  const workflowFallback = React.useRef<ValuationWorkflowController | null>(null)
  if (workflowFallback.current === null) {
    workflowFallback.current = createValuationWorkflowController(valuationWorkflowPort(), { autoPoll: true })
  }
  const workflowController: ValuationWorkflowController = props.workflow ?? workflowFallback.current
  const evaluationFallback = React.useRef<ReportEvaluationController | null>(null)
  if (evaluationFallback.current === null) {
    evaluationFallback.current = createReportEvaluationPaneController(reportEvaluationPaneServices(
      hostPickerCapabilities(
        () => props.services,
        {
          // 门禁与 `apply()` 同一条判据：现读环境快照 —— 快照一次会把"还没自检"永久钉住。
          ready: () => {
            const current = envStatus.get()
            return current.env !== null && current.env.allOk === true
              ? { ok: true, error: '' }
              : { ok: false, error: zhCN.valuationNeedEnvironment }
          },
        },
      ),
      // 会话跳转的两条服务同样现读（它们可能比本插件晚注册）。
      () => props.services,
    ), {
      // 交接被接受后留在工作流：刷新同一个图控制器，由 Host 决定项目状态。
      onHandoff: () => { void workflowController.refresh() },
    })
  }
  const evaluationController: ReportEvaluationController = props.evaluation ?? evaluationFallback.current
  const experienceFallback = React.useRef<ValuationExperienceController | null>(null)
  if (props.experience === undefined && experienceFallback.current === null) {
    experienceFallback.current = createValuationExperienceController({
      evaluation: evaluationController,
      workflow: workflowController,
    })
  }
  const experienceController: ValuationExperienceController = props.experience
    ?? (experienceFallback.current as ValuationExperienceController)
  React.useEffect(() => {
    if (props.experience !== undefined) return undefined
    return () => { experienceFallback.current?.dispose() }
  }, [props.experience])
  const snapshot = useEnvStatus(envStatus)
  const env = snapshot.env
  const envState = environmentStateOf(env)
  const envOk = env !== null && env.allOk === true
  // 问候的姓名来自**环境自检**（`env.me`，钉钉 CLI 在同一次自检里取回），所以这里不额外发请求 ——
  // 用户口径（2026-09-22）：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调」。
  // 按**本地时钟**的小时分档；姓名拿不到时 greetingLine 返回空串 → 整句不渲染。
  const greeting = greetingLine(new Date().getHours(), env?.me?.name ?? '')

  // 「现在跑的是哪一份插件」与侧栏入口共用同一份结论：dev（本地源码检出）还是装好的包 + 版本号。
  // 单测直接渲染组件时没有 props.build，就地建一个（属于组件实例，不是模块级单例）。
  // 模块状态与侧栏那张分组卡共用同一份；单测直接渲染组件时就地造一份（不是模块级单例）。
  const moduleFallback = React.useRef<ModuleStore | null>(null)
  if (moduleFallback.current === null) moduleFallback.current = createModuleStore()
  const modules = props.modules ?? moduleFallback.current
  const mod = useModule(modules)
  /** 当前二级目录对应的节点（一级目录 / 环境信息 / 空目录时为 `null`）。 */
  const activeNode = nodeById(mod.node)
  /**
   * 当前目录条属于哪个模块 —— 由**一级目录的 `module` 字段**决定，不是页面里按字符串过滤。
   *
   * 评估树与审核树因此是两棵：进入「报告评估」时一级标签只有「估值」，不会出现「审核」
   *（报告审核 / 本地审核由侧栏「报告审核」进入，它们那棵树里也没有「估值」）。
   */
  const navModule = moduleOfParent(mod.parent)
  /**
   * The audit module has exactly one parent group (审核); painting it above its two leaf pages is a
   * redundant row. Audit therefore flattens to a single primary row of 报告审核 / 本地审核, reusing
   * the same stable child ids and existing click / keyboard handlers. Other modules keep the
   * generic two-level tree.
   */
  const flatAuditNav = navModule === 'audit'
  /**
   * 资产评估的业务步骤（协议 43）：总览 → 某一项业务（当前只有「估值」）。
   *
   * 它必须长在**面板实例**上，而不是长在 `AssetAssessmentWorkflow` 内部：注入式渲染器
   * 每次展开嵌套组件都会新建实例，组件内部 state 在父级重渲染时会被重置 —— 那样点进
   * 「估值」会立刻弹回总览。
   */
  const [workflowStep, setWorkflowStep] = React.useState<AssetWorkflowStep>('overview')
  /**
   * 估值页激活时才读取工作流状态；离开时中止在途请求与轮询计时器。
   *
   * `activate()` 是**被动读取**：它不会启动 / 恢复任务。切回总览或切走模块时 `deactivate()`
   * 释放定时器；面板卸载同样走这条清理。
   */
  const onWorkflowPage = activeNode?.page === 'valuation'
  /**
   * The workflow projection belongs to one workspace. Re-enter (or change workspace) must
   * re-read passively and drop the previous projection instead of flashing it.
   */
  const workflowWorkspaceIdentity = `${env?.workspace.id ?? ''}\u0000${env?.workspace.path ?? ''}`
  React.useEffect(() => {
    if (!onWorkflowPage) {
      workflowController.deactivate()
      return undefined
    }
    void workflowController.activate()
    return () => { workflowController.deactivate() }
  }, [onWorkflowPage, workflowController, workflowWorkspaceIdentity])
  // 离开估值页就回到业务总览：下次进来先看业务步骤，而不是上次停在哪。
  React.useEffect(() => {
    if (!onWorkflowPage) setWorkflowStep('overview')
  }, [onWorkflowPage])
  /**
   * 内容区容器（滚动容器）。它切换目录时**不重建**，所以滚动位置要按页面身份处理。
   */
  const tabPanelRef = React.useRef<HTMLDivElement | null>(null)
  const pageIdentity = pageIdentityOf(mod)
  const shownIdentity = React.useRef(pageIdentity)
  React.useEffect(() => {
    if (shownIdentity.current === pageIdentity) return
    shownIdentity.current = pageIdentity
    // 不许把上一页的滚动位置无条件套给下一页：身份换了就回到顶部。
    const element = tabPanelRef.current
    if (element !== null && element !== undefined) element.scrollTop = 0
  }, [pageIdentity])
  /**
   * 两级目录的页签引用：键盘左右切换后把焦点带到新页签上（roving tabindex 的另一半是 `tabIndex`）。
   *
   * 一级与二级共用一个表，键是页签自己的稳定 id —— 两级各存一份只会让"焦点跟没跟上"分成两处判。
   */
  const tabRefs = React.useRef<Record<string, { focus?: () => void } | null>>({})
  /**
   * 点一级目录：门禁、落点、二级目录的默认页全在统一导航层里一次算完（组件不重复判）。
   *
   * 「每次切一级目录都默认选中第一个可用页面」是明确口径（用户 2026-10-13），
   * 所以这里**不记忆**上一次停在哪个二级页面。
   */
  const gotoParent = (parentId: string): void => {
    const verdict = modules.navigateParent(parentId, { state: environmentStateOf(envStatus.get().env) })
    if (verdict.blocked && mounted.current) setNotice(verdict.reason)
  }
  const gotoNode = (nodeId: string): void => {
    const verdict = modules.navigateNode(nodeId, { state: environmentStateOf(envStatus.get().env) })
    if (verdict.blocked && mounted.current) setNotice(verdict.reason)
  }
  const keyOf = (event: React.KeyboardEvent): string => (event as unknown as { key?: string }).key ?? ''
  /** 键盘左右切换一级目录（Home / End 直达两端，别的键不动）。 */
  const onParentKeyDown = (event: React.KeyboardEvent): void => {
    if (navModule === null) return
    const key = keyOf(event)
    const next = nextTabKey(mod.parent, key, parentIdList(navModule))
    if (next === mod.parent) return
    event.preventDefault()
    gotoParent(next)
    tabRefs.current[parentTabIdOf(next)]?.focus?.()
  }
  /** 键盘左右切换二级目录；「开发中」的子项不参与循环（它们不可进入）。 */
  const onChildKeyDown = (event: React.KeyboardEvent): void => {
    const key = keyOf(event)
    const ids = enabledChildIds(mod.parent)
    if (mod.node === null || ids.length === 0) return
    const next = nextTabKey(mod.node, key, ids)
    if (next === mod.node) return
    event.preventDefault()
    gotoNode(next)
    tabRefs.current[tabIdOf(next)]?.focus?.()
  }
  /**
   * **统一导航入口的本地包装**。
   *
   * 每一次跳转（侧栏子项、环境页的「进入报告审核」、报告页内跳转、报告评估页的引导）
   * 都走这一条：门禁判据只有一份（`module-store` → `shared/environment/model.ts` 的纯函数），
   * 面板不再自己写"能不能进 audit"。
   */
  const go = React.useCallback((target: ModuleId): NavigateResult => {
    const verdict = modules.navigate(target, { state: environmentStateOf(envStatus.get().env) })
    if (verdict.blocked && mounted.current) {
      // 被门禁拦下来：把原因留下来（环境页顶部会显示「进入【目标页】前…」）。
      setNotice(verdict.reason)
    }
    return verdict
  }, [modules, envStatus])

  const buildFallback = React.useRef<BuildStore | null>(null)
  if (buildFallback.current === null) buildFallback.current = createBuildStore()
  const buildStore = props.build ?? buildFallback.current
  const build = useBuild(buildStore)
  const tag = buildTagOf(build)
  // 自助更新：与侧栏那枚徽标共用**同一个** store（apply 里创建的唯一一份）。
  // hook 无条件调用，缺省时不注入任何东西（单测直接渲染组件也能跑）。
  const updateSnapshot = useUpdateStore(props.update)
  const updateDialogState = useUpdateDialog(props.updateDialog)

  /** 被门禁拦住的界面状态：running = 正在重新自检，blocked = 自检没过。 */
  const [gate, setGate] = React.useState<'idle' | 'running' | 'blocked'>('idle')
  // 登录结果（成功/失败原因/CLI 打印的 URL 或设备码）。**不能丢**：命令跑不起来时
  // 它是用户唯一的线索 —— 实测「点了钉钉登录没有任何反应」就是因为它被丢掉了。
  const [loginMessage, setLoginMessage] = React.useState('')
  /**
   * loopback 登录（氚云 / 钉钉）在飞。
   *
   * 为什么需要它：两条登录都要抢同一把 `~/.dws` 锁。设备流正在跑时宿主会拦住 loopback；
   * 反方向宿主**看不见**（那是一次同步调用），只能由界面在这里禁用设备流按钮。
   */
  const [loginInFlight, setLoginInFlight] = React.useState<'' | 'h3yun' | 'dingtalk'>('')
  /** 正在飞的那次登录调用；「改用设备流登录」要等它落定，否则两条命令会在同一把锁上撞。 */
  const loginRunningRef = React.useRef<Promise<void> | null>(null)
  /** 设备流登录的当前快照（协议 32）；`null` = 没有会话。 */
  const [deviceLogin, setDeviceLogin] = React.useState<DwsDeviceLoginView | null>(null)
  const deviceLoginRef = React.useRef<DeviceLoginStore | null>(null)
  // 授权门槛：拒绝**不落盘**（下次打开页面还会再问）；同意落盘在 Host 的 trustCredentials 里。
  const [authDeclined, setAuthDeclined] = React.useState(false)
  const [authBusy, setAuthBusy] = React.useState(false)
  const [authError, setAuthError] = React.useState('')
  const reportLoader = React.useRef<ReturnType<typeof createReportPageLoader> | null>(null)
  if (reportLoader.current === null) reportLoader.current = createReportPageLoader({
    pending: workbenchApi.pending,
    ossBatchIndex: async (args, options) => {
      if (buildStore.get().protocol === null) await buildStore.refresh()
      if (buildStore.get().protocol !== WORKBENCH_PROTOCOL) return { ok: false, error: zhCN.hostStaleGate, results: {} }
      return await workbenchApi.ossBatchIndex(args, options)
    },
  })
  const pageLoader = reportLoader.current
  const [reportPage, setReportPage] = React.useState(pageLoader.get())
  const pending = reportPage.pending
  const busy = reportPage.pageLoading
  const ossIndex = Object.fromEntries(Object.entries(reportPage.remote)
    .filter(([, result]) => result.status === 'ready' && result.item !== null)
    .map(([seq, result]) => [seq, result.item!]))
  const [audits, setAudits] = React.useState<Record<string, AuditView>>({})
  /**
   * 本地记下的"我刚点过停止"的时刻（F1）。
   *
   * `audit-stop` 是两阶段的：RPC 只**接受**请求，真正停下要等后台。而状态轮询是 10 秒一次 ——
   * 只靠轮询的话，用户点完会盯着没反应的按钮最多 10 秒。本地这个时刻让界面立刻显示
   * 「正在请求停止审核…」，阶段与结论仍然以 Host 回报为准。
   */
  const [stopRequestedAt, setStopRequestedAt] = React.useState(0)
  /** 正在打开交付件的那一行（行内显示「正在打开…」并锁住按钮）。 */
  const [openingKey, setOpeningKey] = React.useState('')
  /**
   * Host 说"现在能不能启动下一条审核"（F4）。**只信 Host**：
   * 缺字段（旧宿主）按"没有正在停的审核"处理，否则老版本界面会被永久禁用。
   */
  const [canStartNext, setCanStartNext] = React.useState(true)
  const [activeKey, setActiveKey] = React.useState('')
  const [activeChildId, setActiveChildId] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [auditBusy, setAuditBusy] = React.useState('')
  const [stopBusy, setStopBusy] = React.useState(false)
  const [retryBusy, setRetryBusy] = React.useState(false)
  const [drawer, setDrawer] = React.useState<{ key: string; info: Record<string, unknown> | null; error: string } | null>(null)
  /** Drawer 正在播关闭动画（150ms 后再卸载）。 */
  const [drawerClosing, setDrawerClosing] = React.useState(false)
  const drawerTimer = React.useRef<number | null>(null)
  const drawerRequest = React.useRef(0)
  const [wsBusy, setWsBusy] = React.useState(false)
  const [wsMessage, setWsMessage] = React.useState('')
  // 钉钉本机目录体检（协议 18 · D）：诊断结果是**组件状态**，不进全局 store ——
  // 它只服务这一个面板，而且"查过一次"这个事实本身没有跨页面意义。
  const [dwsLocal, setDwsLocal] = React.useState<DwsLocalDoctorView | null>(null)
  const [dwsLocalRepair, setDwsLocalRepair] = React.useState<DwsLocalRepairView | null>(null)
  const [dwsLocalBusy, setDwsLocalBusy] = React.useState(false)
  const [dwsLocalError, setDwsLocalError] = React.useState('')
  // 二次确认：**许可**（允许读本机凭据）与**改权限**是两件事，必须分开问。
  const [dwsLocalConfirming, setDwsLocalConfirming] = React.useState(false)
  const [handoff, setHandoff] = React.useState<TaskRow | null>(null)
  const [handoffCopied, setHandoffCopied] = React.useState(false)
  // 卸载标记：面板切走之后到达的应答**不得**再写状态。
  // 没有这个守卫时，React 会对已卸载组件设置状态，而且旧数据可能覆盖下一次挂载的结果。
  const mounted = React.useRef(true)

  const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

  // 卸载时清掉关闭动画的计时器（面板关掉之后不许再 setState）。
  React.useEffect(() => () => {
    if (drawerTimer.current !== null) window.clearTimeout(drawerTimer.current)
  }, [])

  /**
   * 跑一次登录并把结果**显示出来**。
   *
   * 这两条命令会开浏览器、等人扫码（宿主侧超时 5 分钟），所以：成功也要给一句话，
   * 失败必须带原因，CLI 打到 stdout 的 URL / 设备码 / 提示原样带出来 —— 浏览器打不开时，
   * 那串 URL 就是员工唯一能自己走下去的路。
   *
   * `sandboxBlocked` 是 **Host 的归因事实**（登录必须写工作区之外的路径）：为真时
   * `error` 里已经是一句人话 + 下一步动作，这里不再追加 stdout 尾巴 —— 那只会是一句
   * 「正在打开浏览器窗口…」，把真正的动作挤到看不见。
   */
  const runLogin = React.useCallback(async (label: string, call: LoginCall, kind: LoginKind) => {
    // 文案口径（协议 32）：**授权页由面板自己打开**（本机 CLI 那次失败是静默的，见 dwsLogin）。
    // 面板仍然不创建浏览器 Tab、不显示二维码。
    setLoginMessage(`${label}：正在打开授权页…完成授权后这里会自动更新（最多 5 分钟）`)
    setLoginInFlight(kind)
    try {
      const result = await call()
      if (!mounted.current) return
      const lines: string[] = []
      if (result.cancelled === true) lines.push(`${label}：已取消这次登录。`)
      else if (result.ok) lines.push(`${label}：命令已执行完成，请点「重新检查」查看结果。`)
      else if (result.timedOut === true) lines.push(`${label}：等待超时（5 分钟）。请重试一次。`)
      else lines.push(`${label}失败：${result.error || result.stderrTail || '未知原因'}`)
      if (result.sandboxBlocked !== true) {
        const detail = (result.stdoutTail ?? '').trim() || (result.stderrTail ?? '').trim()
        if (detail !== '') lines.push(detail)
      }
      // 系统 `open` 退出 0 不等于页面真的出现了：没能打开就把链接摆出来（见 loginManualOpenLines）。
      lines.push(...loginManualOpenLines(result))
      setLoginMessage(lines.join('\n'))
    } catch (cause) {
      if (mounted.current) setLoginMessage(`${label}失败：${describe(cause)}`)
    } finally {
      if (mounted.current) setLoginInFlight('')
    }
    if (mounted.current) await envStatus.refresh()
  }, [envStatus])

  /** 把一次登录登记成"在飞"，供「改用设备流登录」等待。 */
  const trackLogin = React.useCallback((label: string, call: LoginCall, kind: LoginKind): void => {
    const running = runLogin(label, call, kind)
    loginRunningRef.current = running
    void running.finally(() => {
      if (loginRunningRef.current === running) loginRunningRef.current = null
    })
  }, [runLogin])

  /**
   * 设备流登录的会话（协议 32）。**按面板实例持有** —— 它握着轮询定时器，卸载时必须停掉。
   *
   * `resume()` 是「切走再切回来还看得到正在跑的那次」的实现：会话在宿主手里，客户端只有主动
   * 问一次才知道。终态时刷新环境自检一次（由 store 保证只刷一次）。
   */
  React.useEffect(() => {
    const store = createDeviceLoginStore({
      api: {
        dwsLoginDeviceStart: workbenchApi.dwsLoginDeviceStart,
        dwsLoginDeviceStatus: workbenchApi.dwsLoginDeviceStatus,
        dwsLoginDeviceCancel: workbenchApi.dwsLoginDeviceCancel,
      },
      onSettled: (view) => {
        if (view.phase !== 'ok') return
        void envStatus.refresh()
      },
    })
    deviceLoginRef.current = store
    const unsubscribe = store.subscribe(() => {
      const view = store.get()
      if (!mounted.current) return
      setDeviceLogin(view)
      // 授权页**只由 Host 打开一次**（`open -n`）。客户端**不**再自己补开：它拿到的
      // `opened === false` 分不清"Host 还没试"和"Host 那次调用还在飞"，补开就会开出两个窗口
      //（2026-10-13 评审抓到的竞态）。可靠路径是面板上那颗「打开授权页面」+ 可复制的链接。
    })
    void store.resume()
    return () => {
      unsubscribe()
      store.dispose()
      deviceLoginRef.current = null
    }
  }, [envStatus])

  const startDeviceLogin = React.useCallback(() => { void deviceLoginRef.current?.start() }, [])
  const cancelDeviceLogin = React.useCallback(() => { void deviceLoginRef.current?.cancel() }, [])
  /**
   * 「改用设备流登录」：**先**让 Host 把正在跑的 loopback 杀掉（它占着 `~/.dws` 锁），
   * 再起设备流 —— 顺序不能反，反了设备流那条命令只会卡在同一把锁上。
   */
  const switchToDeviceLogin = React.useCallback(() => {
    void (async () => {
      let killed = false
      try {
        killed = (await workbenchApi.dwsLoginCancel()).ok
      } catch {
        // 取消请求本身失败不该挡住下一步：真起不来的话设备流会给出它自己的失败归因。
      }
      // 真的取消掉了：那次 `dws-login` 还要等到下一次轮询才返回（≤300ms）。**等它落定**再起
      // 设备流，否则两条命令会撞在同一把 `~/.dws` 锁上 —— 那正是"改用"要解决的事。
      if (killed) {
        try {
          await loginRunningRef.current
        } catch {
          // 那次登录自己会记消息；这里只负责顺序。
        }
      }
      await deviceLoginRef.current?.start()
    })()
  }, [])

  /**
   * 打开工作流里的**真实父会话**（协议 43）：只在员工点击时发生。
   *
   * 走 `uiWorkspace.openSession`（不是 `openSubagent`）；两条服务都在调用时现读，
   * 因为它们可能比本插件晚注册。
   */
  const openParentSession = React.useCallback((sessionId: string): void => {
    void openValuationSession({
      get uiWorkspace() { return props.services.uiWorkspace },
      get layout() { return props.services.layout },
    }, sessionId).then((result) => {
      if (!result.ok && mounted.current) setNotice(result.error)
    })
  }, [props.services])

  React.useEffect(() => {
    let epoch = pageLoader.get().epoch
    return pageLoader.subscribe((next) => {
      if (next.epoch !== epoch) {
        epoch = next.epoch
        drawerRequest.current++
        if (drawerTimer.current !== null) { window.clearTimeout(drawerTimer.current); drawerTimer.current = null }
        setDrawer(null)
        setDrawerClosing(false)
      }
      setReportPage(next)
    })
  }, [pageLoader])
  const loadReport = React.useCallback((options: Partial<{ query: string; page: number; size: number }> = {}) => {
    setNotice('')
    return pageLoader.load({ ...pageLoader.get().target, ...options })
  }, [pageLoader])
  const uploaded = React.useRef<Record<string, string>>({})

  // 「本地的审核记录 / 子会话是否已经查过一次」。报告行的主操作标签（AI 审核 / 重新审核）
  // 取决于这份数据，所以**必须先有它再画行**：否则用户会看到「AI 审核」先出现、
  // 过一会儿跳成「重新审核」（用户 2026-09-22 报的一致性问题）。
  const [auditsReady, setAuditsReady] = React.useState(false)

  /**
   * 「复制诊断」：把当前审核的停止诊断整理成一段可粘贴的文本。
   *
   * 只放**维护者需要的事实**（key / childId 尾 / 阶段 / 错误 / 观察 / attempt / 开始时间）——
   * 路径、凭据一律不进（脱敏口径见 AGENTS §4.4.2）。
   */
  const copyStopDiagnostics = React.useCallback((key: string) => {
    const record = audits[key]
    if (record === undefined) return
    const stop = record.stop
    const lines = [
      `key=${key}`,
      `child=${record.childId === '' ? '(空)' : record.childId.slice(-8)}`,
      `attempt=${record.attempt}`,
      `status=${record.status}`,
      `startedAt=${record.startedAt}`,
      `stop.phase=${stop?.phase ?? '(未知)'}`,
      `stop.quiesced=${String(stop?.quiesced ?? '(未知)')}`,
      `stop.aborted=${String(stop?.aborted ?? '(未知)')}`,
      `stop.disposed=${String(stop?.disposed ?? '(未知)')}`,
      `stop.elapsedMs=${String(stop?.elapsedMs ?? 0)}`,
      `stop.error=${stop?.error === undefined || stop.error === '' ? '(无)' : stop.error}`,
      `stop.notes=${stop?.notes === undefined || stop.notes.length === 0 ? '(无)' : stop.notes.join('；')}`,
    ].join('\n')
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard
    if (clipboard?.writeText !== undefined) {
      void clipboard.writeText(lines).then(() => { setNotice(zhCN.copyDiagnosticsDone) }).catch(() => { setNotice(zhCN.copyDiagnosticsFailed) })
      return
    }
    // 没有浏览器剪贴板（旧 webview）→ 退回宿主剪贴板。
    void workbenchApi.clipboard({ text: lines })
      .then((result) => { setNotice(result.ok ? zhCN.copyDiagnosticsDone : result.error) })
      .catch((cause: unknown) => { setNotice(describe(cause)) })
  }, [audits])

  const refreshAudits = React.useCallback(async () => {
    try {
      const result = await workbenchApi.auditStatus({})
      if (!mounted.current || !result.ok) return
      setAuditsReady(true)
      const next: Record<string, AuditView> = {}
      for (const record of result.audits) next[record.key] = record
      for (const record of result.audits) {
        if (record.uploadedAt !== '' && uploaded.current[record.key] !== undefined
        && uploaded.current[record.key] !== record.uploadedAt) void pageLoader.refresh(record.seqNo)
      }
      uploaded.current = Object.fromEntries(result.audits.map((record) => [record.key, record.uploadedAt]))
      setAudits(next)
      setActiveKey(result.active.key)
      setActiveChildId(result.active.childId)
      setCanStartNext(result.canStartNext !== false)
    } catch (cause) {
      // 轮询失败不改状态：下一轮会自愈，把界面清空反而更糟。
      void cause
    }
  }, [pageLoader])

  // 首次进入：boot（宿主版本 / 协议代数 / 已登记父级）+ 环境自检。
  // 侧栏入口也会 refresh 这两个 store，store 内部做并发去重，所以整页只发一次真实请求。
  React.useEffect(() => {
    void buildStore.refresh()
    // 自检**一次就够**：用户口径（2026-09-22）「这个钉钉 cli 环境监测一遍就可以了，不需要每次
    // 切换页面都去调，本质就是从环境信息把这个人的信息拿到」。面板会被关掉再打开（切会话、
    // 切模块），而一次自检要探二进制、问氚云与钉钉、列一次 OSS —— 所以只在**还没有结论**时补一次；
    // 要重跑有页面上的「重新自检」按钮，以及登录 / 授权成功后的那几次显式刷新。
    const current = envStatus.get()
    if (current.env === null && !current.busy) void envStatus.refresh()
    // 自助更新：面板也调一次 initialize()，store 自己保证幂等 + 单飞
    //（侧栏那枚常驻徽标通常已经先跑过，这里不会重复请求）。
    if (props.update !== undefined && !props.update.get().initialized) void props.update.initialize()
    return () => {
      mounted.current = false
    }
  }, [envStatus, buildStore])

  // 环境结论落地 → 交给 store 决定两件事：首次自动落位一次；以及**检查通过后恢复**
  // 最近一次被门禁拦下来的目标（没有 pendingTarget 时什么都不做，绝不无条件弹走用户）。
  //
  // 依赖用**统一模型的引用**：它是 Host 每次应答里的新对象，只在自检真的回来时变化。
  // 只盯解出来的 `env` 会漏掉「重新检查通过了、但 active 已经被用户改过」的那次通知，
  // 表现就是"检查通过了、人还卡在环境页"（实测踩到）。
  React.useEffect(() => {
    if (envState === null) return
    modules.envChanged({ state: envState })
  }, [modules, envState])

  // 从侧栏子项切模块时清掉上一次的拦截态：用户已经补好环境、再点回「报告审核」，
  // 不能还看到那张过期的「自检没过」拦截屏（以前由底部模块条的 onSelect 负责）。
  React.useEffect(() => {
    if (mod.selectEpoch === 0) return
    setGate('idle')
  }, [mod.selectEpoch])

  // 报告审核页激活时才轮询状态；离开时清掉定时器。
  const onReportPage = activeNode?.page === 'report-audit'
  React.useEffect(() => {
    if (!onReportPage || !envOk) return undefined
    void refreshAudits()
    void loadReport()
    const timer = setInterval(() => { void refreshAudits() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer); pageLoader.cancel() }
  }, [onReportPage, envOk, refreshAudits, loadReport, pageLoader])

  /**
   * ⚠️ 协议 35 起这里**没有**估值轮询（设计稿 §4.5）。
   *
   * 上一版面板替估值页轮询 `valuation-status`（4 秒一次，页面卸载也不停）。这一代
   * 页面在交接成功后**直接跳进顶层父会话**，完成度由父会话自己负责 —— 页面不再有
   * 状态/结果/交付件这些接口，所以"面板不再轮询"不是纪律，而是没有东西可轮询。
   * 报告审核那 10 秒的轮询仍在（在下面那个 effect 里），它的语义与估值无关。
   */

  /**
   * 「进入报告审核」。
   *
   * 走统一导航：能进就进；不能进时**不是静默禁用按钮**，而是当场重新检查一次环境 ——
   * 用户刚装完 / 刚登录完，最想做的就是再点一次，而不是先去别处找「重新检查」。
   * 检查通过后由 store 恢复这个被拦下来的目标（`pendingTarget`）。
   */
  const enterReport = (): void => {
    const verdict = go('audit')
    // 被拦时统一导航层已经记下 `blocked` + `gateReason`（上面那段 props 直接读它）；
    // 通过时把它清回 idle。
    setGate(verdict.blocked ? 'blocked' : 'idle')
  }

  /** 顶部结论卡与拦截屏共用的「重新检查环境」：跑完让 store 决定要不要恢复目标。 */
  const recheck = (): void => {
    setGate('running')
    void envStatus.refresh({ refresh: true }).then((result) => {
      if (!mounted.current) return
      const state = environmentStateOf(result)
      // 检查结论落地后由 store 统一决定"恢复还是继续留在环境页"。
      modules.envChanged({ state })
      setGate(result !== null && state?.proceed === true ? 'idle' : 'blocked')
    })
  }

  /**
   * 打开一份**已签名**的报告链接。
   *
   * 2026-10-11 用户实测「点查看报告后浏览器很慢」：原来这条链路是**两次串行的提权进程**
   * （`ossutil sign` → `open <url>`）。现在第②步交给客户端：
   *   1. `oss-link({ open: false })` 只拿链接（宿主一个进程都不起）；
   *   2. 客户端 `window.open` → 桌面端主进程转 `shell.openExternal` → 系统默认浏览器；
   *   3. 被弹窗拦截（`window.open` 返回 null）**或**宿主自作主张已经打开了（旧宿主
   *      忽略 `open:false`、回 `opened: true`）时，按对应分支收尾 —— 绝不重复开两个窗口。
   */
  const openReportLink = async (key: string): Promise<void> => {
    try {
      const signed = await workbenchApi.ossLink({ key, open: false })
      if (signed.ok !== true || String(signed.url ?? '') === '') {
        const note = openReportNotice(signed)
        if (note !== '') setNotice(note)
        return
      }
      // 旧宿主不认 `open:false`：它已经自己打开了，客户端不能再开一次。
      if (signed.opened === true) return
      if (openSignedUrl(String(signed.url))) return
      // 被浏览器拦住：退回宿主打开（老宿主与新宿主都支持这条路径）。
      const fallback = await workbenchApi.ossLink({ key })
      const note = openReportNotice(fallback)
      if (note !== '') setNotice(note)
    } catch (cause: unknown) {
      setNotice(describe(cause))
    }
  }

  /** 抽屉里「查看更多审核依据」的动作：打开这一行的交付件 HTML（没有就不给入口）。 */
  const reportOpenerOf = (key: string): (() => void) | undefined => {
    const cloud = ossIndex[key]
    if (cloud === undefined || cloud.htmlKey === '') return undefined
    const htmlKey = cloud.htmlKey
    return () => { void openReportLink(htmlKey) }
  }

  /**
   * 关闭 Drawer：**先播 150ms 关闭动画，再卸载**。
   *
   * `onClose` 依旧被立刻调用（Esc / 遮罩 / × 的行为不变），只是把"从 DOM 上消失"
   * 推迟到动画之后；重新打开会取消上一次的计时器，避免"关到一半又打开"时被中途卸载。
   */
  const closeDrawer = React.useCallback((): void => {
    drawerRequest.current++
    setDrawerClosing(true)
    if (drawerTimer.current !== null) window.clearTimeout(drawerTimer.current)
    drawerTimer.current = window.setTimeout(() => {
      drawerTimer.current = null
      setDrawer(null)
      setDrawerClosing(false)
    }, 150)
  }, [])

  const openAuditInfo = async (key: string, cloud: CloudItem): Promise<void> => {
    const request = ++drawerRequest.current
    const epoch = pageLoader.get().epoch
    const current = (): boolean => mounted.current && request === drawerRequest.current && epoch === pageLoader.get().epoch
    // 上一次的关闭动画还没跑完就又打开了：取消卸载，直接换成新的内容。
    if (drawerTimer.current !== null) { window.clearTimeout(drawerTimer.current); drawerTimer.current = null }
    setDrawerClosing(false)
    setDrawer({ key, info: null, error: '' })
    if (cloud.jsonKey === '') {
      setDrawer({ key, info: null, error: '这条报告没有审核结果 JSON' })
      return
    }
    try {
      const result = await workbenchApi.ossResult({ key: cloud.jsonKey })
      if (!current()) return
      setDrawer({ key, info: result.info, error: result.ok ? '' : result.error })
    } catch (cause) {
      if (current()) setDrawer({ key, info: null, error: describe(cause) })
    }
  }

  // 授权态：Host 回的本机访问收据（`env.localAccess`）是**唯一**判据（落盘后重启仍在）。
  // 客户端不许从「有没有凭据 / 是不是登录过」倒推 —— 那正是"未授权时报未登录"的来源。
  // 未授权**不遮住整页**（用户口径：「不要让一个模态层遮住整个环境页」）：它变成
  // 「账号连接」这一步里的第一张卡；真实门禁仍在 Host 侧（未授权一律拒绝）。
  const authorized = env !== null && consentGranted(env)
  /**
   * 允许本机访问。
   *
   * 提交的是**规范能力清单 + 权限说明版本**（不是 `{credentials: true}`）：Host 逐字核对清单，
   * 所以「界面显示的清单」与「落盘的收据」不可能不一致。返回的 `consent` 是回读结果 ——
   * 写盘失败时它不是 granted，界面就照实说"没有获得权限"，而不是一句成功提示。
   */
  const grantCredentials = (): void => {
    setAuthBusy(true)
    setAuthError('')
    void workbenchApi.localAccessGrant({
      schemaVersion: PERMISSION_SCHEMA_VERSION,
      capabilities: consentRequestCapabilities(),
    })
      .then((result) => {
        if (result.ok !== true) { setAuthError(result.error || zhCN.envConsentPersistFailedGrant); return null }
        setAuthDeclined(false)
        return envStatus.refresh()
      })
      .catch((cause: unknown) => { setAuthError(describe(cause)) })
      .finally(() => { setAuthBusy(false) })
  }
  /** 撤销本机访问：Host 侧**内存先关**，写盘失败也 fail closed（只在界面上如实报错）。 */
  const revokeCredentials = (): void => {
    setAuthBusy(true)
    setAuthError('')
    void workbenchApi.localAccessRevoke()
      .then((result) => {
        setAuthDeclined(false)
        // **撤销失败时不刷新环境**：宿主内存里已经关闭，但磁盘上可能还是上一份授权；
        // 刷新会走一次 `syncLocalAccessConsent`，把那份旧授权重新采纳回来 ——
        // 界面上就会出现"明明报了失败，却仍然是已允许"。宿主侧也有墓碑兜底（见 consent.ts），
        // 这里不去触发那条路径，是为了不制造一个自相矛盾的画面。
        if (result.ok !== true) {
          setAuthError(result.error || zhCN.envConsentPersistFailed)
          return undefined
        }
        return envStatus.refresh()
      })
      .catch((cause: unknown) => { setAuthError(describe(cause)) })
      .finally(() => { setAuthBusy(false) })
  }

  // 宿主与客户端不同代：明说 + 停发起审核（其余只读功能照常）。
  // 客户端产物随页面刷新就换新，宿主产物只有重启 profile 才换 —— 不同代时必须拦住，
  // 否则界面是新的、逻辑是旧的，会按旧规则把审核挂到「当前会话」下（实测踩过）。
  const hostStale = hostIsStale(build)
  // 权限说明版本不一致（含旧宿主没给这个字段）：**本机凭据操作必须停住**（授权卡整体禁用），
  // 因为执行旧授权范围的宿主"看起来授权成功"比拦住更危险。
  //
  // 为什么它不像 `hostStale` 那样替换整屏：协议 18 起两者是同一个 bundle 里的常量，
  // 「协议相同但 schema 不同」只有被改过的产物才可能出现 —— 那种情况下该拦的是凭据动作，
  // 而不是把整个工作台（包括只读的诊断信息）也一起换掉。
  const permissionStale = hostPermissionSchemaStale(build)
  /**
   * 是不是"第一次进来、还没拿到自检结论"。
   *
   * 三种情况下**不**显示等待页：
   * - 已经有结论（那当然直接渲染对应模块）；
   * - 宿主是旧构建（那是配置问题，要看到「请重启 profile」那句话，转圈会把它藏起来）；
   * - 请求已经失败（`snapshot.error` 非空）—— 失败要看到真实原因，不能一直转圈。
   */
  const awaitingEnv = env === null && !hostStale && snapshot.error === ''
  const bootError = build.error
  const boundParentId = build.parentSessionId
  // 有审核在跑时禁的是"安装"（不动 profile），**不禁检查** —— 这一点由 View Model 决定。
  // 判据只认两种**真的在跑审核**的状态：正在发起（auditBusy）与 Host 已确认在跑（activeKey）。
  // `busy` 是报告列表的加载/翻页状态，把它算进来会对着一个"正在刷新列表"的用户说
  // "有审核任务正在进行"（口径错误，第 6 轮审查点掉的就是这个）。
  const gatingHasAudit = auditBusy !== '' || activeKey !== ''
  const updateView = updateViewModelOf({
    snapshot: updateSnapshot,
    currentVersion: currentVersionOf(build),
    auditBusy: gatingHasAudit,
    nowMs: (props.now ?? Date.now)(),
    buildKind: build.buildKind,
    platform: props.platform ?? 'other',
  })
  const gating = gatingOf(env, activeKey, {
    busy,
    ...(auditBusy === '' ? {} : { auditBusy }),
    stopBusy,
    retryBusy,
    // 停止没确认静默之前不许再起一条（F1/F2）：与 Host 的 `canStartNext` 取交，
    // 这样行上的「AI 审核 / 重新审核」会一起变灰，而不是只靠文案提醒。
    ...(canStartNext ? {} : { canStart: false, gateReason: zhCN.stopNoRestartHint }),
    ...(hostStale ? { canDispatch: false, gateReason: zhCN.hostStaleGate } : {}),
  })

  const childAliveHint = activeChildId !== ''
    ? `当前占用的子会话：${activeChildId.slice(0, 8)}…`
    : ''

  const reportState = {
    tasks: (pending?.rows ?? []) as TaskRow[],
    audits,
    /** 审核记录查过没有 —— 报告页据此决定"现在能不能画行"（见 ReportPaneState 注释）。 */
    auditsReady,
    ossIndex,
    ossIndexError: reportPage.ossError,
    ossLoading: reportPage.ossLoading,
    remote: reportPage.remote,
    pageEpoch: reportPage.epoch,
    stale: reportPage.stale,
    pageError: reportPage.pageError,
    formName: pending?.formName ?? '',
    query: reportPage.target.query,
    page: pending?.page ?? reportPage.target.page,
    pageSize: pending?.size ?? 20,
    total: pending?.total ?? 0,
    filterMode: pending?.filterMode ?? '',
    activeKey,
    escalateAvailable: reportPage.escalateAvailable,
    handoff,
    notice,
    childAliveHint,
  }

  /**
   * 只读体检：**不是随时可跑的健康检查**，而是"刚才那次为什么失败"的事后归因。
   *
   * 设计 §D2 规定它只在"刚刚发生过一次 DWS 失败、且结构化事实排除沙箱"之后运行；
   * Host 在没有任何可归因失败时直接拒绝（`not-applicable`），界面如实显示那句话。
   * 这里不自己判断"该不该给按钮" —— 那是 Host 的判据，客户端再判一次就会有两套口径。
   */
  const checkDwsLocal = (): void => {
    setDwsLocalBusy(true)
    setDwsLocalError('')
    void workbenchApi.dwsLocalDoctor()
      .then((view) => { setDwsLocal(view); if (!view.ok) setDwsLocalError(view.error) })
      .catch((error: unknown) => { setDwsLocalError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDwsLocalBusy(false) })
  }
  /** 修复：只有走完二次确认才会到这里。 */
  const repairDwsLocal = (): void => {
    setDwsLocalConfirming(false)
    setDwsLocalBusy(true)
    setDwsLocalError('')
    void workbenchApi.dwsLocalPermissionRepair({ confirm: true })
      .then((result) => {
        setDwsLocalRepair(result)
        setDwsLocal(result.doctor)
        if (!result.ok) setDwsLocalError(result.error)
      })
      .catch((error: unknown) => { setDwsLocalError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDwsLocalBusy(false) })
  }

  // 环境信息页（不是目录树里的一页）：被门禁拦下来时、或自检还没结论时落在这里。
  const pendingNode = nodeById(mod.pendingNode)
  const envPane = <EnvironmentPane
    env={env}
    build={build}
    error={snapshot.error !== '' ? snapshot.error : bootError}
    busy={snapshot.busy}
    checkedAt={snapshot.checkedAt}
    onRefresh={recheck}
    // 账号连接**只读取、检查已有凭据**（2026-09-30 口径）：DSH 不再提供内置浏览器扫码登录，
    // 也不再提供钉钉设备码登录与登录进度轮询。这两颗按钮走的是**本机 CLI**（CLI 自己拉起
    // 系统浏览器），是给已有用户保留的兼容路径。
    onRelogin={() => { trackLogin('氚云登录', workbenchApi.relogin, 'h3yun') }}
    onDwsLogin={() => { trackLogin('钉钉登录', () => workbenchApi.dwsLogin(), 'dingtalk') }}
    loginMessage={loginMessage}
    // 设备流登录（协议 32）：快照由 store 订阅进来，两条登录的“在飞”状态合成卡片的 busy。
    deviceLogin={deviceLogin}
    // 只有**钉钉**那条 loopback 才占 `~/.dws` 锁；氚云登录时设备流那颗按钮照常可用。
    deviceLoginBusy={loginInFlight === 'dingtalk'}
    onDeviceLoginStart={startDeviceLogin}
    onDeviceLoginCancel={cancelDeviceLogin}
    onDeviceLoginSwitch={switchToDeviceLogin}
    // 拦截说明**直接读统一导航层记下来的结论**（`gate` + `pendingNode` + `gateReason`）：
    // 侧栏点子项被拦回来的那一刻就要说清"本来要去哪、为什么没进去"，
    // 不能等用户自己再点一次「重新检查」才出现。
    //
    // `gate` 的优先级：界面自己刚点的动作（`running` / `blocked`）> 统一导航层的 `blocked`。
    // 顺序不能反：用户刚点「重新检查」时要先看到 loading，而不是上一轮的拦截说明。
    {...(gate !== 'idle' ? { gate } : (mod.blocked ? { gate: 'blocked' as const } : {}))}
    {...(pendingNode === null ? {} : { gateTarget: pendingNode.label })}
    {...(mod.gateReason === '' ? {} : { gateReason: mod.gateReason })}
    services={props.services}
    wsBusy={wsBusy}
    wsMessage={wsMessage}
    onWsBusy={setWsBusy}
    onWsMessage={setWsMessage}
    // 授权（一次性、长期有效）**整合进配置流程**：不再用一个模态层遮住整页环境信息。
    authorized={authorized}
    authBusy={authBusy}
    authError={authError}
    authDeclined={authDeclined}
    onGrantCredentials={grantCredentials}
    onRevokeCredentials={revokeCredentials}
    onDeclineCredentials={() => { setAuthError(''); setAuthDeclined(true) }}
    authSchemaMismatch={permissionStale}
    onRegrant={() => { setAuthError(''); setAuthDeclined(false) }}
    dwsLocal={dwsLocal}
    dwsLocalRepair={dwsLocalRepair}
    dwsLocalBusy={dwsLocalBusy}
    dwsLocalError={dwsLocalError}
    dwsLocalConfirming={dwsLocalConfirming}
    onDwsLocalCheck={checkDwsLocal}
    onDwsLocalAskRepair={() => { setDwsLocalConfirming(true) }}
    onDwsLocalCancelRepair={() => { setDwsLocalConfirming(false) }}
    onDwsLocalConfirmRepair={repairDwsLocal}
    cleanup={props.cleanup}
  />

  /**
   * 报告审核模块被门禁挡住时的正文。
   *
   * 它和「环境信息」页不是一回事：这里只回答两件事 —— 为什么进不去、以及下一步点哪。
   * 详细的分层排查留在环境信息模块里（那是它唯一的职责）。
   */
  const auditGate = <div className={C.gate}>
    <div className={C.gateTitle}>
      {gate === 'running' ? zhCN.gateRunningTitle : zhCN.gateBlockedTitle}
    </div>
    <div className={C.muted}>{gate === 'running' ? zhCN.gateRunningHint : zhCN.gateBlockedHint}</div>
    <div className={C.row} style={{ marginTop: '12px' }}>
      <Button label={zhCN.recheck} tone="primary" disabled={gate === 'running'} onClick={enterReport} />
      <Button label={zhCN.moduleEnv} onClick={() => { go('env') }} />
    </div>
    {env !== null && env.blocked.length > 0
      ? <ul className={C.blockers}>
          {env.blocked.map((item, index) => <li key={item} className={C.blocker}>
            <span className={C.blockerIndex}>{String(index + 1)}</span>
            <span>{item}</span>
          </li>)}
        </ul>
      : null}
  </div>

  /**
   * 二级目录 → 正文。**只有这一处**按 `page` 分发 —— 新增页面在这里加一条，
   * 别在别处再写一套"现在停在哪一页"的判断。
   */
  const pageContentOf = (page: PageId | null): React.ReactElement | null => {
    if (page === 'report-audit') {
      // 环境没过时给拦截屏（说清为什么进不去 + 重新检查 + 回环境信息），而不是空白页。
      return envOk
        ? <ReportPane
            state={reportState}
            gating={gating}
            workspace={{ id: env?.workspace.id ?? '', path: env?.workspace.path ?? '' }}
            // 讨论面板只拿**真实存在的四个动词**（create/using/binding/list），
            // 适配器保证经接收者调用；「跳会话」不在 port 里（见下面的 onOpenDiscussion）。
            port={discussionPortOf(props.services)}
            onOpenDiscussion={(sessionId) => {
              // 「跳到这条讨论会话」= DSH 原生入口 `uiWorkspace.openSession(id)`：
              // 内部 replaceMain(…, 'reveal') 会设置主会话并切回原生对话
              //（工具调用、审批、完整渲染都在那边）。左侧会话列表被点也是走它。
              props.services.uiWorkspace?.openSession?.(sessionId)
              // 保底：`uiWorkspace` 缺席（旧宿主）时至少把插件面板让开，
              // 用户还能在左侧列表里点那条会话。`openSession` 自己也会调这一句，幂等。
              props.services.layout?.selectPanel?.(null)
            }}
            onSearch={(next) => { void loadReport({ query: next, page: 1 }) }}
            onGoPage={(next) => { void loadReport({ page: next }) }}
            onRefreshPending={() => { void loadReport() }}
            onRetryQuery={(seqNo) => { void pageLoader.retry(seqNo) }}
            onStart={(task, retry) => {
              const key = task.seqNo !== '' ? task.seqNo : task.name
              setAuditBusy(key)
              void workbenchApi.auditStart({
                key,
                seqNo: task.seqNo,
                objectId: task.id,
                project: task.project,
                ...(retry ? { retry: true } : {}),
              }).then((result) => {
                setNotice(result.ok ? '' : result.error)
                // 失败时留下手工兜底：审核本身可以在普通会话里做，不该让用户干等。
                setHandoff(result.ok ? null : task)
                setHandoffCopied(false)
                if (result.ok) {
                  setActiveKey(key)
                  setActiveChildId(result.childId)
                  // 上传成功后才会重新列举 OSS；这里只是启动审核，不动云端清单。
                  void refreshAudits()
                }
              }).catch((cause: unknown) => { setNotice(describe(cause)) })
                .finally(() => { setAuditBusy('') })
            }}
            onStop={(childId) => {
              setStopBusy(true)
              // 点下去**立刻**进入"正在停止"（100ms 内可见），不等轮询。
              setStopRequestedAt(Date.now())
              void workbenchApi.auditStop(childId === '' ? {} : { childId })
                .then((result) => {
                  // 两阶段：`ok` 在这里表示"请求已被接受"；**是否真的停下**由 Host 的阶段回答，
                  // 所以这里不报"已停止"，只把失败原因说出来。
                  setNotice(result.ok ? '' : result.error)
                  return refreshAudits()
                })
                .catch((cause: unknown) => {
                  setStopRequestedAt(0)
                  setNotice(describe(cause))
                })
                .finally(() => { setStopBusy(false) })
            }}
            stopRequestedAt={stopRequestedAt}
            openingKey={openingKey}
            onRefreshStatus={() => { void refreshAudits() }}
            onCopyDiagnostics={(key) => { copyStopDiagnostics(key) }}
            onRetryUpload={(key) => {
              setRetryBusy(true)
              void workbenchApi.ossUpload({ key })
                .then((result) => {
                  setNotice(result.ok ? '' : result.error)
                  // 上传成功才重新列举云端清单。
                  if (result.ok) void pageLoader.refresh(key)
                  return refreshAudits()
                })
                .catch((cause: unknown) => { setNotice(describe(cause)) })
                .finally(() => { setRetryBusy(false) })
            }}
            onOpenCloud={(key) => {
              // 立刻进入「正在打开…」：签名 + 拉起浏览器这几百毫秒里按钮不能看起来没反应，
              // 也不能被重复点（同一个 key 只允许一次在飞）。
              setOpeningKey(key)
              void openReportLink(key).finally(() => { setOpeningKey('') })
            }}
            onOpenLocalHtml={(key) => {
              const record = audits[key]
              if (record === undefined || record.casePath === '' || record.htmlFile === '') {
                setNotice('这条记录还没有本地 HTML')
                return
              }
              void workbenchApi.openPath({ path: joinLocalPath(record.casePath, record.htmlFile) })
                .then((result) => { if (!result.ok) setNotice(result.error) })
            }}
            onOpenSession={(key) => {
              // 用**被点那一行**的 key，不要拿 activeKey 顶替：那是「当前在跑的那条」，
              // 点别的行会开到错的孩子，activeKey 为空时报「该记录没有子会话 id。」（实测踩到）。
              const { childId, parentSessionId } = openSessionTarget(key, audits, boundParentId)
              void openChildSession(props.services, { childId, parentSessionId })
                .then((result) => {
                  setNotice(result.ok ? `${zhCN.openSessionOpened}${childId.slice(0, 8)}…` : result.error)
                })
            }}
            onOpenAuditInfo={(key, cloud) => { void openAuditInfo(key, cloud) }}
            // 「AI 审核结果分析会话」要的是**数据**（不是抽屉界面）：同一个 `oss-result`
            // 操作，把裁剪过的审核摘要直接交回去；失败如实返回原因，由页内降级处理。
            onLoadAuditInfo={async (_key, cloud) => {
              if (cloud.jsonKey === '') return { info: null, error: '' }
              try {
                const result = await workbenchApi.ossResult({ key: cloud.jsonKey })
                return { info: result.ok ? result.info : null, error: result.ok ? '' : result.error }
              } catch (cause: unknown) {
                return { info: null, error: describe(cause) }
              }
            }}
            handoffCopied={handoffCopied}
            onHandoffCopied={setHandoffCopied}
            onEscalateRetry={() => { void loadReport() }}
            onOpenPath={(path) => {
              void workbenchApi.openPath({ path })
                .then((result) => { if (!result.ok) setNotice(result.error) })
            }}
          />
        : auditGate
    }
    if (page === 'local-audit') {
      // 本地审核是单列滚动布局，不重复画 24px 的页头（身份由上面那行页签说明）。
      return <LocalAuditPane
        services={props.services}
        {...(props.localAudit === undefined ? {} : { controller: props.localAudit })}
        hostStale={hostStale}
        workspacePath={env?.workspace.path ?? ''}
        workspaceId={env?.workspace.id ?? ''}
      />
    }
    if (page === 'valuation') {
      // 通用估值页已经是**资产评估工作流入口**（协议 43）：业务总览 → 估值工作面。
      // 控制器由 `apply()` 注入（它握着 RPC 与轮询），切走再回来仍是同一份项目状态；
      // 这里不再直接 `return <ReportEvaluationPane>` —— 那正是"另建了一个孤立组件"的旧接线。
      return <AssetAssessmentWorkflow
        workflow={workflowController}
        evaluation={evaluationController}
        experience={experienceController}
        step={workflowStep}
        onStep={setWorkflowStep}
        onOpenParentSession={openParentSession}
      />
    }
    // 元数据里有、页面还没实现的（`enabled: false`，正常路径进不来）：不假装有内容。
    return <div className={C.navEmpty}>{zhCN.navParentEmpty}</div>
  }

  // Primary navigation row: generic modules list their parent groups, while audit lists its leaf
  // pages directly (the sole parent group is not painted as a redundant second level).
  const navPrimaryNodes = navModule === null ? [] : (flatAuditNav ? childNodes(mod.parent) : parentNodes(navModule))

  // `data-crwu-scope` 是**插件作用域**：主题变量定义在它上面（styles/tokens.ts），
  // 样式也只在它之内生效。它和 `.crwu-audit-root`（面板布局）是两件事 ——
  // 侧栏入口、会话头按钮这些独立挂载点只带作用域、不带面板布局。
  return <div className={C.root} {...CRWU_SCOPE_PROPS}>
    {/* 自助更新面板：与侧栏那枚徽标共用同一个开关状态与同一份更新状态。
        `position: fixed` 让它盖在面板之上，但仍长在面板壳内（--crwu-* token 照常继承）。 */}
    {updateDialogState.open && props.update !== undefined
      ? <UpdateDialog
          snapshot={updateSnapshot}
          currentVersion={currentVersionOf(build)}
          buildKind={build.buildKind}
          auditBusy={gatingHasAudit}
          nowMs={(props.now ?? Date.now)()}
          platform={props.platform ?? 'other'}
          onClose={() => { props.updateDialog?.close() }}
          onCheck={() => { void props.update?.check() }}
          onInstall={() => { void props.update?.install() }}
          onCancel={() => { void props.update?.cancel() }}
        />
      : null}
    <div className={C.header}>
      {/* 品牌标记：与侧栏入口同一个图形（用户给的原图描成的矢量版）。 */}
      <BrandMark size={22} />
      <span className={C.title}>{zhCN.title}</span>
      {/* 同一枚小标签：dev（本地源码检出）或 v<版本>（装好的包）。
          客户端刷新就换新、宿主只有重启才换，所以这枚标签是「我到底在跑哪一版」的唯一凭据
          （悬停看形态说明与构建时间）。 */}
      {props.update === undefined
        ? <span className={[C.version, BUILD_TAG_CLASSES[tag.tone]].join(' ')} title={tag.title}>{tag.text}</span>
        : <button
            type="button"
            className={[C.version, C.updateBadge, UPDATE_TONE_CLASSES[updateView.badgeTone]].filter((item) => item !== '').join(' ')}
            title={updateView.badgeTitle}
            aria-label={updateView.badgeTitle}
            onClick={() => { props.updateDialog?.open() }}
          >{updateView.badgeText}</button>}
      <span className={C.grow} />
      {/* 头部右侧只放一句问候：`下午好，杨凡宾`。姓名来自宿主的钉钉 CLI（`whoami`），
          **拿不到就整句不渲染**（用户 2026-09-22 口径：钉钉 CLI 没有登录信息就什么也不展示）。
          这里原先写的是当前模块名，用户要求去掉 —— 模块在哪一页由侧栏那张分组卡的高亮说了算。 */}
      {greeting === '' ? null : <span className={C.greeting}>{greeting}</span>}
    </div>

    <div className={C.body}>
      {/*
        两级目录：一级始终在页面顶部，二级紧跟其下、随一级目录一起换。
        点一级目录时"一级 + 二级 + 正文"在**同一次状态更新**里变完（见 module-store 的 landOn），
        所以不存在"一级已经切了、二级还显示旧目录"的中间帧。
        ⚠️ 报告评估（`eval`）**不再画通用页签行**：那里的正文是业务总览 → 估值工作流，
        业务步骤由页面自己的 `data-business-step` 表达；画一行只有一个「估值」的 tablist
        既是重复导航，也会把正文错误地标成 `aria-labelledby` 指向的 tabpanel。
        审核树的两级页签原样保留（本地审核 / 报告审核仍靠它切换）。
      */}
      {(mod.kind === 'node' || mod.kind === 'empty') && navModule !== 'eval'
        ? navModule === null ? null : <div className={C.navBar}>
            {/* Primary row: parent groups for generic modules; for audit the leaf pages themselves
                (the sole parent group would otherwise repeat above them). Both use the existing
                underlined tab family with stable ids. */}
            <div
              className={LOCAL_AUDIT_CLASSES.tablist}
              role="tablist"
              aria-orientation="horizontal"
              aria-label={zhCN.navParentsLabel}
            >
              {navPrimaryNodes.map((node) => {
                const on = flatAuditNav ? mod.node === node.id : mod.parent === node.id
                const id = flatAuditNav ? tabIdOf(node.id) : parentTabIdOf(node.id)
                return <button
                  key={node.id}
                  type="button"
                  role="tab"
                  id={id}
                  aria-selected={on}
                  aria-controls={TAB_PANEL_ID}
                  tabIndex={on ? 0 : -1}
                  ref={(element) => { tabRefs.current[id] = element }}
                  className={[LOCAL_AUDIT_CLASSES.tab, on ? LOCAL_AUDIT_CLASSES.tabOn : ''].filter((one) => one !== '').join(' ')}
                  onClick={flatAuditNav ? () => { gotoNode(node.id) } : () => { gotoParent(node.id) }}
                  onKeyDown={flatAuditNav ? onChildKeyDown : onParentKeyDown}
                >{node.label}</button>
              })}
            </div>
            {/* Secondary row (generic modules only): lighter pills; audit is already flat. */}
            {flatAuditNav || childNodes(mod.parent).length === 0 ? null : <div
              className={C.navChildren}
              role="tablist"
              aria-orientation="horizontal"
              aria-label={zhCN.navChildrenLabel}
            >
              {childNodes(mod.parent).map((child) => {
                const on = mod.node === child.id
                const id = tabIdOf(child.id)
                return <button
                  key={child.id}
                  type="button"
                  role="tab"
                  id={id}
                  aria-selected={on}
                  aria-controls={TAB_PANEL_ID}
                  // 「开发中」的二级目录可见、不可进入（`disabled` 挡住点击，`aria-disabled` 说给读屏）。
                  aria-disabled={!child.enabled}
                  disabled={!child.enabled}
                  tabIndex={on ? 0 : -1}
                  ref={(element) => { tabRefs.current[id] = element }}
                  className={[C.navChild, on ? C.navChildOn : '', child.enabled ? '' : C.navChildOff].filter((one) => one !== '').join(' ')}
                  onClick={() => { gotoNode(child.id) }}
                  onKeyDown={onChildKeyDown}
                >
                  <span>{child.label}</span>
                  {child.enabled ? null : <span className={C.navChildTag}>{zhCN.moduleDevTag}</span>}
                </button>
              })}
            </div>}
          </div>
        : null}

      {/* 页面内容区：目录条之外那个**切换时不重建**的容器（同一个元素、同样高度），
          所以切换目录不会让宽度抖动、也不会重建页面内部状态。所有页签的 `aria-controls` 指向它。
          滚动位置**按页面身份**处理：容器本身不重建，所以它的 `scrollTop` 会原样留到下一页——
          那会让用户切过去就落在半空中。这里在页面身份变化时把滚动位置归零。 */}
      <div
        className={C.tabPanel}
        id={TAB_PANEL_ID}
        ref={tabPanelRef}
        // 页面身份交给 CSS：估值是**固定高度工作面**（只有正文内部滚），其它页面照旧由这里滚。
        {...(mod.kind === 'node' && activeNode !== null && activeNode.page !== null
          ? { 'data-workbench-page': activeNode.page }
          : {})}
        // 环境信息不是目录里的一页（那时目录条整个不画），所以内容区只在有目录时才是 tabpanel ——
        // 否则 `aria-labelledby` 会指向一个此刻并不存在的页签 id。
        // 报告评估也没有页签行（见上面 navBar 的说明），所以它用普通 `region` 地标，
        // 绝不把 `aria-labelledby` 指向一个已经删掉的 tab。
        {...(mod.kind === 'env'
          ? {}
          : navModule === 'eval'
            ? { role: 'region', 'aria-label': '报告评估' }
            : {
                role: 'tabpanel',
                'aria-labelledby': mod.kind === 'node' && activeNode !== null ? tabIdOf(activeNode.id) : parentTabIdOf(mod.parent),
              })}
      >
        {bootError === '' ? null : <Notice tone="warn">{bootError}</Notice>}

        {hostStale
          ? <Notice tone="warn">
              <div className={C.itemName}>{zhCN.hostStaleTitle}</div>
              <div>{zhCN.hostStaleHint}</div>
            </Notice>
          : null}

        {/* 自检没出结论之前，正文只放这一页统一等待页 —— 这时候谈"在哪一页"没有意义：
            结论一到，envChanged() 会把用户送到该去的那一页（通过 → 报告审核，不通过 → 环境信息）。 */}
        {awaitingEnv ? <WorkbenchLoading /> : null}

        {/* 环境信息**不是目录树里的一页**（用户 2026-10-13 口径）：环境没就绪时所有入口统一落到它，
            员工也可以自己进来改配置。所以它不占页签；从它回工作台给一颗明确的按钮。 */}
        {!awaitingEnv && mod.kind === 'env'
          ? <div className={C.envScreen}>
              {envOk && !mod.blocked
                ? <div className={C.row}>
                    <Button label={zhCN.navBackToWorkbench} onClick={() => { go('audit') }} />
                  </div>
                : null}
              {envPane}
            </div>
          : null}

        {/* 一级目录下一个可用页面都没有：如实说一句，不给空白页。 */}
        {mod.kind === 'empty' ? <div className={C.navEmpty}>{zhCN.navParentEmpty}</div> : null}

        {/* 当前二级目录的正文。页面标题来自**导航元数据**（有 `title` 的节点才画）。
            估值刻意**不声明** `title`：上面那行「估值」页签已经是页面身份，再画一次大字
            就是用户截图里那处重复页头（2026-10-16）。其它节点照旧。 */}
        {!awaitingEnv && mod.kind === 'node' && activeNode !== null && activeNode.title !== undefined
          ? <div className={C.navPageHead}>
              <h2 className={C.navPageTitle}>{activeNode.title}</h2>
              {activeNode.lead === undefined ? null : <p className={C.navPageLead}>{activeNode.lead}</p>}
              {activeNode.note === undefined ? null : <p className={C.navPageNote}>{activeNode.note}</p>}
            </div>
          : null}

        {/* 三个业务页在内容区里共用**同一张工作纸**（14px 圆角 + 轻边界 + 轻阴影）。
            估值页以前直接落在内容区底色上，于是"内部辅助卡片很重、外面反而没有纸" ——
            现在它和审核页是同一种纸，估值工作面自己不再画第二层框（`> .crwu-valuation`）。 */}
        {!awaitingEnv && mod.kind === 'node' && activeNode !== null
          ? (activeNode.page === 'report-audit' || activeNode.page === 'local-audit'
              || activeNode.page === 'valuation'
              ? <div
                className={C.pagePaper}
                data-workbench-page={activeNode.page}
              >{pageContentOf(activeNode.page)}</div>
              : pageContentOf(activeNode.page))
          : null}
      </div>
    </div>
    {/* 审核信息走**右侧抽屉**：不离开当前列表就能看明细，关掉之后列表还在原来的位置。 */}
    {drawer === null ? null : <SideDrawer
      title={zhCN.auditInfo}
      subtitle={drawer.key}
      closing={drawerClosing}
      onClose={closeDrawer}
    >
      <AuditInfoDrawer
        seqNo={drawer.key}
        info={drawer.info}
        error={drawer.error}
        // 「查看更多审核依据」回到完整审核报告（交付件 HTML）——抽屉里不放规则证据链。
        // 这一行**没有**交付件时不给入口（给了就是假功能）。
        onOpenReport={reportOpenerOf(drawer.key)}
      />
    </SideDrawer>}
  </div>
}
