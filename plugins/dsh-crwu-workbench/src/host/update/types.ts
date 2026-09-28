/**
 * Host 端更新领域的内部类型（**不进线协议**）。
 *
 * 这里允许出现 registry 地址与失败归因：它们只在 Host 内部用于决策与脱敏诊断，
 * 到 Client 的只有 `src/shared/update/types.ts` 里的规范化字段。
 */
import type { PluginRegistries } from '@deepseek-ai/dsh-plugin-manager'

import type { UpdateCandidate, UpdateCheckState, UpdateSourceKind } from '../../shared/update/types.ts'
import type { UpdateSourceDescriptor } from '../../shared/update/consts.ts'
import type { HostBuildKind } from '../build-info.ts'

/** 一个可请求的公开源；形状由 `shared/update/consts.ts` 的固定常量决定。 */
export type UpdateSource = UpdateSourceDescriptor

export interface UpdateFetchInit {
  signal: AbortSignal
  headers: Record<string, string>
}

/**
 * 注入口的 fetch：只有这个签名会被用到，测试可以直接替换它。
 *
 * 真实实现就是全局 `fetch`（TLS 正常校验）：这里**不提供**任何"关闭校验"的开关。
 */
export type UpdateFetch = (url: string, init: UpdateFetchInit) => Promise<Response>

/** 取数与时钟都靠注入：单元测试不得访问公网，也不得依赖真实时间。 */
export interface RegistryDeps {
  fetch: UpdateFetch
  now: () => Date
}

/** registry 响应里被**接受**的规范化字段（原始文档到此为止，不再往下传）。 */
export interface RegistryPackageMetadata {
  name: string
  version: string
  publishedAt?: string
}

export type RegistryFailureKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-json'
  | 'invalid-metadata'
  | 'too-large'

export interface RegistryFailure {
  kind: RegistryFailureKind
  /** 仅 `http` 失败带状态码，用于区分"没有这个包"和"上游故障"。 */
  status?: number
}

export type RegistryFetchResult =
  | { ok: true; metadata: RegistryPackageMetadata; fetchedAt: string }
  | { ok: false; failure: RegistryFailure }

/** 单个源的结果摘要：成功给版本，失败给归因；原始元数据一律不保留。 */
export interface RegistrySourceOutcome {
  kind: UpdateSourceKind
  latestVersion?: string
  publishedAt?: string
  failure?: RegistryFailure
}

export interface UpdateDiscovery {
  /** 只有"严格高于当前版本"的合法稳定版才产生候选。 */
  candidate?: UpdateCandidate
  sources: RegistrySourceOutcome[]
}

export interface DiscoverLatestDeps extends RegistryDeps {
  /** 缺省用固定公共源；测试可注入自定义源以覆盖超时与合并顺序。 */
  sources?: readonly UpdateSource[]
}

/**
 * 注入的发现函数：入参只有"当前版本"，**不接受**包名、registry、源列表或版本区间。
 *
 * 缺省实现是 Task 1 的 `discoverLatestVersion`（固定 npmmirror + npm 两个公共源）；
 * 测试注入替身，因此单元测试不访问公网。
 */
export type UpdateDiscoveryFn = (currentVersion: string) => Promise<UpdateDiscovery>

/**
 * 检查器的注入端口。
 *
 * **不依赖 Context**：这里没有 `ctx.get(...)`，Cordis 接线留给后续任务。
 * `registries` 缺失（服务不在）与 `buildKind === 'dev'` 都是"不支持自助更新"，而不是失败。
 */
export interface UpdateCheckPorts {
  /** 当前运行版本（Host 构建常量）。来自请求的版本值不参与任何判断。 */
  version: string
  /** 源码检出（`dev`）不参与自助更新，避免 npm 包覆盖开发中的 link/file 安装。 */
  buildKind: HostBuildKind
  now: () => Date
  /** Plugin Manager 的 `registries()`；缺失即 manager-unavailable。 */
  registries?: () => Promise<PluginRegistries>
  /** discovery 注入点；缺省用 Task 1 的固定两源发现。 */
  discover?: UpdateDiscoveryFn
}

export interface UpdateCheckOptions {
  /** 用户手动"检查更新"：绕过成功缓存与失败退避，但**不绕过** dev / manager / 私有源限制。 */
  force?: boolean
}

/** 每个 Host 插件实例一个检查器：缓存、退避与单飞都是实例状态。 */
export interface UpdateChecker {
  /** 当前结论（不触发任何上游请求）。 */
  status(): UpdateCheckState
  /**
   * 自动或手动检查。
   *
   * 并发调用共享同一次上游往返（单飞）；自动检查复用 6 小时内的成功结果，并在失败后
   * 10 分钟内不再访问上游。
   */
  check(options?: UpdateCheckOptions): Promise<UpdateCheckState>
  /**
   * 当前**仍可授权安装**的候选（供安装服务使用）。
   *
   * 判据是此刻重新核对 `expiresAt`：过期候选只能作历史展示，不能授权安装。
   */
  installableCandidate(): UpdateCandidate | undefined
}
