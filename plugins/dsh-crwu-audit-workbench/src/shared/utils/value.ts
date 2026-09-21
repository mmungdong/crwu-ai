/** 将可空外部值转换为稳定字符串。 */
export function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 只接受有限数值，否则返回零。 */
export function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
