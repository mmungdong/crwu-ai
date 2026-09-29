/**
 * 本机错误文本的**路径脱敏**（协议 18 · D2 / §4.6 第 3 条）。
 *
 * ## 为什么要单独做这一步
 *
 * 系统调用的错误消息里常常**内嵌路径**：
 *
 * ```
 * EACCES: permission denied, stat '/Users/mungdong/.dws'
 * chmod: /Users/mungdong/.ossutilconfig: Operation not permitted
 * ```
 *
 * 这些字符串会被原样放进 doctor / 凭据卡片的 `message`，也就是**员工界面上**。
 * 而按 §4.6 第 3 条，凭据文件路径与主目录属于"维护者信息"（只在开发者诊断里展开）；
 * 员工卡片上突然出现 `C:\Users\张三\…` 既不必要，也把本机目录结构带进了日常界面。
 *
 * **保留错误本身**（`EACCES: permission denied` / `Operation not permitted` 是排障的关键），
 * 只把"像路径的那个词"换成 `<路径>`。整条消息不作废：丢掉原因比多一个路径更难查。
 *
 * 判据刻意保守：只处理**绝对路径**（`/…`、`~/…`、`X:\…`）与带分隔符的长串。
 * 普通命令词（`chmod` / `stat` / 中文说明）原样保留。
 */

/**
 * 绝对路径 / 主目录写法 / Windows 盘符路径。
 *
 * 两种形态分开写：Windows 的盘符路径**内含**冒号（`C:\Users\x`），而 POSIX 路径后面
 * 常跟着**标点**（`chmod: /Users/x/.ossutilconfig: Operation not permitted`）——
 * 把冒号算进 POSIX 路径就会把那个标点一起吃掉，消息读起来就断了。
 */
const PATH_TOKEN = /(?:[A-Za-z]:[\\/][^\s'"，。；、)）】]*|(?:~|\/)[^\s'"，。；、)）】:]*)/g

/** 把消息里像绝对路径的词换成 `<路径>`（同一个词只换一次，其余原样）。 */
export function redactPaths(raw: unknown): string {
  const message = typeof raw === 'string' ? raw : ''
  if (message === '') return ''
  return message.replace(PATH_TOKEN, (match) => {
    // 单个 `/` 或 `//` 这种分隔符本身不是路径（例如 `a / b`），不动它。
    if (/^[\\/]+$/.test(match)) return match
    return '<路径>'
  })
}
