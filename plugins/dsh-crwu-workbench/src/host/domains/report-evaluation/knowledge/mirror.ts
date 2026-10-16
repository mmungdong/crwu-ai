import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { text } from '../../../../shared/utils/value.ts'
import type { LookupAttempt } from '../../../../shared/contracts/valuation-project.ts'
import { knowledgeDigest } from './snapshot.ts'
import { resolveRoute, type CatalogFile, type KnowledgeCatalog } from './resolve.ts'
import type { KnowledgeRoute } from './route.ts'

/**
 * **身份已验证的本地镜像**（设计稿 §6.1 恢复阶梯的第 ④ 级）。
 *
 * 为什么单独成文件（并且替换掉旧的 `fallback.ts`）：
 *
 * - 旧形态把技能自带 `references/` 当生产降级来源 —— 那会让"知识库没读到"被一段
 *   技能发布时的副本悄悄掩盖，规范改了也没人知道。现在生产正文只来自业务库或**身份已验证**镜像。
 * - 目录名相符**不构成**身份证明：本机 `~/knowledge-中瑞世联业务业务知识库` 的
 *   `_manifest.json` 里 `spaceName` 是「中瑞世联评估审核知识库」（审核库）。所以判据只有
 *   manifest 的 `spaceName` 与期望业务库名**逐字相等**，且每个文件的字节 digest 对得上。
 * - 镜像根属于 Host 配置，**默认留空 = 不启用**；模型拿不到它，也提交不了。
 *
 * 这一层只读：不写镜像、不改 manifest、不因为"像"就放行。
 */

export interface MirrorConfig {
  /** 身份已验证的镜像根（绝对路径）；空串 = 不启用。 */
  mirrorRoot: string
  /** manifest 文件名（缺省 `_manifest.json`）。 */
  manifestFileName?: string
}

export interface MirrorDocument {
  /** 来源恒为身份已验证镜像（写进证据的稳定值）。 */
  source: 'verified-mirror'
  name: string
  /** 镜像根内的相对路径（**不是**绝对路径：模型可见结果里不许出现镜像根）。 */
  relativePath: string
  extension: string
  updatedAt: string
  bytes: Uint8Array
  digest: string
  mediaType: string
}

export interface MirrorOutcome {
  ok: boolean
  reasonKind: 'disabled' | 'identity' | 'digest' | 'missing' | 'unreadable' | ''
  reason: string
  routeId: string
  spaceName: string
  /** 镜像根（Host 内部事实；**不进**模型可见结果）。 */
  mirrorRoot: string
  documents: MirrorDocument[]
  attempts: LookupAttempt[]
}

interface MirrorManifestEntry {
  path: string
  digest: string
  updatedAt: string
  bytes: number | null
}

/** `sha256:<hex>` 或裸 hex → 统一成 `sha256:<hex>`；其它形状返回空串（不猜）。 */
function normalizeDigest(value: unknown): string {
  const raw = text(value).trim().toLowerCase()
  if (/^sha256:[0-9a-f]{64}$/.test(raw)) return raw
  if (/^[0-9a-f]{64}$/.test(raw)) return `sha256:${raw}`
  return ''
}

function stringOf(value: unknown): string {
  return text(value)
}

function relativeSegments(path: string): string[] | null {
  const raw = text(path).trim().replace(/\\/g, '/')
  if (raw === '' || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.includes('..')) return null
  return segments
}

function nameOf(segments: readonly string[]): string {
  return segments[segments.length - 1] ?? ''
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function foldersOf(paths: readonly string[]): string[] {
  const set = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) set.add(segments.slice(0, index).join('/'))
  }
  return [...set]
}

/** manifest 里的一条 entry → 目录树节点（路径、名称、后缀都由 manifest 给，不按本地文件猜）。 */
function entryToFile(entry: MirrorManifestEntry): CatalogFile | null {
  const segments = relativeSegments(entry.path)
  if (segments === null) return null
  const name = nameOf(segments)
  if (name === '') return null
  return {
    name,
    path: segments.join('/'),
    extension: extensionOf(name),
    updatedAt: entry.updatedAt,
    bytes: undefined,
    mediaType: '',
  }
}

function outcomeOf(route: KnowledgeRoute, input: Partial<MirrorOutcome> & { reasonKind: MirrorOutcome['reasonKind']; reason: string }): MirrorOutcome {
  return {
    ok: input.ok ?? false,
    reasonKind: input.reasonKind,
    reason: input.reason,
    routeId: route.routeId,
    spaceName: input.spaceName ?? '',
    mirrorRoot: input.mirrorRoot ?? '',
    documents: input.documents ?? [],
    attempts: input.attempts ?? [],
  }
}

/**
 * 尝试用本地镜像恢复一条路由。
 *
 * 四级判据全部要过：根目录已配置 → manifest 可读且 `spaceName` 逐字等于期望业务库名 →
 * 路由在镜像里解析到唯一候选 → 每个候选的字节 digest 与 manifest 一致。
 * 任一条不过就 `ok:false`，并如实给出 `reasonKind`（不许"像就当对"）。
 */
export async function loadVerifiedMirror(
  spec: KnowledgeRoute,
  expectedSpace: string,
  config: MirrorConfig,
): Promise<MirrorOutcome> {
  const root = text(config?.mirrorRoot).trim()
  const attempts: LookupAttempt[] = []
  const note = (channel: LookupAttempt['channel'], target: string, outcome: LookupAttempt['outcome'], detail: string): void => {
    attempts.push({ routeId: spec.routeId, channel, target, outcome, detail })
  }
  if (root === '') {
    note('mirror', '(未配置镜像根)', 'missing', '镜像未启用（mirrorRoot 为空）：不猜任何本地路径')
    return outcomeOf(spec, { reasonKind: 'disabled', reason: '镜像未启用（mirrorRoot 为空）', attempts })
  }
  if (!/^([A-Za-z]:[\\/]|[\\/])/.test(root) || root.split(/[\\/]+/).includes('..')) {
    note('mirror', root, 'unreadable', '镜像根必须是绝对路径且不含 `..`')
    return outcomeOf(spec, { reasonKind: 'unreadable', reason: `镜像根不是可用的绝对路径：${root}`, attempts, mirrorRoot: root })
  }

  const manifestFile = join(root, text(config.manifestFileName) || '_manifest.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    note('mirror', '(manifest)', 'unreadable', `镜像 manifest 读不到或不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    return outcomeOf(spec, { reasonKind: 'unreadable', reason: `镜像 manifest 读不到：${manifestFile}`, attempts, mirrorRoot: root })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    note('mirror', '(manifest)', 'unreadable', '镜像 manifest 不是对象')
    return outcomeOf(spec, { reasonKind: 'unreadable', reason: '镜像 manifest 不是对象', attempts, mirrorRoot: root })
  }
  const manifest = parsed as Record<string, unknown>
  const spaceName = stringOf(manifest.spaceName).trim()
  if (spaceName === '' || spaceName !== text(expectedSpace).trim()) {
    // 目录名像业务库不算身份证明：判据只有 manifest 里的 spaceName。
    note('mirror', spaceName === '' ? '(manifest 未声明 spaceName)' : spaceName, 'rejected-identity',
      `镜像空间不是期望的业务库（期望 ${text(expectedSpace).trim()}，实际 ${spaceName === '' ? '未声明' : spaceName}）：目录名相符不构成身份证明`)
    return outcomeOf(spec, {
      reasonKind: 'identity',
      reason: `镜像身份未通过：manifest.spaceName=${spaceName === '' ? '未声明' : spaceName}，期望 ${text(expectedSpace).trim()}`,
      attempts, spaceName, mirrorRoot: root,
    })
  }

  const rows = Array.isArray(manifest.entries) ? manifest.entries : []
  const byPath = new Map<string, MirrorManifestEntry>()
  const files: CatalogFile[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const segments = relativeSegments(stringOf(record.path))
    if (segments === null) continue
    const entry: MirrorManifestEntry = {
      path: segments.join('/'),
      digest: stringOf(record.digest),
      updatedAt: stringOf(record.updatedAt),
      bytes: typeof record.bytes === 'number' ? record.bytes : null,
    }
    const file = entryToFile(entry)
    if (file === null) continue
    byPath.set(entry.path, entry)
    files.push(file)
  }
  const catalog: KnowledgeCatalog = {
    spaceName,
    verified: true,
    files,
    folders: foldersOf([...byPath.keys()]),
    failures: [],
  }

  const resolution = resolveRoute(catalog, spec)
  attempts.push(...resolution.attempts.map((attempt) => ({ ...attempt, channel: 'mirror' as const })))
  if (resolution.state !== 'found' || resolution.documents.length === 0) {
    return outcomeOf(spec, {
      reasonKind: resolution.state === 'missing' ? 'missing' : 'unreadable',
      reason: `镜像里没有可用的这条路由（${resolution.state}）：${resolution.error}`,
      attempts, spaceName, mirrorRoot: root,
    })
  }

  const documents: MirrorDocument[] = []
  for (const document of resolution.documents) {
    const entry = byPath.get(document.path)
    if (entry === undefined) continue
    const target = join(root, ...document.path.split('/'))
    let bytes: Buffer
    let real = target
    try {
      real = await realpath(target)
      // 越界判据在 **realpath 之后**：镜像里的符号链接也不能把读取带出根范围。
      const realRoot = await realpath(root)
      if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        note('mirror', document.path, 'unreadable', '镜像条目的真实路径越出了镜像根')
        return outcomeOf(spec, { reasonKind: 'unreadable', reason: `镜像条目越界：${document.path}`, attempts, spaceName, mirrorRoot: root })
      }
      bytes = await readFile(real)
    } catch (error) {
      note('mirror', document.path, 'unreadable', `镜像文件读不到：${error instanceof Error ? error.message : String(error)}`)
      return outcomeOf(spec, { reasonKind: 'unreadable', reason: `镜像文件读不到：${document.path}`, attempts, spaceName, mirrorRoot: root })
    }
    const actual = knowledgeDigest(bytes)
    const expected = normalizeDigest(entry.digest)
    if (expected !== '' && expected !== actual) {
      note('mirror', document.path, 'rejected-digest', `字节与 manifest digest 不符（期望 ${expected}，实际 ${actual}）`)
      return outcomeOf(spec, {
        reasonKind: 'digest',
        reason: `镜像 hash 不符：${document.path}`,
        attempts, spaceName, mirrorRoot: root,
      })
    }
    if (entry.bytes !== null && entry.bytes !== bytes.length) {
      note('mirror', document.path, 'rejected-digest', `字节数与 manifest 不符（期望 ${entry.bytes}，实际 ${bytes.length}）`)
      return outcomeOf(spec, { reasonKind: 'digest', reason: `镜像字节数不符：${document.path}`, attempts, spaceName, mirrorRoot: root })
    }
    note('mirror', document.path, 'found', `身份与 digest 均通过：${actual}`)
    documents.push({
      source: 'verified-mirror',
      name: document.name,
      relativePath: document.path,
      extension: document.extension,
      updatedAt: entry.updatedAt,
      bytes: new Uint8Array(bytes),
      digest: actual,
      mediaType: '',
    })
  }

  if (documents.length === 0) {
    return outcomeOf(spec, { reasonKind: 'missing', reason: '镜像里没有可用的这条路由', attempts, spaceName, mirrorRoot: root })
  }
  return outcomeOf(spec, { ok: true, reasonKind: '', reason: '', attempts, spaceName, mirrorRoot: root, documents })
}

/** 解析后的镜像根（诊断用；`ok:false` 时为空串）。 */
export function mirrorRootOf(outcome: MirrorOutcome): string {
  return outcome.ok ? resolve(outcome.mirrorRoot) : ''
}
