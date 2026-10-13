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

/**
 * 隐藏的 `<input type="file" multiple>`。
 *
 * DSH 没有原生文件选择器客户端服务（只有目录选择器），所以文件多选只能走渲染进程的 input；
 * 绝对路径由 Electron 的 `__DSH_HOST_PATHS__.pathFor(file)` 取回（见 pick.ts）。
 * input 不挂进 DOM、选完即弃：它只是一次性的系统对话框入口。
 */
export function pickFilesFromInput(): Promise<readonly PickedFileLike[] | null> {
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

/**
 * 宿主路径桥（`__DSH_HOST_PATHS__`）——**每次调用现读**。
 *
 * 为什么必须现读而不是在装配时取一次：它是渲染进程 preload 注入的全局，注入时机不由我们定。
 * 快照下来就会出现「能力明明在、插件说不在」（本仓在 `sessions` / `uiWorkspace` 上踩过三次同一个坑）。
 */
export function hostPathBridge(): FilePicker['hostPaths'] | undefined {
  const value = (globalThis as { __DSH_HOST_PATHS__?: { pathFor?: (file: unknown) => string | undefined } }).__DSH_HOST_PATHS__
  return typeof value?.pathFor === 'function' ? value : undefined
}

/** 目录选择服务（`uiWorkspace.pickDirectory`）的形状；只取我们真正会用的那一个方法。 */
export interface DirectoryPickerService {
  pickDirectory?: () => Promise<string | null | undefined>
}

/** 门禁结论：`ok: false` 时把原因原样写给用户（不写"未知错误"）。 */
export interface PickerReadiness {
  ok: boolean
  error: string
}

/** 能拿到客户端的那个东西（`apply()` 里的 `services`、组件里的 `props.services`）。 */
export interface PickerServiceSource {
  uiWorkspace?: DirectoryPickerService | undefined
}

/**
 * 把"本机选择"的两条能力做成**活的**适配器：给两个模块（本地审核 / 报告评估）共用一份。
 *
 * ## 为什么要有这个函数（2026-10-12 用户实测的缺陷）
 *
 * 报告评估那一页原本自己拼了这份能力，结果漏了两件事，症状是点「选文件」永远弹
 * 「当前运行环境拿不到本机绝对路径…请在桌面端打开本页」——**而桌面端本来也拿不到**：
 *
 * 1. **没接 `hostPaths`**：现代 Electron 已经移除 `File.path`（改成 `webUtils.getPathForFile`，
 *    DSH 以 `__DSH_HOST_PATHS__.pathFor` 暴露）。不接它，`file.path` 恒为空 → 一个绝对路径都拿不到
 *    → 如实报"能力不可用"。那句提示把用户指去桌面端，而桌面端缺的正是这一根线。
 * 2. **装配时快照**：`...(services.uiWorkspace?.pickDirectory === undefined ? {} : …)` 在 `apply()` 里
 *    只判一次；我们的客户端插件先激活时 `ui-workspace` 还没注册，这一条就永远是 undefined。
 *    本地审核那一页为此专门写过注释与 getter（2026-10-11 的同一个 bug），报告评估又犯了一遍。
 *
 * 所以这里用 **getter**：能力在不在、全局注入得晚不晚，都由**调用时刻**决定。
 * 两个模块共用这一份实现，也就不存在"某一页记得接、另一页忘了接"。
 */
export function hostPickerCapabilities(
  source: () => PickerServiceSource,
  extra: { ready?: () => PickerReadiness } = {},
): DirectoryPicker & FilePicker & { ready?: () => PickerReadiness } {
  return {
    get hostPaths() {
      return hostPathBridge()
    },
    get pickDirectory() {
      const call = source().uiWorkspace?.pickDirectory
      // 绑回服务本身：解绑后 `this` 可能丢（`uiWorkspace` 的实现里用了 `this`）。
      const owner = source().uiWorkspace
      return typeof call === 'function' && owner !== undefined
        ? async () => await call.call(owner)
        : undefined
    },
    fileInput: pickFilesFromInput,
    // `ready` 也必须是 getter：调用方传进来的是**活的**判据，展开/求值一次就变成快照。
    get ready() {
      return extra.ready
    },
  }
}
