import { zhCN } from '../../locales/zh-CN.ts'
import type {
  LocalAuditFileView, LocalAuditScanView, LocalAuditScannedFileView, LocalAuditSkippedView, LocalAuditStartView,
} from '../../../shared/types.ts'
import {
  addSelection, basenameOf, buttonStateOf, itemStatusOf, itemMetaOf, overLimitMessageOf,
  relativePathOf, removeSelection, sameEntryPath, summaryLineOf,
  type LocalAuditButtonState, type LocalAuditEntryView, type LocalAuditPhase,
} from './selection.ts'
import { trimTrailingSeparators } from '../../../shared/utils/local-path.ts'
import { pickDirectory, pickFile, type DirectoryPicker, type FilePicker, type PickedFileLike } from './pick.ts'
import { createLocalAuditSession, type SessionPort } from './session.ts'

/**
 * 本地审核的**纯状态机**（没有 React、没有 DOM、没有真实 RPC）。
 *
 * 为什么把它从组件里拆出来：这一页真正的风险不是排版，而是**失败时把手里的东西弄丢** ——
 * Host 可能已经把选中的文件复制进临时快照、也给了可复制的固定提示词，此时会话创建失败，
 * 如果客户端顺手把选择清掉，用户只能从头再选一次。所以"失败不丢内容"必须是可断言的纯行为，
 * 而不是渲染树里的隐含结果。
 *
 * 契约：
 * - 所有动作都返回**新的状态**（同样的东西也写到内部状态里，供 React 之外的地方读）；
 * - 所有失败都收敛成状态字段（`error` / `pickError`），**绝不抛出去**；
 * - 每一次状态变化都会 `dispatch`，React 用 `useState` 接住它（本仓的测试替身没有
 *   `useSyncExternalStore`，所以订阅式 hook 不在选项里）。
 */

/** 已准备的一次性交接（`local-audit-start` 的应答裁剪版）。 */
export interface LocalAuditHandoff {
  handoffId: string
  prompt: string
  providedCount: number
  skippedCount: number
  expiresAt: number
  /** 本轮案例目录（`<工作空间>/本地审核/<handoffId>`）：只用于界面诊断与"打开目录"，不进提示词。 */
  casePath: string
  /**
   * 新会话的 `cwd`：**员工选定的工作空间**（逐字）。
   *
   * DSH 按 cwd 把会话归到工作空间下（用户 2026-10-11 口径：「本地审核对话应该创建在我
   * 环境信息规定的工作区下面」），而它同时是会话的沙箱边界 —— 案例目录就在它里面。
   */
  workspacePath: string
  files: LocalAuditFileView[]
  skipped: LocalAuditSkippedView[]
}

export interface LocalAuditState {
  /** 用户的选择（绝对路径，去重保序）。 */
  selected: string[]
  /** 逐项扫描结果（用户选的入口）。 */
  items: LocalAuditEntryView[]
  /**
   * 扫描后的**文件级清单**（`parentPath` 指回入口）。
   *
   * 界面把每个文件单独渲染一行（完整文件名 + 右侧 X 移除）—— 用户 2026-10-11 口径。
   */
  files: LocalAuditScannedFileView[]
  /**
   * 被逐个移除掉的文件（绝对路径，排序去重）。
   *
   * 它**必须发给 Host**：重新扫描与建快照都以它为准，否则"移除一个文件"在下一次扫描后
   * 就会自己长回来（那正是这个功能最容易做错的地方）。
   */
  excluded: string[]
  fileCount: number
  limit: number
  overLimit: boolean
  readableCount: number
  skippedCount: number
  skipped: LocalAuditSkippedView[]
  phase: LocalAuditPhase
  /** 主流程失败原因（人话）。 */
  error: string
  /** 选择能力失败原因（与主流程分开：它属于"选择"那块区域）。 */
  pickError: string
  prompt: string
  /** 已经准备好的 handoff；非空即"再点一次会用这份快照建会话"，不重新复制文件。 */
  handoff: LocalAuditHandoff | null
  /** 这份 handoff 覆盖的那次选择：与当前选择不同 = 已经过期，必须重新准备。 */
  preparedSelection: string[]
  providedCount: number
  skippedProvidedCount: number
  /** handoff 过期的时刻（0 = 没有）。 */
  expiresAt: number
  expired: boolean
  /** 自动认领失败的原因（不阻塞）。 */
  claimError: string
  /** 移交成功（阶段条走完）。 */
  done: boolean
  /** 刚才是哪一步失败的：决定"重试准备"该重跑扫描还是重跑快照。 */
  failedAt: '' | 'scan' | 'prepare' | 'session'
}

export const LOCAL_AUDIT_STAGE_KEYS = ['scope', 'snapshot', 'conversation', 'switch', 'claim'] as const
export type LocalAuditStageKey = typeof LOCAL_AUDIT_STAGE_KEYS[number]

export function initialLocalAuditState(): LocalAuditState {
  return {
    selected: [], items: [], files: [], excluded: [], fileCount: 0, limit: 30, overLimit: false,
    readableCount: 0, skippedCount: 0, skipped: [],
    phase: 'idle', error: '', pickError: '', prompt: '',
    handoff: null, preparedSelection: [], providedCount: 0, skippedProvidedCount: 0,
    expiresAt: 0, expired: false, claimError: '', done: false, failedAt: '',
  }
}

/**
 * 移交阶段的进度：准备快照 → 创建审核对话 → 切换到新对话 → 认领本次审核。
 *
 * 只回一个**下标**（0..5）：0 = 还没开始，1 = 第一步已完成…5 = 四步都完成。
 * 失败时停在本阶段的起点上，**不假装成功**。
 */
export function stageIndexOf(state: Pick<LocalAuditState, 'phase' | 'failedAt'>): number {
  if (state.phase === 'preparing') return 1
  if (state.phase === 'creating') return 2
  if (state.phase === 'done') return LOCAL_AUDIT_STAGE_KEYS.length
  if (state.phase === 'failed') {
    if (state.failedAt === 'session') return 3
    if (state.failedAt === 'prepare') return 1
    return 0
  }
  return 0
}

export interface LocalAuditPort extends DirectoryPicker, FilePicker {
  status: (input: { selection: string[]; excluded?: string[] }) => Promise<LocalAuditScanView>
  start: (input: { selection: string[]; excluded?: string[]; prompt?: string }) => Promise<LocalAuditStartView>
  claim: (input: { handoffId: string; sessionId: string }) => Promise<{ ok?: boolean; error?: string }>
  sessions?: SessionPort
  /** 剪贴板（浏览器剪贴板不可用时的兜底由调用方决定）。 */
  copyText?: (text: string) => Promise<{ ok: boolean; error: string }>
  clock?: () => number
}

export interface LocalAuditActionResult {
  ok: boolean
  error: string
  /** 只对"已经准备好了 handoff"这一类结果有意义。 */
  expired?: boolean
}

export interface LocalAuditController {
  state: () => LocalAuditState
  /**
   * React 侧订阅：注册后立刻回调一次当前状态（同一实例只保留一个监听者）。
   *
   * 返回**解除订阅**的函数：状态机现在归 `apply()` 所有、比页面活得久，页面卸载时不解除
   * 就会把 `dispatch` 留在一个已经消失的组件实例上（React 18 不再警告，但它是个静默的坑）。
   */
  subscribe: (listener: (state: LocalAuditState) => void) => () => void
  /** 直接写入状态（测试与被动的外部同步用；组件自己的动作请走下面那些动词）。 */
  setState: (patch: Partial<LocalAuditState>) => LocalAuditState
  pickDirectory: () => Promise<LocalAuditState>
  pickFile: (files?: readonly PickedFileLike[]) => Promise<LocalAuditState>
  /** 选择变了吗（变了就要作废已准备的快照）。 */
  selectionChanged: (selected: readonly string[]) => LocalAuditState
  remove: (path: string) => LocalAuditState
  clear: () => LocalAuditState
  rescan: () => Promise<LocalAuditState>
  setPrompt: (prompt: string) => LocalAuditState
  /** 只做"建快照 + 拿提示词"这一步（失败卡片上的「重新准备文件」）。 */
  prepare: () => Promise<LocalAuditActionResult>  /** 主按钮：复用已准备的快照 → 建会话 → 切过去（没有快照就先建）。 */
  /**
   * 主按钮：复用已准备的快照 → 建会话 → 切过去（没有快照就先建）。
   *
   * `workspacePath` 是**界面已经显示的那个工作区**（环境信息里选定的），点按钮时传进来 ——
   * 会话 cwd 因此不依赖宿主在 `local-audit-start` 里新回一个字段（2026-10-11 用户指出：
   * 「我插件的环境信息中不是已经规定了工作区吗」—— 对，客户端本来就该用自己已有的那份）。
   * 宿主回的 `handoff.workspacePath` 优先（它才是案例目录落点的权威）；两边不一致时拒绝重来。
   */
  start: (options?: { workspacePath?: string; workspaceId?: string }) => Promise<LocalAuditActionResult>
  copyPrompt: () => Promise<LocalAuditActionResult>
  button: () => LocalAuditButtonState
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createLocalAuditController(input: { port: LocalAuditPort; dispatch?: (state: LocalAuditState) => void; now?: () => number }): LocalAuditController {
  const port = input.port
  const clock = input.now ?? port.clock ?? Date.now
  let current = initialLocalAuditState()

  const notify = (): LocalAuditState => {
    if (typeof input.dispatch === 'function') input.dispatch(current)
    return current
  }

  const write = (patch: Partial<LocalAuditState>): LocalAuditState => {
    current = { ...current, ...patch }
    return notify()
  }

  /** 把 Host 的应答收窄成界面状态（旧宿主可能缺字段，一律当 0 / 空处理，不崩）。 */
  const applyScan = (view: LocalAuditScanView, selected: readonly string[]): void => {
    const raw = Array.isArray(view.items) ? view.items : []
    // 相对路径的根取自这一批选择项里最浅的那个（多选时没有单一根，就退回文件名）。
    const root = commonRootOf(raw.map((item) => text(item.path)).filter((path) => path !== ''))
    const items: LocalAuditEntryView[] = raw.map((item) => ({
      path: text(item.path),
      name: text(item.name),
      kind: item.kind === 'directory' ? 'directory' : 'file',
      sizeBytes: number(item.sizeBytes),
      fileCount: number(item.fileCount),
      status: text(item.status),
      reason: text(item.reason),
      relativePath: relativePathOf(text(item.path), root),
    }))
    const files: LocalAuditScannedFileView[] = (Array.isArray(view.files) ? view.files : []).map((item) => ({
      parentPath: text(item.parentPath),
      path: text(item.path),
      name: text(item.name),
      relativePath: text(item.relativePath),
      sizeBytes: number(item.sizeBytes),
    }))
    current = {
      ...current,
      selected: [...selected],
      items,
      files,
      fileCount: number(view.fileCount),
      limit: number(view.limit, 30),
      overLimit: view.overLimit === true,
      readableCount: number(view.readableCount),
      skippedCount: number(view.skippedCount),
      skipped: Array.isArray(view.skipped) ? view.skipped : [],
      phase: 'idle',
      error: '',
    }
  }

  const scan = async (): Promise<LocalAuditState> => {
    const selected = [...current.selected]
    if (selected.length === 0) {
      return write({
        items: [], fileCount: 0, overLimit: false, readableCount: 0, skippedCount: 0,
        skipped: [], phase: 'idle', error: '', failedAt: '',
      })
    }
    // 扫描窗口里先把**已经选了的那些**画成「待审核」占位行：计数这时还不知道，
    // 所以一起归零（界面据此说"正在统计文件数量…"，而不是拿上一轮的旧数字冒充结论）。
    write({
      phase: 'scanning', items: pendingEntriesOf(selected),
      fileCount: 0, readableCount: 0, overLimit: false, skippedCount: 0, skipped: [],
      error: '', pickError: '', expired: false, done: false, failedAt: '',
    })
    let view: LocalAuditScanView
    try {
      view = await port.status({ selection: selected, excluded: [...current.excluded] })
    } catch (cause: unknown) {
      return write({ phase: 'failed', failedAt: 'scan', error: `${zhCN.localAuditScanFailed}${describe(cause)}` })
    }
    if (view.ok !== true) {
      // 超限不是"失败"：Host 会连 items 一起给回来，界面照样要把逐项状态画出来。
      const overLimit = view.overLimit === true
      applyScan(view, selected)
      return write({
        overLimit,
        phase: overLimit ? 'idle' : 'failed',
        failedAt: overLimit ? '' : 'scan',
        error: text(view.error) === '' ? zhCN.localAuditScanUnknown : text(view.error),
      })
    }
    applyScan(view, selected)
    return notify()
  }

  const pickDirectoryPaths = async (): Promise<LocalAuditState> => {
    const result = await pickDirectory(port)
    if (!result.ok) return write({ pickError: result.error })
    if (result.paths.length === 0) return write({ pickError: '' })
    return await applyPicked(result.paths)
  }

  const pickFilePaths = async (files?: readonly PickedFileLike[]): Promise<LocalAuditState> => {
    const result = await pickFile(port, files)
    if (!result.ok) return write({ pickError: result.error })
    if (result.paths.length === 0) return write({ pickError: '' })
    return await applyPicked(result.paths)
  }

  /** 选择变了 → 已准备的快照作废（否则用户改了选择却仍在用旧快照，结论对不上）。 */
  const applyPicked = async (paths: readonly string[]): Promise<LocalAuditState> => {
    write({ selected: addSelection(current.selected, paths), pickError: '', handoff: null, preparedSelection: [], expired: false, done: false })
    return await scan()
  }

  const prepare = async (): Promise<LocalAuditActionResult> => {
    if (current.selected.length === 0) {
      write({ phase: 'failed', failedAt: 'scan', error: zhCN.localAuditNeedFiles })
      return { ok: false, error: zhCN.localAuditNeedFiles }
    }
    write({ phase: 'preparing', error: '', expired: false, done: false, failedAt: '' })
    let view: LocalAuditStartView
    try {
      view = await port.start({ selection: [...current.selected], excluded: [...current.excluded], prompt: current.prompt })
    } catch (cause: unknown) {
      const error = `${zhCN.localAuditPrepareFailed}${describe(cause)}`
      write({ phase: 'failed', failedAt: 'prepare', error, handoff: null })
      return { ok: false, error }
    }
    if (view.ok !== true) {
      const error = text(view.error) === '' ? zhCN.localAuditPrepareUnknown : text(view.error)
      write({ phase: 'failed', failedAt: 'prepare', error, handoff: null })
      return { ok: false, error }
    }
    write({
      phase: 'ready',
      error: '',
      failedAt: '',
      handoff: {
        handoffId: text(view.handoffId),
        prompt: text(view.prompt),
        providedCount: number(view.providedCount),
        skippedCount: number(view.skippedCount),
        expiresAt: number(view.expiresAt),
        casePath: text(view.casePath),
        workspacePath: text(view.workspacePath),
        files: Array.isArray(view.files) ? view.files : [],
        skipped: Array.isArray(view.skipped) ? view.skipped : [],
      },
      preparedSelection: [...current.selected],
      providedCount: number(view.providedCount),
      skippedProvidedCount: number(view.skippedCount),
      expiresAt: number(view.expiresAt),
      expired: false,
    })
    return { ok: true, error: '' }
  }

  const start = async (options?: { workspacePath?: string; workspaceId?: string }): Promise<LocalAuditActionResult> => {
    // 已经准备好的快照可以被复用；但选择变了就必须重新准备（旧快照与新选择不是一回事）。
    const reusable = current.handoff !== null && sameSelection(current.handoff !== null ? current.preparedSelection : [], current.selected)
    if (!reusable) {
      const prepared = await prepare()
      if (!prepared.ok) return prepared
    }
    const handoff = current.handoff
    if (handoff === null) return { ok: false, error: zhCN.localAuditPrepareUnknown }
    // 过期就不再去建会话：Host 会拒绝，用户看到的只会是一句更难懂的错。
    if (handoff.expiresAt > 0 && handoff.expiresAt <= clock()) {
      write({ expired: true, error: zhCN.localAuditHandoffExpired, phase: 'failed', failedAt: 'session' })
      return { ok: false, error: zhCN.localAuditHandoffExpired, expired: true }
    }
    /**
     * 会话 cwd = 员工选定的工作空间。两个来源，宿主的优先（它决定案例目录落在哪，权威）：
     * - `handoff.workspacePath`：`local-audit-start` 回的；
     * - `options.workspacePath`：**界面已经显示的那个工作区**（环境信息里选定的）——
     *   有了它，这一条就不会因为宿主少回一个字段而发出空 cwd。
     * 两边都非空且不一致时**拒绝**：那种情况下案例目录可能落在另一个工作区里，
     * 会话的沙箱边界罩不住它，硬跑会在"写交付件"那一步才失败。
     */
    const fromView = handoff.workspacePath
    const fromPanel = (options?.workspacePath ?? '').trim().replace(/[\\/]+$/, '')
    if (fromView !== '' && fromPanel !== '' && fromView !== fromPanel) {
      const error = zhCN.localAuditWorkspaceChanged
      write({ phase: 'failed', failedAt: 'prepare', error, handoff: null })
      return { ok: false, error }
    }
    write({ phase: 'creating', error: '', done: false, failedAt: '', claimError: '' })
    const created = await createLocalAuditSession({
      port: port.sessions,
      handoffId: handoff.handoffId,
      prompt: handoff.prompt,
      // 挂工作空间用 id（宿主注册表的成员关系）；cwd 只是退回路径 + 沙箱边界。
      workspaceId: (options?.workspaceId ?? '').trim(),
      workspacePath: fromView !== '' ? fromView : fromPanel,
      clock,
      claim: async (claimInput) => await port.claim(claimInput),
    })
    if (!created.ok) {
      // 失败时**什么都不清**：已选内容、提示词、快照都留着，用户可以直接复制提示词手工完成。
      write({ phase: 'failed', failedAt: 'session', error: created.error, claimError: '' })
      return { ok: false, error: created.error }
    }
    write({
      phase: 'done',
      done: true,
      error: '',
      failedAt: '',
      claimError: created.claimError,
      providedCount: handoff.providedCount,
      skippedProvidedCount: handoff.skippedCount,
    })
    return { ok: true, error: '' }
  }

  return {
    state: () => current,
    subscribe: (listener) => {
      input.dispatch = listener
      listener(current)
      return () => { if (input.dispatch === listener) input.dispatch = undefined }
    },
    setState: (patch) => write(patch),
    pickDirectory: pickDirectoryPaths,
    pickFile: pickFilePaths,
    selectionChanged: (selected) => {
      const next = addSelection([], selected)
      if (sameSelection(next, current.selected)) return notify()
      // 选择换了：不在任何入口之内的排除项要丢掉（否则它会悄悄少审一个同名文件）。
          const kept = current.excluded.filter((item) => next.some((root) => item.startsWith(`${root.replace(/[/\\]+$/, '')}/`)))
      write({ selected: next, excluded: kept, handoff: null, preparedSelection: [], expired: false, done: false })
      return notify()
    },
    /**
     * 移除**一个条目**：入口（文件/文件夹）从选择里去掉；入口之内的某个文件进排除清单。
     *
     * 两条语义分开很重要（用户 2026-10-11 口径：「右侧有个 X 的 icon，表示移除该文件」）：
     * - 文件夹整行上的 X = 不审这个文件夹 → 从 `selection` 删掉；
     * - 文件夹里某个文件行上的 X = 只不审这个文件 → 进 `excluded`（重新扫描后依然不审）。
     */
    remove: (path) => {
      const trimmed = trimTrailingSeparators(path.trim())
      if (trimmed === '') return notify()
      /**
       * 是"入口"还是"入口里的文件"？
       *
       * 判据取 **Host 回的 items**（它才是权威），并做拼法归一 —— 只比 `selected.includes`
       * 会栽在拼法上：macOS 的目录选择器回 `/x/资料/`（带尾斜杠），而 `item.path` 是 `/x/资料`，
       * 于是"移除这个文件夹"认不出来、被当成"入口里的某个文件"塞进排除清单，怎么点都移不掉
       * （用户 2026-10-11 实测）。扫描还没回来时 `items` 是占位行、路径就是 `selected` 本身，
       * 所以这条判据在扫描窗口里同样成立；扫描彻底失败时再退回比 `selected`。
       */
      const isEntry = current.items.some((item) => item.path !== '' && sameEntryPath(item.path, trimmed))
        || current.selected.some((item) => sameEntryPath(item, trimmed))
      if (isEntry) {
        // 入口本身：连同它下面已经记下的排除项一起清掉（那些条目已经没有意义）。
        const kept = current.excluded.filter((item) => !sameEntryPath(item, trimmed)
          && !item.startsWith(`${trimmed.replace(/[/\\]+$/, '')}/`))
        write({
          selected: removeSelection(current.selected, trimmed),
          excluded: kept,
          handoff: null, preparedSelection: [], expired: false, done: false,
        })
        return notify()
      }
      write({
        excluded: [...new Set([...current.excluded, trimmed])].sort(),
        handoff: null, preparedSelection: [], expired: false, done: false,
      })
      return notify()
    },
    clear: () => write({
      selected: [], items: [], files: [], excluded: [], fileCount: 0, overLimit: false, readableCount: 0, skippedCount: 0,
      skipped: [], phase: 'idle', error: '', pickError: '', handoff: null, preparedSelection: [],
      expired: false, done: false, failedAt: '',
    }),
    rescan: scan,
    setPrompt: (prompt) => write({
      prompt,
      // 提示词变了，上一次的快照提示词就不是用户要的那一份了 → 作废，重新准备。
      handoff: null, preparedSelection: [], expired: false, done: false,
    }),
    prepare,
    start,
    copyPrompt: async () => {
      const prompt = current.handoff?.prompt ?? ''
      if (prompt === '') return { ok: false, error: zhCN.localAuditCopyNoClipboard }
      if (typeof port.copyText !== 'function') return { ok: false, error: zhCN.localAuditCopyNoClipboard }
      try {
        const result = await port.copyText(prompt)
        return { ok: result.ok, error: result.ok ? '' : `${zhCN.localAuditCopyFailed}${result.error}` }
      } catch (cause: unknown) {
        return { ok: false, error: `${zhCN.localAuditCopyFailed}${describe(cause)}` }
      }
    },
    button: () => buttonStateOf({
      phase: current.phase,
      items: current.items,
      overLimit: current.overLimit,
      readableCount: current.readableCount,
      hasHandoff: current.handoff !== null,
    }),
  }
}

/**
 * 扫描窗口里的**占位行**（设计 §3 的「待审核」）。
 *
 * 这些行只表达一件事：用户已经选了它们、Host 还没回过话。所以：
 * - `kind` 留空（扫之前**不知道**是文件还是文件夹，不猜）→ 行上画中性图标；
 * - `sizeBytes` / `fileCount` 都是 0，`itemMetaOf` 会说「正在读取…」，不拿 0 B 冒充结论。
 */
export function pendingEntriesOf(selected: readonly string[]): LocalAuditEntryView[] {
  const root = commonRootOf(selected)
  return selected.map((path) => ({
    path,
    name: basenameOf(path),
    kind: '',
    sizeBytes: 0,
    fileCount: 0,
    status: 'pending',
    reason: '',
    relativePath: relativePathOf(path, root),
  }))
}

/** 两项选择是不是同一批（顺序也算：选择是按顺序累加的）。 */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

/**
 * 一批路径最浅的公共目录（只用来算展示用的相对路径）。
 *
 * 多选时常常是同一层（都在一个文件夹里）——那就把那一层当根，行上显示文件名；
 * 完全不相关的多个路径（比如两个盘符）时公共根为空，此时退回文件名。
 */
export function commonRootOf(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const split = (path: string): string[] => path.replace(/\\/g, '/').split('/')
  const first = split(paths[0])
  // 末段是文件/文件夹自己的名字，不是公共目录的一部分。
  const head = first.slice(0, -1)
  let common = head.length
  for (const path of paths.slice(1)) {
    const parts = split(path).slice(0, -1)
    let keep = 0
    while (keep < common && keep < parts.length && parts[keep] === head[keep]) keep += 1
    common = keep
    if (common === 0) break
  }
  return common === 0 ? '' : head.slice(0, common).join('/')
}

/** 逐项状态的语气 → 图标语义（组件用同一套判据挑图标，避免两处各写一份）。 */
export { itemStatusOf, itemMetaOf, basenameOf, summaryLineOf, overLimitMessageOf }
