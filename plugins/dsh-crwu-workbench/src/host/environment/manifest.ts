import { DEFAULT_MANIFEST, type OssSpec } from './manifest-default.ts'

/**
 * 环境域的取值收窄。
 *
 * 2026-09-25 之前这里还住着「远程清单拉取与归一」：一份放在只读 OSS 上的 JSON 可以远程改写
 * 员工机器上认哪些二进制、装到哪儿。整条只读依赖下掉后它已删除 —— 现在清单只有内置一份
 * （`manifest-default.ts`），外部输入只剩 YAML（由 `config/yaml.ts` 校验）。
 *
 * 原来的 `quoteArg`（POSIX-only 引用）已经删除：平台引用只有一个出口，
 * 就是 `platform/shell.ts` 的 `shellQuote` —— 留着第二个引用函数就等于留着第二条绕过 Windows 的路。
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asTextArray(value: unknown): string[] {
  return asArray(value).map((item) => String(item ?? ''))
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** OSS 配置归一：`prefix` 去掉尾斜杠，`linkMode` 只认 public/signed，TTL 至少 1 秒。 */
export function normalizeOss(value: unknown, fallback: OssSpec = DEFAULT_MANIFEST.oss): OssSpec {
  const base = { ...fallback, ...asRecord(value) }
  const linkMode = String(base.linkMode ?? '')
  return {
    enabled: base.enabled === true,
    bucket: String(base.bucket ?? ''),
    endpoint: String(base.endpoint ?? ''),
    prefix: (String(base.prefix ?? '') || 'crwu/audit').replace(/\/+$/, ''),
    publicBaseUrl: String(base.publicBaseUrl ?? ''),
    ossutil: String(base.ossutil ?? '') || 'ossutil',
    probeCommand: String(base.probeCommand ?? ''),
    extraArgs: asTextArray(base.extraArgs),
    linkMode: linkMode === 'public' ? 'public' : 'signed',
    linkTtl: asNumber(base.linkTtl) > 0 ? Math.floor(asNumber(base.linkTtl)) : 3600,
    autoUpload: base.autoUpload !== false,
  }
}
