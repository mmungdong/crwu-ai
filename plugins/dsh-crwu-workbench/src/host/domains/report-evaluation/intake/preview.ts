import { text } from '../../../../shared/utils/value.ts'
import { basenameLocalPath, joinLocalPath, trimTrailingSeparators } from '../../../../shared/utils/local-path.ts'
import {
  VALUATION_INPUT_SCHEMA_VERSION,
  type AssetType,
  type FailureEnvelope,
  type MethodRequest,
} from '../../../../shared/contracts/valuation-project.ts'
import { canonicalJson, digestOf } from '../../../tools/common/snapshot.ts'
import { VALUATION_MATERIAL_DIR } from '../../../tools/report-evaluation/consts.ts'
import type { LocalAuditScan } from '../../local-audit/scan.ts'
import {
  MAX_MATERIAL_FILES,
  SUPPLEMENTAL_PROMPT_MAX_LENGTH,
  isSafeIdSegment,
  normalizeAssetType,
  normalizeBaseDate,
  normalizePurpose,
  normalizeValueType,
} from '../project/contracts.ts'
import { isValuationMethod } from '../scope.ts'
import { extensionOf, kindOf } from './classify.ts'
import { sha256OfBytes } from './manifest.ts'
import {
  archiveNameOf,
  materialFileId,
  takeDuplicate,
  fingerprintOf,
  type MaterialMetadata,
} from './metadata.ts'

/**
 * 资料归档**预览**（计划 Task 2 · 设计稿 §4.4 / §5）。
 *
 * ## 为什么这里"只做本机的事"
 *
 * 用户点「确认」时要看到的是"这次到底吃进去哪一批字节"。以前这一步还顺手做了三件事 ——
 * 调 Python 提取正文、预检知识库路由、串行探测三家外部站点 —— 于是按钮要么等一分钟，
 * 要么在**还没确认**的时候就把资料内容送进了模型可见的路径。现在这里只做：
 *
 * 1. 递归扫描本机选择（复用本地审核的扫描算法：realpath 去重、符号链接不跟随、深度/数量保护）；
 * 2. 1–上限份的硬边界（**超过就整批阻止**，不悄悄截取前若干份）；
 * 3. 按字节复制进案例目录，**对归档副本重算 sha256 并校验**；
 * 4. 生成规范化输入摘要（**有序**文件清单 + 方法 + 基准日 + 评估目的 + 价值类型 + 补充要求 + Schema 版本）。
 *
 * 提取（`crwu_valuation_file_extract`）与知识物化都留在**父会话**里做，而且只做一次。
 *
 * ## 为什么摘要不含绝对路径
 *
 * 摘要是"这批输入是什么"的判据，会随会话与结果留痕。把 `/Users/<员工>/…` 塞进去，
 * 它就同时成了**员工本机目录结构**的副本 —— 而下游（模型、报告、交接指令）完全不需要它。
 * 面板要显示原始路径，走 `files[].absolutePath`（只回显给员工本人）。
 */

/** 预览的有效期：用户在确认抽屉里停留太久就不再算数（要与归档副本的状态重新对齐）。 */
export const VALUATION_PREVIEW_TTL_MS = 30 * 60_000

/** 一次准备预览的请求（面板提交）。 */
export interface PreviewRequest {
  /** 面板生成的请求标识：同一次准备重复提交时按它幂等。 */
  requestId: string
  /** 用户选中的入口（绝对路径；文件或文件夹）。 */
  paths: readonly string[]
  /** Optional absolute path to the uploaded `.xlsx` calculation template. */
  templatePath?: string
  /**
   * 员工在界面上**逐个移除**掉的文件（绝对路径）。
   *
   * 它与扫描共用同一份排除范围：扫描里不出现、归档时也不会出现 —— 否则"移除"就只是
   * 过滤了一下 UI 列表（设计稿 §8.4 明确禁止的假排除）。入口本身要去掉就把它从 `paths` 里删掉，
   * 所以这里只允许列出**入口之内**的文件。
   */
  excluded: readonly string[]
  /** 用户选定的资产类型（稳定业务标识；未选直接拒绝，没有默认值）。 */
  assetType: string
  method: string
  /** 用户填的基准日（未填是空串）。 */
  baseDate: string
  /** 用户填的评估目的（未填是空串 = 未指定）。 */
  purpose: string
  /** 用户填的价值类型（未填是空串 = 未指定）。 */
  valueType: string
  supplementalPrompt: string
}

/** 预览需要的外部能力（全部注入：这一层不直接碰 shell / Broker / 网络）。 */
export interface PreviewDeps {
  /** 预览注册表（交接按 `previewId` 读它）。 */
  previews: PreviewRegistry
  /** 递归展开本机选择（生产实现复用 `scanSelection`；`excluded` = 员工逐个移除掉的文件）。 */
  scan(selection: readonly string[], excluded: readonly string[]): Promise<LocalAuditScan>
  /**
   * Canonical identity (realpath) used to bind the template role to a scanned candidate.
   * Optional so old injected fixtures fall back to identity; production always supplies it.
   */
  canonicalPath?(path: string): Promise<string>
  readSourceBytes(path: string): Promise<Uint8Array>
  /** 源文件的元信息；`createdAt` 取 `birthtime`，拿不到就是 `null`。 */
  statSource(path: string): Promise<{ createdAt: string | null; modifiedAt: string | null; readable: boolean }>
  /** 建项目目录与资料归档目录（面板来源，Broker 提权；幂等）。 */
  ensureDirectories(input: { projectDir: string; materialDir: string }): Promise<{ ok: boolean; error: string; errorKind: string }>
  /**
   * 按字节复制一份资料（Broker 的 `system.valuation-material.copy`）。
   *
   * 只回答"命令有没有成功"：复制**到底成不成功**由调用方读回目标文件重算指纹来判
   * （命令的退出码不是字节的判据）。
   */
  copyMaterial(input: { sourcePath: string; archivePath: string }): Promise<{ ok: boolean; error: string; errorKind: string }>
  /** 读回**归档副本**的字节（指纹的唯一判据）。 */
  readArchiveBytes(path: string): Promise<Uint8Array>
  /** 项目目录（Host 派生：`<已选工作空间>/<projectId>`）。 */
  projectDirOf(projectId: string): string
  /** Host 铸号（`projectId` 会成为目录名，**模型与页面都提交不了**）。 */
  mintProjectId(): string
  now(): Date
}

/** 一次预览的结果（面板确认抽屉的数据源）。 */
export interface PreviewResult {
  ok: boolean
  errorKind: string
  error: string
  requestId: string
  /** 预览标识。它与 `projectId` 同值：一个预览就是一个项目目录，不可能交接成另一个。 */
  previewId: string
  projectId: string
  /** 项目目录（= 本轮估值的案例目录）。 */
  casePath: string
  /** 覆盖有序文件清单、方法、基准日、评估目的、价值类型、补充要求与 Schema 版本的规范化摘要。 */
  inputDigest: string
  /** 用户选定的资产类型（装配哪个 Skill / 哪份入口 Wiki 的依据）。 */
  assetType: string
  methodRequest: string
  baseDate: string | null
  /** 评估目的；未指定是 `null`（**不默认**成某种正式目的）。 */
  purpose: string | null
  /** 价值类型；未指定是 `null`。 */
  valueType: string | null
  /** Archived material id of the calculation template; null when none. */
  templateFileId: string | null
  supplementalPrompt: string
  /** 每份资料的元信息（含 `absolutePath`，**只回显给面板**）。 */
  files: MaterialMetadata[]
  fileCount: number
  overLimit: boolean
  /** 扫描阶段被跳过的条目（符号链接 / 特殊文件 / 权限不足）。 */
  skipped: string[]
  capabilityGaps: string[]
  createdAt: string
  expiresAt: string
}

/** Host 侧留存的预览记录（比返回给面板的多一个有效期）。 */
export interface PreviewRecord {
  requestId: string
  previewId: string
  projectId: string
  casePath: string
  inputDigest: string
  assetType: AssetType
  methodRequest: MethodRequest
  baseDate: string | null
  purpose: string | null
  valueType: string | null
  templateFileId: string | null
  supplementalPrompt: string
  files: MaterialMetadata[]
  fileCount: number
  overLimit: boolean
  skipped: string[]
  capabilityGaps: string[]
  createdAt: string
  expiresAt: string
}

/**
 * 预览注册表（进程内，随插件生命周期）。
 *
 * 为什么不落盘：预览是"确认抽屉还开着"这段时间里的事实，插件重启后抽屉里的东西本来就失效了；
 * 真正需要持久化的是**交接记录**（`execution/handoff-store.ts`），那一份才必须活过重启。
 * 注册表有界 + 按有效期淘汰：员工连着开很多次确认而不交接时不能无界增长。
 */
export class PreviewRegistry {
  private readonly records = new Map<string, PreviewRecord>()
  private readonly byRequest = new Map<string, string>()
  private readonly maxEntries: number
  private readonly clock: () => Date

  constructor(options: { maxEntries?: number; now?: () => Date } = {}) {
    this.maxEntries = options.maxEntries ?? 32
    this.clock = options.now ?? (() => new Date())
  }

  put(record: PreviewRecord): void {
    this.prune()
    this.records.set(record.previewId, record)
    this.byRequest.set(record.requestId, record.previewId)
  }

  get(previewId: string): PreviewRecord | undefined {
    return previewId === '' ? undefined : this.records.get(previewId)
  }

  /** 同一次准备请求已经准备过的预览（幂等：双击「确认」不该重新归档一遍）。 */
  requested(requestId: string): PreviewRecord | undefined {
    const previewId = requestId === '' ? undefined : this.byRequest.get(requestId)
    return previewId === undefined ? undefined : this.records.get(previewId)
  }

  drop(previewId: string): boolean {
    const record = this.records.get(previewId)
    if (record === undefined) return false
    this.records.delete(previewId)
    if (this.byRequest.get(record.requestId) === previewId) this.byRequest.delete(record.requestId)
    return true
  }

  get size(): number {
    return this.records.size
  }

  /** 淘汰过期记录，再按插入顺序淘汰到上限之内。 */
  private prune(): void {
    const now = this.clock().getTime()
    for (const record of [...this.records.values()]) {
      if (Date.parse(record.expiresAt) < now) this.drop(record.previewId)
    }
    while (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) return
      this.drop(oldest.value)
    }
  }
}

/** Fields that make up the canonical input identity (digest). */
export interface ValuationInputIdentity {
  assetType: AssetType
  methodRequest: MethodRequest
  baseDate: string | null
  purpose: string | null
  valueType: string | null
  /** Archived material id of the calculation template; null when none. */
  templateFileId: string | null
  supplementalPrompt: string
  files: readonly MaterialMetadata[]
}

/** 输入摘要的载荷（**只有这些字段**进指纹）。 */
export function valuationInputPayload(input: ValuationInputIdentity): Record<string, unknown> {
  return {
    schemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    assetType: input.assetType,
    methodRequest: input.methodRequest,
    baseDate: input.baseDate,
    // 评估目的与价值类型是**结论前提**：改了它们摘要就要变，否则"条件变了还按旧摘要启动"拦不住。
    purpose: input.purpose,
    valueType: input.valueType,
    templateFileId: input.templateFileId,
    supplementalPrompt: input.supplementalPrompt,
    files: input.files.map(fingerprintOf),
  }
}

/** 规范化输入摘要：同一批字节与同一批条件，无论来自哪个绝对路径都得到同一个值。 */
export function valuationInputDigest(input: ValuationInputIdentity): string {
  return digestOf([canonicalJson(valuationInputPayload(input))])
}

function emptyScan(): LocalAuditScan {
  return {
    ok: true, error: '', errorKind: '', items: [], files: [], skipped: [],
    fileCount: 0, limit: MAX_MATERIAL_FILES, overLimit: false,
    readableCount: 0, skippedCount: 0, truncated: false,
  }
}

function failure(errorKind: FailureEnvelope['errorKind'], error: string, patch: Partial<PreviewResult> = {}): PreviewResult {
  return {
    ok: false,
    errorKind,
    error,
    requestId: '',
    previewId: '',
    projectId: '',
    casePath: '',
    inputDigest: '',
    assetType: '',
    methodRequest: '',
    baseDate: null,
    purpose: null,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '',
    files: [],
    fileCount: 0,
    overLimit: false,
    skipped: [],
    capabilityGaps: [],
    createdAt: '',
    expiresAt: '',
    ...patch,
  }
}

/** 预览记录 → 面板应答。 */
export function previewView(record: PreviewRecord): PreviewResult {
  return { ...record, ok: true, errorKind: '', error: '' }
}

/**
 * 结构化失败（调用方在"连工作区都拿不到"这类前置失败时也要用它，
 * 免得手拼一份少字段的应答）。
 */
export function previewFailure(
  errorKind: FailureEnvelope['errorKind'],
  error: string,
  patch: Partial<PreviewResult> = {},
): PreviewResult {
  return failure(errorKind, error, patch)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 准备一次归档预览。
 *
 * 顺序（每一步失败都在**建任何东西之前**返回结构化失败）：
 *   ① 请求与条件收窄（requestId / 方法 / 基准日 / 补充要求长度）；
 *   ② 幂等：同一 requestId 已经准备过就直接回那一份；
 *   ③ 扫描 + 份数边界（1–`MAX_MATERIAL_FILES`，超过整批阻止）；
 *   ④ 建目录 → 逐份按字节复制 → **读回归档副本、重算 sha256、与源字节比对**；
 *   ⑤ 生成摘要并登记预览。
 */
export async function preparePreview(input: PreviewRequest, deps: PreviewDeps): Promise<PreviewResult> {
  const requestId = text(input.requestId).trim()
  if (requestId === '') {
    return failure('input-invalid', '缺少 requestId：面板每一次准备预览都要带一个请求标识（用于幂等与交接追溯）。')
  }
  // 幂等：同一次准备重复提交（双击、晚到的重试）不该重新归档一遍，也不该换一个项目目录。
  const previous = deps.previews.requested(requestId)
  if (previous !== undefined) return previewView(previous)

  // 资产类型先于方法收窄：没有资产类型就没有任何业务入口，
  // 也就不该继续往下建目录（**不默认**成房地产）。
  const assetType = normalizeAssetType(input.assetType)
  if (!assetType.ok) return failure('input-invalid', assetType.error, { requestId })
  const method = text(input.method).trim()
  if (!isValuationMethod(method)) {
    return failure('input-invalid', `评估方法不合法：只允许 market / income / cost（收到「${method}」）`, { requestId })
  }
  const baseDate = normalizeBaseDate(input.baseDate)
  if (!baseDate.ok) return failure('input-invalid', baseDate.error, { requestId })
  // 评估目的与价值类型同样是**业务前提**：未填 = 未指定（`null`），既不默认某种正式结论，
  // 也不从资料/补充要求里猜一个。超长或带控制字符一律在建任何东西之前拒绝。
  const purpose = normalizePurpose(input.purpose)
  if (!purpose.ok) return failure('input-invalid', purpose.error, { requestId })
  const valueType = normalizeValueType(input.valueType)
  if (!valueType.ok) return failure('input-invalid', valueType.error, { requestId })
  const supplementalPrompt = text(input.supplementalPrompt)
  if (supplementalPrompt.length > SUPPLEMENTAL_PROMPT_MAX_LENGTH) {
    return failure('input-invalid',
      `补充要求太长（${String(supplementalPrompt.length)} 字符，上限 ${String(SUPPLEMENTAL_PROMPT_MAX_LENGTH)} 字符）。`, { requestId })
  }

  const selection = input.paths.map((item) => text(item).trim()).filter((item) => item !== '')
  // Excluded paths and selection are narrowed together; both are real absolute paths.
  const excluded = (input.excluded ?? []).map((item) => text(item).trim()).filter((item) => item !== '')

  // Optional template: validate the extension, then merge it into the scan so the realpath
  // scanner deduplicates it against folder contents before archival.
  const templatePath = trimTrailingSeparators(text(input.templatePath))
  if (templatePath !== '' && extensionOf(templatePath) !== '.xlsx') {
    return failure('input-invalid',
      `计算表模板必须是一份 .xlsx 文件（收到「${basenameLocalPath(templatePath) || templatePath}」）：请重新选择计算表模板。`,
      { requestId })
  }
  // Only an intentional empty choice bypasses scanning. A supplied selection or template
  // still goes through the real scan and every failure remains visible.
  const intentionalEmpty = selection.length === 0 && templatePath === ''
  const scanSelectionInput = templatePath === '' ? selection : [...selection, templatePath]

  const scan = intentionalEmpty ? emptyScan() : await deps.scan(scanSelectionInput, excluded)
  if (!scan.ok) {
    return failure(scan.errorKind === 'infrastructure' ? 'infrastructure' : 'input-invalid',
      scan.error || '扫描本机资料失败，请重新选择。', { requestId })
  }
  const skipped = scan.skipped.map((item) => `${item.relativePath}（${item.reason}）`)
  if (scan.files.length === 0 && !intentionalEmpty) {
    return failure('input-invalid',
      `选中的资料里没有可读取的普通文件（跳过 ${String(scan.skippedCount)} 项：符号链接 / 特殊文件 / 权限不足）。`
      + '请重新选择要估值的资料。', { requestId, skipped })
  }
  // ⚠️ **整批阻止**：超过上限时一份都不复制、也不截取前若干份 —— 静默截取会让界面上的
  // "已选 N 份"和真正参与估值的份数对不上，而两边都看不出差别。
  if (scan.overLimit || scan.files.length > MAX_MATERIAL_FILES) {
    return failure('input-invalid',
      `展开后共 ${String(scan.files.length)} 份资料，超过单次最多 ${String(MAX_MATERIAL_FILES)} 份的限制：`
      + `请分批提交（不会悄悄只取前 ${String(MAX_MATERIAL_FILES)} 份）。`, { requestId, skipped, overLimit: true })
  }
  // 枚举被安全上限截断：清单**不完整**，所以真实份数本身不可信 —— 不能拿截断后的数量当全部数量
  // 去归档（否则员工以为交了全部、其实只是前若干个）。
  if (scan.truncated) {
    return failure('input-invalid',
      '资料清单没有完整读取（选择的目录太大或层级太深）：请选择更小的文件夹，或分批提交。',
      { requestId, skipped })
  }
  // An empty array must not pass the all-zero check by vacuous truth.
  if (!intentionalEmpty && scan.files.length > 0 && scan.files.every((item) => item.sizeBytes === 0)) {
    return failure('input-invalid', '选中的资料全是空文件（0 字节）：没有可估值的内容，本轮不能启动。', { requestId, skipped })
  }

  // Bind the template role by canonical identity against the scanned candidates, never by
  // filename. Resolution failures reject before any directory is created; `fileId` is assigned
  // during archival, so only the index is recorded here.
  const canonicalOf = deps.canonicalPath ?? (async (path: string) => path)
  let templateIndex = -1
  if (templatePath !== '') {
    let templateKey: string
    try {
      templateKey = await canonicalOf(templatePath)
    } catch {
      return failure('input-invalid', '计算表模板无法解析成真实路径：请重新选择计算表模板后再试。', { requestId })
    }
    if (templateKey === '') {
      return failure('input-invalid', '计算表模板无法解析成真实路径：请重新选择计算表模板。', { requestId })
    }
    for (const [index, item] of scan.files.entries()) {
      let candidateKey = ''
      try {
        candidateKey = await canonicalOf(item.sourcePath)
      } catch (error) {
        void error
      }
      if (candidateKey !== '' && candidateKey === templateKey) {
        templateIndex = index
        break
      }
    }
    if (templateIndex < 0) {
      return failure('input-invalid',
        `计算表模板「${basenameLocalPath(templatePath) || templatePath}」不在可读取的资料清单里`
        + '（可能已被移除、不可读、是目录或符号链接）：请重新选择计算表模板。', { requestId, skipped })
    }
    if (kindOf(scan.files[templateIndex].name) !== 'excel') {
      return failure('input-invalid',
        `计算表模板必须是一份 .xlsx 表格（收到「${scan.files[templateIndex].name}」）：请重新选择计算表模板。`,
        { requestId, skipped })
    }
  }

  const now = deps.now()
  const projectId = deps.mintProjectId()
  if (!isSafeIdSegment(projectId)) {
    return failure('infrastructure', `项目目录名不合法（${projectId || '空'}）：Host 铸号失败，本轮不能启动。`, { requestId })
  }
  const projectDir = deps.projectDirOf(projectId)
  const materialDir = joinLocalPath(projectDir, VALUATION_MATERIAL_DIR)
  const made = await deps.ensureDirectories({ projectDir, materialDir })
  if (!made.ok) {
    return failure(made.errorKind === 'policy' ? 'policy' : 'infrastructure',
      `创建资料归档目录失败：${made.error}`, { requestId, projectId, casePath: projectDir })
  }

  const files: MaterialMetadata[] = []
  const taken = new Set<string>()
  const firstBySha = new Map<string, string>()
  const capabilityGaps: string[] = []
  for (const [index, item] of scan.files.entries()) {
    const fileId = materialFileId(index + 1)
    const archiveName = archiveNameOf(item.name, taken)
    taken.add(archiveName)
    const archiveRelativePath = joinLocalPath(VALUATION_MATERIAL_DIR, archiveName)
    const archivePath = joinLocalPath(projectDir, archiveRelativePath)

    let sourceBytes: Uint8Array
    try {
      sourceBytes = await deps.readSourceBytes(item.sourcePath)
    } catch (error) {
      return failure('infrastructure', `读取资料失败（${item.name}）：${messageOf(error)}`, { requestId, projectId, casePath: projectDir })
    }
    const copied = await deps.copyMaterial({ sourcePath: item.sourcePath, archivePath })
    if (!copied.ok) {
      return failure(copied.errorKind === 'policy' ? 'policy' : 'infrastructure',
        `复制资料失败（${item.name}）：${copied.error}`, { requestId, projectId, casePath: projectDir })
    }
    let archiveBytes: Uint8Array
    try {
      archiveBytes = await deps.readArchiveBytes(archivePath)
    } catch (error) {
      return failure('infrastructure',
        `归档副本读不回来（${item.name}）：${messageOf(error)}`, { requestId, projectId, casePath: projectDir })
    }
    // **指纹以归档副本为准**：源文件"自报"的摘要（甚至命令的退出码）都不算数 ——
    // 复制没按字节完成时，必须在这里失败，而不是让下游拿着一份坏副本继续算。
    const sha256 = sha256OfBytes(archiveBytes)
    if (sha256 !== sha256OfBytes(sourceBytes) || archiveBytes.length !== sourceBytes.length) {
      return failure('infrastructure',
        `归档副本与源文件不一致（${item.name}）：复制没有按字节完成，本轮输入不可信。`, { requestId, projectId, casePath: projectDir })
    }

    const stats = await deps.statSource(item.sourcePath)
    if (archiveBytes.length === 0) capabilityGaps.push(`${item.name} 是空文件（0 字节）。`)
    if (!stats.readable) capabilityGaps.push(`${item.name} 的源文件当前不可读（归档副本已取到，但请确认它是不是你要的那一份）。`)
    files.push({
      fileId,
      fileName: item.name,
      absolutePath: item.sourcePath,
      archiveRelativePath,
      kind: kindOf(item.name),
      sizeBytes: archiveBytes.length,
      sha256,
      // `birthtime` 不可用（部分文件系统给 0）时**留 null**：界面对应显示"创建时间未知"，
      // 绝不拿 mtime 冒充 —— 创建时间与最后修改时间在核对资料时是两件事。
      createdAt: stats.createdAt,
      modifiedAt: stats.modifiedAt,
      readable: stats.readable,
      duplicateOf: takeDuplicate(fileId, sha256, firstBySha),
    })
  }

  // Bind the role to the archived fileId (scan order equals archive order).
  const templateFileId = templateIndex >= 0 ? files[templateIndex].fileId : null
  const inputDigest = valuationInputDigest({
    assetType: assetType.value,
    methodRequest: method,
    baseDate: baseDate.value,
    purpose: purpose.value,
    valueType: valueType.value,
    templateFileId,
    supplementalPrompt,
    files,
  })
  const record: PreviewRecord = {
    requestId,
    previewId: projectId,
    projectId,
    casePath: projectDir,
    inputDigest,
    assetType: assetType.value,
    methodRequest: method,
    baseDate: baseDate.value,
    purpose: purpose.value,
    valueType: valueType.value,
    templateFileId,
    supplementalPrompt,
    files,
    fileCount: files.length,
    overLimit: false,
    skipped,
    capabilityGaps,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + VALUATION_PREVIEW_TTL_MS).toISOString(),
  }
  deps.previews.put(record)
  return previewView(record)
}
