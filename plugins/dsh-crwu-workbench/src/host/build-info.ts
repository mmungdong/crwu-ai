import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 这份 Host 产物的写入时间（ISO 8601），用作「我这次 build 到底装上了没有」的指纹。
 *
 * 为什么需要它：`rev` 是跟着包版本走的固定字符串（`pkg-0.0.1`），**同一次开发里的两次 build
 * 完全一样**。重启 profile 之后光看 `rev` 分不清「新 build 生效了」还是「还是上一份」，
 * 而这正是本地开发循环里最容易搞错的一步 —— 改完、重启、看面板没变化，然后去查一个不存在的 bug。
 *
 * **必须在模块加载时算一次，不能在每次请求里现读文件**（第 33 轮实测踩到）：现读的话，
 * 「重新 build 了、但忘了重启」时它报的是**磁盘上新文件的 mtime**，看起来像新 build 已生效，
 * 而实际跑的还是内存里的旧代码 —— 指纹反而把人骗了。写成模块级常量后它反映的是
 * **这份正在运行的代码**被加载那一刻的文件时间：
 * 不重启 → 值不变（等于在说「你还在跑旧的」）；重启后 → 变成新构建的时间。
 *
 * 取值是自己这个 bundle 文件的 mtime：
 * - `link:` 安装（本机开发）：就是仓库 `lib/index.js` 被构建写入的时间；
 * - npm / tarball 安装：是解包写入的时间，同样足以区分「换了新包」。
 *
 * 读不到就是空串 —— 链路自检不能因为读不到自己的 mtime 而失败。
 */
export const HOST_BUILD_STAMP: string = readStamp()

function readStamp(): string {
  try {
    return new Date(statSync(fileURLToPath(import.meta.url)).mtimeMs).toISOString()
  } catch (error) {
    // 产物被内联进别的形态、或运行环境读不到自身文件时取不到，按「未知」处理。
    void error
    return ''
  }
}

/** 这份 Host 代码是从哪儿加载的。 */
export type HostBuildKind = 'dev' | 'installed'

/**
 * 这份 Host 产物是**源码检出（dev）**还是**装好的包**。
 *
 * 为什么界面要区分：`link:` 安装（本机开发）与员工装 TGZ/npm 是两种完全不同的运行形态 ——
 * 同一台机器上两种都可能存在，而「我现在看到的是哪一份」直接决定排查方向（改了没生效？
 * 那就是还在跑旧的 link；行为像老版本？那就是装过包）。用户要的就是这枚小标签。
 *
 * 判据是**包根旁边有没有 `src/`**（不是猜 profile 里那条依赖写成什么）：
 * 发布包的 `files` 里只有 `lib/`、配置、补丁、文档和技能，**不带 `src/`**；而源码检出一定有。
 * 包根从**这个文件自己**往上找带 `package.json` 的那一层得到 —— `lib/index.js`（构建后）与
 * `src/host/build-info.ts`（测试直接 import 源码）两种形态都能定位到同一个包根。
 *
 * 与 `HOST_BUILD_STAMP` 一样是**模块加载时的常量**：它描述的是「正在跑的这份代码」的来源，
 * 现读磁盘会把「重新 build 但没重启」这件事掩盖掉。
 */
export const HOST_BUILD_KIND: HostBuildKind = readKind()

function readKind(): HostBuildKind {
  try {
    const root = packageRoot(dirname(fileURLToPath(import.meta.url)))
    // 找不到包根（被内联进别的形态、或布局异常）时按「装好的包」处理：
    // 这种情况下界面只显示版本号，不会谎报「这是 dev」。
    return root === '' ? 'installed' : hostBuildKindOf(root)
  } catch (error) {
    void error
    return 'installed'
  }
}

/** 判据本体（纯函数，可单测）：包根旁边有 `src/` 就是源码检出，否则是装好的包。 */
export function hostBuildKindOf(packageRootPath: string): HostBuildKind {
  return existsSync(join(packageRootPath, 'src')) ? 'dev' : 'installed'
}

/** 从某个目录往上找带 `package.json` 的那一层；最多四层，避免顺着文件系统一路爬。 */
function packageRoot(from: string): string {
  let current = from
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}
