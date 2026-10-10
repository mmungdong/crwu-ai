import * as React from 'react'
import { Button, Card } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'
import {
  createLocalAuditController, stageIndexOf,
  type LocalAuditController, type LocalAuditPort, type LocalAuditState,
} from './controller.ts'
import { LocalAuditSelectionList } from './LocalAuditSelectionList.tsx'
import { LocalAuditPromptField } from './LocalAuditPromptField.tsx'
import { LocalAuditPreparationState } from './LocalAuditPreparationState.tsx'
import { LocalAuditHandoffCard } from './LocalAuditHandoffCard.tsx'
import { supportsDirectoryPick, supportsFilePick } from './selection.ts'
import type { ClientServices } from '../workbench/services.ts'
import type { PickedFileLike } from './pick.ts'

/** 主按钮"为什么不能点"那段文字的 id（`aria-describedby` 指向它）。 */
const REASON_ID = 'crwu-audit-local-action-reason'

/**
 * 「本地审核」页签的外壳（协议 28 的客户端一侧）。
 *
 * 这一层只做三件事：**读可选服务 → 驱动纯状态机 → 画状态**。
 * 所有判据（按钮能不能点、该说什么话、阶段停在哪）都在 `controller.ts` / `selection.ts` 里，
 * 这样"失败不丢已选内容"这类行为可以脱开渲染直接断言。
 *
 * 三条边界（与报告审核完全独立，互不影响）：
 * 1. **不要求环境自检通过**：本地审核不读氚云、不读凭据、不上传，只做本机文件 → 快照 → 对话；
 * 2. **不用 Host 的 `audit-*` 状态**：它的进度只活在这一页里，不写全局 store；
 * 3. **一切失败都收敛成界面文字**，绝不抛出去（抛出去整页会崩，而用户手里的选择还在）。
 */

export interface LocalAuditPaneProps {
  services: Pick<ClientServices, 'uiWorkspace' | 'layout' | 'sessions'>
  /**
   * 界面上正在显示的那个工作区（环境信息里选定的；`env.workspace.path`）。
   *
   * 新会话的 cwd 用它 —— **不依赖宿主在 `local-audit-start` 里回什么新字段**：
   * 这一页本来就是"在环境信息规定的工作区下审本机文件"（用户 2026-10-11 的原话：
   * 「我插件的环境信息中不是已经规定了工作区吗」）。
   */
  workspacePath?: string
  /**
   * 工作区在 **DSH 注册表里的 id**（界面 `env.workspace.id`）。
   *
   * 新会话靠它挂到那个工作空间下（DSH 自己的界面也是 `create({ workspaceId })`）；
   * 只有它为空时才退回用 `workspacePath` 当 cwd。
   */
  workspaceId?: string
  /**
   * 宿主是旧构建（协议号不一致）。
   *
   * 真代价（2026-10-11 用户实测）：界面刷新就换新、宿主只有重启 profile 才换新，于是
   * "新界面 + 旧宿主"会拿一个旧宿主根本不回的字段去建会话，报出一句用户看不懂的
   * `mkdir ''`。这里直接**在发请求之前**拦住，并把唯一正确的处置说出来（重启 profile）。
   */
  hostStale?: boolean
  /**
   * 状态机。生产形态由 `apply()` 用 `createLocalAuditPaneController(services)` 建一份、
   * 随 props 下发（这样切换页签 / 模块不会丢掉用户的选择）；测试注入替身；
   * 都没有时就地建一个（只在直接渲染组件的测试里走到）。
   */
  controller?: LocalAuditController
}

/** 浏览器剪贴板不可用（旧 webview / 非安全上下文）时退回宿主剪贴板。 */
async function copyText(text: string): Promise<{ ok: boolean; error: string }> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return { ok: true, error: '' }
    } catch {
      // 落到下面的宿主剪贴板兜底：浏览器剪贴板在无权限时会抛。
      void 0
    }
  }
  try {
    const result = await workbenchApi.clipboard({ text })
    return { ok: result.ok, error: result.error }
  } catch (cause: unknown) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * 隐藏的 `<input type="file" multiple>`。
 *
 * DSH 没有原生文件选择器客户端服务（只有目录选择器），所以文件多选只能走渲染进程的 input；
 * 绝对路径由 Electron 的 `__DSH_HOST_PATHS__.pathFor(file)` 取回（见 pick.ts）。
 * input 不挂进 DOM、选完即弃：它只是一次性的系统对话框入口。
 */
function pickFilesFromInput(): Promise<readonly PickedFileLike[] | null> {
  const doc = (globalThis as { document?: { createElement?: (tag: string) => unknown } }).document
  if (typeof doc?.createElement !== 'function') return Promise.resolve(null)
  const element = doc.createElement('input') as {
    type?: string
    multiple?: boolean
    accept?: string
    files?: ArrayLike<PickedFileLike> | null
    addEventListener?: (type: string, listener: () => void) => void
    click?: () => void
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (files: readonly PickedFileLike[] | null): void => {
      if (settled) return
      settled = true
      resolve(files)
    }
    element.type = 'file'
    element.multiple = true
    // 任意文件类型都允许（审核材料可能是 xlsx / pdf / docx / 图片，界面不做扩展名过滤）。
    element.accept = '*/*'
    element.addEventListener?.('change', () => {
      const list = element.files
      const files: PickedFileLike[] = []
      if (list !== null && list !== undefined) {
        for (let index = 0; index < list.length; index += 1) files.push(list[index])
      }
      finish(files)
    })
    try {
      element.click?.()
    } catch {
      finish(null)
    }
  })
}

/** `sessions.using()` 的回调签名（与 `session.ts` 的 `SessionPort` 同一形状）。 */
type SessionUsingOperation = (
  reference: { binding?: { session?: { rename?: (title: string) => Promise<unknown>, prompt?: (content: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') => Promise<unknown> } } },
) => Promise<unknown> | unknown

/** 默认端口：真实的三个 Host 操作 + 浏览器侧的可选服务。 */
function portOf(services: LocalAuditPaneProps['services']): LocalAuditPort {
  /**
   * ⚠️ **每个能力都必须在"用的那一刻"现读，不能在 `apply()` 里快照**。
   *
   * 2026-10-11 用户实测：点「选择文件夹」得到「当前宿主不支持本机目录选择」，
   * 而 `uiWorkspace` 明明在页面上是好的。根因就是这里曾经在 `apply()` 里
   * `typeof services.uiWorkspace?.pickDirectory === 'function'` 判一次、
   * 把结果**固化**成 `port.pickDirectory`：我们的客户端插件先激活时，
   * `ui-workspace` 还没注册，这一条就**永远是 undefined** ——
   * 而这正是本仓在 `sessions` / `uiWorkspace` 上踩过的同一个坑
   * （见 `features/workbench/services.ts` 的注释：快照下来就「永远不会再变」）。
   *
   * 所以这里用 **getter**：能力在不在由调用时刻决定；缺席时属性是 `undefined`，
   * `pickDirectory()` / `createLocalAuditSession()` 那边"不支持"的分支照旧成立。
   */
  const port: LocalAuditPort = {
    status: async (input) => await workbenchApi.localAuditStatus(input),
    start: async (input) => await workbenchApi.localAuditStart(input),
    // 认领失败不阻塞（模型在对话里还会再认领一次，幂等）。
    claim: async (input) => await workbenchApi.localAuditClaim(input) as { ok?: boolean; error?: string },
    sessions: {
      get create() {
        const call = services.sessions?.create
        return typeof call === 'function' ? (input?: { workspaceId?: string; cwd?: string }) => services.sessions!.create!(input) : undefined
      },
      get using() {
        const call = services.sessions?.using
        return typeof call === 'function'
          ? (id: string, options: { source: string }, operation: SessionUsingOperation) =>
              services.sessions!.using!(id, options, operation)
          : undefined
      },
      openSession: (sessionId) => {
        // 切会话的**唯一**有效入口；保底再把插件面板让开（`openSession` 自己也会调，幂等）。
        services.uiWorkspace?.openSession?.(sessionId)
        services.layout?.selectPanel?.(null)
      },
    },
    copyText,
    clock: Date.now,
    get pickDirectory() {
      const call = services.uiWorkspace?.pickDirectory
      return typeof call === 'function' ? async () => await services.uiWorkspace!.pickDirectory!() : undefined
    },
    get hostPaths() {
      // 桌面端的路径桥是 preload 注入的全局，同样按调用时刻现读（注入时机不由我们定）。
      const value = (globalThis as { __DSH_HOST_PATHS__?: { pathFor?: (file: unknown) => string | undefined } }).__DSH_HOST_PATHS__
      return typeof value?.pathFor === 'function' ? value : undefined
    },
    fileInput: pickFilesFromInput,
  }
  return port
}

/**
 * 建一个真实的本地审核状态机（`apply()` 建一份、随 props 下发）。
 *
 * 为什么**不在组件里**建：这一页手里握着用户的一次选择、提示词与一份已建好的快照。
 * 组件会随页签切换 / 模块切换 / 离开面板被卸载，而在组件里建状态机等于把这份草稿一起丢掉
 * （用户点一下「报告审核」看一眼再回来，选择就没了 —— 与设计 §8「不要丢弃已选内容」相冲突）。
 * 放到 `apply()` 里就与 `modules` / `updateDialog` 同一套口径：**实例级、只有一份、不在模块顶层**。
 */
export function createLocalAuditPaneController(services: LocalAuditPaneProps['services']): LocalAuditController {
  return createLocalAuditController({ port: portOf(services) })
}

export function LocalAuditPane(props: LocalAuditPaneProps): React.ReactElement {
  /**
   * **两条选择能力分开判**（2026-10-11 用户实测反馈：只有一条可用时整块被替换成"不支持"，
   * 于是"连文件夹都不能选"）。各自在就各自给按钮，都没有时才说那句固定的话。
   */
  const hostPaths = (globalThis as { __DSH_HOST_PATHS__?: unknown }).__DSH_HOST_PATHS__
  const canPickDirectory = supportsDirectoryPick(props.services.uiWorkspace?.pickDirectory)
  const canPickFiles = supportsFilePick(hostPaths, pickFilesFromInput)
  /**
   * 目录能力缺席时**补探一次**（不轮询）。
   *
   * 客户端服务的注册顺序不由我们定：我们的插件可能比 `ui-workspace` 先激活。
   * 页签是用户点出来的，那时服务通常已就位；但真的晚到一点点时，
   * "按钮不出现"会一直摆在那里（页签不重挂就不会再算一次）。这里只补一次 ——
   * 补完还没有就说明这个宿主确实没有这条能力，界面照实说。
   */
  const [reprobed, setReprobed] = React.useState(false)
  React.useEffect(() => {
    if (canPickDirectory || reprobed) return undefined
    const timer = setTimeout(() => { setReprobed(true) }, 1200)
    return () => { clearTimeout(timer) }
  }, [canPickDirectory, reprobed])

  // 优先用注入的状态机（测试），否则就地建一个真实的。ref 保证跨渲染只建一次。
  const holder = React.useRef<LocalAuditController | null>(null)
  if (holder.current === null) {
    holder.current = props.controller ?? createLocalAuditPaneController(props.services)
  }
  const controller = holder.current
  const [state, setState] = React.useState<LocalAuditState>(controller.state())
  const [copied, setCopied] = React.useState(false)
  const [copyError, setCopyError] = React.useState('')

  // 异步动作可能晚于一次渲染到达：订阅后由状态机把最新状态推回来。
  React.useEffect(() => controller.subscribe(setState), [controller])

  const button = controller.button()
  // 宿主旧构建时**不发任何请求**：快照也不建（免得用户白等一轮再看到失败卡）。
  const staleReason = props.hostStale === true ? zhCN.hostStaleGate : ''
  const busy = state.phase === 'preparing' || state.phase === 'creating' || state.phase === 'scanning'
  // 主按钮此刻不可点的**可见原因**：宿主旧构建优先（那是当下唯一能做的事），否则用状态机给的。
  const reasonText = staleReason !== '' ? staleReason : button.reason

  /** 复制：成功给一句确认（2 秒后收起），失败把原因说在按钮旁边。 */
  const copy = async (): Promise<void> => {
    const result = await controller.copyPrompt()
    setCopyError(result.ok ? '' : result.error)
    if (!result.ok) return
    setCopied(true)
    window.setTimeout(() => { setCopied(false) }, 2000)
  }

  return <div className={L.pane} tabIndex={0} aria-label={zhCN.localAuditTab}>
    {/* 页面顶部说明（设计 §2）：标题由页签条承担，这里是副标题 + 一句辅助说明。
        次级文本颜色 —— **不做成大面积警告**（文件只用于本次对话是说明，不是风险提示）。 */}
    <div className={L.intro}>
      <div className={L.introLead}>{zhCN.localAuditSubtitle}</div>
      <div className={L.introNote}>{zhCN.localAuditNotice}</div>
    </div>

    {/* 选择能力的失败紧邻「选择」那块区域（不是页面顶部的一条全局提示）。 */}
    {state.pickError === '' ? null : <div className={`${C.notice} ${C.noticeWarn}`} role="alert">{state.pickError}</div>}

    {/* 桌面双栏：左 = 选择资料 + 已选择内容（页面主任务）；右 = 补充提示词与交接/说明。
        小屏自动回到单栏，DOM 顺序就是阅读顺序（选择 → 已选择 → 提示词）。 */}
    <div className={L.columns}>
      <div className={L.column}>
    <LocalAuditSelectionList
      items={state.items}
      files={state.files}
      fileCount={state.fileCount}
      limit={state.limit}
      overLimit={state.overLimit}
      skippedCount={state.skippedCount}
      skipped={state.skipped}
      scanning={state.phase === 'scanning'}
      onRemove={(path) => { controller.remove(path); void controller.rescan() }}
    />

    <Card title={zhCN.localAuditChooseTitle} extra={zhCN.localAuditPickHint}>
      {canPickDirectory || canPickFiles
        ? <>
            <div className={C.row}>
              {/* 次级按钮：整页**只有**底部那枚「开始本地审核」是主操作（设计口径：一枚 primary）。 */}
              {canPickFiles ? <Button
                label={zhCN.localAuditSelectFiles}
                disabled={busy}
                busy={state.phase === 'scanning'}
                onClick={() => { void controller.pickFile() }}
              /> : null}
              {canPickDirectory ? <Button
                label={zhCN.localAuditSelectDirectory}
                disabled={busy}
                busy={state.phase === 'scanning'}
                onClick={() => { void controller.pickDirectory() }}
              /> : null}
            </div>
            {/* 只有一条可用时，把**缺的那一条为什么不行、该改用什么**说在按钮下面
                （而不是把另一条也一起撤掉 —— 那正是用户实测反馈"连文件夹都不能选"的来源）。 */}
            {canPickDirectory ? null
              : <div className={L.rowReason}>{zhCN.localAuditPickDirectoryUnsupported}</div>}
            {canPickFiles ? null
              : <div className={L.rowReason}>{zhCN.localAuditPickFilesUnsupported}</div>}
          </>
        // 两条能力都拿不到（Web profile / 旧宿主）：整块只说明"这个版本不支持"，不给死按钮。
        : <div className={L.rowReason} role="alert">{zhCN.localAuditPickUnsupported}</div>}
      {/* 辅助操作只剩「清空选择」。「重新扫描」按用户 2026-10-11 口径**下掉**了：
          移除一个文件/文件夹本身就会立刻重扫一次，再放一个手动重扫按钮，两者的关系说不清
          （"我移除了它，为什么还要再扫一次？"），而且移除后不重扫还会让界面与 Host 的清单不一致。
          真的需要重扫（例如目录内容在别处变了）时：清空选择后重选一次即可 —— 重新选择本来就会扫。 */}
      <div className={L.cardActions}>
        <Button label={zhCN.localAuditClear} small disabled={busy} onClick={() => { controller.clear() }} />
      </div>
    </Card>

      </div>
      <div className={L.column}>
    <LocalAuditPromptField
      value={state.prompt}
      disabled={busy}
      onChange={(value) => { controller.setPrompt(value) }}
    />

    <LocalAuditHandoffCard
      done={state.done}
      expired={state.expired}
      failed={state.phase === 'failed'}
      error={state.error}
      handoff={state.handoff}
      providedCount={state.providedCount}
      skippedCount={state.skippedProvidedCount}
      copied={copied}
      copyError={copyError}
      claimError={state.claimError}
      busy={busy}
      onCopy={() => { void copy() }}
      onReprepare={() => { void controller.prepare() }}
    />

    {/* 阶段条：只在真的在准备 / 建会话时出现（干等的时候必须看得见进度）。 */}
    {busy ? <LocalAuditPreparationState stageIndex={stageIndexOf(state)} /> : null}
      </div>
    </div>

    <div className={L.action}>
      <Button
        label={button.label}
        tone="primary"
        disabled={button.disabled || staleReason !== ''}
        busy={state.phase === 'preparing' || state.phase === 'creating'}
        title={staleReason !== '' ? staleReason : button.reason}
        // 原因文字**必须在旁边看得见**（设计 §15），并且要能被读屏关联到按钮上：
        // 只挂 `title` 在触屏与读屏上都不稳。
        ariaDescribedBy={reasonText === '' ? undefined : REASON_ID}
        onClick={() => { void controller.start({ workspacePath: props.workspacePath ?? '', workspaceId: props.workspaceId ?? '' }) }}
      />
      {reasonText === '' ? null : <span id={REASON_ID} className={L.actionReason}>{reasonText}</span>}
    </div>
  </div>
}
