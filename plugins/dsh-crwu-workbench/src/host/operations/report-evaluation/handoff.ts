import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { WorkbenchState } from '../../core/state/types.ts'
import type { WorldFacts } from '../../core/platform/world.ts'
import { workspaceSessionService } from '../../core/workspace-session/index.ts'
import { ensureCaseDirectory, writePanelCaseFile } from '../../tools/common/case-files.ts'
import { canonicalJson } from '../../tools/common/snapshot.ts'
import {
  VALUATION_MATERIAL_DIR,
  VALUATION_REPORT_DATA_FILE,
  VALUATION_TOOL_NAMES,
  VALUATION_WORKBOOK_FILE,
} from '../../tools/report-evaluation/consts.ts'
import { missingValuationTools, valuationToolsMissingText } from '../../tools/report-evaluation/visibility.ts'
import { missingAuditTools } from '../../tools/register.ts'
import {
  buildFrozenInput,
  type FrozenInput,
  type HandoffReceipt,
} from '../../domains/report-evaluation/project/contracts.ts'
import { VALUATION_INPUT_SCHEMA_VERSION, type FailureEnvelope } from '../../../shared/contracts/valuation-project.ts'
import type { ValuationSourceFact } from '../../domains/report-evaluation/browser/sites.ts'
import type { CreationDisposition } from '../../../shared/contracts/report-evaluation.ts'
import { WORKBENCH_PROTOCOL } from '../../../shared/consts.ts'
import { valuationPrompt } from '../../domains/report-evaluation/prompt.ts'
import { valuationInputDigest, type PreviewRecord, type PreviewRegistry } from '../../domains/report-evaluation/intake/preview.ts'
import { sha256OfBytes } from '../../domains/report-evaluation/intake/manifest.ts'
import { toArchivedMaterials, type MaterialMetadata } from '../../domains/report-evaluation/intake/metadata.ts'
import {
  HANDOFF_RECORD_FILE,
  HandoffStore,
  type HandoffOutcome,
  type HandoffRecord,
} from '../../domains/report-evaluation/execution/handoff-store.ts'
import type { ValuationLifecycles } from '../../domains/report-evaluation/lifecycle/index.ts'
import {
  PROJECT_RECORD_FILE,
  PROJECT_RECORD_SCHEMA_VERSION,
  buildProjectRecord,
  projectRecordFiles,
} from '../../domains/report-evaluation/lifecycle/project-record.ts'
import type { ValuationScope } from '../../domains/report-evaluation/scope.ts'
import type { ValuationScopes } from '../../domains/report-evaluation/scope.ts'
import { samePathText } from '../../domains/report-audit/scope.ts'
import type { OperationMap } from '../types.ts'

/**
 * **幂等父会话交接**（计划 Task 2 · 设计稿 §5）。
 *
 * ## 交接事务的六步（顺序不可换）
 *
 * 1. 从 Host 预览读条件 —— **不接受 Client 再提交一套方法 / 基准日 / 补充要求**；
 * 2. 逐份回读**归档副本**、重算 sha256 → 重算输入摘要，与预览摘要比对（不一致就强制重新确认）；
 * 3. 认领（`requestId` 互斥 + 同一预览只能成功交接一次），先把 `pending` 落盘；
 * 4. 统一工作区会话服务建父会话（只发 `workspaceId`，回读 cwd 与工作区归组）；
 * 5. 绑定父会话 scope，写只读的 `估值输入.json`（v2，**不含绝对路径**）与 `交接清单.json`；
 * 6. 以可重试的 `dispatchReceipt` 发固定指令，收到 accepted 才写 `dispatched`。
 *
 * ## 两条"绝不"
 *
 * - **绝不**在读条件失败、摘要不一致、归档被改、工具不可见时建会话（否则留下空会话）；
 * - **绝不**在建出会话之后再建第二条 —— 发送失败 / 超时一律复用同一个 `parentSessionId`。
 */

/** 交接清单（人可读的执行记录；同样**不含原始绝对路径**）。 */
export const HANDOFF_MANIFEST_FILE = '交接清单.json'

export interface HandoffRequest {
  previewId: string
  confirmedInputDigest: string
  requestId: string
}

/**
 * 交接完成后、发固定指令之前的**工作流图登记钩子**（协议 43）。
 *
 * 返回成功时给出的 `prompt` 是**唯一**要发给父会话的指令（不透明、只含 commandId）；
 * 失败时不得发任何指令 —— 父会话已经建好，重试会复用同一条会话。
 */
export type WorkflowPrepareHandoffHook = (input: {
  receipt: HandoffReceipt
  frozen: FrozenInput
}) => Promise<{ ok: boolean; error?: string; prompt: string }>

/** `bindScope` 的结构化结果；`void` 仍被接受，旧夹具不需要改。 */
export interface HandoffBindScopeResult {
  ok: boolean
  error?: string
}

/**
 * A retry must keep the live scope generation verbatim: `openedAt` is part of the Graph
 * runtime scope key and registered `planIds` belong to the running round. Only the exact
 * same-round identity keeps the original scope; a foreign binding must fail closed.
 */
function sameScopeIdentity(existing: ValuationScope, next: ValuationScope): boolean {
  return existing.valuationId === next.valuationId
    && text(existing.projectId) === text(next.projectId)
    && existing.sessionId === next.sessionId
    && text(existing.parentSessionId) === text(next.parentSessionId)
    && existing.workspaceId === next.workspaceId
    && samePathText(existing.workspacePath, next.workspacePath)
    && samePathText(existing.casePath, next.casePath)
    && text(existing.snapshot?.digest) === text(next.snapshot?.digest)
}

/** 交接需要的外部能力（全部注入：事务本身可以直接单测）。 */
export interface HandoffDeps {
  previews: PreviewRegistry
  store: HandoffStore
  /** 已选工作区（唯一来源；`workspaceId` / `workspacePath` 都从它来）。 */
  workspace(): Promise<{ ok: boolean; error: string; workspaceId: string; workspacePath: string }>
  /** 统一工作区会话服务（只发 `workspaceId`，并**回读** cwd 与工作区归组）。 */
  createSession(input: { title: string; source: string }): Promise<{
    ok: boolean
    error: string
    sessionId: string
    workspaceId: string
    workspacePath: string
  }>
  /** 确保项目目录存在（面板来源；幂等）。 */
  ensureProjectDirectory(path: string): Promise<{ ok: boolean; error: string; errorKind: string }>
  /** 写项目目录内的数据文件（面板来源；实现必须回读校验）。 */
  writeProjectFile(path: string, content: string): Promise<{ ok: boolean; error: string; errorKind: string }>
  /** 读回归档副本的字节（摘要重算的唯一判据）。 */
  readArchiveBytes(path: string): Promise<Uint8Array>
  /** 发固定指令。**可重试**：同一个 `messageId` 不会被应用两次。 */
  dispatch(input: { sessionId: string; messageId: string; prompt: string }): Promise<{ accepted: boolean; error: string }>
  /**
   * 登记父会话的案例 scope（归属按会话 id 逐字钉死）。
   *
   * 返回 `{ ok:false, error }` 表示这一轮已经被另一份归属占用（foreign / mismatched）：调用方
   * 必须 fail closed，不能覆盖正在运行的 scope。返回 `void` 是旧夹具的兼容形态。
   */
  bindScope(scope: ValuationScope): void | HandoffBindScopeResult
  /** 交接成功后的宿主记账（轮次记录等，尽力而为）。 */
  onHandoff?(receipt: HandoffReceipt, frozen: FrozenInput): Promise<void> | void
  /**
   * 可选的工作流图登记钩子。给了它就在写完冻结输入/项目记录、绑定 scope 之后、发指令之前调用；
   * 成功只用它给的指令，失败**不发任何指令**（父会话已建好，重试复用同一条）。
   */
  prepareHandoff?: WorkflowPrepareHandoffHook
  /** 工具可见性预检：返回缺失的工具名（空数组 = 齐备）。 */
  missingTools?(): string[]
  projectDirOf(projectId: string): string
  projectPath(projectId: string, relative: string): string
  /**
   * 来源策略（协议 39）：配置里有哪些案例来源、各自必需还是可选、为什么现在还没有状态。
   *
   * 交接发生在检索之前，所以这里的 `state` 诚实取值是 `'unknown'`；但**列表不能为空** ——
   * 父会话必须拿到来源与原因，才能按知识库的降级策略选替代来源。
   */
  sources: readonly ValuationSourceFact[]
  now(): Date
}

/**
 * 构造一次失败回执。
 *
 * `creationDisposition` **必须显式给**（没有默认值）：它是界面能不能「返回修改」的唯一判据，
 * 让它可以被漏写就等于让"未知"悄悄变成"未创建"，而那会造出第二个项目目录。
 */
function failure(
  errorKind: FailureEnvelope['errorKind'],
  error: string,
  creationDisposition: CreationDisposition,
  patch: {
    projectId?: string
    parentSessionId?: string
    reused?: boolean
    recoveryAction?: 'refresh-preview' | 'retry-handoff'
  } = {},
): HandoffOutcome {
  return {
    ok: false,
    errorKind,
    error,
    projectId: patch.projectId ?? '',
    parentSessionId: patch.parentSessionId ?? '',
    dispatchAccepted: false,
    reused: patch.reused ?? false,
    creationDisposition,
    ...(patch.recoveryAction === undefined ? {} : { recoveryAction: patch.recoveryAction }),
  }
}

/**
 * "到这一步为止有没有可能已经建出会话"的判据。
 *
 * 只有**还没建会话**（`boundSessionId === ''`）才可能是 `not-created`；已经绑定了会话 id 的
 * 一律 `created`。拿不准的时候（异常、回执丢失）调用方直接给 `unknown`。
 */
function dispositionFor(boundSessionId: string): CreationDisposition {
  return boundSessionId === '' ? 'not-created' : 'created'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 交接一次：`previewId + confirmedInputDigest + requestId` → 父会话。
 *
 * 失败一律返回 `{ ok:false, errorKind, error }`（**不抛裸业务错误**）：调用方是面板 RPC，
 * 抛出去就只剩一句话，界面没法按类别派活（重新确认 / 去自检 / 打开已创建的会话）。
 */
export async function handoffProject(input: HandoffRequest, deps: HandoffDeps): Promise<HandoffOutcome> {
  const requestId = text(input.requestId).trim()
  const previewId = text(input.previewId).trim()
  const confirmed = text(input.confirmedInputDigest).trim()
  if (requestId === '' || previewId === '') {
    return failure('input-invalid', '缺少 requestId / previewId：交接必须能追溯到一次预览与一次确认。',
      'not-created')
  }
  if (confirmed === '') {
    return failure('input-invalid',
      '缺少确认摘要（confirmedInputDigest）：必须先由 Host 准备预览并逐份核对归档副本，再按那一份摘要启动。',
      'not-created', { projectId: previewId })
  }

  // The durable handoff record is consulted BEFORE the ephemeral preview TTL: a created
  // parent must never be relabeled "not created", and a dispatched handoff replays.
  const existing = deps.store.get(requestId)
  const holder = deps.store.requestOfPreview(previewId)
  if (existing !== undefined) {
    if (existing.previewId !== previewId) {
      return failure('conflict',
        '同一个 requestId 已经用在了另一个预览上：请返回修改并重新确认（不会按旧预览启动）。',
        'unknown', { projectId: previewId })
    }
  } else if (holder !== undefined && holder !== requestId) {
    return failure('conflict',
      '这个预览已经（或正在）被交接：同一份预览只能成功交接一次，请返回修改并重新确认。',
      'unknown', { projectId: previewId })
  }

  const now = deps.now()

  // A durable record already exists: claim it now (never a new record) so an inflight
  // first creation is awaited instead of being TTL-dropped or relabeled not-created.
  let ownClaim: { record: HandoffRecord; settle: (outcome: HandoffOutcome) => void } | null = null
  if (existing !== undefined) {
    const claimed = await deps.store.claim(requestId, previewId)
    if (!claimed.ok) return failure(claimed.errorKind, claimed.error, 'unknown', { projectId: previewId })
    if (!claimed.own) {
      const settled = await claimed.settled
      return settled.ok ? { ...settled, reused: true } : settled
    }
    ownClaim = { record: claimed.record, settle: claimed.settle }
  }

  const preview = deps.previews.get(previewId)
  const boundParent = ownClaim?.record.parentSessionId ?? ''
  const hasExistingParent = boundParent !== ''
  const createdPatch = hasExistingParent
    ? { parentSessionId: boundParent, reused: true, recoveryAction: 'retry-handoff' as const }
    : {}
  const settleOwn = (outcome: HandoffOutcome): void => {
    if (ownClaim !== null) ownClaim.settle(outcome)
  }

  // Only a genuinely new handoff (no created parent yet) depends on a live preview TTL.
  if (!hasExistingParent) {
    const expired = preview !== undefined && now.getTime() > Date.parse(preview.expiresAt)
    if (preview === undefined || expired) {
      if (expired) deps.previews.drop(previewId)
      const outcome = failure('not-found',
        preview === undefined
          ? '这次预览已经不在宿主里（或从未准备过）：请返回修改并重新确认。'
          : '这次预览已经过期：请返回修改并重新确认（归档副本可能已经变了）。',
        'not-created', { projectId: previewId, recoveryAction: 'refresh-preview' })
      settleOwn(outcome)
      return outcome
    }
  }

  const missing = deps.missingTools?.() ?? []
  if (missing.length > 0) {
    const outcome = failure('capability-gap', valuationToolsMissingText(missing),
      hasExistingParent ? 'created' : 'not-created', { projectId: previewId, ...createdPatch })
    settleOwn(outcome)
    return outcome
  }

  const selected = await deps.workspace()
  if (!selected.ok) {
    const outcome = failure('policy', selected.error,
      hasExistingParent ? 'created' : 'not-created', { projectId: previewId, ...createdPatch })
    settleOwn(outcome)
    return outcome
  }

  if (ownClaim === null) {
    // A genuinely new request is claimed only after a valid, fresh preview passed.
    const claimed = await deps.store.claim(requestId, previewId)
    if (!claimed.ok) return failure(claimed.errorKind, claimed.error, 'unknown', { projectId: previewId })
    if (!claimed.own) {
      // 同一 requestId 已经有一次交接在跑：**等它的结果**，绝不自己再建一条会话。
      const settled = await claimed.settled
      return settled.ok ? { ...settled, reused: true } : settled
    }
    ownClaim = { record: claimed.record, settle: claimed.settle }
  }

  const activeClaim = ownClaim
  if (activeClaim === null) {
    return failure('infrastructure', '交接认领状态丢失：没有发出固定指令', 'unknown', { projectId: previewId })
  }

  if (preview === undefined) {
    // A created parent whose preview was lost keeps its identity: retry the SAME session.
    // The claim is settled exactly once here so the next retry never waits forever.
    const parentSessionId = activeClaim.record.parentSessionId
    const created = parentSessionId !== ''
    const outcome = failure('infrastructure',
      '这次预览已经失效：父会话已经建好，重试会复用同一条会话（不会新建）。',
      created ? 'created' : 'not-created',
      {
        projectId: activeClaim.record.projectId,
        parentSessionId,
        reused: created,
        recoveryAction: created ? 'retry-handoff' : 'refresh-preview',
      })
    activeClaim.settle(outcome)
    return outcome
  }

  // 事务体抛错时**没有**权威结论：默认必须落在 `unknown`（宁可让员工恢复同一轮，
  // 也不能让界面以为"没建过"而再建一个）。
  let outcome: HandoffOutcome = failure('infrastructure', '交接没有完成', 'unknown', { projectId: previewId })
  try {
    outcome = await runHandoff(activeClaim.record.parentSessionId, preview, confirmed, deps, selected, now)
    return outcome
  } finally {
    activeClaim.settle(outcome)
  }
}

async function runHandoff(
  boundSessionId: string,
  preview: PreviewRecord,
  confirmed: string,
  deps: HandoffDeps,
  selected: { workspaceId: string; workspacePath: string },
  now: Date,
): Promise<HandoffOutcome> {
  const projectId = preview.projectId
  const projectDir = deps.projectDirOf(projectId)

  // ① 归档副本才是输入：逐份回读重算指纹（源文件后来被改动不影响这里）。
  const current: MaterialMetadata[] = []
  for (const file of preview.files) {
    const path = deps.projectPath(projectId, file.archiveRelativePath)
    let bytes: Uint8Array
    try {
      bytes = await deps.readArchiveBytes(path)
    } catch (error) {
      return failure('infrastructure',
        `归档副本读不回来（${file.fileName}）：${messageOf(error)}`,
        dispositionFor(boundSessionId), { projectId, parentSessionId: boundSessionId })
    }
    current.push({ ...file, sizeBytes: bytes.length, sha256: sha256OfBytes(bytes) })
  }
  const currentDigest = valuationInputDigest({
    assetType: preview.assetType,
    methodRequest: preview.methodRequest,
    baseDate: preview.baseDate,
    purpose: preview.purpose,
    valueType: preview.valueType,
    // The template role is part of the recomputed identity.
    templateFileId: preview.templateFileId,
    supplementalPrompt: preview.supplementalPrompt,
    files: current,
  })
  if (currentDigest !== preview.inputDigest) {
    return failure('conflict',
      '案例目录里的归档副本已经和确认时不一样了：请返回修改并重新确认（不会按旧摘要启动）。',
      dispositionFor(boundSessionId), { projectId, parentSessionId: boundSessionId })
  }
  if (confirmed !== preview.inputDigest) {
    return failure('conflict',
      '确认摘要与宿主预览不一致（确认之后输入变过）：请返回修改并重新确认。',
      dispositionFor(boundSessionId), { projectId, parentSessionId: boundSessionId })
  }

  // ② 父会话：已建过就复用（重试路径），否则走统一工作区会话服务建一条。
  let parentSessionId = boundSessionId
  let reused = parentSessionId !== ''
  let workspaceId = selected.workspaceId
  let workspacePath = selected.workspacePath
  const made = await deps.ensureProjectDirectory(projectDir)
  if (!made.ok) {
    return failure(made.errorKind === 'policy' ? 'policy' : 'infrastructure',
      `创建估值项目目录失败：${made.error}`, dispositionFor(parentSessionId), { projectId, parentSessionId, reused })
  }
  if (!reused) {
    const created = await deps.createSession({ title: `房地产估值 · ${projectId}`, source: 'report-evaluation' })
    if (!created.ok || created.sessionId === '') {
      // 会话服务没给出会话 id：连"建到一半"的证据都没有，可以安全地说是未创建。
      return failure('infrastructure', `创建估值父会话失败：${created.error || '会话服务没有返回会话 id'}`,
        'not-created', { projectId })
    }
    parentSessionId = created.sessionId
    workspaceId = created.workspaceId || workspaceId
    workspacePath = created.workspacePath || workspacePath
    const bound = await deps.store.bindSession(projectId, parentSessionId)
    if (!bound.ok) {
      // 会话**已经建出来了**（`parentSessionId` 非空），只是没登记进交接记录：重试必须发回
      // 同一条会话，所以这里既不能报"未创建"，也不能假装一切正常。
      return failure('infrastructure', `登记父会话失败：${bound.error}`, 'created', { projectId, parentSessionId })
    }
  }

  // ③ 只读输入 + 交接清单（两份都**不含原始绝对路径**）+ 案例 scope。
  const materials = toArchivedMaterials(preview.files)
  const frozen = buildFrozenInput({
    projectId,
    // 资产类型与其它前提一样是**用户确认过的输入**：进冻结输入与摘要，不由 Host 默认。
    assetType: preview.assetType,
    methodRequest: preview.methodRequest,
    baseDate: preview.baseDate,
    // 评估目的 / 价值类型（P16）：未指定就是 `null`，绝不在交接这一层替用户默认一个正式结论。
    purpose: preview.purpose,
    valueType: preview.valueType,
    // Store only the archived fileId; never the original absolute path.
    templateFileId: preview.templateFileId,
    supplementalPrompt: preview.supplementalPrompt,
    files: materials,
    inputDigest: preview.inputDigest,
  })
  const bindOutcome = deps.bindScope({
    valuationId: projectId,
    projectId,
    previewId: preview.previewId,
    casePath: projectDir,
    sessionId: parentSessionId,
    parentSessionId,
    workspaceId,
    workspacePath,
    snapshot: {
      valuationId: projectId,
      method: preview.methodRequest,
      baseDate: preview.baseDate ?? '',
      purpose: preview.purpose ?? '',
      valueType: preview.valueType ?? '',
      assetType: preview.assetType,
      templateFileId: preview.templateFileId,
      supplementalPrompt: preview.supplementalPrompt,
      digest: preview.inputDigest,
      files: materials.map((file) => ({
        fileName: file.fileName,
        relativePath: file.archiveRelativePath,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      })),
      frozenAt: now.toISOString(),
    },
    planIds: [],
    openedAt: now.getTime(),
  })
  if (typeof bindOutcome === 'object' && bindOutcome !== null && bindOutcome.ok !== true) {
    // The parent session exists, but this round is already bound to a foreign identity:
    // fail closed with the actual parent instead of overwriting a live Graph runtime scope.
    return failure('conflict',
      text(bindOutcome.error) || '这一轮估值的案例归属已经被占用：本次交接已停止，不会覆盖正在运行的归属。',
      'created', { projectId, parentSessionId, reused, recoveryAction: 'retry-handoff' })
  }

  const inputWritten = await deps.writeProjectFile(
    deps.projectPath(projectId, '估值输入.json'), canonicalJson(frozen))
  if (!inputWritten.ok) {
    return failure('infrastructure', `冻结输入落盘失败：${inputWritten.error}`,
      dispositionFor(parentSessionId), { projectId, parentSessionId, reused })
  }
  const manifestWritten = await deps.writeProjectFile(
    deps.projectPath(projectId, HANDOFF_MANIFEST_FILE),
    canonicalJson({
      schemaVersion: 'crwu.valuation.handoff-manifest.v1',
      requestId: preview.requestId,
      previewId: preview.previewId,
      projectId,
      inputDigest: preview.inputDigest,
      parentSessionId,
      methodRequest: preview.methodRequest,
      baseDate: preview.baseDate,
      // 评估目的与价值类型同样进交接清单：它是"这一轮到底在做什么"的一部分，要能事后核对。
      purpose: preview.purpose,
      valueType: preview.valueType,
      // Template role, for later audit of which workbook was used.
      templateFileId: preview.templateFileId,
      materialDir: VALUATION_MATERIAL_DIR,
      files: materials.map((file) => ({
        fileId: file.fileId,
        fileName: file.fileName,
        archiveRelativePath: file.archiveRelativePath,
        sha256: file.sha256,
        duplicateOf: file.duplicateOf,
      })),
      dispatchedAt: now.toISOString(),
    }))
  if (!manifestWritten.ok) {
    return failure('infrastructure', `交接清单落盘失败：${manifestWritten.error}`,
      dispositionFor(parentSessionId), { projectId, parentSessionId, reused })
  }

  // ③-b **受保护的项目记录**（P18）：恢复归属时唯一可读的"这一轮是什么"的事实源。
  // 它与冻结输入、交接记录在同一处落盘（面板来源、Broker 提权、Host 派生路径）；
  // 写不进去就**不前进** —— 否则重启后这一轮将没有任何可核对的记录，只能永久卡死。
  const recordWritten = await deps.writeProjectFile(
    deps.projectPath(projectId, PROJECT_RECORD_FILE),
    canonicalJson(buildProjectRecord({
      schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
      protocolVersion: WORKBENCH_PROTOCOL,
      inputSchemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
      valuationId: projectId,
      projectId,
      previewId: preview.previewId,
      casePath: projectDir,
      workspaceId,
      workspacePath,
      sessionId: parentSessionId,
      // planIds：交接这一刻还没有登记方案（方案由 `crwu_valuation_project_prepare` 登记）。
      // 目前没有"登记方案时刷新项目记录"的调用点，见报告里的残留风险。
      planIds: [],
      phase: 'running',
      assetType: preview.assetType,
      methodRequest: preview.methodRequest,
      baseDate: preview.baseDate,
      purpose: preview.purpose,
      valueType: preview.valueType,
      templateFileId: preview.templateFileId,
      supplementalPrompt: preview.supplementalPrompt,
      inputDigest: preview.inputDigest,
      files: projectRecordFiles(materials),
      createdAt: now.toISOString(),
    })),
  )
  if (!recordWritten.ok) {
    return failure('infrastructure', `项目记录落盘失败：${recordWritten.error}`,
      dispositionFor(parentSessionId), { projectId, parentSessionId, reused })
  }

  const receipt: HandoffReceipt = { projectId, parentSessionId, dispatchAccepted: true, reused }
  await deps.onHandoff?.(receipt, frozen)

  // ④ 固定指令。`messageId` **稳定**（同一个项目永远同一个 id）：发送已受理但 RPC 超时时，
  //    重试复用同一条会话、同一个 messageId，接收侧不会把同一条指令应用两次。
  //
  // 装配了工作流图时，唯一要发的是 Host 铸造的不透明命令（只含 commandId）；
  // 旧的整套 SOP 指令只保留给**没有**工作流钩子的兼容路径。
  let prompt: string
  const prepareHandoff = deps.prepareHandoff
  if (prepareHandoff !== undefined) {
    const prepared = await prepareHandoff({ receipt, frozen })
    if (!prepared.ok) {
      // The parent session already exists: never dispatch a legacy SOP and never claim
      // it was not created. Retrying reuses this exact session.
      return failure('infrastructure',
        prepared.error === undefined || prepared.error === '' ? '工作流图登记失败：未发出固定指令' : prepared.error,
        'created', { projectId, parentSessionId, reused, recoveryAction: 'retry-handoff' })
    }
    prompt = prepared.prompt
  } else {
    prompt = valuationPrompt({
      valuationId: projectId,
      casePath: projectDir,
      assetType: preview.assetType,
      method: preview.methodRequest,
      baseDate: preview.baseDate ?? '',
      purpose: preview.purpose ?? '',
      valueType: preview.valueType ?? '',
      supplementalPrompt: preview.supplementalPrompt,
      digest: preview.inputDigest,
      files: materials.map((file) => ({
        fileName: file.fileName, relativePath: file.archiveRelativePath, kind: file.kind, sizeBytes: file.sizeBytes,
      })),
      // 提取由**父会话**在本轮内做一次（Host 不在确认前提取，也不在交接时假装提取过）。
      extraction: materials.map((file) => ({
        fileName: file.fileName, parsed: false, fieldCount: 0,
        note: '尚未提取：请在父会话里调用一次 crwu_valuation_file_extract',
      })),
      knowledge: [],
      // 知识的取用在会话内按**库侧入口 Wiki** 进行：交接这一刻不去取（还没定方法，也没必要让
      // 一次知识库抖动挡住建会话），也**不声称任何"知识已就绪"**。
      //
      // 来源策略**不是空数组**：登录是可选用能力，父会话必须先知道配置里有哪些来源、各自
      // 必需还是可选、以及"现在还没有状态"这个事实，才能按知识库的渠道与降级策略往下走。
      sources: deps.sources.map((source) => ({ ...source })),
      validateScripts: [
        { name: '工作簿契约', script: joinLocalPath(projectDir, 'scripts/check_workbook_contract.py'), args: [joinLocalPath(projectDir, VALUATION_WORKBOOK_FILE)] },
        { name: '报告数据', script: joinLocalPath(projectDir, 'scripts/build_report_data.py'), args: ['--validate', joinLocalPath(projectDir, VALUATION_REPORT_DATA_FILE)] },
      ],
    })
  }
  const sent = await deps.dispatch({ sessionId: parentSessionId, messageId: `msg-valuation-${projectId}`, prompt })
  if (!sent.accepted) {
    return failure('infrastructure',
      `估值指令没有被受理（父会话已经建好，重试会复用同一条会话）：${sent.error}`,
      'created', { projectId, parentSessionId, reused, recoveryAction: 'retry-handoff' })
  }
  const accepted = await deps.store.acceptDispatch(projectId, receipt)
  if (!accepted.ok) {
    return failure('infrastructure', `交接回执落盘失败：${accepted.error}`,
      'created', { projectId, parentSessionId, reused, recoveryAction: 'retry-handoff' })
  }
  return { ok: true, errorKind: '', error: '', creationDisposition: 'created', ...receipt }
}

/** 组装 `valuation-start` 的依赖（Broker / 统一会话服务 / 工具可见性都在这里接）。 */
export interface HandoffOperationDeps {
  ctx: Context
  state: WorkbenchState
  access: LocalAccessBroker
  world: WorldFacts
  previews: PreviewRegistry
  store: HandoffStore
  /** 轮次记录：交接成功后登记一轮（供工具回写与 v1 监控操作读取）。 */
  lifecycles: ValuationLifecycles
  scopes: ValuationScopes
  /**
   * 来源策略（协议 39）：配置里有哪些案例来源、各自必需还是可选、为什么现在还没有状态。
   *
   * 交接发生在检索之前，所以这里的 `state` 诚实取值是 `'unknown'` —— 但**列表不能为空**：
   * 父会话必须拿到来源与原因，才能按知识库的降级策略选替代来源。
   */
  sources: readonly ValuationSourceFact[]
  /**
   * 可选的工作流图登记钩子（由 Host 工厂提供）。装配了它就在交接后发不透明命令，
   * 并把 `crwu_valuation_workflow_run` 纳入本轮工具可见性预检。
   */
  prepareHandoff?: WorkflowPrepareHandoffHook
}

export function createHandoffOperations(deps: HandoffOperationDeps): OperationMap {
  const { ctx, state, access, world } = deps
  const service = () => workspaceSessionService(ctx, state)

  const requireWorkspace = async () => {
    const selected = await service().requireSelectedWorkspace()
    if (!selected.ok) return { ok: false as const, error: selected.error, workspaceId: '', workspacePath: '' }
    return {
      ok: true as const,
      error: '',
      workspaceId: selected.workspace.id,
      workspacePath: selected.workspace.path,
    }
  }

  const handoffDeps: HandoffDeps = {
    previews: deps.previews,
    store: deps.store,
    sources: deps.sources,
    // Host 铸造的不透明命令由工作流工厂在冻结输入/项目记录落盘之后给出。
    ...(deps.prepareHandoff === undefined ? {} : { prepareHandoff: deps.prepareHandoff }),
    workspace: requireWorkspace,
    createSession: async (input) => {
      const created = await service().createSession({ title: input.title, source: input.source })
      if (!created.ok) {
        return { ok: false, error: created.error, sessionId: '', workspaceId: '', workspacePath: '' }
      }
      return {
        ok: true,
        error: '',
        sessionId: created.sessionId,
        workspaceId: created.workspace.id,
        workspacePath: created.workspace.path,
      }
    },
    ensureProjectDirectory: async (path) => {
      const selected = await service().requireSelectedWorkspace()
      if (!selected.ok) return { ok: false, error: selected.error, errorKind: 'policy' }
      const platform = await world.platform()
      // 面板来源（没有会话）：建目录必须逐次声明提权，否则命令落在部署默许的沙箱里被拒。
      const made = await ensureCaseDirectory(access, path, {
        workspace: selected.workspace.path,
        probeWorkdir: await world.workdir(),
        platform,
        source: 'panel',
      })
      return { ok: made.ok, error: made.error, errorKind: made.errorKind }
    },
    writeProjectFile: async (path, content) => {
      const selected = await service().requireSelectedWorkspace()
      if (!selected.ok) return { ok: false, error: selected.error, errorKind: 'policy' }
      const written = await writePanelCaseFile(access, {
        ctx, path, content, workspaceRoot: selected.workspace.path,
      })
      return { ok: written.ok, error: written.error, errorKind: written.errorKind }
    },
    readArchiveBytes: async (path) => new Uint8Array(await readFile(path)),
    dispatch: async ({ sessionId, messageId, prompt }) => {
      const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
      const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      const followup = (agent as { followup?: (message: unknown) => void } | undefined)?.followup
      if (typeof followup !== 'function') {
        return { accepted: false, error: '估值父会话的 Agent 不在运行中：无法发送固定指令（会话已建好，可重试）' }
      }
      try {
        followup.call(agent, {
          id: messageId,
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        })
        return { accepted: true, error: '' }
      } catch (error) {
        return { accepted: false, error: messageOf(error) }
      }
    },
    bindScope: (scope) => {
      const existing = deps.scopes.get(scope.valuationId)
      if (existing === undefined) {
        // First bind for this round: open exactly once.
        deps.scopes.open(scope)
        return { ok: true as const }
      }
      // A retry with the exact same round identity keeps the original scope verbatim
      // (including `openedAt` and every registered `planId`); a foreign binding fails
      // closed instead of overwriting a live Graph runtime scope.
      if (sameScopeIdentity(existing, scope)) return { ok: true as const }
      return {
        ok: false as const,
        error: '这一轮估值的案例归属已经绑定了另一条会话 / 工作空间：为避免覆盖正在运行的归属，本次交接已停止。',
      }
    },
    onHandoff: async (receipt, frozen) => {
      const selected = await service().requireSelectedWorkspace()
      if (!selected.ok) return
      const casePath = joinLocalPath(selected.workspace.path, receipt.projectId)
      const existing = deps.lifecycles.get(receipt.projectId)
      if (existing === undefined) {
        deps.lifecycles.open({
          valuationId: receipt.projectId,
          casePath,
          workspaceId: selected.workspace.id,
          workspacePath: selected.workspace.path,
          method: frozen.methodRequest,
          baseDate: frozen.baseDate ?? '',
          supplementalPrompt: frozen.supplementalPrompt,
          digest: frozen.inputDigest,
          sessionId: receipt.parentSessionId,
        })
      } else {
        deps.lifecycles.update(receipt.projectId, existing.phase, {
          sessionId: receipt.parentSessionId, digest: frozen.inputDigest,
        })
      }
      // 父会话已经接手：轮次记录直接推到 `running`（页面这一代不再读轮次阶段，
      // 但宿主自己的记录要能反映"会话已经在跑"）。原来是 monitor.ts 里的一个小工具，
      // 监控那一层随 Task 4 下线后由这里自己走一遍（同一处、同一个语义）。
      for (const step of ['extracting', 'confirmation', 'queued', 'running'] as const) {
        const current = deps.lifecycles.get(receipt.projectId)
        if (current === undefined || current.phase === step) continue
        deps.lifecycles.update(receipt.projectId, step, {})
      }
    },
    missingTools: () => {
      const missing = [...missingValuationTools(ctx)]
      // The parent session can only enter the graph through the control tool: when the
      // workflow hook is wired, that registered tool is part of this round's required set.
      if (deps.prepareHandoff !== undefined) {
        for (const name of missingAuditTools(ctx, undefined, [VALUATION_TOOL_NAMES.workflowRun])) {
          if (!missing.includes(name)) missing.push(name)
        }
      }
      return missing
    },
    projectDirOf: (projectId) => joinLocalPath(state.workspacePath, projectId),
    projectPath: (projectId, relative) => joinLocalPath(joinLocalPath(state.workspacePath, projectId), relative),
    now: () => new Date(),
  }

  return {
    'valuation-start': async (args) => await handoffProject({
      previewId: text(args.previewId),
      confirmedInputDigest: text(args.confirmedInputDigest),
      requestId: text(args.requestId),
    }, handoffDeps),
  }
}

export type { HandoffOutcome as HandoffResult }
export { HANDOFF_RECORD_FILE }
