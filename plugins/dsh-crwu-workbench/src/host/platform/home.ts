import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { commandLine } from '../shell/run.ts'
import { homeProbeCommand } from './shell.ts'

/**
 * 用户主目录。
 *
 * 包形态优先用 Host 的 `os.homedir()`：插件就跑在 DSH 进程里，不必再探一次。只有当它与执行
 * 世界不一致（例如 shell 走 SSH/容器，本地主目录不是目标机器的主目录）时，才退回 shell 探测。
 *
 * **探测命令按平台只选一条**（2026-09-28 收紧）：旧实现把三条探测串成一条链
 * （`python3` → `printf` → `$env:USERPROFILE`）在 Windows 上先跑 `python3` —— 系统没装 Python 时
 * 每个探测都会先在 PowerShell 里报一次 command-not-found，日志噪音大、还让人误以为缺依赖。
 * 现在 Windows 只问 PowerShell 自己的环境变量，POSIX 只问 `$HOME`。
 */
export async function detectHome(ctx: Context, options: { workdir?: string; platform?: string } = {}): Promise<string> {
  let local = ''
  try {
    local = text(homedir()).trim()
  } catch (error) {
    // 无 HOME/USERPROFILE 的环境下 homedir() 可能抛错；不是失败，继续探测执行世界。
    void error
    local = ''
  }
  if (local !== '') return local

  // 平台由调用方注入；缺省时按 POSIX 探测（`Win32` 事实必须显式传进来，不猜）。
  const platform = text(options.platform)
  const line = await commandLine(ctx, homeProbeCommand(platform), {
    timeoutMs: 15_000,
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
  })
  return line
}

/** 展开 `~` / `~/x`；不认识的前缀原样返回。 */
export function expandLocal(path: unknown, home: string, isWindows: boolean): string {
  const value = text(path)
  if (home === '') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return `${home.replace(/[\\/]+$/, '')}${isWindows ? '\\' : '/'}${value.slice(2)}`
  }
  return value
}
