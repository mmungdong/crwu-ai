import type { Context } from '@deepseek-ai/cordis'
import { commandLine } from '../shell/run.ts'

/**
 * 判定当前执行世界（shell 实际运行的那台机器）的平台。
 *
 * 为什么不能直接用 `process.platform`：DSH 的 shell 可能通过 SSH / 容器在其他机器上执行，
 * `process.platform` 描述的是 Host 进程所在机器，而 `ossutil` / `crwu` / `dws` 装在执行世界。
 * 所以这里**以 shell 探测为准**；探测全部失败时回退到 Host 的 `process.platform`
 * （legacy 只返回空串，包形态能多给一个可信的兜底）。
 */

/** 把 `uname -sm` / `python platform` 之类的输出规范成 `os-arch`。 */
export function normalizePlatform(raw: unknown): string {
  const first = String(raw ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (first === '') return ''
  const tokens = first.toLowerCase().replace(/\s+/g, '-').split('-').filter(Boolean)
  if (tokens.length === 0) return ''
  let os = tokens[0] ?? ''
  let arch = tokens.length > 1 ? (tokens[1] ?? '') : ''
  if (os === 'darwin' || os === 'mac' || os === 'macos') os = 'darwin'
  else if (os.startsWith('win')) os = 'win32'
  else if (os === 'linux') os = 'linux'
  else return ''
  if (arch === 'x86_64' || arch === 'amd64') arch = 'x64'
  else if (arch === 'aarch64' || arch === 'arm64') arch = 'arm64'
  else if (arch === 'i386' || arch === 'i686' || arch === 'x86') arch = 'ia32'
  return os + (arch === '' ? '' : `-${arch}`)
}

/** 探测执行世界的平台；结果由调用方缓存（进程内一次即可）。 */
export async function detectPlatform(ctx: Context, workdir?: string): Promise<string> {
  const probes = [
    'node -p \'process.platform+"-"+process.arch\'',
    'node -p \'process.platform\'',
    'python3 -c \'import sys,platform;print(sys.platform+"-"+platform.machine())\'',
    'uname -sm',
  ]
  for (const probe of probes) {
    const line = await commandLine(ctx, probe, { timeoutMs: 20_000, ...(workdir === undefined ? {} : { workdir }) })
    const normalized = normalizePlatform(line)
    if (normalized !== '') return normalized
  }
  const fallback = `${process.platform}-${process.arch}`
  return normalizePlatform(fallback)
}

/** 平台是否为 Windows。 */
export function isWindowsPlatform(platform: string): boolean {
  return platform.startsWith('win32')
}
