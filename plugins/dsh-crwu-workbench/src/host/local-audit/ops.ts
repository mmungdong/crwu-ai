import type { Context } from '@deepseek-ai/cordis'
import type { LocalAuditScanView, LocalAuditStartView } from '../../shared/types.ts'
import { text } from '../../shared/utils/value.ts'
import { trimTrailingSeparators } from '../../shared/utils/local-path.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import { LOCAL_AUDIT_MAX_FILES } from './consts.ts'
import { localAuditPrompt } from './prompt.ts'
import { localAuditCaseDir, prepareSnapshot, type SnapshotIo } from './snapshot.ts'
import type { LocalAuditRegistry } from './handoff.ts'
import { newHandoffId } from './handoff.ts'
import { scanSelection, type LocalAuditFs, type LocalAuditScan } from './scan.ts'

/**
 * 本地审核的三个 Host 操作（协议 28）。
 *
 * | 操作 | 做什么 |
 * | --- | --- |
 * | `local-audit-status` | 按本次选择扫描（展开 / 去重 / 大小 / 可读性 / 是否超限），只回事实 |
 * | `local-audit-start` | 重新校验选择 → 建临时快照 → 生成一次性 handoff 与**可复制的固定提示词** |
 * | `local-audit-claim` | 把 handoff 绑到一条会话，并回传案例目录与材料清单 |
 *
 * ## 三条口径
 *
 * 1. **每次调用都重新判一次**：`local-audit-start` 不信任 `local-audit-status` 的结果
 *    （两次调用之间用户可能删了文件、也可能换了选择），所以它自己再扫一遍。
 * 2. **上限在这里，不在界面**：界面禁用按钮只是体验；超限时 Host 也必须拒绝（同源路由是公开契约）。
 * 3. **`local-audit-status` 不是 sidecar 状态**：它只回答"我这次选的这些现在是什么样"，
 *    不回传任何历史、不落盘、不作为其他页面的数据源。
 */

export interface LocalAuditDeps {
  ctx: Context
  access: LocalAccessBroker
  state: WorkbenchState
  world: WorldFacts
  registry: LocalAuditRegistry
  fs: LocalAuditFs
  io: SnapshotIo
}

/** 本机访问操作名：读用户选中的本机文件并写入临时快照。 */
export const LOCAL_AUDIT_OPERATION = 'system.local-audit-material.snapshot' as const

function scanView(scan: LocalAuditScan): LocalAuditScanView {
  return {
    ok: scan.ok,
    error: scan.error === '' && scan.overLimit
      ? `当前选择会展开为 ${String(scan.fileCount)} 个文件，超过单次最多 ${String(LOCAL_AUDIT_MAX_FILES)} 个文件的限制。请移除部分文件或文件夹后再继续。`
      : scan.error,
    errorKind: scan.errorKind,
    fileCount: scan.fileCount,
    limit: LOCAL_AUDIT_MAX_FILES,
    overLimit: scan.overLimit,
    readableCount: scan.readableCount,
    skippedCount: scan.skippedCount,
    items: scan.items,
    // 文件级清单：界面据此在"文件夹行"下面逐行展示完整文件名，并允许逐个移除。
    // `sourcePath` 只在同一台机器上从 Host 回到界面（与 `items[].path` 同一类数据），
    // 不进提示词、不进快照清单。
    files: scan.files.map((item) => ({
      parentPath: item.parentPath,
      path: item.sourcePath,
      name: item.name,
      relativePath: item.relativePath,
      sizeBytes: item.sizeBytes,
    })),
    skipped: scan.skipped,
  }
}

function emptyStart(): LocalAuditStartView {
  return {
    ok: false, error: '', errorKind: '', handoffId: '', prompt: '',
    providedCount: 0, skippedCount: 0, expiresAt: 0, workspacePath: '', casePath: '', files: [], skipped: [],
  }
}

/** 选择的规范化：只接受字符串数组，逐个 trim。 */
export function selectionOf(args: Record<string, unknown>): string[] {
  const raw = args.selection
  if (!Array.isArray(raw)) return []
  return raw.map((item) => text(item).trim()).filter((item) => item !== '')
}

/**
 * 排除清单的规范化：员工在界面上**逐个移除**掉的文件（绝对路径）。
 *
 * 每个入口本身要不要审，是靠从 `selection` 里删掉它表达的；这里只装"入口之内的某个文件"。
 */
export function excludedOf(args: Record<string, unknown>): string[] {
  const raw = args.excluded
  if (!Array.isArray(raw)) return []
  return raw.map((item) => text(item).trim()).filter((item) => item !== '')
}

export async function localAuditStatus(deps: LocalAuditDeps, args: Record<string, unknown>): Promise<LocalAuditScanView> {
  const selection = selectionOf(args)
  if (selection.length === 0) {
    return { ...scanView({
      ok: false, error: '', errorKind: '', items: [], files: [], skipped: [],
      fileCount: 0, limit: LOCAL_AUDIT_MAX_FILES, overLimit: false,
      readableCount: 0, skippedCount: 0, truncated: false,
    }) }
  }
  return scanView(await scanSelection(selection, deps.fs, { excluded: excludedOf(args) }))
}

export async function localAuditStart(deps: LocalAuditDeps, args: Record<string, unknown>): Promise<LocalAuditStartView> {
  const selection = selectionOf(args)
  if (selection.length === 0) {
    return { ...emptyStart(), errorKind: 'input', error: '请先选择文件或文件夹' }
  }
  const scan = await scanSelection(selection, deps.fs, { excluded: excludedOf(args) })
  if (!scan.ok) {
    return { ...emptyStart(), errorKind: scan.errorKind === 'input' ? 'input' : 'infrastructure', error: scan.error }
  }
  if (scan.overLimit) {
    return {
      ...emptyStart(),
      errorKind: 'input',
      error: `当前选择会展开为 ${String(scan.fileCount)} 个文件，超过单次最多 ${String(LOCAL_AUDIT_MAX_FILES)} 个文件的限制。请移除部分文件或文件夹后再继续。`,
    }
  }
  if (scan.files.length === 0) {
    return { ...emptyStart(), errorKind: 'input', error: '没有可审核的文件' }
  }
  // 读本机文件需要一个**具名特权操作**（本机访问授权 + 结构化诊断）；
  // 未授权时一个字节都不读，把 Broker 的原话交给界面去解释。
  const workdir = await deps.world.workdir()
  const decision = deps.access.authorize({
    operation: LOCAL_AUDIT_OPERATION,
    source: 'panel',
    ...(workdir === '' ? {} : { workdir }),
  })
  if (!decision.ok) {
    return { ...emptyStart(), errorKind: 'policy', error: decision.error }
  }
  /**
   * 案例目录落在**员工选定的工作空间**下：`<工作空间>/本地审核/<handoffId>`。
   *
   * 为什么必须有工作空间（2026-10-11 用户口径：「本地审核对话应该创建在我环境信息规定的
   * 工作区下面」）：会话的分组与沙箱边界都由 **cwd** 决定 —— cwd 逐字等于工作空间路径时，
   * 这条会话才挂到那个工作空间下；而 cwd = 工作空间又要求案例目录**在工作空间之内**，
   * 否则对话里的案例内工具（非特权）写不进去。交付件也因此落在员工自己的目录里。
   */
  const workspacePath = trimTrailingSeparators(text(deps.state.workspacePath) || text(deps.state.caseRoot))
  if (workspacePath === '') {
    return {
      ...emptyStart(),
      errorKind: 'policy',
      error: '还没有选定工作空间：请先在「环境信息」里选择工作空间，再开始本地审核。',
    }
  }
  const handoffId = newHandoffId()
  const snapshot = await prepareSnapshot(handoffId, scan.files, deps.io, {
    casePath: localAuditCaseDir(workspacePath, handoffId),
  })
  if (!snapshot.ok) {
    // 授权已经通过、快照却没建起来：留一条诊断，"我点了没反应"才查得到。
    deps.access.note({ operation: LOCAL_AUDIT_OPERATION, source: 'panel' }, { errorClass: 'infrastructure' })
    return { ...emptyStart(), errorKind: snapshot.errorKind === 'infrastructure' ? 'infrastructure' : 'input', error: snapshot.error }
  }
  deps.access.note({ operation: LOCAL_AUDIT_OPERATION, source: 'panel' })
  const extraPrompt = text(args.prompt)
  const prompt = localAuditPrompt({
    handoffId,
    files: snapshot.files,
    skipped: snapshot.skipped,
    extraPrompt,
  })
  const record = deps.registry.create({
    id: handoffId,
    casePath: snapshot.casePath,
    files: snapshot.files,
    skipped: snapshot.skipped,
  })
  return {
    ok: true,
    error: '',
    errorKind: '',
    handoffId: record.id,
    prompt,
    providedCount: snapshot.files.length,
    skippedCount: snapshot.skipped.length,
    expiresAt: record.expiresAt,
    /**
     * 新会话的 **cwd**（= 员工选定的工作空间，逐字）。
     *
     * DSH 按 cwd 把会话归到工作空间下；同时它也是会话的沙箱边界，而案例目录就在它里面。
     * 只回给客户端，**不进提示词**。
     */
    workspacePath,
    /** 本轮案例目录（`<工作空间>/本地审核/<handoffId>`）；只回给客户端，不进提示词。 */
    casePath: snapshot.casePath,
    files: snapshot.files.map((item) => ({ relativePath: item.relativePath, name: item.name })),
    skipped: snapshot.skipped,
  }
}

/**
 * 认领 handoff。
 *
 * `sessionId` **必须由调用方身份给出**：RPC 路由上它是客户端刚创建的那条会话（同源面板
 * 本来就知道自己建了哪条），Tool 上它是 `exec.agent.id`（不可伪造）。两者都走同一个注册表，
 * 所以"哪条会话能用这个案例目录"的判据只有一处。
 */
export async function localAuditClaim(deps: LocalAuditDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handoffId = text(args.handoffId).trim()
  const sessionId = text(args.sessionId).trim()
  if (handoffId === '') {
    return { ok: false, errorKind: 'input', casePath: '', fileCount: 0, skippedCount: 0, files: [], skipped: [], error: '缺少 handoffId' }
  }
  if (sessionId === '') {
    return { ok: false, errorKind: 'input', casePath: '', fileCount: 0, skippedCount: 0, files: [], skipped: [], error: '缺少会话标识：本地审核必须绑定到具体对话' }
  }
  const result = await deps.registry.claim(handoffId, sessionId, deps.io)
  return { ...result }
}
