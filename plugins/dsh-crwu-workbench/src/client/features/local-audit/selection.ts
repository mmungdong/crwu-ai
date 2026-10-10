import { zhCN } from '../../locales/zh-CN.ts'
import type { LocalAuditItemView, LocalAuditScanView } from '../../../shared/types.ts'
import { trimTrailingSeparators } from '../../../shared/utils/local-path.ts'

/**
 * 本地审核的**纯展示逻辑**（不碰 DOM、不碰 React、不认识 RPC）。
 *
 * 为什么要单独一层：这一页所有的"该说什么话、按钮该不该亮"都在设计 §5–§9 里逐条写死了，
 * 把判据留在 `.tsx` 里就只能靠渲染树去间接断言。这里全部是（状态）→（文案 / 是否可用）
 * 的纯函数，可以逐条对着设计表测。
 *
 * 三条口径：
 * 1. **文案一律来自 `zh-CN.ts`**，这里不内联任何用户可见中文（颜色/类的映射除外）；
 * 2. **禁用一定给原因**：设计 §15 要求禁用按钮旁边必须有可理解的原因文字，所以
 *    `buttonStateOf` 同时返回 `reason`，而不是只给一个 `disabled`；
 * 3. **状态是三重表达**：`itemStatusOf` 给出 tone + 中文标签，组件再配一枚同语义的图标 ——
 *    颜色只是第三重，绝不单独承载状态。
 */

/** 页面上出现的选择项（Host 的 `LocalAuditItemView` 加上界面自己的相对展示路径）。 */
export interface LocalAuditEntryView extends LocalAuditItemView {
  /** 相对所选根目录的展示路径（Windows 上反斜杠也会被统一成 `/`）。 */
  relativePath: string
}

/** 阶段：`done` = 四步走完并已经切到新对话。 */
export type LocalAuditPhase = 'idle' | 'scanning' | 'preparing' | 'creating' | 'ready' | 'failed' | 'done'

export interface LocalAuditButtonState {
  label: string
  disabled: boolean
  /** 禁用原因（可用时为空串）。 */
  reason: string
}

export type LocalAuditTone = 'ok' | 'warn' | 'error' | 'muted'

/** 格式化字节数：1024 进制；整数不带小数点，其余保留一位；0 与非法值都说 `0 B`。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${String(Math.round(value))} B`
  // 1.0 KB 写成 1 KB：多一个 `.0` 只是噪音，用户要的是量级。
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 两种平台的路径都按 `/` 切：Windows 上选择器回的是 `C:\资料\附件`。 */
function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((part) => part !== '')
}

/** 展示用的文件名（只用于界面；Host 才是路径判据的唯一来源）。 */
export function basenameOf(path: string): string {
  const parts = segmentsOf(path)
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/**
 * 相对所选根目录的展示路径。
 *
 * 前缀匹配失败（大小写、正斜杠差异）时退回文件名：界面**不猜**绝对路径，
 * 提示词里的路径由 Host 给，这里只是让人一眼看出选了什么。
 */
export function relativePathOf(path: string, root: string): string {
  const base = segmentsOf(root)
  const parts = segmentsOf(path)
  if (base.length === 0 || parts.length < base.length) return basenameOf(path)
  if (parts.length === base.length) return basenameOf(path)
  for (let index = 0; index < base.length; index += 1) {
    if (parts[index].toLowerCase() !== base[index].toLowerCase()) return basenameOf(path)
  }
  const rest = parts.slice(base.length)
  // `rest` 为空只发生在"path 就是 root 本身"，此时 `parts.length === base.length` 已经拦掉了；
  // 真正会走到这里的都是"root 下的子路径"（选择项是文件夹里的文件/子文件夹）。
  return rest.length === 0 ? basenameOf(path) : rest.join('/')
}

/** 加入选择：去掉空白项、按原值去重、保持既有顺序（后加入的排在后）。 */
export function addSelection(list: readonly string[], paths: readonly string[]): string[] {
  const out = [...list]
  const seen = new Set(out)
  for (const raw of paths) {
    // ⚠️ 必须**去掉尾部分隔符**：macOS 的目录选择器回的是 `/Users/x/资料/`（带斜杠），
    // 而 Host 回的 `items[].path` 是去掉过的。两边拼法不一致 → 界面上"移除这个文件夹"
    // 会认不出它是入口，于是被当成"入口里的某个文件"，怎么点都移不掉（用户实测）。
    const path = trimTrailingSeparators(raw.trim())
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 两个路径是不是**同一个入口**。
 *
 * 只做"拼法"层面的归一（分隔符、尾部分隔符、Windows 盘符大小写）—— 它**不做**真实路径解析，
 * 那是 Host 的 `canonical` 在管；界面只需要能把"用户选的那个字符串"与"Host 回的 item.path"
 * 对上号。
 */
export function sameEntryPath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

/** 移除一项；`path` 同时按 `/` 与 `\` 归一后比较（Windows 上两处写法都算同一项）。 */
export function removeSelection(list: readonly string[], path: string): string[] {
  const target = normalizePath(path)
  return list.filter((item) => normalizePath(item) !== target)
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 设计 §8 的**主按钮状态表**（九种状态逐条对应）。
 *
 * 判据优先级是有意义的，不是随手排的：
 * 扫描中 > 超限 > 建会话 > 准备快照 > 没有选择 > 没有可读文件 > 已准备 handoff > 普通错误；
 * 前四条是"正在进行 / 硬性阻止"，任何一条成立时都必须盖住后面那些"可以开始"的结论 ——
 * 否则扫描到一半就会亮起一个按下去必然被 Host 拒掉的按钮。
 *
 * 返回的 `reason` 是禁用原因（设计 §15）：可用时为空串。
 */
export function buttonStateOf(state: {
  phase: LocalAuditPhase
  items: readonly unknown[]
  overLimit: boolean
  readableCount: number
  /** 已经"准备好文件快照"但还没建会话（快照可以被复用，不必重新复制）。 */
  hasHandoff: boolean
}): LocalAuditButtonState {
  const hasSelection = state.items.length > 0
  if (state.phase === 'scanning') {
    return { label: zhCN.localAuditScanningButton, disabled: true, reason: zhCN.localAuditScanning }
  }
  if (state.overLimit) {
    return { label: zhCN.localAuditOverLimitButton, disabled: true, reason: zhCN.localAuditOverLimit }
  }
  if (state.phase === 'creating') {
    return { label: zhCN.localAuditCreatingButton, disabled: true, reason: zhCN.localAuditCreating }
  }
  if (state.phase === 'preparing') {
    return { label: zhCN.localAuditPreparingButton, disabled: true, reason: zhCN.localAuditPreparing }
  }
  if (!hasSelection) {
    return { label: zhCN.localAuditNeedFilesButton, disabled: true, reason: zhCN.localAuditNeedFiles }
  }
  if (state.readableCount === 0) {
    return { label: zhCN.localAuditNoReadableButton, disabled: true, reason: zhCN.localAuditNoReadable }
  }
  if (state.phase === 'failed' && !state.hasHandoff) {
    return { label: zhCN.localAuditRetryPrepare, disabled: false, reason: '' }
  }
  return { label: zhCN.localAuditStartButton, disabled: false, reason: '' }
}

/** 「已选择 N 个项目，展开后共 M 个文件」；没有选择时整句不渲染（返回空串）。 */
export function summaryLineOf(scan: Pick<LocalAuditScanView, 'items' | 'fileCount'>): string {
  if (scan.items.length === 0) return ''
  return zhCN.localAuditSummary
    .replace('%s', String(scan.items.length))
    .replace('%s', String(scan.fileCount))
}

/** 超过上限时那句明确阻止的话（Host 也会在 `error` 里给同一口径的一句）。 */
export function overLimitMessageOf(scan: Pick<LocalAuditScanView, 'overLimit' | 'fileCount' | 'limit'>): string {
  if (!scan.overLimit) return ''
  return zhCN.localAuditOverLimitMessage
    .replace('%s', String(scan.fileCount))
    .replace('%s', String(scan.limit))
}

/**
 * Host 的 `status` → 语气 + 中文标签（组件再配一枚同语义图标）。
 *
 * 五个标签与设计 §3 逐字对应；`pending`（以及 Host 还没回过话的空串）是**待审核**，
 * 不是"未知状态" —— 扫描窗口里的行就是这一态，把它说成"未知"会让人以为出错了。
 */
export function itemStatusOf(status: string): { tone: LocalAuditTone; label: string } {
  if (status === 'scanned') return { tone: 'ok', label: zhCN.localAuditStatusScanned }
  if (status === 'unreadable') return { tone: 'error', label: zhCN.localAuditStatusUnreadable }
  if (status === 'skipped') return { tone: 'muted', label: zhCN.localAuditStatusSkipped }
  if (status === 'over-limit') return { tone: 'warn', label: zhCN.localAuditStatusOverLimit }
  if (status === 'pending' || status === '') return { tone: 'muted', label: zhCN.localAuditStatusPending }
  // 认不出的取值不谎报成功。
  return { tone: 'muted', label: zhCN.localAuditStatusUnknown }
}

/**
 * 一行的辅助事实：文件说大小，文件夹说展开后有多少个文件。
 *
 * `pending` 行**没有**这些事实（还没扫到），所以如实说"正在读取…"—— 不用 `0 B` 冒充结论。
 */
export function itemMetaOf(item: Pick<LocalAuditItemView, 'kind' | 'sizeBytes' | 'fileCount'> & { status?: string }): string {
  if (item.status === 'pending') return zhCN.localAuditScanningMeta
  if (item.kind === 'directory') {
    return `${zhCN.localAuditKindDirectory} · ${item.fileCount > 0
      ? zhCN.localAuditDirectoryFiles.replace('%s', String(item.fileCount))
      : zhCN.localAuditDirectoryEmpty}`
  }
  return `${zhCN.localAuditKindFile} · ${formatBytes(item.sizeBytes)}`
}

/**
 * 宿主路径服务在不在（`__DSH_HOST_PATHS__`）。
 *
 * ⚠️ **它是对象 `{ pathFor }`，不是函数**。2026-10-11 用户实测抓到：早先这里写的是
 * `typeof input.hostPaths === 'function'`，于是**永远为假**，「选择文件」这条能力从来没被认出来过
 * （替身测试恰好传了函数形状，所以单测全绿）。两种形状都接受，是因为这个字段的注入形态可能变。
 */
export function hasHostPaths(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (value === null || typeof value !== 'object') return false
  return typeof (value as { pathFor?: unknown }).pathFor === 'function'
}

/** 「选择文件夹」这条能力在不在（客户端 `uiWorkspace.pickDirectory`）。 */
export function supportsDirectoryPick(pickDirectory: unknown): boolean {
  return typeof pickDirectory === 'function'
}

/** 「选择文件」这条能力在不在（宿主路径服务 + 渲染进程的 file input）。 */
export function supportsFilePick(hostPaths: unknown, fileInput: unknown): boolean {
  return hasHostPaths(hostPaths) && typeof fileInput === 'function'
}

/**
 * 两条能力里**有任何一条**可用。
 *
 * 设计 §4 那句「当前 DeepSeek Harness 版本不支持本机文件选择」只在**两条都没有**时才说；
 * 只有一条可用时，另一个按钮照旧要给（用户实测的问题正是"只有一条可用却整块被替换掉"）。
 */
export function pickSupported(input: {
  pickDirectory?: unknown
  hostPaths?: unknown
  fileInput?: unknown
}): boolean {
  return supportsDirectoryPick(input.pickDirectory) || supportsFilePick(input.hostPaths, input.fileInput)
}
