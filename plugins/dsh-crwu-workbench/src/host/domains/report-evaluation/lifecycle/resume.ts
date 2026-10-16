import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import type { FailureEnvelope } from '../../../../shared/contracts/valuation-project.ts'
import { VALUATION_INPUT_SCHEMA_VERSION } from '../../../../shared/contracts/valuation-project.ts'
import { VALUATION_INPUT_FILE } from '../../../tools/report-evaluation/consts.ts'
import { sha256OfBytes } from '../intake/manifest.ts'
import { valuationInputDigest } from '../intake/preview.ts'
import { isSafeValuationId, type ValuationMethod, type ValuationScope } from '../scope.ts'
import {
  PROJECT_RECORD_FILE,
  materialOfEntry,
  projectRecordCompatibility,
  projectRecordFinished,
  projectRecordOf,
  type ProjectRecord,
} from './project-record.ts'
import { isTerminalPhase, type RecordPatch, type ValuationPhase, type ValuationRecord } from './state.ts'

/**
 * **项目归属的显式恢复 / 重新绑定**（P18）。
 *
 * ## 为什么需要一条独立的恢复路径，而不是"重建注册表时顺手再开一次"
 *
 * 估值会话的案例归属是进程内的（按会话 id 逐字绑定）。插件实例重建之后，同一份案例目录
 * 仍然在磁盘上，但**没有任何东西**能把"这条父会话 = 这个项目目录"这条事实重新立起来。
 * 唯一安全的做法是把恢复做成一条**受控的、逐项核对过的**操作：
 *
 * ```text
 * projectId  →  Host 从已选工作空间派生项目目录  →  逐项核对  →  绑回同一个 projectId / 会话 / 冻结输入
 * ```
 *
 * ## 逐项核对（顺序即诊断优先级，任何一项不符都拒绝）
 *
 * | # | 判据 | 为什么 |
 * | --- | --- | --- |
 * | ① | 本机访问授权收据仍有效 | 未授权时连读盘都不该发生（fail closed 的前置） |
 * | ② | 当前选中的工作区可解析 | 恢复的落点只能是"现在选中的那个"工作区 |
 * | ③ | 项目目录由 Host **派生**（`<工作区>/<projectId>`） | 记录里的 `casePath` 只被核对，不被采用 |
 * | ④ | 记录合法（Schema / 自身指纹） | 损坏、被改过、不是本插件写的记录一律不认 |
 * | ⑤ | 协议代与冻结输入 Schema 兼容（严格相等） | 跨代恢复必须是显式决定，不能猜 |
 * | ⑥ | 记录的工作区与当前工作区逐字一致 | 换过工作区就不许恢复（内容会写进旧目录） |
 * | ⑦ | 交接记录说"已派发"且父会话 id 与记录一致 | 不恢复一条指令根本没送到的轮次 |
 * | ⑧ | 会话仍存在且属于本工作区 | 不存在时**如实报告**并给"重新创建父会话"的显式动作 |
 * | ⑨ | `估值输入.json` 与记录逐字段一致 | 冻结输入是这一轮的输入事实，不能只看目录里有没有文件 |
 * | ⑩ | `材料-源/*` 的**实际字节**能重算出同一个摘要 | 摘要是判据，磁盘字节是它的唯一来源 |
 *
 * ## 两个"绝不"
 *
 * - **绝不**因为案例目录里有 JSON 就授予旧会话访问权：文件是候选，判据是上面十条；
 * - **绝不**新建第二套目录或重复派发：恢复只写进程内注册表，不建会话、不发指令、不建目录。
 */
export interface ResumeRequest {
  /** 只接受项目 id（Host 铸号）；调用方提交不了目录、会话 id 或沙箱参数。 */
  projectId: string
}

export interface ResumeWorkspace {
  ok: boolean
  error: string
  workspaceId: string
  workspacePath: string
}

/** 恢复要写回的**轮次注册表**面（进程内）。 */
export interface ResumeLifecycles {
  get(valuationId: string): ValuationRecord | undefined
  open(input: {
    valuationId: string
    casePath: string
    workspaceId: string
    workspacePath: string
    method: ValuationMethod
    baseDate: string
    digest: string
    supplementalPrompt?: string
    sessionId?: string
  }): { ok: boolean; error: string }
  update(valuationId: string, to: ValuationPhase, patch?: RecordPatch): { ok: boolean; error: string }
  close(valuationId: string): boolean
}

export interface ResumeDeps {
  /** 本机访问授权收据是否仍有效。 */
  accessGranted(): boolean
  /** 当前选中的工作区（唯一来源，不接受任何降级来源）。 */
  workspace(): Promise<ResumeWorkspace>
  /** 读项目目录内的文本（读不到必须抛）。 */
  readProjectText(path: string): Promise<string>
  /** 读项目目录内的字节（读不到必须抛）。 */
  readProjectBytes(path: string): Promise<Uint8Array>
  /** 两个路径是不是同一个目录（规范解析后比较）。 */
  samePath(left: string, right: string): Promise<boolean>
  /** 会话是否仍存在且属于给定工作区（`verifyPlacement`）。 */
  verifySession(placement: { workspaceId: string; workspacePath: string; sessionId: string }):
  Promise<{ ok: boolean; reason: string }>
  /** 交接记录给出的权威会话（缺失 = 这一轮没有完成交接）。 */
  recordedHandoff(projectId: string): Promise<{ state: string; parentSessionId: string } | undefined>
  /** 案例 scope 注册表（恢复成功时写入）。 */
  scopes: { open(scope: ValuationScope): void }
  /** 轮次注册表（恢复成功时写入）。 */
  lifecycles: ResumeLifecycles
  now(): Date
}

export interface ResumeOutcome {
  ok: boolean
  /** 成功时是空串；失败时是结构化类别。 */
  errorKind: FailureEnvelope['errorKind'] | ''
  error: string
  projectId: string
  casePath: string
  parentSessionId: string
  inputDigest: string
  method: string
  baseDate: string
  purpose: string
  valueType: string
  fileCount: number
  planIds: string[]
  phase: string
  /** 恢复**必然**复用同一个项目目录与同一条会话：只有拒绝时才是 false。 */
  reused: boolean
  /**
   * 需要员工/宿主做一件事时的**显式动作**。
   *
   * 目前只有一个取值：`recreate-parent-session`（父会话已不存在）——
   * 恢复路径**不会**自己新建一条，因为那会绕开"同一轮"这个前提。
   */
  action: string
}

/** 记录里的阶段 → 重新建立轮次记录时要走的合法路径。 */
const PHASE_PATH: readonly ValuationPhase[] = [
  'extracting', 'confirmation', 'queued', 'running', 'browser-login-required',
]

function failure(
  errorKind: FailureEnvelope['errorKind'],
  error: string,
  patch: Partial<ResumeOutcome> = {},
): ResumeOutcome {
  return {
    ok: false,
    errorKind,
    error,
    projectId: '',
    casePath: '',
    parentSessionId: '',
    inputDigest: '',
    method: '',
    baseDate: '',
    purpose: '',
    valueType: '',
    fileCount: 0,
    planIds: [],
    phase: '',
    reused: false,
    action: '',
    ...patch,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 恢复这一轮：核不过就拒绝，核得过就把同一份归属绑回来。 */
export async function resumeProject(input: ResumeRequest, deps: ResumeDeps): Promise<ResumeOutcome> {
  const projectId = text(input.projectId).trim()
  if (projectId === '' || !isSafeValuationId(projectId)) {
    return failure('input-invalid', '项目 id 不合法：它必须是 Host 铸出的单段目录名（不含分隔符与 `..`）。')
  }
  // ① 授权收据：未授权时**不读盘**（拒绝的前置，也避免把本机内容读进内存）。
  if (!deps.accessGranted()) {
    return failure('policy',
      '还没有允许工作台读取本机配置（授权收据无效或已撤销）：恢复项目需要本机访问权限，请先在环境信息里允许。',
      { projectId })
  }
  // ② 当前选中的工作区（唯一来源；换过工作区就不恢复）。
  const selected = await deps.workspace()
  if (!selected.ok) {
    return failure('policy', `当前工作区不成立，无法恢复：${selected.error}`, { projectId })
  }
  // ③ 项目目录**由 Host 派生**：记录里的 `casePath` 只被核对，不被采用。
  const projectDir = joinLocalPath(selected.workspacePath, projectId)
  const recordPath = joinLocalPath(projectDir, PROJECT_RECORD_FILE)

  let recordRaw: string
  try {
    recordRaw = await deps.readProjectText(recordPath)
  } catch (error) {
    return failure('not-found',
      `项目目录里没有可恢复的项目记录（${PROJECT_RECORD_FILE}）：${messageOf(error)}。`
      + '恢复只认这一份受保护的记录，不会因为案例目录里有其它 JSON 就授权。',
      { projectId, casePath: projectDir })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(recordRaw)
  } catch (error) {
    return failure('conflict', `项目记录不是合法 JSON（${messageOf(error)}）：不能据此恢复。`,
      { projectId, casePath: projectDir })
  }
  // ④ 记录合法 + 自身指纹一致。
  const read = projectRecordOf(parsed)
  if (!read.ok) {
    return failure('conflict', `项目记录不可用：${read.error}。`, { projectId, casePath: projectDir })
  }
  const record: ProjectRecord = read.record
  if (record.projectId !== projectId) {
    return failure('conflict',
      `项目记录里的项目 id（${record.projectId}）与请求的 id（${projectId}）不一致：拒绝按记录恢复。`,
      { projectId, casePath: projectDir })
  }
  // ⑤ 协议代 / 冻结输入 Schema：严格相等。
  const incompatible = projectRecordCompatibility(record)
  if (incompatible !== '') {
    return failure('capability-gap', incompatible, { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  if (projectRecordFinished(record)) {
    return failure('policy',
      `这一轮估值已经结束（${record.phase}）：不能恢复已结束的轮次（要重来请重新发起）。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  if (record.phase === 'stale-host' || !PHASE_PATH.includes(record.phase)) {
    return failure('conflict',
      `项目记录里的状态（${record.phase}）不是可以恢复的阶段：拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  // ⑥ 工作区与记录一致（id 逐字、两条路径规范解析后相等）。
  if (record.workspaceId !== selected.workspaceId) {
    return failure('policy',
      `项目记录属于另一个工作区（记录 ${record.workspaceId}，当前 ${selected.workspaceId}）：`
      + '恢复只会发生在同一个工作区里，请先切回那个工作区。',
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  if (!await deps.samePath(record.workspacePath, selected.workspacePath)) {
    return failure('policy',
      `项目记录里的工作区路径（${record.workspacePath}）与当前选定工作区（${selected.workspacePath}）不是同一个目录：拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  // ③-b：记录里的案例目录必须**正好**是 Host 刚派生出来的那一个。
  if (!await deps.samePath(record.casePath, projectDir)) {
    return failure('policy',
      `项目记录里的案例目录（${record.casePath}）不是 Host 从当前工作空间派生出来的那一个（${projectDir}）：拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  // ⑦ 交接记录：这一轮必须真的派发过，而且父会话 id 与记录一致。
  const handoff = await deps.recordedHandoff(projectId)
  if (handoff === undefined) {
    return failure('not-found',
      `没有找到这一轮的交接记录（交接记录.json）：无法确认父会话是哪一条，拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  if (handoff.state !== 'dispatched') {
    return failure('conflict',
      `这一轮的交接没有完成（状态 ${handoff.state || '空'}）：固定指令没有送到父会话，拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  if (handoff.parentSessionId !== record.sessionId) {
    return failure('conflict',
      '项目记录与交接记录给出的父会话不是同一条：拒绝恢复（不会挑其中一条用）。',
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  // ⑧ 会话仍存在且属于本工作区。
  const verdict = await deps.verifySession({
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
  })
  if (!verdict.ok) {
    return failure('policy',
      `这一轮的父会话已经不在了（${verdict.reason}）：不会静默新建父会话。`
      + '请显式**重新创建父会话**（本轮项目目录与冻结输入保持不变，可继续使用）。',
      { projectId, casePath: projectDir, action: 'recreate-parent-session' })
  }
  // ⑨ 冻结输入文件：逐字段与记录一致。
  let frozenRaw: string
  try {
    frozenRaw = await deps.readProjectText(joinLocalPath(projectDir, VALUATION_INPUT_FILE))
  } catch (error) {
    return failure('conflict',
      `案例目录里的 ${VALUATION_INPUT_FILE} 读不回来：${messageOf(error)}。恢复需要它来核对冻结输入。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  let frozen: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(frozenRaw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是一个 JSON 对象')
    frozen = value as Record<string, unknown>
  } catch (error) {
    return failure('conflict',
      `${VALUATION_INPUT_FILE} 不是合法 JSON（${messageOf(error)}）：无法核对冻结输入。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  const frozenProblem = frozenInputProblem(record, frozen)
  if (frozenProblem !== '') {
    return failure('conflict', frozenProblem, { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  // ⑩ 材料字节：逐份重算 sha256，再用**磁盘上的字节**重算输入摘要。
  for (const entry of record.files) {
    let bytes: Uint8Array
    try {
      bytes = await deps.readProjectBytes(joinLocalPath(projectDir, entry.archiveRelativePath))
    } catch (error) {
      return failure('conflict',
        `材料-源 里的归档副本读不回来（${entry.fileName}）：${messageOf(error)}。`,
        { projectId, casePath: projectDir, parentSessionId: record.sessionId })
    }
    const sha = sha256OfBytes(bytes)
    if (bytes.length !== entry.sizeBytes || sha !== entry.sha256) {
      return failure('conflict',
        `材料-源/${entry.fileName} 的字节与项目记录不一致（记录 ${String(entry.sizeBytes)} 字节 / ${entry.sha256}，`
        + `磁盘 ${String(bytes.length)} 字节 / ${sha}）：拒绝恢复。`,
        { projectId, casePath: projectDir, parentSessionId: record.sessionId })
    }
  }
  const recomputed = valuationInputDigest({
    assetType: record.assetType,
    methodRequest: record.methodRequest,
    baseDate: record.baseDate,
    purpose: record.purpose,
    valueType: record.valueType,
    supplementalPrompt: record.supplementalPrompt,
    files: record.files.map(materialOfEntry),
  })
  if (recomputed !== record.inputDigest) {
    return failure('conflict',
      `按磁盘上的材料重算出的输入摘要（${recomputed}）与项目记录（${record.inputDigest}）不一致：拒绝恢复。`,
      { projectId, casePath: projectDir, parentSessionId: record.sessionId })
  }
  const restored = restoreBindings(record, deps)
  if (!restored.ok) {
    return failure('infrastructure', `恢复项目归属失败：${restored.error}`, {
      projectId, casePath: projectDir, parentSessionId: record.sessionId,
    })
  }
  return {
    ok: true,
    errorKind: '',
    error: '',
    projectId: record.projectId,
    casePath: record.casePath,
    parentSessionId: record.sessionId,
    inputDigest: record.inputDigest,
    method: record.methodRequest,
    baseDate: record.baseDate ?? '',
    purpose: record.purpose ?? '',
    valueType: record.valueType ?? '',
    fileCount: record.files.length,
    planIds: [...record.planIds],
    phase: record.phase,
    reused: true,
    action: '',
  }
}

/** 冻结输入与记录的逐字段核对（任一不符返回一句人话）。 */
function frozenInputProblem(record: ProjectRecord, frozen: Record<string, unknown>): string {
  if (text(frozen.schemaVersion) !== VALUATION_INPUT_SCHEMA_VERSION) {
    return `${VALUATION_INPUT_FILE} 的 Schema 版本不是本版认识的（${text(frozen.schemaVersion) || '空'}）：拒绝恢复。`
  }
  if (text(frozen.projectId) !== record.projectId) {
    return `${VALUATION_INPUT_FILE} 属于另一个项目（${text(frozen.projectId) || '空'}）：拒绝恢复。`
  }
  if (text(frozen.inputDigest) !== record.inputDigest) {
    return `${VALUATION_INPUT_FILE} 的输入摘要（${text(frozen.inputDigest) || '空'}）与项目记录（${record.inputDigest}）不一致：拒绝恢复。`
  }
  if (text(frozen.methodRequest) !== record.methodRequest) {
    return `${VALUATION_INPUT_FILE} 的方法（${text(frozen.methodRequest) || '空'}）与项目记录（${record.methodRequest}）不一致：拒绝恢复。`
  }
  const baseDate = frozen.baseDate === null || frozen.baseDate === undefined ? '' : text(frozen.baseDate)
  if (baseDate !== (record.baseDate ?? '')) {
    return `${VALUATION_INPUT_FILE} 的基准日（${baseDate || '空'}）与项目记录（${record.baseDate ?? '空'}）不一致：拒绝恢复。`
  }
  for (const [label, fromFile, fromRecord] of [
    ['评估目的', frozen.purpose, record.purpose],
    ['价值类型', frozen.valueType, record.valueType],
  ] as const) {
    const actual = fromFile === null || fromFile === undefined ? '' : text(fromFile)
    if (actual !== (fromRecord ?? '')) {
      return `${VALUATION_INPUT_FILE} 的${label}（${actual || '空'}）与项目记录（${fromRecord ?? '空'}）不一致：拒绝恢复。`
    }
  }
  if (text(frozen.supplementalPrompt) !== record.supplementalPrompt) {
    return `${VALUATION_INPUT_FILE} 的补充要求与项目记录不一致：拒绝恢复。`
  }
  const files = Array.isArray(frozen.files) ? frozen.files : []
  if (files.length !== record.files.length) {
    return `${VALUATION_INPUT_FILE} 的材料份数（${String(files.length)}）与项目记录（${String(record.files.length)}）不一致：拒绝恢复。`
  }
  for (const [index, item] of files.entries()) {
    const entry = record.files[index]
    const row = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown> : {}
    if (
      text(row.fileId) !== entry.fileId
      || text(row.archiveRelativePath) !== entry.archiveRelativePath
      || text(row.sha256) !== entry.sha256
      || row.sizeBytes !== entry.sizeBytes
    ) {
      return `${VALUATION_INPUT_FILE} 第 ${String(index + 1)} 份材料与项目记录不一致（${entry.fileName}）：拒绝恢复。`
    }
  }
  return ''
}

/**
 * 把归属写回**进程内**注册表：复用同一个 projectId、同一条会话、同一份冻结输入。
 *
 * 不建目录、不建会话、不发指令 —— 恢复的全部副作用就是这两处内存写入。
 * 顺序刻意是"先轮次、后 scope"：`scopes.open` 不会失败，所以失败时不会留下半个绑定。
 */
function restoreBindings(record: ProjectRecord, deps: ResumeDeps): { ok: boolean; error: string } {
  const existing = deps.lifecycles.get(record.projectId)
  if (existing !== undefined) {
    // 进程内已经有这一轮（例如刚刚被恢复过）：只对齐会话与指纹，不改它自己的阶段。
    // 但它要是已经**结束**了，就不该再被绑回来 —— 结束的轮次没有可恢复的东西。
    if (isTerminalPhase(existing.phase)) {
      return { ok: false, error: `宿主里这一轮已经是终态「${existing.phase}」：不能重新绑定（要重来请重新发起）` }
    }
    const updated = deps.lifecycles.update(record.projectId, existing.phase, {
      sessionId: record.sessionId, digest: record.inputDigest,
    })
    if (!updated.ok) return { ok: false, error: updated.error }
  } else {
    const opened = deps.lifecycles.open({
      valuationId: record.projectId,
      casePath: record.casePath,
      workspaceId: record.workspaceId,
      workspacePath: record.workspacePath,
      method: record.methodRequest,
      baseDate: record.baseDate ?? '',
      supplementalPrompt: record.supplementalPrompt,
      digest: record.inputDigest,
      sessionId: record.sessionId,
    })
    if (!opened.ok) return { ok: false, error: opened.error }
    // 从 `draft` 沿合法路径推到记录里的阶段（与交接成功后走的是同一段转移表）。
    for (const step of PHASE_PATH) {
      const current = deps.lifecycles.get(record.projectId)
      if (current === undefined || current.phase === record.phase) break
      const moved = deps.lifecycles.update(record.projectId, step, {})
      if (!moved.ok) {
        deps.lifecycles.close(record.projectId)
        return { ok: false, error: moved.error }
      }
      if (step === record.phase) break
    }
    const reached = deps.lifecycles.get(record.projectId)
    if (reached === undefined || reached.phase !== record.phase) {
      deps.lifecycles.close(record.projectId)
      return { ok: false, error: `恢复后的轮次阶段停在「${reached?.phase ?? '（没有记录）'}」，不是记录里的「${record.phase}」` }
    }
  }
  deps.scopes.open({
    valuationId: record.projectId,
    projectId: record.projectId,
    previewId: record.previewId,
    casePath: record.casePath,
    sessionId: record.sessionId,
    parentSessionId: record.sessionId,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    snapshot: {
      valuationId: record.projectId,
      method: record.methodRequest,
      baseDate: record.baseDate ?? '',
      purpose: record.purpose ?? '',
      valueType: record.valueType ?? '',
      supplementalPrompt: record.supplementalPrompt,
      digest: record.inputDigest,
      files: record.files.map((file) => ({
        fileName: file.fileName,
        relativePath: file.archiveRelativePath,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      })),
      frozenAt: record.createdAt,
    },
    planIds: [...record.planIds],
    openedAt: deps.now().getTime(),
  })
  return { ok: true, error: '' }
}
