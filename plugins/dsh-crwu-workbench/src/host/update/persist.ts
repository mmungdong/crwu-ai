/**
 * `pluginUpdate` 的持久化：解析、读取、合并写入、清除。
 *
 * 复用现有的 `readWorkbenchConfigResult()` / `writeWorkbenchConfig()`（`~/.dsh/crwu-workbench.json`），
 * **不另建状态文件**，也**不整体覆盖**：那份文件里同时住着工作空间选择、凭据授权与审核记录，
 * 覆盖写会把它们一起抹掉。
 *
 * 这一层只做四件事，不认识安装流程，也不认识 Plugin Manager。
 */
import { gt, valid } from 'semver'

import { readWorkbenchConfigResult, writeWorkbenchConfig } from '../state/persist.ts'
import type { ConfigRead } from '../state/persist.ts'
import type { PersistedPluginUpdate, PluginUpdateStore } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 顶层字段名：单一事实源，解析与写入都用它。 */
export const PLUGIN_UPDATE_KEY = 'pluginUpdate'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 合法 SemVer → 规范化形式；不合法返回 undefined。 */
function normalizedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return valid(value) ?? undefined
}

/**
 * 状态文件里的时间契约：**带明确时区的 ISO 8601 date-time**。
 *
 * 只认"日期 + `T` + 时间 + 时区（`Z` 或 ±HH:MM／±HHMM）"这一种结构。
 * 为什么不能用 `Date.parse` 一把梭：它会接受 `September 28 2026`、`2026-09-28`、`'0'`
 * 这类平台相关的宽松格式，还会把 `2026-02-31` 悄悄滚到 3 月 3 日 —— 状态文件是契约，
 * 不是尽力而为的输入框。
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/

/** 日期必须真实存在（含闰年）：`Date.UTC` 会把 2 月 31 日滚到下个月，这里先挡掉。 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  )
}

/** 严格 ISO date-time → `toISOString()` 规范化形式；任何不合格都返回 undefined（不抛异常）。 */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = ISO_DATE_TIME.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  // 秒可以省略（ISO 允许 `hh:mm`），省略时按 0 处理。
  const second = match[6] === undefined ? 0 : Number(match[6])
  if (!isRealCalendarDate(year, month, day)) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return new Date(timestamp).toISOString()
}

/**
 * 严格解析顶层 `pluginUpdate`。
 *
 * 任何不合格都返回 `undefined`（"没有有效恢复记录"），**绝不抛异常**：
 * 状态文件坏掉不能让面板或启动流程跟着炸；按设计，无法确认的安装状态就是不自动重装。
 */
export function parsePluginUpdate(config: unknown): PersistedPluginUpdate | undefined {
  if (!isRecord(config)) return undefined
  const raw = config[PLUGIN_UPDATE_KEY]
  if (!isRecord(raw)) return undefined
  const phase = raw.phase
  if (phase !== 'installing' && phase !== 'awaiting-restart') return undefined
  const fromVersion = normalizedVersion(raw.fromVersion)
  const targetVersion = normalizedVersion(raw.targetVersion)
  if (fromVersion === undefined || targetVersion === undefined) return undefined
  // 目标必须严格更高：否则这条记录要么写坏了，要么是人为构造的（拿它去恢复等于允许降级）。
  if (!gt(targetVersion, fromVersion)) return undefined
  const startedAt = isoTime(raw.startedAt)
  if (startedAt === undefined) return undefined
  if (phase === 'installing') {
    // `installing` 阶段磁盘还没改，不该有完成时间；有就是伪造/写坏。
    if (raw.installedAt !== undefined) return undefined
    return { phase, fromVersion, targetVersion, startedAt }
  }
  const installedAt = isoTime(raw.installedAt)
  if (installedAt === undefined) return undefined
  return { phase, fromVersion, targetVersion, startedAt, installedAt }
}

/** 写入补丁：只带 `pluginUpdate` 一个键，其余字段由 `writeWorkbenchConfig` 的合并写保留。 */
export function pluginUpdatePatch(record: PersistedPluginUpdate): Record<string, unknown> {
  const value: Record<string, unknown> = {
    phase: record.phase,
    fromVersion: record.fromVersion,
    targetVersion: record.targetVersion,
    startedAt: record.startedAt,
  }
  if (record.installedAt !== undefined) value.installedAt = record.installedAt
  return { [PLUGIN_UPDATE_KEY]: value }
}

/**
 * 清除补丁。
 *
 * 值为 `undefined` 的属性会被 `JSON.stringify` **整键省略**，所以合并写入之后顶层不再有
 * `pluginUpdate` —— 这是"删掉一个键"而不动其它字段的唯一办法（不能整体覆盖写）。
 */
export function clearPluginUpdatePatch(): Record<string, unknown> {
  return { [PLUGIN_UPDATE_KEY]: undefined }
}

/** 持久化的底层读写（测试注入内存替身，Task 4 注入真实 ctx + home）。 */
export interface PluginUpdateIo {
  readConfig(): Promise<ConfigRead>
  writeConfig(patch: Record<string, unknown>): Promise<boolean>
}

/** 实例级 store：读不到就是没有记录，写不进去就是 false，一律不抛给调用方。 */
export function createPluginUpdateStore(io: PluginUpdateIo): PluginUpdateStore {
  return {
    async read() {
      try {
        const current = await io.readConfig()
        // 读失败（ok=false）不能当成"没有记录"去覆盖写，但也不该让调用方崩：返回 undefined。
        if (!current.ok) return undefined
        return parsePluginUpdate(current.value)
      } catch {
        // 读盘异常（fs 服务异常等）：按"没有有效恢复记录"处理，安装流程据此什么都不做。
        return undefined
      }
    },
    async write(record) {
      try {
        return await io.writeConfig(pluginUpdatePatch(record))
      } catch {
        return false
      }
    },
    async clear() {
      try {
        return await io.writeConfig(clearPluginUpdatePatch())
      } catch {
        return false
      }
    },
  }
}

/**
 * Task 4 的接线：把真实 `ctx` + home 变成 store。
 *
 * 复用现有合并写入，不给状态文件开第二条写路径。
 */
export function pluginUpdateStoreOf(ctx: Context, home: string): PluginUpdateStore {
  return createPluginUpdateStore({
    readConfig: () => readWorkbenchConfigResult(ctx, home),
    writeConfig: (patch) => writeWorkbenchConfig(ctx, home, patch),
  })
}
