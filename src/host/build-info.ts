import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 这份 Host 产物的写入时间（ISO 8601），用作「我这次 build 到底装上了没有」的指纹。
 *
 * 为什么需要它：`rev` 是跟着包版本走的固定字符串（`pkg-0.1.2`），**同一次开发里的两次 build
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
