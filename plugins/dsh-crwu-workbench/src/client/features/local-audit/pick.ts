import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 本机文件 / 文件夹选择的**注入式**适配。
 *
 * 为什么不直接调真实的 DOM 与 Electron：
 * - 这一层要能单测（真 file input 在 Node 里不存在），所以两条能力都以参数注入；
 * - 「不支持」是**产品状态**，不是异常：Web profile 与旧宿主里两条能力都可能缺席，
 *   设计 §6 要求整块显示一句固定的话，且**不许暴露 JS 错误或底层服务名**。
 *
 * DSH 没有原生的"文件选择器"客户端服务（只有 `uiWorkspace.pickDirectory`），所以文件多选
 * 走渲染进程的 `<input type="file" multiple>` + Electron 的
 * `globalThis.__DSH_HOST_PATHS__.pathFor(file)` 取绝对路径 —— 后者只在桌面端存在。
 */

/**
 * 选择失败。**两种失败必须分开**（2026-10-11 用户实测踩到）：
 *
 * - `unsupported: true` —— 这个宿主**根本没有**这个能力（Web profile / 旧宿主）。
 *   文案是设计 §4 那句固定的「当前 DeepSeek Harness 版本不支持本机文件选择。请更新宿主后重试。」；
 * - `unsupported: false` —— 能力在，但**这一次没打开**（系统选择窗口被挡、宿主进程弹不出窗口……）。
 *   这时说"请更新宿主"是**错的话**：用户换了桌面版也照样打不开，他该做的是重试或反馈。
 */
export interface LocalAuditPickFailure {
  ok: false
  paths: string[]
  unsupported: boolean
  error: string
}

export type LocalAuditPickResult =
  | { ok: true; paths: string[]; unsupported: false; error: '' }
  | LocalAuditPickFailure

/** 一份 Electron `File` 上我们真正会读的字段（别处可能是别的实现）。 */
export interface PickedFileLike {
  name?: string
  path?: string
  webkitRelativePath?: string
}

/** 目录选择：客户端 `uiWorkspace` 服务（可能整个缺席）。 */
export interface DirectoryPicker {
  pickDirectory?: () => Promise<string | null | undefined>
}

/** 文件选择：宿主路径服务 + 隐藏 file input 的点击入口。 */
export interface FilePicker {
  hostPaths?: { pathFor?: (file: unknown) => string | undefined }
  fileInput?: () => Promise<readonly PickedFileLike[] | null>
}

function unsupported(message: string = zhCN.localAuditPickUnsupported): LocalAuditPickFailure {
  return { ok: false, paths: [], unsupported: true, error: message }
}

/** 能力在、这一次打不开：文案要说"重试/反馈"，不能说"请更新宿主"。 */
function failed(): LocalAuditPickFailure {
  return { ok: false, paths: [], unsupported: false, error: zhCN.localAuditPickFailed }
}

/**
 * 「选择文件夹」→ 绝对路径。
 *
 * 用户取消（服务返回空）**不是错误**：返回 `ok: true` 加空清单，界面什么都不说 ——
 * 说一句"不支持"会让取消看起来像坏了。
 */
export async function pickDirectory(picker: DirectoryPicker | undefined): Promise<LocalAuditPickResult> {
  if (typeof picker?.pickDirectory !== 'function') return unsupported(zhCN.localAuditPickDirectoryUnsupported)
  let picked: string | null | undefined
  try {
    picked = await picker.pickDirectory()
  } catch {
    // 服务在、但这一次弹不出窗口（宿主被沙箱挡住 / 系统对话框不可用）：
    // 如实说"打不开、请重试"，**不说**"请更新宿主" —— 后者会把用户指到错的处置上。
    return failed()
  }
  const path = typeof picked === 'string' ? picked.trim() : ''
  if (path === '') return { ok: true, paths: [], unsupported: false, error: '' }
  return { ok: true, paths: [path], unsupported: false, error: '' }
}

/** 一个 File 的绝对路径：先问宿主路径服务，再退到 File 自己的 `path` 字段（旧 Electron）。 */
function pathOfFile(file: PickedFileLike, hostPaths: FilePicker['hostPaths']): string {
  if (typeof hostPaths?.pathFor === 'function') {
    try {
      const path = hostPaths.pathFor(file)
      if (typeof path === 'string' && path.trim() !== '') return path.trim()
    } catch {
      void 0
    }
  }
  return typeof file.path === 'string' ? file.path.trim() : ''
}

/**
 * 「选择文件」→ 绝对路径清单。
 *
 * `fileInput` 缺席（Web profile）或**一个文件都拿不到绝对路径**时算"不支持"：
 * 拿不到绝对路径的选择项对 Host 毫无意义（它按路径扫描），假装成功只会让下一步报错。
 *
 * 选取目录时 `webkitRelativePath` 是相对所选文件夹的路径，绝对路径仍是 `pathFor()` 那个；
 * 这里只把 `webkitRelativePath` 交给控制器去算展示路径。
 */
export async function pickFile(picker: FilePicker | undefined, files?: readonly PickedFileLike[]): Promise<LocalAuditPickResult> {
  if (files !== undefined) {
    if (files.length === 0) return { ok: true, paths: [], unsupported: false, error: '' }
    const paths = files.map((file) => pathOfFile(file, picker?.hostPaths)).filter((path) => path !== '')
    // 选择窗口开出来了、但一个绝对路径都拿不到（浏览器里就是这样）：这是**能力**问题 ——
    // 对 Host 而言没有路径的选择毫无意义（它按路径扫描），所以如实说这条能力不可用。
    if (paths.length === 0) return unsupported(zhCN.localAuditPickFilesUnsupported)
    return { ok: true, paths, unsupported: false, error: '' }
  }
  if (typeof picker?.fileInput !== 'function') return unsupported(zhCN.localAuditPickFilesUnsupported)
  let picked: readonly PickedFileLike[] | null
  try {
    picked = await picker.fileInput()
  } catch {
    return failed()
  }
  if (picked === null || picked === undefined) return { ok: true, paths: [], unsupported: false, error: '' }
  return await pickFile(picker, picked)
}
