import { text } from './value.ts'

/**
 * **本地展示路径**的纯函数适配器（不引用 `node:path`）。
 *
 * ## 为什么需要它
 *
 * Host 与 Client 都要算「案例目录」「文件名」这类**展示路径**，而共享层不能引入 Node 模块
 * （Client 产物是要进浏览器的）。于是历史实现各处都用 `/` 硬拼，在 Windows 上产生三类错误：
 *
 * 1. **拼接**：`C:\Work` + `/` + `S1` 得到 `C:\Work/S1`，进 shell（PowerShell 的 `-Path`）
 *    与进提示词（模型照着写命令）都是混用分隔符；
 * 2. **取末段**：`'C:\\Work\\S1'.split('/')` 得到整串，界面上的案例名变成一整条路径；
 * 3. **裁剪**：`replace(/\/+$/, '')` 对 `C:\Work\` 无效；对 `\\server\share\` 稍有不慎就裁成
 *    无法解析的 `\\server`。
 *
 * ## 边界（改这个文件前先读）
 *
 * - 这里处理的是**本地路径**：盘符、UNC、POSIX 根。**OSS object key 永远用 `/`**，
 *   不属于这里（见 `host/oss/ops.ts` 里 `objectKey` 的命名）。
 * - **安全性判断不要用这里的函数**：`..`、符号链接、Windows 盘符大小写都会让字符串比较失效，
 *   父目录/子目录判定一律走 `ctx.fs.contains`（后端 realpath 之后比较）。
 *   这里只负责「拼一条给人看、给命令用的路径」。
 * - `joinLocalPath` 对**不受信任的片段**是拒绝而不是清洗：绝对路径、`..` 片段都抛错。
 *   静默清洗会让调用方以为拿到了一条安全路径（最危险的形态）。
 */

/** 盘符形式：`C:\` / `C:/`，也接受裸 `C:`。 */
const DRIVE = /^[A-Za-z]:([\\/]|$)/
/** UNC / 双分隔符开头：`\\server\share` 或 `//server/share`。 */
const UNC = /^[\\/]{2}[^\\/]/

/** 这个字符串看起来是 Windows 风格路径（盘符或 UNC）。 */
export function isWindowsStylePath(value: unknown): boolean {
  const raw = text(value)
  return DRIVE.test(raw) || UNC.test(raw)
}

/** 是否是绝对本地路径（POSIX `/…`、Windows 盘符、UNC 都算）。 */
export function isAbsoluteLocalPath(value: unknown): boolean {
  const raw = text(value)
  return raw.startsWith('/') || isWindowsStylePath(raw)
}

/**
 * 去掉尾部路径分隔符，但**保留根**：
 *
 * - `'/work/'` → `'/work'`；`'/'` → `'/'`；
 * - `'C:\\Work\\'` → `'C:\\Work'`；`'C:\\'` → `'C:\\'`（裁成 `'C:'` 会变成「盘符相对路径」）；
 * - `'\\\\server\\share\\'` → `'\\\\server\\share'`；
 *   `'\\\\server\\'` → `'\\\\server\\'`（裁掉尾部分隔符就只剩服务器名，不是一个可解析的路径）。
 */
export function trimTrailingSeparators(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  if (/^\/+$/.test(raw)) return '/'
  if (/^[A-Za-z]:[\\/]$/.test(raw)) return raw
  if (/^[\\/]{2}[^\\/]+[\\/]$/.test(raw)) return raw
  let end = raw.length
  while (end > 0 && (raw[end - 1] === '/' || raw[end - 1] === '\\')) end -= 1
  // 整串都是分隔符（Windows 的 `\\`）时保持原样，不去猜它是什么意思。
  return end === 0 ? raw : raw.slice(0, end)
}

/** 该路径风格用哪个分隔符；非 Windows 风格一律 `/`。 */
export function localSeparator(value: unknown): '/' | '\\' {
  return isWindowsStylePath(value) ? '\\' : '/'
}

/**
 * `child` 是不是 `parent` 本身或它的后代（**仅供展示层的匹配**）。
 *
 * 为什么需要：`WorkspaceEntry` 之间可能互相嵌套（一个工作空间是另一个的子目录），
 * 界面要选**最长**的那个；历史实现写的是 `child.startsWith(parent + '/')`，
 * 在 Windows 上既漏（分隔符是 `\`）又不区分大小写（Windows 路径不区分）。
 *
 * **这不是安全边界**：`..`、符号链接、8.3 短名都会让它判断错 ——
 * 任何「能不能读写这个目录」的判断都必须走 `ctx.fs.contains`（后端 realpath 之后比较）。
 */
export function isLocalPathUnder(child: unknown, parent: unknown): boolean {
  const base = trimTrailingSeparators(parent)
  if (base === '') return false
  const target = trimTrailingSeparators(child)
  if (target === '') return false
  const fold = isWindowsStylePath(base) ? (value: string): string => value.toLowerCase() : (value: string): string => value
  const left = fold(target)
  const right = fold(base)
  if (left === right) return true
  // 根形式（`/`、`C:\`、`\\server\`）自带尾分隔符，不能再补一个。
  if (/[\\/]$/.test(base)) return left.startsWith(right)
  return left.startsWith(`${right}/`) || left.startsWith(`${right}\\`)
}

/** 一个片段是不是 `..`（只看整段，不看 `a..b` 这种文件名）。 */
function isParentSegment(segment: string): boolean {
  return segment.split(/[\\/]+/).some((part) => part === '..')
}

/**
 * 拼接一条本地路径：分隔符随 `root` 的风格。
 *
 * - `joinLocalPath('C:\\Work', 'a', 'b')` → `'C:\\Work\\a\\b'`
 * - `joinLocalPath('/work', 'a', 'b')` → `'/work/a/b'`
 * - `joinLocalPath('/work/', 'a')` → `'/work/a'`（根上的尾分隔符不产生双斜杠）
 *
 * **拒绝**（抛 `RangeError`）而不是清洗：
 * - 片段是绝对路径（`/x`、`C:\x`、`\\server\x`）—— 那会静默替换掉整条路径；
 * - 片段含 `..` 整段 —— 那会静默越出调用方以为的目录。
 *
 * 空片段（`''`）跳过；片段内部的另一种分隔符会被规范成目标分隔符。
 */
export function joinLocalPath(root: unknown, ...segments: unknown[]): string {
  const base = trimTrailingSeparators(root)
  const sep = localSeparator(base)
  const parts: string[] = []
  if (base !== '') parts.push(base)
  for (const segment of segments) {
    const raw = text(segment)
    if (raw === '') continue
    if (isAbsoluteLocalPath(raw)) {
      throw new RangeError(`joinLocalPath 拒绝绝对路径片段：${raw}`)
    }
    if (isParentSegment(raw)) {
      throw new RangeError(`joinLocalPath 拒绝含 .. 的片段：${raw}`)
    }
    const cleaned = raw.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (cleaned === '') continue
    parts.push(sep === '\\' ? cleaned.replace(/\//g, '\\') : cleaned.replace(/\\/g, '/'))
  }
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0] as string
  const [head, ...tail] = parts
  // 根自带尾分隔符时不要再补一个（`/` + `a` 不能变成 `//a`）。
  const joint = head !== undefined && /[\\/]$/.test(head) ? '' : sep
  return `${head ?? ''}${joint}${tail.join(sep)}`
}

/**
 * 取路径最后一段（目录名 / 文件名）。
 *
 * 两种分隔符、盘符根、UNC 根都能正确处理：`'C:\\Work\\S1\\'` → `'S1'`，
 * `'\\\\server\\share'` → `'share'`，`'/'` → `'/'`，`'C:\\'` → `'C:\\'`。
 */
export function basenameLocalPath(value: unknown): string {
  const trimmed = trimTrailingSeparators(value)
  if (trimmed === '') return ''
  if (/^[\\/]+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] ?? trimmed) : trimmed
}
