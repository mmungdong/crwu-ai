/**
 * 公开 registry 元数据的**有界读取**与版本提取。
 *
 * 这一层是外部输入边界，判据只有一条：宁可判定"这次检查失败"，也不接受任何来路不明的数据。
 * 因此：
 * - 请求地址由**固定包名 + 固定源地址**拼成，客户端/模型/profile 无法参与；
 * - 响应正文**边读边限**（1 MiB），不信任 `content-length`（它可以缺失，也可以谎报）；
 * - 超时用 `AbortController`，请求与正文读取共享同一个 signal；
 * - 只接受 `dist-tags.latest` 指向的**合法稳定版 SemVer**（预发布版本不进入候选）；
 * - 多源合并用标准 SemVer 比较，**不做字符串比较**（字符串比较会认为 `0.0.9` > `0.0.10`）；
 * - 只把规范化后的少量字段传给内部结果，原始 registry 文档读完即丢。
 */
import { compare, prerelease, valid } from 'semver'

import {
  UPDATE_MAX_RESPONSE_BYTES,
  UPDATE_PACKAGE_NAME,
  UPDATE_SOURCES,
  UPDATE_SUCCESS_TTL_MS,
} from '../../shared/update/consts.ts'
import type { UpdateCandidate, UpdateSourceKind } from '../../shared/update/types.ts'
import type {
  DiscoverLatestDeps,
  RegistryDeps,
  RegistryFetchResult,
  RegistryPackageMetadata,
  RegistrySourceOutcome,
  UpdateDiscovery,
  UpdateSource,
} from './types.ts'

/** 一个源的元数据地址：固定包名拼在固定源地址上，没有任何外部片段。 */
function metadataUrl(source: UpdateSource): string {
  return new URL(UPDATE_PACKAGE_NAME, source.registryUrl).href
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从原始文档里取出规范化字段；任何一条不满足就返回 null（调用方归类为 `invalid-metadata`）。
 *
 * "包名不一致"必须拒绝：registry 可能返回重定向后的别的包，甚至是一个同名的恶意文档。
 */
function parsePackageDocument(raw: unknown): RegistryPackageMetadata | null {
  if (!isRecord(raw)) return null
  if (raw.name !== UPDATE_PACKAGE_NAME) return null
  const distTags = raw['dist-tags']
  if (!isRecord(distTags)) return null
  const latest = distTags.latest
  if (typeof latest !== 'string') return null
  // 规范化：`valid` 同时负责"是不是合法 SemVer"，返回规范化后的版本串。
  const version = valid(latest)
  if (version === null) return null
  // 预发布（beta / rc / next 通道）不进候选：这一版只做正式版更新。
  if (prerelease(version) !== null) return null
  // 只看 `dist-tags.latest` 是不够的：还必须确认它**指向**的那个版本条目自身自洽
  // （设计文档 §5.2「对应版本的基本包信息，用于确认包名和版本」）。
  if (!hasConsistentVersionEntry(raw.versions, latest, version)) return null
  const publishedAt = parsePublishedAt(raw.time, version)
  return publishedAt === undefined
    ? { name: UPDATE_PACKAGE_NAME, version }
    : { name: UPDATE_PACKAGE_NAME, version, publishedAt }
}

/**
 * 校验 `versions[latest]` 自洽：条目必须是对象，`name` 精确等于固定包名，`version` 是合法稳定版，
 * 且规范化后与 `dist-tags.latest` 规范化后的版本相等。
 *
 * 只校验 latest 指向的**那一个**条目：不遍历 `versions`，也不看 description / dependencies /
 * dist / readme 等与"这次要装哪个版本"无关的字段 —— 那些字段既不需要也不该被相信。
 */
function hasConsistentVersionEntry(versions: unknown, rawLatest: string, latest: string): boolean {
  if (!isRecord(versions)) return false
  // registry 的 `versions` 键是规范化版本；`latest` 写成 `v0.0.11` 这类非规范形式时再退回原始键。
  const entry = versions[rawLatest] ?? versions[latest]
  if (!isRecord(entry)) return false
  if (entry.name !== UPDATE_PACKAGE_NAME) return false
  const declared = entry.version
  if (typeof declared !== 'string') return false
  const declaredVersion = valid(declared)
  if (declaredVersion === null) return false
  if (prerelease(declaredVersion) !== null) return false
  return declaredVersion === latest
}

/** `time[version]` 是可选字段：缺失或不可解析时只是没有发布时间，不影响版本结论。 */
function parsePublishedAt(time: unknown, version: string): string | undefined {
  if (!isRecord(time)) return undefined
  const value = time[version]
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return new Date(timestamp).toISOString()
}

/**
 * 读取正文并在**超过上限的瞬间**停止。
 *
 * 返回 `null` 表示超限（调用方归类为 `too-large`）。这里不使用 `content-length`：
 * 缺头部的分块响应与谎报的小值都会绕过那条判据。
 */
async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array | null> {
  const body = response.body
  if (body === null) {
    const buffer = await response.arrayBuffer()
    return buffer.byteLength > limit ? null : new Uint8Array(buffer)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      total += value.byteLength
      if (total > limit) {
        // 取消失败不影响结论（我们已经不再读它了）：只要不再继续累积字节即可。
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function decodeJson(bytes: Uint8Array): unknown {
  // `TextDecoder` 默认丢弃 BOM，registry 返回带 BOM 的正文时不至于被误判成非法 JSON。
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * 读取一个公开源的 `dist-tags.latest`。
 *
 * 失败不是异常：返回结构化的 `ok:false`，让上层（缓存、退避、界面文案）自己决定怎么说。
 */
export async function fetchRegistryPackage(
  source: UpdateSource,
  deps: RegistryDeps,
): Promise<RegistryFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), source.timeoutMs)
  try {
    const response = await deps.fetch(metadataUrl(source), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { ok: false, failure: { kind: 'http', status: response.status } }
    const bytes = await readBoundedBody(response, UPDATE_MAX_RESPONSE_BYTES)
    if (bytes === null) return { ok: false, failure: { kind: 'too-large' } }
    let raw: unknown
    try {
      raw = decodeJson(bytes)
    } catch {
      // JSON.parse 的异常到这里就结束了：正文已经完整读到内存，重试读没有意义。
      return { ok: false, failure: { kind: 'invalid-json' } }
    }
    const metadata = parsePackageDocument(raw)
    if (metadata === null) return { ok: false, failure: { kind: 'invalid-metadata' } }
    return { ok: true, metadata, fetchedAt: deps.now().toISOString() }
  } catch {
    // 只看 abort 标记：超时（上游没回）与网络故障（连接失败）必须分开，界面提示与重试策略不同。
    return { ok: false, failure: controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' } }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 并列时的展示优先级：以固定公共源的声明顺序为准（npmmirror 在前）。
 *
 * 这样"优先镜像"这条规则只有一个事实源 —— `UPDATE_SOURCES`；调用方传入的数组顺序影响不了它。
 */
function sourceRank(kind: UpdateSourceKind): number {
  const index = UPDATE_SOURCES.findIndex((source) => source.kind === kind)
  return index === -1 ? UPDATE_SOURCES.length : index
}

/** 在成功的源里挑出最高版本；版本相同时按 `sourceRank` 决定展示来源。 */
function pickHighest(outcomes: readonly RegistrySourceOutcome[]): RegistrySourceOutcome | undefined {
  let best: RegistrySourceOutcome | undefined
  for (const outcome of outcomes) {
    if (outcome.latestVersion === undefined) continue
    if (best?.latestVersion === undefined) {
      best = outcome
      continue
    }
    const ordering = compare(outcome.latestVersion, best.latestVersion)
    if (ordering > 0 || (ordering === 0 && sourceRank(outcome.kind) < sourceRank(best.kind))) {
      best = outcome
    }
  }
  return best
}

/**
 * 并行检查所有允许的公共源，合并出唯一的更新候选。
 *
 * 合并规则（设计文档 §5.2）：
 * - 一个源失败**不抹掉**另一个源的成功结果；
 * - 取成功结果里更高的合法 SemVer；相同时把 npmmirror 作为展示来源；
 * - 目标版本必须**严格高于**当前版本，否则不产生候选（绝不降级）；
 * - 当前版本不是合法 SemVer 时不产生候选（fail closed：宁可让用户看到"已是最新/未知"，
 *   也不给他一个可能把 profile 改坏的安装目标）。
 */
export async function discoverLatestVersion(
  currentVersion: string,
  deps: DiscoverLatestDeps,
): Promise<UpdateDiscovery> {
  const checkedAt = deps.now()
  const sources = deps.sources ?? UPDATE_SOURCES
  const outcomes = await Promise.all(
    sources.map(async (source): Promise<RegistrySourceOutcome> => {
      const result = await fetchRegistryPackage(source, { fetch: deps.fetch, now: () => checkedAt })
      if (!result.ok) return { kind: source.kind, failure: result.failure }
      return result.metadata.publishedAt === undefined
        ? { kind: source.kind, latestVersion: result.metadata.version }
        : {
            kind: source.kind,
            latestVersion: result.metadata.version,
            publishedAt: result.metadata.publishedAt,
          }
    }),
  )

  const current = valid(currentVersion)
  const best = pickHighest(outcomes)
  if (current === null || best?.latestVersion === undefined || compare(best.latestVersion, current) <= 0) {
    return { sources: outcomes }
  }

  const candidate: UpdateCandidate = {
    currentVersion: current,
    targetVersion: best.latestVersion,
    sourceKind: best.kind,
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + UPDATE_SUCCESS_TTL_MS).toISOString(),
  }
  if (best.publishedAt !== undefined) candidate.publishedAt = best.publishedAt
  return { candidate, sources: outcomes }
}
