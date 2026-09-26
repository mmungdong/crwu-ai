import type { Context } from '@deepseek-ai/cordis'
import { binPlatformDir } from './bin-dir.ts'
import { commandLine } from '../shell/run.ts'

/**
 * 判定平台（`darwin-arm64` / `win32-x64` / `linux-x64` 这类键）。
 *
 * **2026-09-25 改造：优先 Host 事实，去掉 `python3` 探针。**
 *
 * 旧实现一上来就跑 `python3 -c 'import sys,platform; ...'`，理由是「清单里的 python3 是必需项，
 * 它一条就给出与清单同构的键」。这条链路的三个前提现在全都不成立：
 *
 * 1. 清单里**已经没有** `python3` 了 —— 技能脚本用的是 **DSH 自带 Python**，系统那一份不是依赖；
 * 2. 把系统 `python3` 当探针，等于让「插件包装配对不对」取决于系统装没装 Python：探不到就回退，
 *    于是同一台机器上「平台未识别」红不红取决于 PATH；
 * 3. 自带二进制属于**插件进程所在机器**（`bin/<平台>/` 就在包里），
 *    所以选平台只该看进程事实 `process.platform` + `process.arch`。
 *
 * 因此现在的顺序是：
 * 1. Host 事实（`process.platform` + `process.arch`）落在 `BUNDLED_BIN_PLATFORMS` 里 → 直接用它，
 *    **一次 shell 都不跑**；
 * 2. 否则跑**一次** `uname -sm`，只作为**执行世界诊断**（shell 可能通过 SSH / 容器跑在别的机器上）。
 *
 * **远程执行世界与插件本地的 packaged binary 不可混用**：`bin/<平台>/` 里的二进制属于插件进程
 * 所在的那台机器，审核链路只用**包内绝对路径**（`platform/command.ts`）。所以 `uname` 给出另一个
 * 受支持平台时也**不采纳**它 —— 采纳就会去认一份本机跑不起来的二进制；此时保留 Host 事实，
 * 由「平台不受支持」如实说出来。这正是不在本机装 PATH / 不搜 PATH 的配套约束。
 */

/** 把 `uname -sm` / `os-arch` 之类的输出规范成 `os-arch`。 */
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

/** Host 事实：插件进程所在机器的平台键。 */
export function hostPlatformKey(): string {
  return normalizePlatform(`${process.platform}-${process.arch}`)
}

/**
 * 探测平台；结果由调用方缓存（进程内一次即可）。
 *
 * `hostFact` 可注入是为了让测试确定性地覆盖「受支持 / 不受支持」两条分支，
 * 而不是依赖跑测试的那台机器（CI 上 Linux 与 Windows 各有一套事实）。
 */
export async function detectPlatform(ctx: Context, workdir?: string, hostFact: string = hostPlatformKey()): Promise<string> {
  // ① Host 事实就是包内二进制的那台机器：唯一口径，不跑任何子进程。
  if (binPlatformDir(hostFact) !== '') return hostFact

  // ② Host 事实不在受支持平台集合里：跑一次 `uname -sm` 做**执行世界诊断**。
  //    探测链里没有 python3，也没有 node —— 它们是否可用与本插件包的装配毫无关系。
  const line = await commandLine(ctx, 'uname -sm', {
    timeoutMs: 20_000,
    ...(workdir === undefined ? {} : { workdir }),
  })
  const probed = normalizePlatform(line)
  // 执行世界若落在受支持平台上（SSH / 容器到另一台机器），也**不采纳**：包内二进制不可跨机器混用。
  if (probed === '' || binPlatformDir(probed) !== '') return hostFact
  return probed
}

/** 平台是否为 Windows。 */
export function isWindowsPlatform(platform: string): boolean {
  return platform.startsWith('win32')
}
