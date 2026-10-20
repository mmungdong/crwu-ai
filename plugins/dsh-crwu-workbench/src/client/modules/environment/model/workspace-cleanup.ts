import type {
  WorkspaceCleanupPlan, WorkspaceCleanupRequest, WorkspaceCleanupResult,
} from '../../../../shared/contracts/workspace-cleanup.ts'
import type { LocalAccessConsentView } from '../../../../shared/access/types.ts'

/**
 * 「清理工作空间」的客户端状态机与纯判据。
 *
 * 判据刻意做成纯函数：弹窗只渲染，不自己拼"能不能点"。真正的安全边界在 Host ——
 * 这里的禁用只是不给假希望，任何一条都可能在服务端被重新判一次。
 */

export type CleanupPhase = 'closed' | 'scanning' | 'ready' | 'applying' | 'done' | 'error'

export interface CleanupViewState {
  phase: CleanupPhase
  plan: WorkspaceCleanupPlan | null
  result: WorkspaceCleanupResult | null
  error: string
  confirmName: string
  deleteSessionLogs: boolean
  startedAt: number
}

export function initialCleanupState(): CleanupViewState {
  return {
    phase: 'closed',
    plan: null,
    result: null,
    error: '',
    confirmName: '',
    deleteSessionLogs: false,
    startedAt: 0,
  }
}

export function cleanupBlockedReason(input: {
  chosen: boolean
  missing: boolean
  busy: boolean
  consent: LocalAccessConsentView
  schemaMismatch: boolean
}): string {
  if (input.schemaMismatch) {
    return '客户端与宿主的权限说明版本不一致：请完全退出并重新打开 DeepSeek Harness 后再试'
  }
  if (input.missing) return '已选定的工作空间目录不在了，请重新选择'
  if (!input.chosen) return '尚未选择工作空间'
  if (input.consent.state !== 'granted') {
    return '需要先在「账号连接」里允许工作台访问本机账号和配置'
  }
  if (!input.consent.capabilities.includes('workspace-cleanup')) {
    return '新增的「清理工作空间」授权范围还没同意：请在「账号连接」里重新允许一次'
  }
  if (input.busy) return '正在处理工作空间，请稍等'
  return ''
}

export function cleanupIsEmpty(plan: WorkspaceCleanupPlan | null): boolean {
  if (plan === null || !plan.ok) return false
  const totals = plan.totals
  return totals.folders + totals.files + totals.symlinks + totals.other === 0
    && totals.sessions === 0
}

export function canApply(state: CleanupViewState): boolean {
  if (state.phase !== 'ready' || state.plan === null || !state.plan.ok) return false
  if (cleanupIsEmpty(state.plan)) return false
  return state.confirmName.trim() === state.plan.workspace.name
}

export function cleanupSummary(plan: WorkspaceCleanupPlan): string {
  const totals = plan.totals
  const size = totals.bytesComplete ? `约 ${formatBytes(totals.bytes)}` : `至少 ${formatBytes(totals.bytes)}`
  return `${String(totals.folders)} 个文件夹 · ${String(totals.files)} 个文件 · ${size}`
}

export function cleanupResultSummary(result: WorkspaceCleanupResult): string {
  if (result.status === 'aborted') return result.error === '' ? '会话没有停下，已中止' : result.error
  if (result.status === 'failed') return result.error === '' ? '清理没有开始' : result.error
  const parts = [
    `删除 ${String(result.deleted.folders)} 个文件夹、${String(result.deleted.files)} 个文件`,
  ]
  if (result.archivedSessionIds.length > 0) parts.push(`归档 ${String(result.archivedSessionIds.length)} 条会话`)
  if (result.deletedSessionLogs.length > 0) parts.push(`删除 ${String(result.deletedSessionLogs.length)} 条会话日志`)
  if (result.remaining > 0) parts.push(`仍有 ${String(result.remaining)} 项未删除`)
  return parts.join(' · ')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`
}

export interface WorkspaceCleanupController {
  get(): CleanupViewState
  subscribe(listener: () => void): () => void
  open(): void
  close(): void
  rescan(): Promise<void>
  apply(): Promise<void>
  setConfirmName(value: string): void
  setDeleteSessionLogs(value: boolean): void
}

interface CleanupApi {
  plan(): Promise<WorkspaceCleanupPlan>
  apply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult>
}

export function createWorkspaceCleanupController(options: {
  api?: CleanupApi
  now?: () => number
  onSettled?: (result: WorkspaceCleanupResult) => void
} = {}): WorkspaceCleanupController {
  const now = options.now ?? (() => Date.now())
  let state = initialCleanupState()
  // 异步回来的结果只允许落到"还是它发起的那一轮"上：用户在扫描/执行中途关掉弹窗后，
  // 迟到的结果不许把界面重新拉回 ready/done（那看起来像弹窗自己又弹了一次）。
  let generation = 0
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const patch = (next: Partial<CleanupViewState>): void => {
    state = { ...state, ...next }
    emit()
  }
  const api = options.api ?? {
    plan: async () => {
      const { environmentApi } = await import('../api.ts')
      return await environmentApi.workspaceCleanupPlan()
    },
    apply: async (request: WorkspaceCleanupRequest) => {
      const { environmentApi } = await import('../api.ts')
      return await environmentApi.workspaceCleanupApply(request)
    },
  }

  const rescan = async (): Promise<void> => {
    const mine = ++generation
    patch({ phase: 'scanning', error: '', plan: null, result: null })
    try {
      const plan = await api.plan()
      if (mine !== generation) return
      if (!plan.ok) {
        patch({ phase: 'error', error: plan.error === '' ? '扫描失败' : plan.error })
        return
      }
      patch({ phase: 'ready', plan, confirmName: '', deleteSessionLogs: false })
    } catch (error) {
      if (mine !== generation) return
      patch({ phase: 'error', error: reasonOf(error) })
    }
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open() {
      if (state.phase !== 'closed') return
      void rescan()
    },
    close() {
      // 执行中不许关：RPC 还在飞，关掉只会让员工以为"取消了"，而磁盘已经在删。
      if (state.phase === 'applying') return
      generation += 1
      state = initialCleanupState()
      emit()
    },
    rescan,
    async apply(): Promise<void> {
      if (!canApply(state) || state.phase === 'applying' || state.plan === null) return
      const plan = state.plan
      const mine = ++generation
      patch({ phase: 'applying', startedAt: now(), error: '' })
      try {
        const result = await api.apply({
          planId: plan.planId,
          digest: plan.digest,
          confirmName: state.confirmName.trim(),
          deleteSessionLogs: state.deleteSessionLogs,
        })
        if (mine !== generation) return
        if (result.status === 'failed' && result.errorKind === 'input') {
          // 清单变了：让员工看新清单，而不是对着旧清单反复点。
          await rescan()
          return
        }
        patch({ phase: 'done', result, error: result.ok ? '' : (result.error || cleanupResultSummary(result)) })
        options.onSettled?.(result)
      } catch (error) {
        if (mine !== generation) return
        patch({ phase: 'error', error: reasonOf(error) })
      }
    },
    setConfirmName(value) {
      patch({ confirmName: value })
    },
    setDeleteSessionLogs(value) {
      patch({ deleteSessionLogs: value })
    },
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
