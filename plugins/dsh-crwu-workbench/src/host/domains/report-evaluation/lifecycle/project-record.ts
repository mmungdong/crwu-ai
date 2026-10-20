import { text } from '../../../../shared/utils/value.ts'
import { WORKBENCH_PROTOCOL } from '../../../../shared/consts.ts'
import {
  ASSET_TYPES,
  VALUATION_INPUT_SCHEMA_VERSION,
  type AssetType,
  type MethodRequest,
} from '../../../../shared/contracts/valuation-project.ts'
import { canonicalJson, digestOf } from '../../../tools/common/snapshot.ts'
import { extensionOf } from '../intake/classify.ts'
import type { MaterialMetadata } from '../intake/metadata.ts'
import { TERMINAL_PHASES, type ValuationPhase } from './state.ts'

/**
 * **受保护的项目记录**（P18 · 计划 Task 2 续）——`<项目目录>/项目记录.json`。
 *
 * ## 为什么必须有它
 *
 * 估值的案例归属是**进程内**注册表（`ValuationScopes` / `ValuationLifecycles`），随插件实例活着。
 * 实例一重建，同一条父会话就再也拿不到自己那一份 `casePath`，案例内 Tool 立刻 fail closed。
 * 拒绝本身是对的（重建后的宿主记录不可信），但此前**没有任何恢复能力**：磁盘上明明有
 * `估值输入.json`、`材料-源/` 与交接记录，却没有任何受支持的入口把它们重新绑回同一条会话。
 *
 * 所以恢复需要一个**跨重启可读的事实源**：这一轮的项目是什么、绑在哪条会话上、冻结输入的
 * 摘要是什么、逐份材料的字节指认是什么。这份记录就是它。
 *
 * ## 它不是"凭文件授权"
 *
 * ⚠️ 案例目录对估值会话是可写的，所以 `项目记录.json` **天然可被改写**，它不是密码学凭据。
 * 它的作用是把恢复判据**逐项写下来**，让恢复时能拿它去和**权威事实**对账：
 *
 * 1. 工作区（当前选中的那个）与记录逐字一致 —— 换过工作区就不许恢复；
 * 2. 项目目录由 **Host 从已选工作空间派生**，记录里的 `casePath` 只是被**核对**，不是被采用；
 * 3. 会话仍存在且属于本工作区（`verifyPlacement`）；
 * 4. `估值输入.json` 与 `材料-源/*` 的**实际字节**能重算出同一个摘要。
 *
 * 也就是说：改过记录里任何一项，都必须同时改掉磁盘上的输入与字节才可能对上 ——
 * 而"能不能恢复"的判据仍然由授权收据、工作区与会话归属这三条 Host 事实决定。
 *
 * ## 指纹口径
 *
 * 记录自身的 `recordDigest` 与冻结输入摘要同一条口径：`canonicalJson`（键排序）之后取 sha256。
 * 它只能发现**不一致**（被改过 / 损坏 / 不是本插件写的），不提供防伪。
 */

/** 项目记录在项目目录里的固定文件名。 */
export const PROJECT_RECORD_FILE = '项目记录.json'

/** 项目记录的 Schema 版本（维护者可见；与冻结输入的 Schema 版本分开演进）。 */
export const PROJECT_RECORD_SCHEMA_VERSION = 'crwu.valuation.project-record.v1'

/** 记录里逐份材料的指认（进记录指纹的字段与 `fingerprintOf` 同一批）。 */
export interface ProjectRecordFileEntry {
  fileId: string
  fileName: string
  archiveRelativePath: string
  kind: string
  sizeBytes: number
  sha256: string
  duplicateOf: string | null
}

/** 记录正文（`recordDigest` 之外的全部字段）。 */
export interface ProjectRecordPayload {
  schemaVersion: string
  /** 协议代：跨进程行为变化时提升，旧记录据此拒绝恢复。 */
  protocolVersion: number
  /** 冻结输入的 Schema 版本（`crwu.valuation.input.v2`）。 */
  inputSchemaVersion: string
  valuationId: string
  projectId: string
  previewId: string
  /** `<已选工作区>/<projectId>`（恢复时被**核对**，不是被采用）。 */
  casePath: string
  workspaceId: string
  workspacePath: string
  /** 父估值会话。 */
  sessionId: string
  planIds: string[]
  /** 交接成功那一刻的轮次阶段（恢复据此把注册表对齐回来）。 */
  phase: ValuationPhase
  /** 用户选定的资产类型（v3 起进记录）：恢复时按它核对本轮装的是哪条资产入口。 */
  assetType: AssetType
  methodRequest: MethodRequest
  baseDate: string | null
  /** 评估目的（P16）；未指定是 `null`（**不默认**成某种正式目的）。 */
  purpose: string | null
  /** 价值类型（P16）；未指定是 `null`。 */
  valueType: string | null
  /** Archived calculation-template material id; null when none. */
  templateFileId: string | null
  supplementalPrompt: string
  /** 冻结输入摘要（`估值输入.json` 的 `inputDigest`）。 */
  inputDigest: string
  files: ProjectRecordFileEntry[]
  createdAt: string
}

/** 落盘形态：正文 + 自身指纹。 */
export interface ProjectRecord extends ProjectRecordPayload {
  recordDigest: string
}

/**
 * 逐份材料 → 记录条目（`ArchivedMaterial` 与指纹字段之外的东西一律不进记录）。
 *
 * 参数类型是**记录条目**而不是 `ArchivedMaterial`：`ArchivedMaterial` 结构上满足它
 * （多出来的 `createdAt` / `modifiedAt` / `readable` 不参与指纹），所以两个调用点都能直接传。
 */
export function projectRecordFiles(files: readonly ProjectRecordFileEntry[]): ProjectRecordFileEntry[] {
  return files.map((file) => ({
    fileId: text(file.fileId),
    fileName: text(file.fileName),
    archiveRelativePath: text(file.archiveRelativePath),
    kind: text(file.kind),
    sizeBytes: file.sizeBytes,
    sha256: text(file.sha256),
    duplicateOf: file.duplicateOf === null ? null : text(file.duplicateOf),
  }))
}

/** 记录条目 → 指纹口径的元信息（`absolutePath` 不进指纹，所以这里给空串）。 */
export function materialOfEntry(entry: ProjectRecordFileEntry): MaterialMetadata {
  return {
    fileId: entry.fileId,
    fileName: entry.fileName,
    absolutePath: '',
    archiveRelativePath: entry.archiveRelativePath,
    kind: entry.kind,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    createdAt: null,
    modifiedAt: null,
    readable: true,
    duplicateOf: entry.duplicateOf,
  }
}

/** 组装记录并算上自身指纹。 */
export function buildProjectRecord(payload: ProjectRecordPayload): ProjectRecord {
  const body: ProjectRecordPayload = {
    schemaVersion: text(payload.schemaVersion),
    protocolVersion: payload.protocolVersion,
    inputSchemaVersion: text(payload.inputSchemaVersion),
    valuationId: text(payload.valuationId),
    projectId: text(payload.projectId),
    previewId: text(payload.previewId),
    casePath: text(payload.casePath),
    workspaceId: text(payload.workspaceId),
    workspacePath: text(payload.workspacePath),
    sessionId: text(payload.sessionId),
    planIds: payload.planIds.map((item) => text(item)).filter((item) => item !== ''),
    phase: payload.phase,
    assetType: payload.assetType,
    methodRequest: payload.methodRequest,
    baseDate: payload.baseDate === null ? null : text(payload.baseDate),
    purpose: payload.purpose === null || payload.purpose === undefined ? null : text(payload.purpose),
    valueType: payload.valueType === null || payload.valueType === undefined ? null : text(payload.valueType),
    templateFileId: payload.templateFileId === null || payload.templateFileId === undefined
      ? null : text(payload.templateFileId),
    supplementalPrompt: text(payload.supplementalPrompt),
    inputDigest: text(payload.inputDigest),
    files: projectRecordFiles(payload.files),
    createdAt: text(payload.createdAt),
  }
  return { ...body, recordDigest: digestOf([canonicalJson(body)]) }
}

const PHASES: readonly string[] = [
  'draft', 'extracting', 'confirmation', 'queued', 'running',
  'browser-login-required', 'completed', 'failed', 'cancelled', 'stale-host',
]
const METHODS: readonly string[] = ['market', 'income', 'cost']

export type ProjectRecordRead =
  | { ok: true; record: ProjectRecord }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 逐字段收窄一份记录；任何一项不成立都返回**一句能读懂**的话。 */
export function projectRecordOf(raw: unknown): ProjectRecordRead {
  if (!isPlainObject(raw)) return { ok: false, error: '项目记录不是一个 JSON 对象' }
  if (text(raw.schemaVersion) !== PROJECT_RECORD_SCHEMA_VERSION) {
    return { ok: false, error: `项目记录的 Schema 版本不是本版认识的（${text(raw.schemaVersion) || '空'}）` }
  }
  if (!Number.isFinite(raw.protocolVersion)) return { ok: false, error: '项目记录缺少协议代' }
  const required: Array<[string, string]> = [
    ['inputSchemaVersion', text(raw.inputSchemaVersion)],
    ['valuationId', text(raw.valuationId)],
    ['projectId', text(raw.projectId)],
    ['previewId', text(raw.previewId)],
    ['casePath', text(raw.casePath)],
    ['workspaceId', text(raw.workspaceId)],
    ['workspacePath', text(raw.workspacePath)],
    ['sessionId', text(raw.sessionId)],
    ['inputDigest', text(raw.inputDigest)],
    ['createdAt', text(raw.createdAt)],
  ]
  for (const [label, value] of required) {
    if (value.trim() === '') return { ok: false, error: `项目记录缺少 ${label}` }
  }
  if (!ASSET_TYPES.includes(text(raw.assetType) as AssetType)) {
    return { ok: false, error: `项目记录里的资产类型不合法（${text(raw.assetType) || '空'}）` }
  }
  if (text(raw.methodRequest).trim() === '' || !METHODS.includes(text(raw.methodRequest))) {
    return { ok: false, error: `项目记录里的方法不合法（${text(raw.methodRequest) || '空'}）` }
  }
  if (!PHASES.includes(text(raw.phase))) {
    return { ok: false, error: `项目记录里的状态不合法（${text(raw.phase) || '空'}）` }
  }
  const baseDate = raw.baseDate
  if (baseDate !== null && typeof baseDate !== 'string') return { ok: false, error: '项目记录里的基准日既不是字符串也不是 null' }
  for (const [label, value] of [
    ['评估目的', raw.purpose],
    ['价值类型', raw.valueType],
    ['计算模板', raw.templateFileId],
  ] as const) {
    if (value !== null && value !== undefined && typeof value !== 'string') {
      return { ok: false, error: `项目记录里的${label}既不是字符串也不是 null` }
    }
  }
  // An intentional zero-material run is valid; a non-array or bad entry is not.
  if (!Array.isArray(raw.files)) {
    return { ok: false, error: '项目记录里的材料清单不是数组' }
  }
  const files: ProjectRecordFileEntry[] = []
  for (const [index, item] of raw.files.entries()) {
    if (!isPlainObject(item)) return { ok: false, error: `项目记录第 ${String(index + 1)} 份材料不是对象` }
    const sizeRaw = item.sizeBytes
    const entry: ProjectRecordFileEntry = {
      fileId: text(item.fileId),
      fileName: text(item.fileName),
      archiveRelativePath: text(item.archiveRelativePath),
      kind: text(item.kind),
      sizeBytes: typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : -1,
      sha256: text(item.sha256),
      duplicateOf: item.duplicateOf === null ? null : text(item.duplicateOf),
    }
    if (entry.fileId === '' || entry.archiveRelativePath === '' || entry.sha256 === '' || entry.sizeBytes < 0) {
      return { ok: false, error: `项目记录第 ${String(index + 1)} 份材料缺少 fileId / 相对路径 / 指纹 / 字节数` }
    }
    files.push(entry)
  }
  // The template role must reference an archived .xlsx entry, not a dangling id.
  const templateFileId = raw.templateFileId === null || raw.templateFileId === undefined
    ? null : text(raw.templateFileId)
  if (templateFileId !== null && templateFileId !== '') {
    const referenced = files.find((entry) => entry.fileId === templateFileId)
    if (referenced === undefined) {
      return { ok: false, error: `项目记录里的计算模板（${templateFileId}）不是本批归档材料里的任何一份：拒绝恢复。` }
    }
    if (extensionOf(referenced.fileName) !== '.xlsx') {
      return { ok: false, error: `项目记录里的计算模板（${referenced.fileName}）不是 .xlsx 文件：拒绝恢复。` }
    }
  }
  const planIds = Array.isArray(raw.planIds) ? raw.planIds.map((item) => text(item)).filter((item) => item !== '') : []
  // 上面已经校验过它是有限数；这里再收窄一次（`Record<string, unknown>` 的属性不会跨语句收窄）。
  const protocolVersion = typeof raw.protocolVersion === 'number' && Number.isFinite(raw.protocolVersion)
    ? raw.protocolVersion : 0
  const body: ProjectRecordPayload = {
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
    protocolVersion,
    inputSchemaVersion: text(raw.inputSchemaVersion),
    valuationId: text(raw.valuationId),
    projectId: text(raw.projectId),
    previewId: text(raw.previewId),
    casePath: text(raw.casePath),
    workspaceId: text(raw.workspaceId),
    workspacePath: text(raw.workspacePath),
    sessionId: text(raw.sessionId),
    planIds,
    phase: text(raw.phase) as ValuationPhase,
    assetType: text(raw.assetType) as AssetType,
    methodRequest: text(raw.methodRequest) as MethodRequest,
    baseDate: baseDate === null ? null : text(baseDate),
    purpose: raw.purpose === null || raw.purpose === undefined ? null : text(raw.purpose),
    valueType: raw.valueType === null || raw.valueType === undefined ? null : text(raw.valueType),
    templateFileId: templateFileId === '' ? null : templateFileId,
    supplementalPrompt: text(raw.supplementalPrompt),
    inputDigest: text(raw.inputDigest),
    files,
    createdAt: text(raw.createdAt),
  }
  const recordDigest = digestOf([canonicalJson(body)])
  if (text(raw.recordDigest) !== recordDigest) {
    return { ok: false, error: '项目记录的内容与它自己的指纹不一致：文件被改过或没有写完' }
  }
  return { ok: true, record: { ...body, recordDigest } }
}

/**
 * 协议代 / 冻结输入 Schema 的**兼容性**核对。
 *
 * 严格相等（不是"大于等于"）：协议代描述的是跨进程行为，冻结输入的 Schema 描述的是输入语义。
 * 两者任一变化，"重启前的记录能不能继续用"都必须是**显式**决定，不能由版本号大小猜。
 */
export function projectRecordCompatibility(record: ProjectRecord): string {
  if (record.protocolVersion !== WORKBENCH_PROTOCOL) {
    return `项目记录来自另一个协议代（记录 ${String(record.protocolVersion)}，当前 ${String(WORKBENCH_PROTOCOL)}）：`
      + '请重新发起本轮估值（不会按旧协议代恢复）。'
  }
  if (record.inputSchemaVersion !== VALUATION_INPUT_SCHEMA_VERSION) {
    return `项目记录的冻结输入 Schema 版本不兼容（记录 ${record.inputSchemaVersion}，当前 ${VALUATION_INPUT_SCHEMA_VERSION}）：`
      + '请重新发起本轮估值（不会按旧 Schema 恢复）。'
  }
  return ''
}

/** 这一轮的记录状态是不是**已经结束**（结束的轮次没有可恢复的东西）。 */
export function projectRecordFinished(record: ProjectRecord): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(record.phase)
}
