import { isSafeSeqNo } from '../../../shared/consts.ts'
import type { CloudItem, OssBatchIndexResult } from '../../../shared/types.ts'
import type { PendingResult, WorkbenchApi } from './api.ts'

export interface RemoteQuery {
  status: 'loading' | 'ready' | 'failed' | 'invalid'
  item: CloudItem | null
  error: string
}
export interface PageTarget { query: string; page: number; size: number }
export interface ReportPageState {
  pending: PendingResult | null
  target: PageTarget
  remote: Record<string, RemoteQuery>
  pageLoading: boolean
  ossLoading: boolean
  pageError: string
  ossError: string
  stale: boolean
  epoch: number
  escalateAvailable: boolean
}

export function createReportPageLoader(api: Pick<WorkbenchApi, 'pending' | 'ossBatchIndex'>) {
  let state: ReportPageState = {
    pending: null, target: { query: '', page: 1, size: 20 }, remote: {}, pageLoading: false,
    ossLoading: false, pageError: '', ossError: '', stale: false, epoch: 0, escalateAvailable: false,
  }
  const listeners = new Set<(state: ReportPageState) => void>()
  const controllers = new Set<AbortController>()
  const retries = new Set<string>()
  const refreshWaiters = new Map<string, Array<() => void>>()
  const versions = new Map<string, number>()
  let pageQuery: Promise<void> | null = null
  const publish = (patch: Partial<ReportPageState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  const stop = (): void => {
    for (const controller of controllers) controller.abort()
    controllers.clear()
    retries.clear()
    for (const waiters of refreshWaiters.values()) waiters.forEach((resolve) => resolve())
    refreshWaiters.clear()
    versions.clear()
    pageQuery = null
  }
  const resultOf = (seq: string, result: OssBatchIndexResult): RemoteQuery => {
    const entry = result.results?.[seq]
    if (!result.ok || entry === undefined || !entry.ok) {
      return { status: 'failed', item: null, error: !result.ok ? result.error : entry?.error || '审核文件查询未完成，请重试' }
    }
    const item = entry.item
    if (item !== null && (item.seqNo !== seq || [...item.files.map((file) => file.key), item.htmlKey, item.jsonKey]
      .some((key) => key !== '' && !key.includes(`/${seq}/`)))) {
      return { status: 'failed', item: null, error: '审核文件与报告流水号不匹配' }
    }
    return { status: 'ready', item, error: '' }
  }
  const query = async (seqNos: string[], epoch: number, controller: AbortController): Promise<void> => {
    const tickets = new Map(seqNos.map((seq) => {
      const version = (versions.get(seq) ?? 0) + 1
      versions.set(seq, version)
      return [seq, version]
    }))
    const currentSerials = (): string[] => seqNos.filter((seq) => versions.get(seq) === tickets.get(seq))
    try {
      const result = await api.ossBatchIndex({ seqNos }, { signal: controller.signal })
      if (state.epoch !== epoch || controller.signal.aborted) return
      if (currentSerials().length === 0) return
      const next = { ...state.remote, ...Object.fromEntries(currentSerials().map((seq) => [seq, resultOf(seq, result)])) }
      const failed = Object.values(next).some((entry) => entry.status === 'failed')
      publish({ remote: next, ossError: result.ok ? (failed && state.ossError !== '' ? state.ossError : '') : result.error })
    } catch {
      if (state.epoch !== epoch || controller.signal.aborted) return
      publish({ remote: { ...state.remote, ...Object.fromEntries(currentSerials().map((seq) => [seq,
        { status: 'failed', item: null, error: '查询审核文件失败，请重试' }])) } })
    }
  }
  const load = async (target: PageTarget = state.target): Promise<void> => {
    stop()
    const epoch = state.epoch + 1
    const controller = new AbortController()
    controllers.add(controller)
    publish({ target, epoch, pageLoading: true, ossLoading: false, pageError: '', ossError: '',
      stale: state.pending !== null, escalateAvailable: false })
    try {
      const pending = await api.pending(target, { signal: controller.signal })
      if (state.epoch !== epoch || controller.signal.aborted) return
      if (!pending.ok) {
        publish({ pageError: pending.error, escalateAvailable: pending.escalateAvailable === true })
        return
      }
      const serials = [...new Set(pending.rows.map((row) => row.seqNo))]
      const seqNos = [...new Set(serials.filter(isSafeSeqNo).map((seq) => seq.trim()))]
      const remote = Object.fromEntries(serials.map((seq) => [seq, {
        status: isSafeSeqNo(seq) ? 'loading' : 'invalid', item: null,
        error: isSafeSeqNo(seq) ? '' : '流水号不可查询',
      }])) as Record<string, RemoteQuery>
      publish({ pending, target: { query: pending.query, page: pending.page, size: pending.size }, remote,
        pageLoading: false, stale: false, ossLoading: seqNos.length > 0 })
      if (seqNos.length > 0) {
        const outstanding = query(seqNos, epoch, controller)
        pageQuery = outstanding
        await outstanding
        if (pageQuery === outstanding) pageQuery = null
        // Associate trimmed serials without changing the authoritative business row.
        if (state.epoch === epoch && !controller.signal.aborted) {
          const aliases = serials.filter(isSafeSeqNo)
          const mapped = Object.fromEntries(aliases
            .map((seq) => [seq, state.remote[seq.trim()]] as const)
            .filter(([, value]) => value !== undefined))
          if (Object.keys(mapped).length > 0) publish({ remote: { ...state.remote, ...mapped } })
        }
      }
    } catch {
      if (state.epoch === epoch && !controller.signal.aborted) publish({ pageError: '读取报告列表失败，请重试' })
    } finally {
      controllers.delete(controller)
      if (state.epoch === epoch && !controller.signal.aborted) publish({ pageLoading: false, ossLoading: false })
    }
  }
  const aliasesOf = (seq: string): string[] => state.pending?.rows
    .filter((row) => row.seqNo.trim() === seq).map((row) => row.seqNo) ?? [seq]
  const markLoading = (seq: string): void => {
    const aliases = [seq, ...aliasesOf(seq)]
    publish({ remote: { ...state.remote, ...Object.fromEntries(aliases.map((key) => [key, { status: 'loading', item: null, error: '' }])) } })
  }
  const executeSingle = async (seq: string): Promise<void> => {
    const epoch = state.epoch
    const controller = new AbortController()
    controllers.add(controller)
    retries.add(seq)
    const aliases = aliasesOf(seq)
    markLoading(seq)
    try {
      const outstanding = pageQuery
      if (outstanding !== null) {
        versions.set(seq, (versions.get(seq) ?? 0) + 1)
        await outstanding
        if (state.epoch !== epoch || controller.signal.aborted) return
      }
      await query([seq], epoch, controller)
      if (state.epoch === epoch && !controller.signal.aborted) {
        const value = state.remote[seq]
        publish({ remote: { ...state.remote, ...Object.fromEntries(aliases.map((key) => [key, value])) } })
      }
    } finally {
      controllers.delete(controller)
      if (state.epoch !== epoch) return
      retries.delete(seq)
      const waiters = refreshWaiters.get(seq)
      if (waiters !== undefined) {
        refreshWaiters.delete(seq)
        if (state.epoch === epoch && !controller.signal.aborted) {
          await executeSingle(seq)
        }
        waiters.forEach((resolve) => resolve())
      }
    }
  }
  const retry = async (raw: string): Promise<void> => {
    const seq = raw.trim()
    if (state.pageLoading || state.stale || !isSafeSeqNo(seq) || retries.has(seq)
      || !state.pending?.rows.some((row) => row.seqNo.trim() === seq)) return
    await executeSingle(seq)
  }
  const refresh = async (raw: string): Promise<void> => {
    const seq = raw.trim()
    if (state.pageLoading || state.stale || !isSafeSeqNo(seq)
      || !state.pending?.rows.some((row) => row.seqNo.trim() === seq)) return
    markLoading(seq)
    versions.set(seq, (versions.get(seq) ?? 0) + 1)
    if (retries.has(seq)) {
      await new Promise<void>((resolve) => {
        const waiters = refreshWaiters.get(seq) ?? []
        waiters.push(resolve)
        refreshWaiters.set(seq, waiters)
      })
      return
    }
    await executeSingle(seq)
  }
  return {
    get: (): ReportPageState => state,
    subscribe: (listener: (state: ReportPageState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load, retry, refresh,
    cancel: (): void => { stop(); publish({ epoch: state.epoch + 1, pageLoading: false, ossLoading: false }) },
  }
}
