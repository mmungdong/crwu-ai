import { text } from '../../shared/utils/value.ts'

/**
 * 版本号比较。
 *
 * 为什么不用 semver 包：环境清单里的 `expect` 只用 `>=` / `>` / `<=` / `<` / `=` 加三段数字，
 * 而 `crwu --version` / `ossutil --version` 的输出还夹着无关文本（`Version: 1.7.19`）。
 * 自己解析更稳，也少一个依赖。行为与 legacy 的 `satisfies` 逐项一致，便于对照回归。
 */

export type VersionTuple = [number, number, number]

/** 从任意文本里抓出第一段 `x.y[.z]`；抓不到返回 null。 */
export function parseVersion(value: unknown): VersionTuple | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text(value))
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** 三段的字典序比较。 */
export function compareVersion(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export interface SatisfyVerdict {
  ok: boolean
  reason: string
}

/**
 * 判定 `actualText` 是否满足 `expect`。
 *
 * 约定（与 legacy 一致）：
 * - 空串或 `*` → 通过，不校验；`expect` 解析不出数字也视为「没有约束」，通过；
 * - 实际输出解析不出数字 → **失败**（装了但读不到版本，不能算通过）；
 * - 无操作符时按等号处理。
 */
export function satisfies(actualText: unknown, expect: unknown): SatisfyVerdict {
  const wanted = text(expect).trim()
  if (wanted === '' || wanted === '*') return { ok: true, reason: '' }
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(wanted)
  const operator = match?.[1] ?? '='
  const want = parseVersion(match?.[2] ?? wanted)
  if (want === null) return { ok: true, reason: '' }
  const got = parseVersion(actualText)
  if (got === null) return { ok: false, reason: '无法从命令输出解析出版本号' }
  const order = compareVersion(got, want)
  if (operator === '>=') return { ok: order >= 0, reason: order >= 0 ? '' : `低于期望 ${wanted}` }
  if (operator === '>') return { ok: order > 0, reason: order > 0 ? '' : `未高于 ${wanted}` }
  if (operator === '<=') return { ok: order <= 0, reason: order <= 0 ? '' : `高于期望 ${wanted}` }
  if (operator === '<') return { ok: order < 0, reason: order < 0 ? '' : `低于期望 ${wanted}` }
  return {
    ok: order === 0,
    reason: order === 0 ? '' : `与期望 ${wanted} 不一致（实际 ${text(actualText).trim()}）`,
  }
}
