import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { commandLine } from '../shell/run.ts'
import { text } from '../../shared/utils/value.ts'

/**
 * 用户主目录。
 *
 * 包形态优先用 Host 的 `os.homedir()`：插件就跑在 DSH 进程里，不必再探一次。只有当它与执行
 * 世界不一致（例如 shell 走 SSH/容器，本地主目录不是目标机器的主目录）时，才退回 shell 探测。
 */
export async function detectHome(ctx: Context, workdir?: string): Promise<string> {
  let local = ''
  try {
    local = text(homedir()).trim()
  } catch (error) {
    // 无 HOME/USERPROFILE 的环境下 homedir() 可能抛错；不是失败，继续探测执行世界。
    void error
    local = ''
  }
  if (local !== '') return local

  // 与 `detectPlatform` 同理：不用 node 探测。Host 自己的 `os.homedir()` 在绝大多数部署里
  // 已经答了；下面这条链是给「shell 在别的执行世界」准备的，python3 是清单必需项、`$HOME` 兜底。
  const probes = [
    'python3 -c \'import os;print(os.path.expanduser("~"))\'',
    'printf %s "$HOME"',
    'Write-Output $env:USERPROFILE',
  ]
  for (const probe of probes) {
    const line = await commandLine(ctx, probe, { timeoutMs: 15_000, ...(workdir === undefined ? {} : { workdir }) })
    if (line !== '') return line
  }
  return ''
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
