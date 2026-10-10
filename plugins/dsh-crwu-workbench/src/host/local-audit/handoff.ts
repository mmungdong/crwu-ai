import { randomUUID } from 'node:crypto'
import { LOCAL_AUDIT_HANDOFF_TTL_MS, LOCAL_AUDIT_MAX_FILES } from './consts.ts'
import type { LocalAuditSkipped } from './scan.ts'
import type { LocalAuditScope, LocalAuditScopeRegistry } from './scope.ts'
import { readManifest, type SnapshotFile, type SnapshotIo } from './snapshot.ts'

/**
 * **一次性 handoff 注册表**（协议 28）。
 *
 * ## 为什么是进程内的一次性记录，而不是落盘的任务
 *
 * 本地审核的产品口径是「审核结果只存在于这次对话里，不保存审核历史、不监控其他对话」。
 * handoff 只是**从面板到新对话的一次交接**：谁建的、哪个案例目录、什么时候过期、有没有被用过。
 * 把它落盘会立刻引出"重启后这些记录算什么""要不要清理""能不能重放"一整套新语义 ——
 * 而它要回答的问题在一次进程生命周期里就有答案。**进程重启 = 全部失效**，这是刻意的。
 *
 * ## 两条不可退让的判据
 *
 * 1. **只能用一次**：`claim()` 成功即置 `used`；重复 claim 一律拒绝（旧提示词不能重放）。
 * 2. **绑定到具体会话**：claim 之后案例 scope 只对**那一次调用的会话**成立，
 *    其他会话拿不到这个案例目录（`scopeOf` 的判据就是会话 id 逐字相等）。
 */

export interface LocalAuditHandoff {
  id: string
  casePath: string
  createdAt: number
  expiresAt: number
  used: boolean
  /** claim 成功的会话；空串 = 还没被认领。 */
  claimedSessionId: string
  fileCount: number
  skippedCount: number
  files: SnapshotFile[]
  skipped: LocalAuditSkipped[]
}

/** 案例 scope：claim 之后这条会话能用的案例目录。 */
export type { LocalAuditScope } from './scope.ts'

export interface LocalAuditClaimOutcome {
  ok: boolean
  error: string
  errorKind: 'input' | 'policy' | 'capability-gap' | ''
  casePath: string
  fileCount: number
  skippedCount: number
  files: SnapshotFile[]
  skipped: LocalAuditSkipped[]
}

export interface LocalAuditRegistry extends LocalAuditScopeRegistry {
  /** 新建一条 handoff；`id` 由调用方生成（它同时是快照目录名，所以要先有 id 再建快照）。 */
  create(input: {
    id: string
    casePath: string
    files: SnapshotFile[]
    skipped: LocalAuditSkipped[]
    now?: number
  }): LocalAuditHandoff
  peek(id: string): LocalAuditHandoff | undefined
  /** 认领：校验存在 / 未用 / 未过期 / 快照仍在，通过后绑定会话并置 `used`。 */
  claim(id: string, sessionId: string, io: SnapshotIo, now?: number): Promise<LocalAuditClaimOutcome>
  /** 这条会话当前的本地审核案例 scope（没有则 `undefined`）。 */
  scopeOf(sessionId: string): LocalAuditScope | undefined
  /** 清理过期 / 已用完的 handoff，返回被删掉的案例目录。 */
  sweep(io: SnapshotIo, now?: number): Promise<{ dropped: string[]; removed: string[] }>
  size(): number
}

export function newHandoffId(now = Date.now()): string {
  return `la-${String(now)}-${randomUUID().slice(0, 8)}`
}

const MAX_RECORDS = 32

export function createLocalAuditRegistry(): LocalAuditRegistry {
  const handoffs = new Map<string, LocalAuditHandoff>()
  const scopes = new Map<string, LocalAuditScope>()

  /**
   * 待清理的案例目录。
   *
   * 为什么单独一份：`drop()` 会在**同步**路径上被调用（新建时淘汰最旧的一条），那里没有 IO
   * 可做 —— 不记账的话，被淘汰那条的快照目录既不在 `handoffs` 里、也不会再被 `sweep` 遍历到，
   * 于是永久留在临时目录里。记在这里，下一次 `sweep` 顺手删掉。
   */
  const orphans = new Set<string>()

  const drop = (id: string): void => {
    const record = handoffs.get(id)
    handoffs.delete(id)
    const claimed = record?.used === true
    for (const [sessionId, scope] of [...scopes]) {
      if (scope.handoffId === id) scopes.delete(sessionId)
    }
    // **认领过的目录永不自动删**（交付件在里面）：淘汰最旧一条时也一样。
    if (record !== undefined && record.casePath !== '' && !claimed) orphans.add(record.casePath)
  }

  return {
    create(input) {
      const now = input.now ?? Date.now()
      const id = input.id
      const record: LocalAuditHandoff = {
        id,
        casePath: input.casePath,
        createdAt: now,
        expiresAt: now + LOCAL_AUDIT_HANDOFF_TTL_MS,
        used: false,
        claimedSessionId: '',
        fileCount: input.files.length,
        skippedCount: input.skipped.length,
        files: [...input.files],
        skipped: [...input.skipped],
      }
      handoffs.set(id, record)
      // 只保留最近若干条：这是进程内的交接记录，不是历史归档。
      while (handoffs.size > MAX_RECORDS) {
        const oldest = handoffs.keys().next().value
        if (oldest === undefined || oldest === id) break
        drop(oldest)
      }
      return record
    },

    peek: (id) => handoffs.get(id),

    async claim(id, sessionId, io, now = Date.now()) {
      const empty: LocalAuditClaimOutcome = {
        ok: false, error: '', errorKind: '', casePath: '', fileCount: 0, skippedCount: 0, files: [], skipped: [],
      }
      const record = handoffs.get(id)
      if (record === undefined) {
        return {
          ...empty,
          errorKind: 'policy',
          error: '本地审核提示词已过期。\n\n请回到 Workbench，重新选择或准备文件后再试。',
        }
      }
      if (record.used) {
        // **同一条会话重复认领是幂等的**：自动链路里客户端会先替新会话认领一次，
        // 模型随后按提示词再调一次 Tool —— 那一次必须拿到同一份清单，而不是一句
        // 「提示词已经用过了」（那会把它指向一条根本不存在的恢复路径）。
        if (record.claimedSessionId !== '' && record.claimedSessionId === sessionId) {
          return {
            ok: true,
            error: '',
            errorKind: '',
            casePath: record.casePath,
            fileCount: record.fileCount,
            skippedCount: record.skippedCount,
            files: [...record.files],
            skipped: [...record.skipped],
          }
        }
        return {
          ...empty,
          errorKind: 'policy',
          error: '这份本地审核提示词已经用过了：请回到 Workbench 重新准备文件后再试。',
        }
      }
      if (now > record.expiresAt) {
        drop(id)
        return {
          ...empty,
          errorKind: 'policy',
          error: '本地审核提示词已过期。\n\n请回到 Workbench，重新选择或准备文件后再试。',
        }
      }
      if (sessionId === '') {
        return { ...empty, errorKind: 'policy', error: '无法确认调用者的会话身份：本地审核必须绑定到具体对话' }
      }
      // 快照还在吗（用户可能在两次操作之间清过临时目录）。**读清单而不是只判目录存在**：
      // 清单里的 handoffId 是"这一份快照就是那一份"的证据。路径用记录里的 `casePath`。
      const manifest = await readManifest(io, record.casePath, id)
      if (manifest === null) {
        drop(id)
        return {
          ...empty,
          errorKind: 'capability-gap',
          error: '本地审核的临时快照已经不在了：请回到 Workbench 重新准备文件。',
        }
      }
      record.used = true
      record.claimedSessionId = sessionId
      scopes.set(sessionId, { handoffId: id, casePath: record.casePath, claimedAt: now })
      return {
        ok: true,
        error: '',
        errorKind: '',
        casePath: record.casePath,
        fileCount: record.fileCount,
        skippedCount: record.skippedCount,
        files: [...record.files],
        skipped: [...record.skipped],
      }
    },

    scopeOf: (sessionId) => (sessionId === '' ? undefined : scopes.get(sessionId)),

    async sweep(io, now = Date.now()) {
      const dropped: string[] = []
      for (const [id, record] of [...handoffs]) {
        // ⚠️ **只清没人认领的过期快照**（2026-10-11 用户实测抓到的数据丢失）。
        //
        // 原来这里是「过期 **或** 已被认领」，而 `claim()` 一成功就置 `used = true` ——
        // 于是审计一跑完（甚至还在跑），下一次清理就把整个案例目录连**交付件 HTML/JSON**
        // 一起删了（用户原话：「审核完成后的交付件 html 和 json 文件都直接被删掉了」）。
        // `used` 的语义是"已经交接给某条会话了"，**不是"用完了"**：这条链路的产物就在那个
        // 目录里，而且我们刻意不监控对话、不知道它什么时候结束。
        // 所以认领过的一律不自动删：它现在落在员工自己的工作空间里，删不删由员工决定
        // （与报告审核的案例目录同一条口径）。
        if (record.used || now <= record.expiresAt) continue
        dropped.push(id)
        drop(id)
        // 未认领的快照在 `<工作空间>/本地审核/<handoffId>` 之下，删的是**快照副本**，不是原件。
        if (record.casePath !== '') orphans.add(record.casePath)
      }
      const removed: string[] = []
      for (const casePath of [...orphans]) {
        orphans.delete(casePath)
        try {
          await io.removeTree(casePath)
          removed.push(casePath)
        } catch (error) {
          void error
          // 删不掉就下次再试（进程内的待清理表，不是持久化队列）。
          orphans.add(casePath)
        }
      }
      return { dropped, removed }
    },

    size: () => handoffs.size,
  }
}

/** 上限的对外口径（提示词与界面文案共用一处）。 */
export const LOCAL_AUDIT_FILE_LIMIT = LOCAL_AUDIT_MAX_FILES
