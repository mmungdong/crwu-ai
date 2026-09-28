/**
 * Host 端更新领域的内部类型（**不进线协议**）。
 *
 * 这里允许出现 registry 地址与失败归因：它们只在 Host 内部用于决策与脱敏诊断，
 * 到 Client 的只有 `src/shared/update/types.ts` 里的规范化字段。
 */
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginInstallCancellation,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginRegistries,
} from '@deepseek-ai/dsh-plugin-manager'

import type {
  UpdateCandidate,
  UpdateCheckState,
  UpdateInstallErrorKind,
  UpdateInstallState,
  UpdateSourceKind,
} from '../../shared/update/types.ts'
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
   * 每次调用都**重新确认当前政策**：重读 Plugin Manager 的 registry profile，并逐条重验候选自洽性
   * （未过期、`currentVersion` 与运行版本一致、`targetVersion` 是严格更高的稳定版）。
   * 这里只读 profile，**不重新请求 registry metadata**，也不刷新候选的有效期。
   *
   * 为什么不能只读缓存：`check()` 会复用 6 小时成功结果（按设计不再读 profile），
   * 而 profile 可能在这期间被切成企业私有源 —— 只读缓存就等于绕过了
   * 「企业私有源不进入自助安装」的政策。授权是安全出口，必须按**此刻**的政策重新判一次。
   *
   * 任何理由（dev / Plugin Manager 不可用 / 企业私有源 / 无法确认 / reader 抛错）都返回
   * `undefined`（fail closed）。
   */
  installableCandidate(): Promise<UpdateCandidate | undefined>
}

// ---------------------------------------------------------------------------
// 安装与恢复（Task 3）
// ---------------------------------------------------------------------------

/**
 * `~/.dsh/crwu-workbench.json` 顶层 `pluginUpdate` 的形状（设计 §7）。
 *
 * 只保存**恢复所需**的非敏感字段：没有 registry、requestId、pnpm 输出、Token 或命令 ——
 * 这份文件会被读到、也会被写回，往里放任何环境细节都是泄露面。
 */
export interface PersistedPluginUpdate {
  phase: 'installing' | 'awaiting-restart'
  fromVersion: string
  targetVersion: string
  startedAt: string
  /** 只在 `awaiting-restart` 出现：观察到磁盘已到目标版本的时刻。 */
  installedAt?: string
}

/**
 * `pluginUpdate` 的持久化端口：读、合并写入、清除。
 *
 * 三个方法都**不抛异常**：读不到就是"没有有效恢复记录"，写不进去就是 `false`
 * （安装服务据此在开始安装之前 fail closed）。
 */
export interface PluginUpdateStore {
  read(): Promise<PersistedPluginUpdate | undefined>
  write(record: PersistedPluginUpdate): Promise<boolean>
  /** 清除标记：让序列化后的顶层 `pluginUpdate` 真正消失，而不是覆盖整个文件。 */
  clear(): Promise<boolean>
}

/**
 * DSH Plugin Manager 的**公开方法**（`ctx.get('pluginManager')` 满足这个形状）。
 *
 * 只列本任务用到的四个：Task 4 负责接线，Task 3 只通过注入口工作。
 * profile 锁、pnpm、registry 回退、回滚、兼容性与日志全部由 Plugin Manager 拥有。
 */
export interface PluginManagerPort {
  listBundles(): Promise<BundleInfo[]>
  installBundle(spec: string, options: InstallBundleOptions): Promise<ChangeResult>
  waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>
  cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>
}

/**
 * 磁盘事实：固定包在 profile 里的版本。
 *
 * `unknown` 是**独立**的一档，不能并进 `absent` —— 「读不出来」与「确定没装」在恢复里
 * 指向不同结论（前者不能猜，后者是安装中断）。
 */
export type DiskVersionFact =
  | { readonly kind: 'installed'; readonly version: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' }

/** 一次安装调用的归一化结论：只有稳定分类，没有日志、诊断、registry 或异常原文。 */
export type InstallOutcome =
  | { readonly kind: 'ok'; readonly application: 'applied' | 'restart-required' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: UpdateInstallErrorKind }
  | { readonly kind: 'unknown' }

/** 安装服务的注入端口（Context / RPC / Client 都不在这里）。 */
export interface UpdateServicePorts {
  /** 当前运行版本（Host 构建常量 `PLUGIN_VERSION`）。 */
  version: string
  now: () => Date
  /** 请求 id 工厂：id 只活在当前进程内，不进持久化、不进 Client 状态。 */
  newRequestId: () => PluginInstallRequestId
  checker: UpdateChecker
  manager: PluginManagerPort
  store: PluginUpdateStore
  /** 审核任务活动（active 或 starting 都由上层折算成 true）。 */
  auditBusy: () => boolean
}

/** 每个 Host 插件实例一个安装服务。 */
export interface UpdateService {
  /** 当前安装/恢复结论（不触发任何调用）。 */
  status(): UpdateInstallState
  /** 安装 Host 自己已授权的候选：**不接受**版本、包名、registry 或命令参数。 */
  install(): Promise<UpdateInstallState>
  /** 取消当前活动安装；没有活动安装时什么都不做。 */
  cancel(): Promise<UpdateInstallState>
  /** 启动时的状态恢复：只读持久化与磁盘事实，绝不自动重装。 */
  recover(): Promise<UpdateInstallState>
  /** 把 Plugin Manager 的进度事件转交给当前任务（不匹配的 requestId 会被忽略）。 */
  acceptProgress(progress: PluginInstallProgress): void
}
