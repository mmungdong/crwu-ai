/**
 * DSH Plugin Manager 的**薄适配**：把公开 API 收敛成稳定结论。
 *
 * 这里不保存任何业务状态、不认识界面、不认识持久化，也**不实现第二套包管理**：
 * profile 锁、桌面自带 pnpm、registry 回退计划、回滚、完整性与兼容性检查、日志
 * 全部由 Plugin Manager 拥有，本文件只做三件事：
 * 1. 用**固定**包名与固定优先源构造安装调用（Client / 调用方无法参与）；
 * 2. 把进度阶段与 `ChangeResult` 归一化成稳定分类（不含日志、诊断、registry 或异常原文）；
 * 3. 用 `listBundles()` 读出"磁盘事实"，供服务判断成功与恢复。
 */
import { valid } from 'semver'

import { UPDATE_PACKAGE_NAME, UPDATE_SOURCES } from '../../shared/update/consts.ts'
import type {
  ChangeResult,
  PluginInstallProgress,
  PluginInstallRequestId,
} from '@deepseek-ai/dsh-plugin-manager'
import type {
  DiskVersionFact,
  InstallOutcome,
  PluginManagerPort,
} from './types.ts'
import type { UpdateInstallErrorKind, UpdateInstallStage } from '../../shared/update/types.ts'

/**
 * 安装时显式优先的 registry：固定公共源表的首项（npmmirror）。
 *
 * 插件不自己实现 registry 回退 —— 这里只表达"先问国内镜像"，镜像没有或不可达时由
 * Plugin Manager 按它自己的安全计划尝试后备源。企业私有源不会走到这条路径
 * （授权阶段已经判定 `unsupported/enterprise-registry`）。
 */
const PREFERRED_INSTALL_REGISTRY: string = UPDATE_SOURCES[0].registryUrl

/** 固定的安装 spec：包名是常量，版本只能来自 Host 的授权候选。 */
export function installSpecOf(targetVersion: string): string {
  return `${UPDATE_PACKAGE_NAME}@${targetVersion}`
}

/**
 * 固定的安装 options。
 *
 * - `requestId` 由 Host 注入的工厂生成（取消要认它，且它只活在本次安装里）；
 * - `registry` 显式优先国内镜像；
 * - `enabled: true`：装完要生效，不能依赖别处默认值（默认值一变，profile 里就会多一个
 *   装了但不激活的包，而"等待重启"的语义也就不成立了）。
 *
 * 没有 `approvedBuilds`：本插件不替员工批准依赖构建脚本（要管理员处理，见设计 §10）。
 */
export function installOptionsOf(requestId: PluginInstallRequestId): {
  enabled: true
  requestId: PluginInstallRequestId
  registry: string
} {
  return { enabled: true, requestId, registry: PREFERRED_INSTALL_REGISTRY }
}

/** Plugin Manager 的进度阶段 → 界面可展示的离散阶段（没有百分比）。 */
export function installStageOf(phase: PluginInstallProgress['phase']): UpdateInstallStage {
  switch (phase) {
    case 'installing':
      // `installing` 是"pnpm 正在装"：包含取包，所以对外是"下载中"。
      return 'downloading'
    case 'applying':
      return 'installing'
    case 'cancelling':
      return 'cancelling'
  }
}

/** 失败归因：先看更具体的中断原因（兼容性 / 待批准脚本），再看 pnpm 的运行分类。 */
export function classifyInstallErrorKind(result: ChangeResult): UpdateInstallErrorKind {
  if (result.error?.code === 'incompatible-version') return 'incompatible-version'
  if ((result.packageResult?.incompatible?.length ?? 0) > 0) return 'incompatible-version'
  switch (result.packageResult?.kind) {
    case 'not-found':
    case 'no-matching-version':
      return 'not-found'
    case 'network':
      // Plugin Manager 已经按自己的计划试过所有允许的源，走到这里就是"源不可用"。
      return 'source-unavailable'
    case 'timeout':
      return 'timeout'
    case 'disk-full':
      return 'disk-full'
    case 'permission':
      return 'permission'
    case 'build-blocked':
      return 'build-blocked'
    case 'integrity':
      return 'integrity'
    default:
      break
  }
  // 有等待批准的构建脚本：同样属于"需要管理员处理依赖脚本"，不自动批准。
  if ((result.pendingBuilds?.length ?? 0) > 0) return 'build-blocked'
  return 'unknown'
}

/**
 * `ChangeResult` → 归一化结论。
 *
 * `overridden` 与任何不认识的 `application` 都**不是**成功：被更高优先级的配置覆盖时，
 * 我们无法证明重启后会运行目标版本，只能判 unknown（设计 §10「未分类失败」）。
 */
export function classifyChangeResult(result: ChangeResult): InstallOutcome {
  switch (result.application) {
    case 'applied':
    case 'restart-required':
      return { kind: 'ok', application: result.application }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'failed':
      return { kind: 'failed', reason: classifyInstallErrorKind(result) }
    default:
      // 含 `overridden`，也含上游将来新增的取值：一律不谎报成功。
      return { kind: 'unknown' }
  }
}

/**
 * 发起一次安装，并把结果收敛成稳定结论。
 *
 * `installBundle` 抛错时**不猜成功**：用同一个 requestId 问一次 `waitForInstall`；
 * 它返回 `null` 只说明"没有活动请求"（既不等于成功，也不等于取消），因此只能判 `unknown`。
 */
export async function installThroughManager(
  manager: PluginManagerPort,
  targetVersion: string,
  requestId: PluginInstallRequestId,
): Promise<InstallOutcome> {
  try {
    const result = await manager.installBundle(installSpecOf(targetVersion), installOptionsOf(requestId))
    return classifyChangeResult(result)
  } catch {
    try {
      const recovered = await manager.waitForInstall(requestId)
      return recovered === null ? { kind: 'unknown' } : classifyChangeResult(recovered)
    } catch {
      // 连结果都问不到：只能 unknown，绝不假设装上或取消。
      return { kind: 'unknown' }
    }
  }
}

/** 读出固定包在 profile 里的版本（磁盘事实）；读不出来与"确定没装"必须分开。 */
export async function readDiskVersion(manager: PluginManagerPort): Promise<DiskVersionFact> {
  let bundles: Awaited<ReturnType<PluginManagerPort['listBundles']>>
  try {
    bundles = await manager.listBundles()
  } catch {
    return { kind: 'unknown' }
  }
  const entry = bundles.find((bundle) => bundle.name === UPDATE_PACKAGE_NAME)
  // profile 里没有这个包，或者它没被装进 profile（由 dsh 自带提供）→ 磁盘上不是我们要的版本。
  if (entry === undefined || entry.installed !== true) return { kind: 'absent' }
  if (typeof entry.version !== 'string') return { kind: 'unknown' }
  const version = valid(entry.version)
  if (version === null) return { kind: 'unknown' }
  return { kind: 'installed', version }
}
