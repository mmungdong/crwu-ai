import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { finiteNumber } from '../../shared/utils/value.ts'
import type { AuditRecord, WorkbenchState } from './types.ts'
import { readWorkbenchConfig, writeWorkbenchConfig } from './persist.ts'

/**
 * 审核记录的落盘与恢复。
 *
 * 两条规则：
 * 1. **只写可序列化字段**：`runs`（活的进程内句柄）、`uploading` 这类运行态绝不落盘 ——
 *    写进去也没用，插件一重装句柄就失效，反而会让恢复出的记录看起来「还在跑」。
 * 2. **占用锁一起恢复**：记录恢复了但锁没恢复，同一条报告就能被起第二条子会话。
 */

/** 判据是字符串字段一律 text()、布尔字段必须严格 true。 */
export function normalizeAudit(key: string, raw: unknown): AuditRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    key: text(r.key) || key,
    childId: text(r.childId),
    seqNo: text(r.seqNo),
    project: text(r.project),
    objectId: text(r.objectId),
    startedAt: text(r.startedAt),
    parentSessionId: text(r.parentSessionId),
    status: text(r.status) || 'idle',
    ended: r.ended === true,
    stopped: r.stopped === true,
    stopReason: text(r.stopReason),
    endReason: text(r.endReason),
    casePath: text(r.casePath),
    resultFile: text(r.resultFile),
    htmlFile: text(r.htmlFile),
    caseName: text(r.caseName),
    uploadedAt: text(r.uploadedAt),
    uploadError: text(r.uploadError),
    ossPrefix: text(r.ossPrefix),
    attempt: finiteNumber(r.attempt) || 1,
    adopted: r.adopted === true,
  }
}

/** 记录里要落盘的字段（与 `normalizeAudit` 的字段集一致，故意不含 uploading/runs）。 */
export function persistableAudits(audits: Record<string, AuditRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, record] of Object.entries(audits)) {
    if (record === undefined) continue
    out[key] = {
      key: text(record.key) || key,
      childId: text(record.childId),
      seqNo: text(record.seqNo),
      project: text(record.project),
      objectId: text(record.objectId),
      startedAt: text(record.startedAt),
      parentSessionId: text(record.parentSessionId),
      status: text(record.status),
      ended: record.ended === true,
      stopped: record.stopped === true,
      stopReason: text(record.stopReason),
      endReason: text(record.endReason),
      casePath: text(record.casePath),
      resultFile: text(record.resultFile),
      htmlFile: text(record.htmlFile),
      caseName: text(record.caseName),
      uploadedAt: text(record.uploadedAt),
      uploadError: text(record.uploadError),
      ossPrefix: text(record.ossPrefix),
      attempt: finiteNumber(record.attempt) || 1,
      adopted: record.adopted === true,
    }
  }
  return out
}

/** 落盘当前审核记录与占用锁。 */
export async function persistAudits(ctx: Context, home: string, state: WorkbenchState): Promise<boolean> {
  return await writeWorkbenchConfig(ctx, home, {
    audits: persistableAudits(state.audits),
    activeKey: state.activeKey,
    activeChildId: state.activeChildId,
    // 审核根会话跟着一起落盘：跨进程复用同一个根，子代理树才不会散开。
    auditRoot: { ...state.auditRoot },
  })
}

/** 单独落一次根会话（新建根之后立刻写，不等审核记录变化）。 */
export async function persistAuditRoot(ctx: Context, home: string, state: WorkbenchState): Promise<boolean> {
  return await writeWorkbenchConfig(ctx, home, { auditRoot: { ...state.auditRoot } })
}

/**
 * 幂等恢复：每个插件实例只读一次。
 *
 * 已存在的记录**不覆盖** —— 本进程里跑着的记录比磁盘上的新。
 */
export async function ensureRegistry(ctx: Context, home: string, state: WorkbenchState): Promise<void> {
  if (state.registryLoaded) return
  state.registryLoaded = true
  const config = await readWorkbenchConfig(ctx, home)
  const saved = config.audits !== null && typeof config.audits === 'object'
    ? config.audits as Record<string, unknown>
    : {}

  for (const [key, raw] of Object.entries(saved)) {
    if (state.audits[key] !== undefined) continue
    const record = normalizeAudit(key, raw)
    if (record !== null) state.audits[key] = record
  }

  // 占用锁必须跟着恢复：否则重装后同一条报告能被起第二条子会话，两条往同一个案例目录对写。
  if (state.activeChildId === '') {
    state.activeKey = text(config.activeKey)
    state.activeChildId = text(config.activeChildId)
  }
  // 根会话钩子：字段逐个收窄，老状态文件（没有 auditRoot）当作没有根。
  const rawRoot = config.auditRoot
  if (rawRoot !== null && typeof rawRoot === 'object') {
    // 这里**只认真字符串**，不像别处那样用 `text()` 强转：`sessionId` 会被拿去查 Agent、
    // 也会显示在 ⑧ 上，`'[object Object]'` / `'42'` 这种强转结果既查不到东西，又会让界面
    // 假装「有根」。文件被改坏时要退化成「没有根」（诚实状态），而不是编一个 id 出来。
    const root = rawRoot as Record<string, unknown>
    const rootText = (value: unknown): string => (typeof value === 'string' ? value : '')
    state.auditRoot = {
      workspacePath: rootText(root.workspacePath),
      sessionId: rootText(root.sessionId),
      title: rootText(root.title),
      assignedAt: rootText(root.assignedAt),
    }
  }

  // 工作空间**不在这里恢复**：它要连同 title/id/source 一起原子恢复，而且「目录还在不在」
  // 需要 fs 判断 —— 那三件事都在 `ensureWorkspace`（workspace/resolve.ts）。只在这里塞一个
  // workspacePath 会让 workspaceChosen 仍是 false，标签与按钮跟着变样（实测过）。
}
