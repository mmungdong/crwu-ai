import { text } from '../../shared/utils/value.ts'

/** 从对象里按候选键顺序取第一个非空值。 */
export function pick(source: unknown, keys: string[]): unknown {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 把数组/字符串/数字都安全地收成数组。 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 把氚云返回的字段值收成可显示文本。
 *
 * 氚云同一个字段在不同接口里可能是字符串、数字，也可能是 `{ label }` / `{ name }` / `{ value }`
 * 这样的对象 —— 直接 `String()` 会得到 `[object Object]`，界面就废了。
 */
export function labelOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const inner = record.label ?? record.name ?? record.value ?? record.title
    return inner === undefined ? '' : String(inner)
  }
  return ''
}

/** 脱敏展示 AccessKeyId：只留头尾，中间打码；短于 8 位整体打码。 */
export function maskKey(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  if (raw.length <= 8) return '****'
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`
}
