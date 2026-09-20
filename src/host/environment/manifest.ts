import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import { runShell } from '../shell/run.ts'
import {
  DEFAULT_MANIFEST,
  type BinarySpec,
  type EnvManifest,
  type IfindKeySpec,
  type OssSpec,
  type PlatformEntry,
  type ServiceSpec,
} from './manifest-default.ts'

/** 把 `expect` 里用到的字段都收成稳定类型：远程清单是外部输入，一处收窄、全程可信。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asTextArray(value: unknown): string[] {
  return asArray(value).map((item) => text(item))
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 单引号安全引用；需要时包一层 shell 引用，避免清单地址里的特殊字符被解释。 */
export function quoteArg(value: unknown): string {
  const raw = String(value)
  if (raw.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(raw)) return raw
  return `'${raw.split("'").join("'\\''")}'`
}

/** OSS 配置归一：`prefix` 去掉尾斜杠，`linkMode` 只认 public/signed，TTL 至少 1 秒。 */
export function normalizeOss(value: unknown, fallback: OssSpec = DEFAULT_MANIFEST.oss): OssSpec {
  const base = { ...fallback, ...asRecord(value) }
  const linkMode = text(base.linkMode)
  return {
    enabled: base.enabled === true,
    bucket: text(base.bucket),
    endpoint: text(base.endpoint),
    prefix: (text(base.prefix) || 'crwu/audit').replace(/\/+$/, ''),
    publicBaseUrl: text(base.publicBaseUrl),
    ossutil: text(base.ossutil) || 'ossutil',
    probeCommand: text(base.probeCommand),
    extraArgs: asTextArray(base.extraArgs),
    linkMode: linkMode === 'public' ? 'public' : 'signed',
    linkTtl: asNumber(base.linkTtl) > 0 ? Math.floor(asNumber(base.linkTtl)) : 3600,
    autoUpload: base.autoUpload !== false,
  }
}

function normalizeBinary(entry: unknown): BinarySpec {
  const base = asRecord(entry)
  const versionArgs = asTextArray(base.versionArgs)
  const platforms = base.platforms !== null && typeof base.platforms === 'object'
    ? asRecord(base.platforms) as unknown as Record<string, PlatformEntry>
    : null
  return {
    name: text(base.name),
    command: text(base.command) || text(base.name),
    versionArgs: versionArgs.length > 0 ? versionArgs : ['version'],
    expect: text(base.expect),
    url: text(base.url),
    sha256: text(base.sha256),
    target: text(base.target),
    archive: text(base.archive),
    member: text(base.member),
    platforms,
    required: base.required !== false,
    note: text(base.note),
  }
}

function normalizeIfindKey(value: unknown): IfindKeySpec {
  const base = asRecord(value)
  const fallback = DEFAULT_MANIFEST.ifindKey
  if (Object.keys(base).length === 0) return fallback
  return {
    required: base.required !== false,
    path: text(base.path) || fallback.path,
    field: text(base.field) || 'auth_token',
    placeholder: text(base.placeholder) || 'your ifind-mcp key',
  }
}

function normalizeServices(value: unknown): ServiceSpec[] {
  const list = asArray(value)
  if (list.length === 0) return DEFAULT_MANIFEST.services
  return list.map((item) => {
    const base = asRecord(item)
    return { id: text(base.id), label: text(base.label), required: base.required !== false }
  })
}

/**
 * 归一远程清单。
 *
 * 关键约定：**空列表视为「没提供」而不是「什么都没有」** —— 远程清单少写一段 `binaries`
 * 时回退到内置默认，否则环境自检会静默变成「全部通过」。
 */
export function normalizeManifest(value: unknown, fallback: EnvManifest = DEFAULT_MANIFEST): EnvManifest {
  const base = asRecord(value)
  const binaries = asArray(base.binaries).map(normalizeBinary).filter((entry) => entry.name !== '')
  const workspace = asRecord(base.workspace)
  return {
    schema: text(base.schema) || fallback.schema,
    updatedAt: text(base.updatedAt),
    installDocUrl: text(base.installDocUrl) || fallback.installDocUrl,
    binaries: binaries.length > 0 ? binaries : fallback.binaries,
    ifindKey: normalizeIfindKey(base.ifindKey),
    services: normalizeServices(base.services),
    oss: normalizeOss(base.oss, fallback.oss),
    workspace: {
      preferTitle: text(workspace.preferTitle) || fallback.workspace.preferTitle,
      preferPath: text(workspace.preferPath) || fallback.workspace.preferPath,
    },
  }
}

export interface ManifestLoad {
  manifest: EnvManifest
  source: string
  /** `url` = 远程拉取；`invalid` = 地址不合法；`builtin` = 直接用了内置清单。 */
  kind: 'url' | 'invalid' | 'builtin'
  loaded: boolean
  error: string
}

/**
 * 加载环境清单。
 *
 * 本版**不在本地留清单数据**：只接受 http(s) 远程地址，用 `curl` 拉（走 DSH 的 shell，
 * 不绕过沙箱）。拉取失败、地址不合法、JSON 坏掉都回退内置清单，并把原因带回去 ——
 * 环境自检页面必须能显示「用的是哪份清单、为什么」。
 */
export async function loadManifest(
  ctx: Context,
  source: string,
  options: { workdir?: string } = {},
): Promise<ManifestLoad> {
  const url = text(source)
  if (url === '') {
    return {
      manifest: normalizeManifest(DEFAULT_MANIFEST),
      source: url,
      kind: 'builtin',
      loaded: false,
      error: '未配置清单地址，使用内置默认清单。',
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      manifest: normalizeManifest(DEFAULT_MANIFEST),
      source: url,
      kind: 'invalid',
      loaded: false,
      error: '清单地址必须是 http(s) 远程地址（本版不在本地留数据）；已回退到内置默认清单。',
    }
  }
  const run = await runShell(ctx, `curl -fsSL --max-time 25 ${quoteArg(url)}`, {
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    timeoutMs: 45_000,
    stdoutMaxBytes: 4 * 1024 * 1024,
  })
  if (!run.ok) {
    const detail = (run.stderr || run.error || '').slice(0, 300)
    return {
      manifest: normalizeManifest(DEFAULT_MANIFEST),
      source: url,
      kind: 'url',
      loaded: false,
      error: `远程清单拉取失败：${detail}（已回退到内置默认清单）`,
    }
  }
  // `parseJsonLoose` **返回 null 而不抛错**：原来这里靠 `JSON.parse` 抛异常来判失败，
  // 换成它以后必须显式判空，否则一份坏清单会被当成「已加载」（`loaded: true`）静默放行。
  const parsed = parseJsonLoose(run.stdout)
  if (parsed === null) {
    return {
      manifest: normalizeManifest(DEFAULT_MANIFEST),
      source: url,
      kind: 'url',
      loaded: false,
      error: '远程清单不是合法 JSON（已回退到内置默认清单）',
    }
  }
  return { manifest: normalizeManifest(parsed), source: url, kind: 'url', loaded: true, error: '' }
}

/** 按平台挑出某条目实际可用的下载信息；没有对应平台时返回空 url（调用方显示「暂无包」）。 */
export function resolvePlatformEntry(entry: BinarySpec, platform: string): PlatformEntry | null {
  const table = entry.platforms
  if (table === null) return null
  const os = text(platform).split('-')[0] ?? ''
  const chosen = table[platform] ?? (os === '' ? undefined : table[os]) ?? table.default
  return chosen ?? null
}

/** 把一个二进制条目按平台解析成「实际要下载/校验的东西」。 */
export function resolveBinary(entry: BinarySpec, platform: string): BinarySpec {
  const chosen = resolvePlatformEntry(entry, platform)
  if (chosen === null) {
    if (entry.platforms === null) return entry
    return { ...entry, url: '', sha256: '', archive: '', member: '', target: '' }
  }
  return {
    ...entry,
    url: text(chosen.url),
    sha256: text(chosen.sha256),
    target: text(chosen.target) || entry.target,
    archive: text(chosen.archive) || entry.archive,
    member: text(chosen.member) || entry.member,
  }
}
