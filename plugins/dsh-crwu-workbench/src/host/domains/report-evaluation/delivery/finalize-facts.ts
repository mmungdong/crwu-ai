import { text } from '../../../../shared/utils/value.ts'
import { REVISION_DIR } from './revision.ts'
import type {
  Blocker,
  KnowledgeSourceRecord,
  ReportConclusion,
  ReportStatus,
  ReportWorkbookRecord,
  ScreenshotEvidenceRecord,
  ValuationPath,
  ValueScope,
} from '../../../../shared/contracts/valuation-project.ts'
import type { RecalculationOutcome } from './recalculation.ts'
import type { PlanFinalizeFacts } from './finalize.ts'

/**
 * **finalize 的 I/O 适配层**（设计稿 §11.4，计划 Task 11）。
 *
 * ## 它只做一件事：把磁盘事实翻译成判据
 *
 * "什么算完成"住在 `delivery/finalize.ts`（纯函数、12 条断言）。这一层负责把案例目录里的
 * 文件变成它的 `PlanFinalizeFacts`。分开的理由很实际：**翻译错了会静默放行** ——
 * 例如把"知识索引文件不存在"翻译成 `knowledge.verified = true`，或者把缺失的截图
 * 当成"知识没要求截图"。所以这一层要能把每一处"读不到"如实变成缺口，
 * 而且它能用内存替身穷举测试。
 *
 * ## 三条不许含糊的翻译口径
 *
 * 1. **读不到 ≠ 通过**：任何必需文件缺失都翻译成对应的**未通过**或显式缺口，
 *    绝不默认成"没问题"。
 * 2. **知识索引里逐条要有非空正文与 digest**：只有一条"来源记录"而没有正文指纹，
 *    等于无法证明结论建立在哪一版规则上 —— 那不算 `verified`。
 * 3. **重算结论必须由调用方落盘**：没有那份记录就只能按 `unavailable` 处理
 *    （→ 报告上限 `partial`）。**不允许**用"底稿里有公式"推断"已重算"。
 */

/** 相对案例目录的固定落点（与 `tools/report-evaluation/consts.ts` 同一套口径）。 */
export const FINALIZE_PATHS = {
  frozenInput: '估值输入.json',
  projectIndex: '项目估值方案索引.json',
  knowledgeIndex: '知识快照/.知识来源.json',
  reportData: '估值报告数据.json',
  reportHtml: '估值报告.html',
  workbook: '估值底稿.xlsx',
  recalculation: '重算结论.json',
  screenshotManifest: '推理结果/图片/图片清单.json',
  artifactManifest: '产物清单.json',
} as const

/**
 * **方案级交付件**落点（设计稿 §11.1）。
 *
 * ## 为什么方案必须有独立目录
 *
 * 一个项目可以有多个方案（住宅 + 商业、房地分别评估的土地/建筑物…）。如果两个方案
 * 共用同一组文件名，`finalizePlan(plan-002)` 读到的就是 plan-001 的报告数据与结论 ——
 * 它会**通过校验**，因为那些文件确实存在、格式也确实合法，只是不属于这个方案。
 * 这是"看起来正常、实际串了方案"的典型形态，所以方案级文件一律带 `方案/<planId>/` 前缀。
 *
 * 项目级事实（冻结输入、项目索引、知识快照）不前缀：它们对整个项目只有一份。
 */
export const PLAN_DIR = '方案'

/** 方案目录名：planId 必须是单段安全标识（Host 铸号；模型提交的值一律在这里收窄）。 */
export function planDirRelative(planId: string): string {
  const plan = text(planId).trim()
  if (plan === '' || plan.includes('/') || plan.includes('\\') || plan.includes('..') || plan === '.' || plan === '..') {
    return ''
  }
  return `${PLAN_DIR}/${plan}`
}

/**
 * 拼出方案级落点（相对案例目录）；planId 不安全时返回空串（调用方必须当作缺口处理）。
 *
 * `revision > 1` 时落在 `修订/<n>/` 下（协议 39）：**每一版都有自己的交付件**，
 * 所以旧版的报告、底稿与结论原样可读，不会被新版覆盖。
 * 第 1 版（初版）与 `revision <= 1` 都落在方案根 —— 也就是既有案例目录的形状不变。
 */
export function planFilePath(planId: string, fileName: string, revision = 0): string {
  const dir = planDirRelative(planId)
  if (dir === '') return ''
  const rev = revision > 1 ? `${REVISION_DIR}/${String(Math.trunc(revision))}/` : ''
  return `${dir}/${rev}${fileName}`
}

/** 调用方注入的读取面（生产接 fs / Broker；测试接内存）。 */
export interface FinalizeReaders {
  /** 读一份 JSON；读不到或不合法返回 `null`（**错误不是"空对象"**）。 */
  readJson: (relativePath: string) => Promise<Record<string, unknown> | null>
  /** 文件是否存在。 */
  exists: (relativePath: string) => Promise<boolean>
  /** 按冻结输入重新算一遍规范化摘要（finalize 强制重算，不信自报值）。 */
  recomputeInputDigest: () => Promise<string>
  /**
   * **真实探测**本机可用的表格计算程序（协议 39）。
   *
   * 给了就启用"记录必须可被证伪"那一条：探测不到程序时，声称重算成功的记录被判失败。
   * 不给（老调用方 / 只读渲染）就保持原判据 —— 不假装做过探测。
   */
  recalcProviders?: () => Promise<readonly RecalcProviderLike[]>
}

export interface FinalizeRequest {
  projectId: string
  planId: string
  taskId: string
  /** 调用方（模型/会话）请求的状态 —— 只是提示。 */
  requestedStatus: ReportStatus
  /** Host 内存里那一份冻结输入摘要（权威）。 */
  frozenInputDigest: string
  /** **知识是否要求页面截图**（来自本轮知识快照，不由这里猜）。 */
  screenshotRequired: boolean
  valuationPath: ValuationPath
  /**
   * 修订版本（协议 39）：`> 1` 时交付件读 `修订/<n>/`，`<= 1` 读方案根。
   *
   * 缺省 = 0 = 读方案根（既有调用方的行为一字不变）。
   */
  revision?: number
  /** 该方案已知的阻断（调用方从方案索引里带来的）。 */
  blockers?: readonly Blocker[]
  verifiedAt: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 把 `知识快照/.知识来源.json` 或逐路由文档翻译成来源记录。
 *
 * 逐条判据：`routeId` 与 `digest` 都要非空、`bodyNonEmpty` 不能是明确的 false。
 * 「有记录但没指纹」不能算通过 —— 那正是"结论建立在哪一版规则上"无从回答的形态。
 */
export function knowledgeSourcesOf(document: Record<string, unknown> | null): {
  sources: KnowledgeSourceRecord[]
  missing: string[]
} {
  if (document === null) return { sources: [], missing: ['知识来源索引（知识快照/.知识来源.json）'] }
  const entries = asArray(document.entries ?? document.sources ?? [])
  const sources: KnowledgeSourceRecord[] = []
  const missing: string[] = []
  for (const raw of entries) {
    const record = asRecord(raw)
    if (record === null) continue
    const routeId = text(record.routeId).trim()
    const digest = text(record.digest).trim()
    const nodeName = text(record.nodeName ?? record.node).trim()
    if (routeId === '' || digest === '') {
      missing.push(`知识来源条目缺少 routeId 或 digest（${routeId || nodeName || '(未命名)'}）`)
      continue
    }
    // `bodyNonEmpty === false`（空正文）**不是**可用来源：它只能进缺口。
    if (record.bodyNonEmpty === false) {
      missing.push(`知识正文为空：${routeId}`)
      continue
    }
    sources.push({
      routeId,
      nodeName: nodeName || routeId,
      resolvedPath: text(record.resolvedPath),
      source: text(record.source) === 'verified-mirror' ? 'verified-mirror' : 'dws',
      spaceName: text(record.spaceName),
      updatedAt: text(record.updatedAt),
      digest,
      snapshotFile: text(record.snapshotFile),
      sectionIds: asArray(record.sectionIds).map((item) => text(item)).filter((item) => item !== ''),
      ruleIds: asArray(record.ruleIds).map((item) => text(item)).filter((item) => item !== ''),
    })
  }
  if (sources.length === 0 && missing.length === 0) missing.push('知识来源索引里没有任何可用条目')
  return { sources, missing }
}

/** 对象清单：索引文件里的 `objects[].objectId`。 */
export function objectIdsOf(document: Record<string, unknown> | null): string[] {
  if (document === null) return []
  return asArray(document.objects)
    .map((item) => asRecord(item))
    .map((item) => text(item?.objectId).trim())
    .filter((item) => item !== '')
}

/**
 * **这个方案**的对象清单（`plans[].objectIds`）。
 *
 * 为什么不能直接用项目级的 `objects[]`：一个项目里可以有多个方案，各管各的对象。
 * 拿全项目的对象去要求某一个方案逐对象给结论，会让每个方案都"缺"别的方案的对象 ——
 * 那是一条永远过不去的校验，而它看起来只是个"交付不全"的问题。
 *
 * 索引里找不到这个方案时返回空数组：调用方据此报"方案不在项目索引里"（fail closed）。
 */
export function planObjectIdsOf(document: Record<string, unknown> | null, planId: string): string[] {
  if (document === null) return []
  const plan = text(planId)
  if (plan === '') return []
  for (const raw of asArray(document.plans)) {
    const record = asRecord(raw)
    if (record === null) continue
    if (text(record.planId) !== plan) continue
    return asArray(record.objectIds).map((item) => text(item)).filter((item) => item !== '')
  }
  return []
}

/** 结论清单：报告数据里的 `conclusions[]`。 */
export function conclusionsOf(document: Record<string, unknown> | null): ReportConclusion[] {
  if (document === null) return []
  return asArray(document.conclusions)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      objectId: text(item.objectId),
      valueScope: (text(item.valueScope) || 'land-and-building') as ValueScope,
      method: (text(item.method) || 'market') as ReportConclusion['method'],
      unitPrice: text(item.unitPrice) === '' ? null : text(item.unitPrice),
      totalValue: text(item.totalValue) === '' ? null : text(item.totalValue),
      currency: text(item.currency) || 'CNY',
      basisRefs: asArray(item.basisRefs).map((ref) => {
        const record = asRecord(ref) ?? {}
        return { routeId: text(record.routeId), snapshotDigest: text(record.snapshotDigest) }
      }),
      calculationRef: text(item.calculationRef) === '' ? null : text(item.calculationRef),
    }))
    .filter((item) => item.objectId !== '')
}

/** 截图证据：图片清单里的 `entries[]`（`challengeScreenshot` 恒 false 由 schema 把守）。 */
export function screenshotsOf(document: Record<string, unknown> | null): ScreenshotEvidenceRecord[] {
  if (document === null) return []
  return asArray(document.entries)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      caseId: text(item.caseId),
      displayName: text(item.displayName),
      provider: text(item.provider),
      sourceUrl: text(item.sourceUrl),
      capturedAt: text(item.capturedAt),
      relativePath: text(item.relativePath),
      digest: text(item.digest),
      validity: (text(item.validity) || 'missing') as ScreenshotEvidenceRecord['validity'],
      // Optional only: a legacy record keeps its DTO shape, never silently becomes detail.
      ...(['page-screenshot', 'detail-screenshot', 'alternative-evidence'].includes(text(item.evidenceType))
        ? { evidenceType: text(item.evidenceType) as ScreenshotEvidenceRecord['evidenceType'] }
        : {}),
    }))
}

/** 工作簿记录：报告数据里的 `workbooks[]`。 */
export function workbooksOf(document: Record<string, unknown> | null): ReportWorkbookRecord[] {
  if (document === null) return []
  return asArray(document.workbooks)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      workbookId: text(item.workbookId),
      relativePath: text(item.relativePath),
      templateId: text(item.templateId),
      templateDigest: text(item.templateDigest),
      objectIds: asArray(item.objectIds).map((id) => text(id)).filter((id) => id !== ''),
      recalculated: item.recalculated === true,
      recalculationNote: text(item.recalculationNote),
    }))
}

/**
 * 重算结论。**没有落盘记录就是 `unavailable`** —— 绝不用"底稿里有公式"推断"已重算"。
 *
 * ## 协议 39：记录本身也要能被 Host 证伪
 *
 * `重算结论.json` 落在方案目录里，**模型写得到** —— 于是"模型自己写一份
 * `{state:'recalculated', verified:true}`"就能把 `partial` 抬成 `completed`。
 * 那种成功记录只要机器上没有表格计算程序就必然是假的，所以这里加一道**可证伪**的判据：
 *
 * - 调用方给出**真实探测到的 provider 清单**（`options.providers`）时，
 *   清单为空而记录声称重算成功 → 直接判 `failed`（`verified: false`），并说清原因；
 *   清单非空则记录可被接受（引擎确实存在）。
 * - 调用方**不给**清单（老调用方 / 只读渲染）时保持原判据，不假装做过探测。
 */
export function recalculationOf(
  document: Record<string, unknown> | null,
  options: { providers?: readonly RecalcProviderLike[] } = {},
): RecalculationOutcome {
  if (document === null) {
    return {
      state: 'unavailable',
      reason: '没有落盘的重算记录：无法证明底稿数值经过重算核对，本轮只能交付 partial',
      providerId: '', verified: false, observed: [], recalculatedAt: '', mismatches: [],
    }
  }
  const state = text(document.state)
  const parsed: RecalculationOutcome = {
    state: (['recalculated', 'unavailable', 'failed'].includes(state) ? state : 'unavailable') as RecalculationOutcome['state'],
    reason: text(document.reason),
    providerId: text(document.providerId),
    verified: document.verified === true,
    observed: asArray(document.observed).map((item) => {
      const record = asRecord(item) ?? {}
      return {
        objectId: text(record.objectId),
        unitPrice: text(record.unitPrice) === '' ? null : text(record.unitPrice),
        totalValue: text(record.totalValue) === '' ? null : text(record.totalValue),
      }
    }),
    recalculatedAt: text(document.recalculatedAt),
    mismatches: asArray(document.mismatches).map((item) => text(item)).filter((item) => item !== ''),
  }

  // **模型自写的成功记录不算证据**：本机探测不到任何表格计算程序时，"重算成功"必然是编的。
  const probed = options.providers
  if (probed !== undefined && probed.length === 0 && (parsed.state === 'recalculated' || parsed.verified)) {
    return {
      ...parsed,
      state: 'failed',
      verified: false,
      reason: `重算记录声称已经重算并核对过，但本机探测不到任何表格计算程序（Excel / LibreOffice）：`
        + '这份记录不能作为重算证据，本轮只能交付 partial。请先在部署配置里指定可用的表格计算程序，'
        + '再由受控工具真正跑一次重算并回读。',
      mismatches: [
        ...parsed.mismatches,
        '探测到的重算 provider 数 = 0，而记录声称 verified',
      ],
    }
  }
  return parsed
}

/** 探测到的表格计算程序（形状与 `RecalcProvider` 一致；这里只要求这两个字段）。 */
export interface RecalcProviderLike {
  id: string
  detail: string
}

/** 报告数据的 Schema 问题清单（由 `build_report_data.py` / 渲染前校验写出）。 */
export function schemaProblemsOf(document: Record<string, unknown> | null): string[] {
  if (document === null) return ['报告数据文件缺失或不是合法 JSON']
  return asArray(document.problems ?? document.schemaProblems).map((item) => text(item)).filter((item) => item !== '')
}

/**
 * Listing-reference facts: only exported when the report data itself declares
 * `valuationMode=listing-reference`.
 *
 * `verified` is computed by Host review (status must be `partial`, `referenceSummary` present with
 * the right shape, no schema problems, per-object `provisionalResults` present) and never reads a
 * model-claimed `verified` boolean — otherwise edited report data could pass itself off as verified.
 */
export function listingReferenceOf(
  document: Record<string, unknown> | null,
  schemaProblems: readonly string[] = [],
): { verified: boolean; objectIds: string[]; problems: string[] } | null {
  if (document === null || text(document.valuationMode) !== 'listing-reference') return null
  const problems: string[] = [...schemaProblems]
  const summary = asRecord(document.referenceSummary)
  if (summary === null) {
    problems.push('挂牌参考报告缺少 referenceSummary')
  } else {
    if (text(summary.aggregation) !== 'arithmetic-mean') {
      problems.push('挂牌参考 referenceSummary.aggregation 必须是 arithmetic-mean')
    }
    if (text(summary.priceNature) !== '挂牌') problems.push('挂牌参考 referenceSummary.priceNature 必须是「挂牌」')
    if (asArray(summary.caseIds).length === 0) problems.push('挂牌参考 referenceSummary.caseIds 不能为空')
  }
  if (text(document.status) !== 'partial') {
    problems.push(`挂牌参考报告状态必须是 partial，实际 ${text(document.status) || '(空)'}`)
  }
  const objectIds = asArray(document.provisionalResults)
    .map((item) => asRecord(item))
    .map((item) => text(item?.objectId).trim())
    .filter((id) => id !== '')
  if (objectIds.length === 0) problems.push('挂牌参考报告没有逐对象结果（provisionalResults）')
  return { verified: problems.length === 0, objectIds, problems }
}

/**
 * 收集一个方案的 finalize 事实。
 *
 * 其余"文件存在性"都走 `readers.exists`，且**缺失一律翻译成未通过**：
 * 报告没渲染、工作簿不存在、模板指纹读不到 —— 都不是"可以放过的细节"。
 */
/** 探测结果（探测失败 = 没有程序，不是"假装可用"）。 */
async function recalcProviderOptions(
  readers: FinalizeReaders,
): Promise<{ providers?: readonly RecalcProviderLike[] }> {
  if (readers.recalcProviders === undefined) return {}
  try {
    return { providers: await readers.recalcProviders() }
  } catch {
    return { providers: [] }
  }
}

export async function collectPlanFinalizeFacts(
  request: FinalizeRequest,
  readers: FinalizeReaders,
): Promise<PlanFinalizeFacts> {
  // 方案级落点带 `方案/<planId>/` 前缀：planId 不安全时**一律当成读不到**
  // （空路径读不回来 → 逐项降级），绝不退化成"读项目根下那份可能是别的方案的文件"。
  const revision = Number.isFinite(request.revision) ? Math.max(0, Math.trunc(request.revision as number)) : 0
  const planFile = (name: string): string => planFilePath(request.planId, name, revision)
  const path = {
    reportData: planFile(FINALIZE_PATHS.reportData),
    reportHtml: planFile(FINALIZE_PATHS.reportHtml),
    workbook: planFile(FINALIZE_PATHS.workbook),
    template: planFile('模板验真.json'),
    screenshotManifest: planFile(FINALIZE_PATHS.screenshotManifest),
    artifactManifest: planFile(FINALIZE_PATHS.artifactManifest),
    recalculation: planFile(FINALIZE_PATHS.recalculation),
  }
  const read = async (relativePath: string): Promise<Record<string, unknown> | null> =>
    relativePath === '' ? null : await readers.readJson(relativePath)
  const [, index, knowledgeDoc, reportData, templateDoc, screenshotDoc, artifactDoc, recalcDoc] = await Promise.all([
    read(FINALIZE_PATHS.frozenInput),
    read(FINALIZE_PATHS.projectIndex),
    read(FINALIZE_PATHS.knowledgeIndex),
    read(path.reportData),
    read(path.template),
    read(path.screenshotManifest),
    read(path.artifactManifest),
    read(path.recalculation),
  ])
  const recomputed = await readers.recomputeInputDigest()

  const knowledge = knowledgeSourcesOf(knowledgeDoc)
  const template = templateDoc === null
    ? null
    : {
      templateId: text(templateDoc.templateId),
      digest: text(templateDoc.digest),
      expectedDigest: text(templateDoc.expectedDigest),
      structureOk: templateDoc.structureOk === true,
    }

  const workbookPresent = path.workbook !== '' && await readers.exists(path.workbook)
  const reportPresent = path.reportHtml !== '' && await readers.exists(path.reportHtml)
  const workbooks = workbooksOf(reportData)
  if (workbookPresent && workbooks.length === 0) {
    // 磁盘上有底稿但报告数据没登记它：两边对不上，按未登记处理（不让"存在"顶替"登记"）。
    workbooks.push({
      workbookId: 'disk', relativePath: path.workbook, templateId: '',
      templateDigest: '', objectIds: [], recalculated: false,
      recalculationNote: '磁盘上存在底稿，但报告数据里没有登记它',
    })
  }

  const artifactMissing = asArray(artifactDoc?.missing).map((item) => text(item)).filter((item) => item !== '')
  const schemaProblems = schemaProblemsOf(reportData)
  const valuationMode = text(reportData?.valuationMode)
  // 挂牌参考没有正式 `conclusions`；价值范围从它的逐对象中间结果读，避免重复计价检查落空。
  const referenceValueScopes = asArray(reportData?.provisionalResults)
    .map((item) => asRecord(item))
    .map((item) => text(item?.valueScope))
    .filter((scope) => scope !== '') as ValueScope[]

  return {
    projectId: request.projectId,
    planId: request.planId,
    taskId: request.taskId,
    requestedStatus: request.requestedStatus,
    inputDigest: { frozen: text(request.frozenInputDigest), recomputed },
    knowledge: { sources: knowledge.sources, verified: knowledge.missing.length === 0, missing: knowledge.missing },
    template,
    // 逐对象结论按**本方案**的对象核对：`plans[].objectIds` 找不到这个方案时退回空集，
    // 由 finalize 判成"缺少对象结论"（而不是拿全项目的对象去要求它，那永远过不去）。
    objects: { objectIds: planObjectIdsOf(index, request.planId), conclusions: conclusionsOf(reportData) },
    calculation: {
      steps: asArray(reportData?.calculationSteps).length,
      verified: asArray(reportData?.calculationSteps).length > 0,
    },
    evidence: { required: request.screenshotRequired, entries: screenshotsOf(screenshotDoc) },
    workbooks,
    recalculation: recalculationOf(recalcDoc, await recalcProviderOptions(readers)),
    report: { rendered: reportPresent, schemaProblems },
    artifacts: {
      manifestOk: artifactDoc !== null && artifactDoc.ok !== false,
      missing: artifactMissing,
    },
    blockers: request.blockers ?? [],
    valuationPath: request.valuationPath,
    valueScopes: [...new Set(valuationMode === 'listing-reference'
      ? referenceValueScopes
      : conclusionsOf(reportData).map((item) => item.valueScope))],
    ...(valuationMode === '' ? {} : { valuationMode }),
    reference: listingReferenceOf(reportData, schemaProblems),
    verifiedAt: request.verifiedAt,
  }
}
