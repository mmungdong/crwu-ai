import type { Context } from '@deepseek-ai/cordis'
import { detectHome } from './home.ts'
import { detectPlatform } from './detect.ts'
import { sessionRoot } from '../fs/paths.ts'

/**
 * 插件实例级的执行世界事实（平台 / 主目录 / 会话根）。
 *
 * 三者都是「第一次用的时候探一次，之后复用」：探测各自要跑子进程，逐次重探会让环境自检
 * 慢到不可接受，而它们在一次插件生命周期内不会变（换机器 = 换插件实例）。
 * 状态挂在实例上、随 Cordis 生命周期释放，不放模块顶层。
 */
export interface WorldFacts {
  /** 执行世界平台（`darwin-arm64` / `win32-x64` / `linux-x64`）。 */
  platform(): Promise<string>
  /** 用户主目录。 */
  home(): Promise<string>
  /** 当前会话工作目录（命令的默认 workdir）。 */
  workdir(): Promise<string>
  /** 测试与诊断用：已缓存的值，未探测时为 null。 */
  cached(): { platform: string | null; home: string | null }
}

export function createWorldFacts(ctx: Context): WorldFacts {
  let platform: string | null = null
  let home: string | null = null
  let root: string | null = null

  return {
    async platform() {
      if (platform === null) platform = await detectPlatform(ctx)
      return platform
    },
    async home() {
      if (home === null) {
        // 主目录探测要走**当前平台**的方言：Windows 上只能问 PowerShell 的环境变量，
        // 而不是先试 `python3` / `printf`（那两条在 Windows 上只是两次 command-not-found）。
        home = await detectHome(ctx, { platform: await this.platform() })
      }
      return home
    },
    async workdir() {
      if (root === null) root = await sessionRoot(ctx)
      return root
    },
    cached() {
      return { platform, home }
    },
  }
}
