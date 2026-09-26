import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { text } from '../../shared/utils/value.ts'

/**
 * 输入快照的**规范化序列化与指纹**。
 *
 * 为什么需要「规范化」而不是直接 `JSON.stringify`：同一份记录在两个不同进程/两次取数里
 * 键顺序可能不同（对象来自 CLI 的 JSON，键顺序由上游决定）。`JSON.stringify` 会保留插入顺序，
 * 于是**内容没变而指纹变了** —— 子代理据此判「资料更新过」就会误报，重审也会白跑一遍。
 * 排序键 + 固定缩进 + 末尾换行让「同样的内容」永远得到同样的字节，指纹才有意义。
 *
 * 只用于 Host 侧的输入快照与指纹；不进模型上下文（模型只看摘要）。
 */

/** 递归按键排序后的稳定 JSON（2 空格缩进 + 末尾换行）。 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}

function sortValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, JsonValue> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key])
    return out
  }
  // undefined / 函数 / symbol 在快照里没有意义：统一成 null，保证序列化不会静默丢键。
  return null
}

/** `sha256:<hex>` 短指纹：给模型看的 digest 与写进元数据的是同一个值。 */
export function digestOf(texts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of texts) hash.update(part)
  return `sha256:${hash.digest('hex')}`
}

/** 只要指纹、不回显原文的脱敏摘要（用于 `schemaCode` 这类基础设施标识）。 */
export function digestOnly(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  return digestOf([raw]).slice(0, 23)
}
