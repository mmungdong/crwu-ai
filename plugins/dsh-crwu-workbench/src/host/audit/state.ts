import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, isDir, resolveTarget } from '../fs/paths.ts'
import type { AuditRecord, WorkbenchState } from '../state/types.ts'
import { inspectCase } from './case.ts'
import type { AuditStatus } from './consts.ts'
import { agentRegistry, stopChild } from './spawn.ts'

/**
 * 审核状态判定。
 *
 * 这里集中了「状态跟丢」这个历史事故的全部结论，改动前请先读注释：
 *
 * - **存活判据是子 Agent 自己的 `status === 'running'`**，与父会话无关。
 *   `subagents.listChildren` 是会话存储驱动的，跑完的一次性子会话**依然在列**，
 *   所以「在清单里」不等于「还活着」。旧实现把清单当存活依据，父会话一变就全体查不到。
 * - **刚起的子会话有 20 秒宽限**：驱动翻成 running 之前，「停止」按钮会闪成「重新审核」。
 * - **认领来的记录永远等不到 `subagent/end`**（它没有本地历史），一旦不再 running
 *   就必须当结束处理并释放占用，否则一次早就跑完的审核会把单条门禁永久锁住。
 * - **先看生命周期、再看磁盘交付件**：反过来的话，「重新审核」写的是同一个案例目录，
 *   上一轮的 JSON 还在，正在跑的新审核会被显示成「已出结果」。
 */

/** 判定所需的全部外部事实；由操作层一次性取好，保持本函数可测。 */
export interface AssessContext {
  ctx: Context
  state: WorkbenchState
  /** childId → 是否在会话清单里。 */
  listed: Record<string, boolean>
  /** childId → 该子 Agent 当前状态（``''`` = 查不到）。 */
  agentStatusOf: (childId: string) => string
  /** 案例根目录候选（当前工作空间），可为空。 */
  caseRoot: string
  now: number
}

export interface AssessResult {
  status: AuditStatus
  casePath: string
  resultFile: string
  htmlFile: string
  caseName: string
  childAlive: boolean
  /** 记录是否发生了变化（决定要不要落盘）。 */
  changed: boolean
  /** 该 childId 的占用锁是否应当释放。 */
  release: boolean
}

function rootCandidates(context: AssessContext, record: AuditRecord): string[] {
  const paths: string[] = []
  // 先试**记住的绝对路径**：用户换了工作空间后，旧案例必须还能扫到，
  // 否则磁盘上明明有交付件，界面却退化成「未出结果」。
  if (record.casePath !== '') paths.push(record.casePath)
  if (context.caseRoot !== '') {
    if (record.seqNo !== '') paths.push(`${context.caseRoot}/${record.seqNo}`)
    if (record.key !== '') paths.push(`${context.caseRoot}/${record.key}`)
  }
  return paths
}

/** 看这一次审核的子会话是否还活着，并扫出磁盘上的交付件。 */
export async function assessAudit(context: AssessContext, record: AuditRecord): Promise<AssessResult> {
  const { state } = context
  const listed = record.childId !== '' && context.listed[record.childId] === true

  // 刚起的子会话可能还没被驱动翻成 running：给 20 秒宽限。
  const bornAt = record.startedAt === '' ? Number.NaN : Date.parse(record.startedAt)
  const fresh = Number.isFinite(bornAt) && (context.now - bornAt) < 20_000
  const agentRunning = context.agentStatusOf(record.childId) === 'running'
  const childAlive = record.ended !== true && record.stopped !== true && (agentRunning || fresh)
  const childPresent = listed || childAlive

  // 认领来的记录没有本地历史，永远等不到 subagent/end。
  const listedOnly = record.adopted === true || text(record.startedAt) === ''
  const finishedAdopted = listedOnly && !agentRunning

  let resultFile = ''
  let htmlFile = ''
  let caseName = ''
  let casePath = record.casePath
  try {
    for (const candidate of rootCandidates(context, record)) {
      if (!await isDir(context.ctx, candidate)) continue
      const target = await resolveTarget(context.ctx, candidate)
      const item = await inspectCase(context.ctx, target)
      if (item === null) continue
      if (item.resultFile !== '') {
        resultFile = item.resultFile
        htmlFile = item.htmlFile
        caseName = item.name
        casePath = item.path
        break
      }
      if (casePath === '') casePath = item.path
      if (htmlFile === '') htmlFile = item.htmlFile
    }
  } catch (error) {
    // 案例目录尚未开始（子会话刚起步）不是错误。
    void error
  }

  let status: AuditStatus = 'running'
  if (record.stopped === true) {
    // 用户明确停过的，永远显示已停止 —— 哪怕子会话随后自己跑完。
    status = 'stopped'
  } else if (agentRunning || (fresh && record.ended !== true)) {
    // **子 Agent 还在 running 就先信它，不看 `ended`**。`ended` 可能是从磁盘恢复的旧值，
    // 也可能是上一次查询写下的；而它正在跑。反过来会让正在跑的审核显示成「已结束」，
    // 用户会以为跑完了/可以重启，于是对同一个案例目录起第二条子会话。
    // 同理，刚起 20 秒内的子会话还没被驱动翻成 running —— 不套这个宽限，
    // 「停止」按钮会在头几秒里闪成「重新审核」。
    status = 'running'
  } else if (record.ended === true || finishedAdopted) {
    // 正常跑完（completed）或被外部取消（aborted）不算失败，标 idle 说「未出结果」；
    // 只有 error / max-tokens 才是 failed。
    if (resultFile !== '') status = 'done'
    else if (record.endReason === 'completed' || record.endReason === 'aborted' || finishedAdopted) status = 'idle'
    else status = 'failed'
  } else if (record.childId !== '') {
    status = resultFile !== '' ? 'done' : 'idle'
  } else {
    status = resultFile !== '' ? 'done' : 'running'
  }

  const ended = record.ended === true || finishedAdopted
  const changed = record.status !== status
    || record.casePath !== casePath
    || record.resultFile !== resultFile
    || record.ended !== ended
    || (childPresent !== (record.childAlive === true))

  // rec.ended 才是权威；childAlive=false 是重装后的常见情况 —— 那把锁必须松开，
  // 否则这条报告再也起不来。
  const release = ended || !childAlive || finishedAdopted
    || status === 'done' || status === 'failed' || status === 'stopped'

  return { status, casePath, resultFile, htmlFile, caseName, childAlive, changed, release }
}

/** 把判定结果写回记录（不可变替换，便于比较变化）。 */
export function applyAssessment(
  record: AuditRecord,
  assessment: AssessResult,
  activity: string,
): AuditRecord {
  return {
    ...record,
    status: assessment.status,
    casePath: assessment.casePath,
    resultFile: assessment.resultFile,
    htmlFile: assessment.htmlFile,
    caseName: assessment.caseName,
    ended: record.ended === true || (record.adopted === true && assessment.status !== 'running'),
    endReason: record.endReason !== '' ? record.endReason : (record.adopted === true && assessment.status !== 'running' ? 'completed' : ''),
    childAlive: assessment.childAlive,
    activity,
  }
}

/**
 * 释放单条占用锁。
 *
 * `childId` 非空时只释放**这一条**：两条审核交接时不能把新锁一起清掉。
 */
export function releaseActive(state: WorkbenchState, childId?: string): void {
  if (state.activeChildId === '') return
  if (childId !== undefined && childId !== '' && state.activeChildId !== childId) return
  state.activeKey = ''
  state.activeChildId = ''
  state.activeSince = 0
}

/** 占用锁自愈：本轮真的看到有子会话在 running，就把门禁重新挂回它身上。 */
export function reclaimActive(state: WorkbenchState, key: string, childId: string, now: number): boolean {
  if (state.activeChildId !== '' || childId === '') return false
  state.activeKey = key
  state.activeChildId = childId
  state.activeSince = now
  return true
}

/**
 * 门禁有没有对应的活口。
 *
 * `records` 为**本轮查询得到的记录**。两种情况必须放行：
 * 1. 锁指向的 childId 有记录，但那条记录已经结束（`ended` / `stopped`）—— 重装后
 *    锁留在了磁盘上，而子会话早跑完了；不放行这条报告再也起不来；
 * 2. 锁指向的 childId 根本没有记录 —— 比「有结束记录」更死：界面上连一行都点不到，
 *    没有任何入口能释放它。这种情况只能靠子 Agent 的实际状态判断。
 */
export function occupancyIsDead(
  state: WorkbenchState,
  records: AuditRecord[],
  agentStatusOf: (childId: string) => string,
): boolean {
  const childId = state.activeChildId
  if (childId === '') return false
  const record = records.find((item) => item.childId === childId)
  if (record !== undefined) return record.ended === true || record.stopped === true
  return agentStatusOf(childId) !== 'running'
}

/** childId → 该子 Agent 的当前状态；查不到返回空串。 */
export function makeAgentStatusOf(ctx: Context): (childId: string) => string {
  const agents = agentRegistry(ctx)
  return (childId: string): string => {
    if (agents === undefined || typeof agents.get !== 'function' || childId === '') return ''
    try {
      const agent = agents.get(childId as Parameters<typeof agents.get>[0])
      return agent !== undefined && typeof agent.status === 'string' ? text(agent.status) : ''
    } catch (error) {
      void error
      return ''
    }
  }
}

/** 一次取好所有父会话的子会话清单（多父会话聚合）。 */
export async function collectChildren(
  ctx: Context,
  parentIds: string[],
): Promise<{
  listed: Record<string, boolean>
  labels: Record<string, string>
  parentOf: Record<string, string>
}> {
  const listed: Record<string, boolean> = {}
  const labels: Record<string, string> = {}
  const parentOf: Record<string, string> = {}
  const subagents = ctx.get('subagents') as {
    listChildren?: (parentSessionId: string) => Promise<unknown>
  } | undefined
  if (subagents === undefined || typeof subagents.listChildren !== 'function') {
    return { listed, labels, parentOf }
  }
  for (const parentId of parentIds) {
    try {
      const children = await subagents.listChildren(parentId)
      if (!Array.isArray(children)) continue
      for (const child of children) {
        if (child === null || typeof child !== 'object') continue
        const record = child as Record<string, unknown>
        if (text(record.kind) !== 'child') continue
        const childId = text(record.id)
        if (childId === '') continue
        listed[childId] = true
        labels[childId] = text(record.label)
        if (parentOf[childId] === undefined) parentOf[childId] = parentId
      }
    } catch (error) {
      // 某个父会话查不到就跳过：不能因为一个父会话失效让其它记录集体退化成「未出结果」。
      void error
    }
  }
  return { listed, labels, parentOf }
}

/** 停止一条记录对应的子会话，并把它标记为手动停止。 */
export async function stopAuditChild(
  ctx: Context,
  state: WorkbenchState,
  childId: string,
  reason: string,
): Promise<{ ok: boolean; error: string; key: string; errors: string[] }> {
  if (childId === '') return { ok: false, error: '当前没有正在运行的审核子会话。', key: '', errors: [] }
  const outcome = await stopChild(ctx, childId, reason, {
    handle: state.runs[childId],
    parentSessionId: state.parentSessionId,
  })
  delete state.runs[childId]

  let key = ''
  for (const [candidate, record] of Object.entries(state.audits)) {
    if (record.childId === childId) {
      key = candidate
      break
    }
  }
  if (key !== '') {
    const record = state.audits[key]
    if (record !== undefined) {
      state.audits[key] = { ...record, stopped: true, ended: true, status: 'stopped', stopReason: '已被用户手动停止' }
    }
  }
  releaseActive(state, childId)
  return { ok: true, error: '', key, errors: outcome.errors }
}

/** 诊断用：列出仍持有句柄的 childId。 */
export function liveChildIds(state: WorkbenchState): string[] {
  return Object.keys(state.runs)
}

/** 案例根目录：工作空间优先，其次会话工作目录。 */
export async function defaultCaseRoot(ctx: Context, state: WorkbenchState, sessionRoot: () => Promise<string>): Promise<string> {
  for (const candidate of [state.workspacePath, state.caseRoot]) {
    if (candidate !== '' && await isDir(ctx, candidate)) return candidate
  }
  const fallback = await sessionRoot()
  if (fallback !== '' && fileSystem(ctx) !== undefined) return fallback
  return ''
}
