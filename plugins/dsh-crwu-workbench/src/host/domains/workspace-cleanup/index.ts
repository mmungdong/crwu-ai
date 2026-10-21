import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCleanupPlan, WorkspaceCleanupRequest, WorkspaceCleanupResult,
} from '../../../shared/contracts/workspace-cleanup.ts'
import { WORKSPACE_CLEANUP_ENTRY_LIMIT } from '../../../shared/contracts/workspace-cleanup.ts'
import type { WorkspaceResolution } from '../../core/workspace-session/index.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import { applyCleanup, type ApplyDeps } from './apply.ts'
import { guardWorkspace } from './guards.ts'
import { createPlanStore, fingerprint, type CleanupPlan } from './plan.ts'
import { scanEntries } from './scan.ts'
import { cleanupSessionPort, type SessionPortOutcome } from './session-port.ts'
import { scanSessions } from './sessions.ts'
import type { CleanupIo, CleanupSessionPort, WorkspaceIdentity } from './types.ts'

/**
 * 工作空间清理服务：把「扫描 → 确认 → 执行」收成一个对象。
 *
 * 计划只活在**本实例的内存里**（单次使用、5 分钟）。服务不持有别的东西：
 * 工作空间每次现读，授权每次现判，于是切工作空间或撤销授权之后，旧计划一定用不了。
 */
export interface WorkspaceCleanupService {
  plan(): Promise<WorkspaceCleanupPlan>
  apply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult>
}

export interface WorkspaceCleanupServiceDeps {
  access: Pick<LocalAccessBroker, 'authorize' | 'note'>
  resolveWorkspace(): Promise<WorkspaceResolution>
  home(): Promise<string>
  platform(): Promise<string>
  sessionPort(): SessionPortOutcome
  io: CleanupIo
  closeWorkflowStores(workspacePath: string): Promise<void>
  clearAudits(): void
  persistAudits(): Promise<boolean>
  invalidate(): void
  now?(): number
}

const NOTES = [
  '已归档、不在会话列表里的旧会话无法枚举，其日志可能残留（不会出现在侧栏）。',
  '物理删除会话日志不是 DSH 支持的路径；删完后侧栏可能要在重启 DSH 后才彻底消失。',
]

export function createWorkspaceCleanupService(deps: WorkspaceCleanupServiceDeps): WorkspaceCleanupService {
  const store = createPlanStore(deps.now === undefined ? {} : { now: deps.now })
  const authorize = (): { ok: boolean; error: string } => {
    const decision = deps.access.authorize({ operation: 'system.workspace-cleanup', source: 'panel' })
    return { ok: decision.ok, error: decision.ok ? '' : decision.error }
  }

  async function openPlan(): Promise<
    { ok: true; plan: CleanupPlan; identity: WorkspaceIdentity } | { ok: false; plan: WorkspaceCleanupPlan }
  > {
    const allowed = authorize()
    if (!allowed.ok) return { ok: false, plan: emptyPlan(allowed.error, 'policy') }
    const resolved = await deps.resolveWorkspace()
    if (!resolved.ok) return { ok: false, plan: emptyPlan(resolved.error, 'input') }
    const guarded = await guardWorkspace({
      workspace: resolved.workspace,
      home: await deps.home(),
      platform: await deps.platform(),
      deps: { stat: (path) => deps.io.stat(path), realpath: (path) => deps.io.realpath(path) },
    })
    if (!guarded.ok) return { ok: false, plan: emptyPlan(guarded.error, 'input') }
    const ports = deps.sessionPort()
    if (!ports.ok) return { ok: false, plan: emptyPlan(ports.error, 'capability-gap') }
    let entries
    try {
      entries = await scanEntries(deps.io, guarded.identity)
    } catch (error) {
      return { ok: false, plan: emptyPlan(`扫描工作空间失败：${reasonOf(error)}`, 'infrastructure') }
    }
    let rows
    try {
      rows = await ports.port.list()
    } catch (error) {
      return { ok: false, plan: emptyPlan(`会话列表读取失败：${reasonOf(error)}`, 'infrastructure') }
    }
    const sessions = scanSessions(rows, guarded.identity)
    const totals = { ...entries.totals, ...sessions.totals }
    const digest = fingerprint({
      workspaceRealPath: guarded.identity.realPath,
      entries: entries.entries,
      sessionIds: sessions.sessions.map((session) => session.sessionId),
    })
    const plan: CleanupPlan = {
      planId: randomUUID(),
      digest,
      expiresAt: 0,
      identity: guarded.identity,
      entries: entries.entries,
      sessions: sessions.sessions,
      totals,
      notes: [...NOTES],
    }
    const stored = store.put(plan)
    return { ok: true, plan: stored, identity: guarded.identity }
  }

  return {
    async plan(): Promise<WorkspaceCleanupPlan> {
      const opened = await openPlan()
      if (!opened.ok) return opened.plan
      const plan = opened.plan
      return wirePlan(plan)
    },

    async apply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> {
      const allowed = authorize()
      if (!allowed.ok) return failedResult(allowed.error, 'policy')
      const taken = store.take(request.planId)
      if (!taken.ok) return failedResult(conflictText(taken.reason), 'conflict')
      const plan = taken.plan

      const resolved = await deps.resolveWorkspace()
      if (!resolved.ok) return failedResult(resolved.error, 'conflict')
      const guarded = await guardWorkspace({
        workspace: resolved.workspace,
        home: await deps.home(),
        platform: await deps.platform(),
        deps: { stat: (path) => deps.io.stat(path), realpath: (path) => deps.io.realpath(path) },
      })
      if (!guarded.ok || guarded.identity.id !== plan.identity.id
        || guarded.identity.realPath !== plan.identity.realPath) {
        return failedResult('确认期间选定或真实路径变了，请重新扫描后再清理', 'conflict')
      }
      if (request.confirmName.trim() !== plan.identity.name) {
        return failedResult('输入的目录名与工作空间不一致', 'input')
      }
      if (request.digest !== plan.digest) {
        return failedResult('清理清单已变化，请重新扫描后再确认', 'input')
      }

      const ports = deps.sessionPort()
      if (!ports.ok) return failedResult(ports.error, 'capability-gap')
      let freshDigest: string
      try {
        const entries = await scanEntries(deps.io, plan.identity)
        const sessions = scanSessions(await ports.port.list(), plan.identity)
        freshDigest = fingerprint({
          workspaceRealPath: plan.identity.realPath,
          entries: entries.entries,
          sessionIds: sessions.sessions.map((session) => session.sessionId),
        })
      } catch (error) {
        return failedResult(`重新扫描失败：${reasonOf(error)}`, 'infrastructure')
      }
      if (freshDigest !== plan.digest) {
        return failedResult('清理清单在确认期间发生了变化，请重新扫描后再确认', 'input')
      }

      // 重扫与拉会话列表之间有数十秒：授权在这段时间里被撤回，就不能再进入删除。
      const stillAllowed = authorize()
      if (!stillAllowed.ok) {
        return failedResult(`本机访问授权已撤回，未删除任何内容：${stillAllowed.error}`, 'policy')
      }

      if (!store.acquire()) return failedResult('已有一次清理正在执行', 'conflict')
      deps.access.note(
        { operation: 'system.workspace-cleanup', source: 'panel' },
        { summary: 'workspace cleanup apply' },
      )
      const applyDeps: ApplyDeps = {
        io: deps.io,
        port: ports.port as CleanupSessionPort,
        home: await deps.home(),
        closeWorkflowStores: deps.closeWorkflowStores,
        clearAudits: deps.clearAudits,
        persistAudits: deps.persistAudits,
        reauthorize: authorize,
        now: deps.now ?? (() => Date.now()),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }
      try {
        return await applyCleanup(applyDeps, { plan, deleteSessionLogs: request.deleteSessionLogs })
      } catch (error) {
        return failedResult(`清理执行失败：${reasonOf(error)}`, 'infrastructure')
      } finally {
        store.release()
        deps.invalidate()
      }
    },
  }
}

function wirePlan(plan: CleanupPlan): WorkspaceCleanupPlan {
  return {
    ok: true,
    error: '',
    errorKind: '',
    planId: plan.planId,
    digest: plan.digest,
    expiresAt: plan.expiresAt,
    workspace: { path: plan.identity.path, name: plan.identity.name, id: plan.identity.id },
    entries: plan.entries.slice(0, WORKSPACE_CLEANUP_ENTRY_LIMIT)
      .map(({ name, kind, sizeBytes }) => ({ name, kind, sizeBytes })),
    entriesTruncated: Math.max(0, plan.entries.length - WORKSPACE_CLEANUP_ENTRY_LIMIT),
    sessions: plan.sessions,
    totals: plan.totals,
    notes: plan.notes,
  }
}

function emptyPlan(error: string, errorKind: WorkspaceCleanupPlan['errorKind']): WorkspaceCleanupPlan {
  return {
    ok: false,
    error,
    errorKind,
    planId: '',
    digest: '',
    expiresAt: 0,
    workspace: { path: '', name: '', id: '' },
    entries: [],
    entriesTruncated: 0,
    sessions: [],
    totals: {
      folders: 0, files: 0, symlinks: 0, other: 0, bytes: 0, bytesComplete: true,
      sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0,
    },
    notes: [],
  }
}

function failedResult(error: string, errorKind: WorkspaceCleanupResult['errorKind']): WorkspaceCleanupResult {
  return {
    ok: false,
    status: 'failed',
    error,
    errorKind,
    archivedSessionIds: [],
    deletedSessionLogs: [],
    skippedSessionLogs: [],
    deleted: { folders: 0, files: 0, symlinks: 0, other: 0 },
    failures: [],
    remaining: 0,
    remainingNames: [],
    stuckSessionIds: [],
    notes: [],
  }
}

function conflictText(reason: 'unknown' | 'expired' | 'used'): string {
  if (reason === 'expired') return '清理清单已过期，请重新扫描'
  if (reason === 'used') return '这份清理清单已经执行过，请重新扫描'
  return '找不到这次清理的清单，请重新扫描'
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
