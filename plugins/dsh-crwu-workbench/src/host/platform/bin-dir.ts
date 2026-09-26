import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWindowsPlatform } from './detect.ts'
import { packageRootFrom } from './package-root.ts'

/**
 * 插件自带的二进制目录：`<包根>/bin/<平台>/`。
 *
 * **为什么二进制要进包**：DSH 没有任何「把插件里的 bin 挂上 PATH」的机制，四条路都实测堵死 ——
 * `dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 `Config` 没有 env/PATH 入口、
 * `dsh-shell-env` 只接收 `DSH_*` 键（前缀校验会直接抛错）、`.env` 明确拒绝 `PATH`（文档原话
 * “export them instead”）。所以「员工零安装」只能靠插件自己按平台解析出绝对路径，
 * 而解析得到的前提是文件真的在包里（软链接进不了 npm 包，会被静默丢弃）。
 *
 * 目录名 `<os>-<arch>` 与环境清单里 `platforms` 的键、`normalizePlatform()` 的输出是**同一套**。
 *
 * 一个必须知道的边界：这里解析出的是**宿主**（插件进程所在机器）上的路径，而 shell 可能在别的
 * 执行世界（SSH/容器）里跑。两者不一致时自带二进制用不上，调用方必须继续回退到 PATH 查找 ——
 * 所以这些函数只返回「候选路径」，是否可用一律由调用方 `stat` 过再算数。
 */

/** 目前随包发布预编译包的平台。没有对应目录的平台一律回退 PATH。 */
export const BUNDLED_BIN_PLATFORMS = ['darwin-arm64', 'win32-x64'] as const

/** 包内平台目录名；平台不在发布范围内时返回空串。 */
export function binPlatformDir(platform: unknown): string {
  const key = String(platform ?? '')
  return (BUNDLED_BIN_PLATFORMS as readonly string[]).includes(key) ? key : ''
}

/** 该平台下某个二进制的文件名（Windows 带 `.exe`）。 */
export function binaryFileName(name: string, platform: unknown): string {
  return isWindowsPlatform(String(platform ?? '')) ? `${name}.exe` : name
}

/** `<包根>/bin/<平台>`；平台不受支持或定位不到包根时返回空串。 */
export function binDirFor(moduleUrl: string, platform: unknown): string {
  const dir = binPlatformDir(platform)
  if (dir === '') return ''
  const root = packageRootFrom(dirname(fileURLToPath(moduleUrl)))
  return root === '' ? '' : join(root, 'bin', dir)
}

/** 用**这份代码自己**的位置解析包内二进制目录（Host 运行时与源码测试都对）。 */
export function hostBinDir(platform: unknown): string {
  return binDirFor(import.meta.url, platform)
}

/** 包内某个二进制的候选绝对路径；平台不受支持时返回空串（调用方回退 PATH）。 */
export function bundledBinaryPath(platform: unknown, name: string): string {
  const dir = hostBinDir(platform)
  return dir === '' ? '' : join(dir, binaryFileName(name, platform))
}
