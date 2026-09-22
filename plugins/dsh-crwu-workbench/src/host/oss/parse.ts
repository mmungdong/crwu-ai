import { text } from '../../shared/utils/value.ts'

/**
 * OSS 对象路径与命令输出的解析。
 *
 * 全是从动态形态实现搬过来的纯函数（该形态已删除，见 `PORTING.md`），但每一条都对应一个真实坑：
 * - `ossutil ls` 的输出既可能是 `oss://bucket/key` 也可能是裸路径，两种都要认；
 * - `stripPrefix` 是**唯一**的越界判据：所有按 key 读/签名的接口都先过它，
 *   不过它就能读任意 bucket 里的任意对象；
 * - 签名 URL 只能从输出里挑 `http(s)://` 那一行，命令还会打进度与统计。
 */

/** 去掉前缀，返回相对 key；不在前缀内返回空串（= 越界）。 */
export function stripPrefix(key: unknown, prefix: unknown): string {
  const cleanPrefix = text(prefix).replace(/^\/+|\/+$/g, '')
  const raw = text(key)
  if (cleanPrefix === '') return raw
  if (raw === cleanPrefix) return ''
  if (raw.startsWith(`${cleanPrefix}/`)) return raw.slice(cleanPrefix.length + 1)
  return ''
}

/** key 的最后一段（交付件文件名）。 */
export function fileNameOf(key: unknown): string {
  const parts = text(key).split('/')
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : ''
}

/**
 * 解析 `ossutil ls` 的输出为 key 列表。
 *
 * 只认带 `oss://` 的行：命令行还会打印汇总（`Object Number is: 3`、耗时统计），
 * 把那些当 key 会产生幽灵条目。
 */
export function parseLsObjects(output: unknown, bucket: string): string[] {
  const keys: string[] = []
  const prefix = `oss://${bucket}/`
  for (const line of text(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let key = ''
    if (trimmed.startsWith(prefix)) {
      key = trimmed.slice(prefix.length)
    } else if (trimmed.startsWith('oss://')) {
      const rest = trimmed.slice('oss://'.length)
      const at = rest.indexOf('/')
      if (at < 0) continue
      key = rest.slice(at + 1)
    } else {
      continue
    }
    if (key !== '') keys.push(key)
  }
  return keys
}

/**
 * `ossutil ls` **长格式**的一行：`LastModifiedTime / Size(B) / StorageClass / ETAG / ObjectName`。
 *
 * 用户口径（2026-09-23）：「oss 一次可以查询一个目录下有多少个文件」——
 * ossutil 的 `ls` **默认就是长格式**（只有 `--short-format` 才只剩 key），
 * 也就是说**一次列举**就能同时拿到：对象个数、每个对象的大小、最后写入时间、**ETag**。
 * 这三样正是"审核结果有没有重新生成过"的客观依据，所以这里按长格式解析，
 * 不再给自己加 `--short-format` 把信息丢掉。
 *
 * 时区段在不同版本/语言下可能是 `+0800`、`+0000 CST` 或 `Z`，所以这里不逐字匹配它，
 * 只用"时间 → 一堆非空字段 → 数字大小 → 存储类型 → ETag → 对象名"这个骨架。
 */
export interface OssEntry {
  key: string
  /** 字节数；读不出为 0。 */
  size: number
  /** `YYYY-MM-DD HH:MM:SS`（**取字面量，不做时区换算**，与业务时间口径一致）。 */
  lastModified: string
  /** 对象 ETag（单段上传即内容 MD5；分片上传带 `-N` 后缀）。 */
  etag: string
}

const LS_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+.*?\s+(\d+)\s+(\S+)\s+([0-9A-Fa-f-]{8,})\s+(\S+)\s*$/

/** 从长格式输出里解析出带元数据的对象清单；认不出的行**跳过**（表头、汇总、告警都不算对象）。 */
export function parseLsEntries(output: unknown, bucket: string): OssEntry[] {
  const entries: OssEntry[] = []
  for (const line of text(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const matched = LS_LINE.exec(trimmed)
    if (matched === null) continue
    const [, lastModified, size, , etag, name] = matched
    const key = keyOfObjectToken(name, bucket)
    if (key === '') continue
    const bytes = Number.parseInt(size, 10)
    entries.push({
      key,
      size: Number.isFinite(bytes) ? bytes : 0,
      lastModified,
      etag: etag.toLowerCase(),
    })
  }
  return entries
}

/** 对象名那一列 → key（既认 `oss://bucket/key` 也认裸 key；越出该 bucket 的丢掉）。 */
function keyOfObjectToken(token: unknown, bucket: string): string {
  const raw = text(token)
  if (raw === '') return ''
  const prefix = `oss://${bucket}/`
  if (raw.startsWith(prefix)) return raw.slice(prefix.length)
  if (raw.startsWith('oss://')) return ''
  return raw
}

/** 保留老的"只要 key"接口：签名/校验等只需要 key 的地方继续用它。 */
export function keysOfEntries(entries: readonly OssEntry[]): string[] {
  return entries.map((entry) => entry.key)
}

/** 从 `ossutil sign` 的输出里挑出 URL；挑不到返回空串。 */
export function parseSignUrl(output: unknown): string {
  for (const line of text(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
  }
  return ''
}

/** 把 key 逐段编码后接到 base URL 上。 */
export function joinUrl(base: unknown, key: unknown): string {
  const clean = text(base).replace(/\/+$/, '')
  if (clean === '') return ''
  const encoded = text(key).split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${clean}/${encoded}`
}

export interface OssFile {
  key: string
  name: string
  /** 长格式才有：字节数。 */
  size?: number
  /** 长格式才有：`YYYY-MM-DD HH:MM:SS`（字面量，不做时区换算）。 */
  lastModified?: string
  /** 长格式才有：对象 ETag（单段上传即内容 MD5）。 */
  etag?: string
}

export interface OssItem {
  seqNo: string
  files: OssFile[]
  htmlKey: string
  jsonKey: string
}

/**
 * 把对象清单按流水号归并。
 *
 * 只认**规范交付件名**（`审核意见.<流水号>.html` / `审核结果.<流水号>.json`）填 htmlKey/jsonKey，
 * 其它文件只作为附件列出 —— 否则辅助文件（`.before-` 备份、中间产物）会被当成正式结果。
 */
export function groupObjects(
  entries: ReadonlyArray<string | OssEntry>,
  prefix: string,
): Record<string, OssItem> {
  const items: Record<string, OssItem> = {}
  for (const entry of entries) {
    const key = typeof entry === 'string' ? entry : entry.key
    const seq = seqNoFromObjectKey(key, prefix)
    if (seq === '') continue
    const item = items[seq] ?? { seqNo: seq, files: [], htmlKey: '', jsonKey: '' }
    items[seq] = item
    const name = fileNameOf(key)
    // 长格式下把"大小 / 最后写入时间 / ETag"一起带上：上层据此判"审核结果是否重新生成过"。
    if (typeof entry === 'string') item.files.push({ key, name })
    else item.files.push({ key, name, size: entry.size, lastModified: entry.lastModified, etag: entry.etag })
    if (name === `审核意见.${seq}.html`) item.htmlKey = key
    else if (name === `审核结果.${seq}.json`) item.jsonKey = key
  }
  return items
}

/** 从对象 key 反推流水号：`<prefix>/<流水号>/<文件名>`。 */
export function seqNoFromObjectKey(key: unknown, prefix: unknown): string {
  const relative = stripPrefix(key, prefix)
  if (relative !== '') {
    const segments = relative.split('/').filter(Boolean)
    const candidate = segments[2]
    if (segments.length >= 3 && candidate !== undefined && /^\d{4}-\d+-/.test(candidate)) return candidate
  }
  // 前缀没配对（清单换过前缀）时退一步：扫整条 key 里的流水号形状。
  for (const segment of text(key).split('/').filter(Boolean)) {
    if (/^\d{4}-\d+-/.test(segment)) return segment
  }
  return ''
}

/** 交付件对象名：`审核意见.<流水号>.html` / `审核结果.<流水号>.json`。 */
export function isResultJson(key: unknown): boolean {
  return /\.json$/i.test(text(key))
}
