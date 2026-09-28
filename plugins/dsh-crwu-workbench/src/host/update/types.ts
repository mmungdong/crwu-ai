/**
 * Host 端更新领域的内部类型（**不进线协议**）。
 *
 * 这里允许出现 registry 地址与失败归因：它们只在 Host 内部用于决策与脱敏诊断，
 * 到 Client 的只有 `src/shared/update/types.ts` 里的规范化字段。
 */
import type { UpdateCandidate, UpdateSourceKind } from '../../shared/update/types.ts'
import type { UpdateSourceDescriptor } from '../../shared/update/consts.ts'

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
