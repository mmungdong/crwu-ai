import { randomUUID } from 'node:crypto'
import { canonicalJson, digestOf } from '../../tools/common/snapshot.ts'
import { WORKSPACE_CLEANUP_PLAN_TTL_MS } from './consts.ts'
import type {
  ScannedEntry, WorkspaceIdentity,
} from './types.ts'
import type {
  WorkspaceCleanupSession, WorkspaceCleanupTotals,
} from '../../../shared/contracts/workspace-cleanup.ts'

/**
 * 一次扫描产出的**不可变计划**：指纹 + 单次租约。
 *
 * 为什么计划只活在内存里：它代表"用户正在看的这份清单"。落盘会让进程重启后
 * 拿一份过期清单去删东西 —— 那正是需要重新扫描、重新确认的时刻。
 */
export interface CleanupPlan {
  planId: string
  digest: string
  expiresAt: number
  identity: WorkspaceIdentity
  entries: ScannedEntry[]
  sessions: WorkspaceCleanupSession[]
  totals: WorkspaceCleanupTotals
  notes: string[]
}

export type PlanTake =
  | { ok: true; plan: CleanupPlan }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' }

export interface PlanStore {
  /** 存入并返回带真实 `expiresAt` 的那一份（调用方要把它给界面，不能给原始 0）。 */
  put(plan: CleanupPlan): CleanupPlan
  take(planId: string): PlanTake
  acquire(): boolean
  release(): void
  busy(): boolean
}

export function createPlanStore(options: {
  now?: () => number
  id?: () => string
  ttlMs?: number
} = {}): PlanStore {
  const now = options.now ?? (() => Date.now())
  const mint = options.id ?? (() => randomUUID())
  const ttlMs = options.ttlMs ?? WORKSPACE_CLEANUP_PLAN_TTL_MS
  let current: CleanupPlan | null = null
  const used = new Set<string>()
  let locked = false

  return {
    put(plan) {
      // 只保留最后一份：用户重新扫描后，旧清单不能再被执行。
      current = { ...plan, expiresAt: now() + ttlMs }
      return current
    },
    take(planId) {
      if (used.has(planId)) return { ok: false, reason: 'used' }
      if (current === null || current.planId !== planId) return { ok: false, reason: 'unknown' }
      if (now() > current.expiresAt) {
        current = null
        return { ok: false, reason: 'expired' }
      }
      const plan = current
      current = null
      used.add(planId)
      return { ok: true, plan }
    },
    acquire() {
      if (locked) return false
      locked = true
      return true
    },
    release() {
      locked = false
    },
    busy() {
      return locked
    },
  }
}

/**
 * 清单指纹：**只**覆盖会删哪些顶层项与哪些会话。
 *
 * 两个刻意的取舍（见 spec §7.5）：不含 `sizeBytes`（预算会让大小漂移）、
 * 不含 `running` / `agentAvailable`（几秒就变，而它不改变删除集合）。
 */
export function fingerprint(input: {
  workspaceRealPath: string
  entries: readonly ScannedEntry[]
  sessionIds: readonly string[]
}): string {
  // 只取"哪些顶层项"：目录 mtime 会因子目录内部写入而变（活的审核/估值仍在写案例），
  // 把它放进来会让确认框反复打回重扫，而删除集合其实没变。
  const entries = [...input.entries]
    .map((entry) => ({ name: entry.name, kind: entry.kind }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const sessionIds = [...input.sessionIds].sort()
  return digestOf([canonicalJson({
    v: 1,
    workspace: input.workspaceRealPath,
    entries,
    sessions: sessionIds,
  })])
}
