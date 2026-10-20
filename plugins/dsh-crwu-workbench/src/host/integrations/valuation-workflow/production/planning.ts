/**
 * Production planning adapter for the valuation workflow.
 *
 * Registered market providers and the verified knowledge-selected template paths are
 * the only catalogs the isolated planning-selection child sees. Planning dispatches
 * real business Tools through the official composite dispatcher built from the
 * current genuine execution, and template choice keeps the uploaded/KB original role
 * distinct from the controlled listing-reference workbook that is actually used.
 */
import { text } from '../../../../shared/utils/value.ts'
import { isMethodRequest } from '../../../domains/report-evaluation/project/coverage.ts'
import { MARKET_PROVIDER_IDS } from '../../../domains/report-evaluation/browser/login-state.ts'
import { cloneInitialInput } from '../../../domains/report-evaluation/workflow/input-context.ts'
import {
  FILE_NAME_SUFFIX,
  USER_SOURCE_ID,
} from '../../../domains/report-evaluation/workflow/planning-selection.ts'
import type {
  KnowledgeSourceRecord,
  ValuationEvidencePort,
  ValuationInferencePort,
  ValuationInferenceRequest,
  ValuationKnowledgeRef,
  ValuationPlanningPort,
} from '../../../domains/report-evaluation/workflow/ports.ts'
import { VALUATION_TOOL_NAMES } from '../../../tools/report-evaluation/consts.ts'
import { createWorkflowToolDispatcher } from '../execution.ts'
import {
  createWorkflowMarketPorts,
  type WorkflowMarketDispatchResult,
  type WorkflowMarketSelectResult,
} from '../market.ts'
import { createWorkflowExecutionEvidencePort } from './evidence.ts'
import { prepareListingReferenceTemplate } from '../services/listing-reference.ts'
import type { WorkflowKnowledgeAdapter, WorkflowTemplateCatalog } from './knowledge.ts'
import type { WorkflowFrozenInput } from './types.ts'
import type { ValuationWorkflowExecution } from '../runtime.ts'
import type { HostWorkflowServiceDeps } from '../services/deps.ts'
import type { ValuationServicePrincipal } from '../services/access.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Merge verified template-directory sources into the selection/binder context by identity. */
function mergeCatalogSources(
  current: ValuationKnowledgeRef[],
  catalogSources: readonly KnowledgeSourceRecord[],
): ValuationKnowledgeRef[] {
  const seen = new Set(current.map((item) => item.sourceId))
  const merged = [...current]
  for (const source of catalogSources) {
    if (seen.has(source.sourceId)) continue
    seen.add(source.sourceId)
    merged.push({
      sourceId: source.sourceId,
      path: source.path,
      section: '',
      quote: source.body.slice(0, 400),
      digest: source.digest,
      spaceName: source.spaceName,
      kind: source.kind,
      body: source.body,
    })
  }
  return merged
}

/** Explicit method labels; only the listing-reference (market) slice is wired. */
const METHOD_LABELS: Record<string, string> = {
  market: '市场法',
  income: '收益法',
  cost: '成本法',
}

function unsupportedMethodError(methodRequest: string): string {
  const label = METHOD_LABELS[methodRequest] ?? methodRequest
  return `本切片只接入挂牌参考口径（market / 市场法）；已明确选择的方法（${methodRequest} / ${label}）尚未接入`
}

export interface CreateWorkflowPlanningOptions {
  deps: HostWorkflowServiceDeps
  frozenInput: WorkflowFrozenInput
  planId: string
  casePath: () => string
  /** Live principal for the current genuine execution. */
  principal: () => ValuationServicePrincipal | undefined
  /** Only the currently executing genuine ToolRunContext. */
  currentExecution: () => ValuationWorkflowExecution | undefined
  inference: ValuationInferencePort
  knowledge: WorkflowKnowledgeAdapter
}

export interface WorkflowPlanningPorts {
  planning: ValuationPlanningPort
  evidence: ValuationEvidencePort
  /** Shared mutable catalog filled from verified knowledge before each preflight. */
  allowedTemplatePaths: readonly string[]
}

export function createWorkflowPlanningPorts(
  options: CreateWorkflowPlanningOptions,
): WorkflowPlanningPorts {
  const allowedTemplatePaths: string[] = []

  const dispatch = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowMarketDispatchResult> => {
    const exec = options.currentExecution()
    if (exec === undefined) {
      return { ok: false, errorKind: 'policy', error: '本轮工作流没有受控执行：拒绝转发业务工具' }
    }
    const dispatcher = createWorkflowToolDispatcher({
      ctx: options.deps.ctx,
      ...(options.deps.valuationScopes === undefined ? {} : { valuationScopes: options.deps.valuationScopes }),
    }, exec)
    return dispatcher.dispatch(name, args, signal)
  }

  const uploadedTemplate = (): { path: string; digest: string } | undefined => {
    const fileId = text(options.frozenInput.templateFileId)
    if (fileId === '') return undefined
    const file = options.frozenInput.files.find((item) => item.fileId === fileId)
    if (file === undefined) return undefined
    const path = text(file.archiveRelativePath) || text(file.relativePath)
    return path === '' ? undefined : { path, digest: text(file.sha256) }
  }

  const market = createWorkflowMarketPorts({
    casePath: options.casePath(),
    planId: options.planId,
    allowedProviderIds: MARKET_PROVIDER_IDS,
    allowedTemplatePaths,
    dispatch,
    select: async (input): Promise<WorkflowMarketSelectResult> => {
      // The exact accepted source identities and the fields each may prove. Material
      // and knowledge bodies stay in their existing sections and are never duplicated.
      const materials = Array.isArray(input.materials) ? input.materials : []
      const knowledge = Array.isArray(input.knowledge) ? input.knowledge : []
      const sourceCatalog: Array<{
        sourceId: string
        kind: 'user' | 'material' | 'file-name' | 'knowledge'
        allowedFields: string[]
        text?: string
      }> = [
        {
          sourceId: USER_SOURCE_ID,
          kind: 'user',
          allowedFields: ['city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath'],
          text: input.userInput,
        },
      ]
      for (const material of materials) {
        sourceCatalog.push({
          sourceId: material.materialId,
          kind: 'material',
          allowedFields: ['city', 'community', 'nearbyCommunities'],
        })
        sourceCatalog.push({
          sourceId: `${material.materialId}${FILE_NAME_SUFFIX}`,
          kind: 'file-name',
          allowedFields: ['community'],
          text: material.fileName,
        })
      }
      for (const source of knowledge) {
        if (typeof source.body !== 'string' || source.body.trim() === '') continue
        sourceCatalog.push({
          sourceId: source.sourceId,
          kind: 'knowledge',
          allowedFields: ['valueScope', 'providerOrder', 'templatePath'],
        })
      }
      const request: ValuationInferenceRequest = {
        runId: input.request.runId,
        revision: input.request.revision,
        nodeId: 'planning-selection',
        stage: 'plan',
        attempt: 1,
        correlationId: `${input.request.runId}:planning-selection`,
        operation: 'planning-selection',
        materials: input.materials,
        facts: {
          userInput: input.userInput,
          promptSupplement: input.promptSupplement,
          allowedProviderIds: input.allowedProviderIds,
          allowedTemplatePaths: input.allowedTemplatePaths,
          sourceCatalog,
          methodOutput: input.request.methodOutput,
          // Original entry choices stay distinct from the current confirmed facts.
          initialInput: cloneInitialInput(input.request.initialInput),
          object: { ...input.request.object },
          purpose: input.request.purpose,
          baseDate: input.request.baseDate,
        },
        knowledge: input.knowledge,
        ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
      }
      const result = await options.inference.infer(request)
      return {
        ok: result.ok,
        ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
    prepareTemplate: async (input) => {
      const principal = options.principal()
      if (principal === undefined) return { ok: false, error: '模板核对需要真实的本轮估值执行' }
      const limitations: string[] = []
      const selectedPath = text(input.selection.templatePath)
      const uploaded = uploadedTemplate()
      const uploadedSelected = uploaded !== undefined && selectedPath !== '' && selectedPath === uploaded.path
      if (uploadedSelected) {
        // The uploaded workbook is a registered local original, never a business-library
        // Wiki path: it is preserved by archived identity and not downloaded from DWS.
        limitations.push(
          `用户上传的计算表按归档身份保留为未映射原始件：${uploaded.path}（摘要 ${uploaded.digest}）；`
          + '不按业务库 Wiki 路径取回，也不声明它已被填充',
        )
      } else if (selectedPath !== '') {
        let original: WorkflowMarketDispatchResult
        try {
          original = await dispatch(VALUATION_TOOL_NAMES.templateMaterialize, {
            caseDir: principal.caseDir,
            method: 'market',
            planId: options.planId,
            wikiPath: selectedPath,
          }, input.request.signal)
        } catch {
          original = { ok: false, errorKind: 'failed', error: '业务库计算表模板取回调用失败' }
        }
        if (!original.ok || !isRecord(original.value) || original.value.ok !== true) {
          const reason = isRecord(original.value) ? text(original.value.error) : ''
          return { ok: false, error: reason === '' ? '业务库计算表模板没有取回：拒绝在未验真的模板上出具参考结果' : reason }
        }
        const source = text(original.value.source)
        limitations.push(
          `业务库原始计算表已按选取路径取回：${selectedPath}（来源：${source || '业务库'}）；`
          + '它只作为原始件保留，本轮不声明它可直接自动计算',
        )
      } else {
        limitations.push('本轮没有登记业务库模板路径：未取回业务库原始计算表')
      }
      if (uploaded !== undefined && !uploadedSelected) {
        limitations.push(
          `用户上传的计算表按归档身份保留：${uploaded.path}（摘要 ${uploaded.digest}）；`
          + '未取得可核对的取值映射，不声明它已被填充',
        )
      }
      const prepared = await prepareListingReferenceTemplate({ planId: options.planId }, options.deps, principal)
      if (!prepared.ok || prepared.template === undefined) {
        return { ok: false, error: text(prepared.error) || '受控挂牌参考计算表没有准备成功' }
      }
      limitations.push(
        '本次参考计算使用受控挂牌参考计算表（独立于业务库原始模板与上传件）：'
        + '取值映射、摘要与公式检查均已逐项验真',
      )
      return { ok: true, template: prepared.template, limitations }
    },
  })

  const evidence = createWorkflowExecutionEvidencePort({
    casePath: options.casePath(),
    planId: options.planId,
    approvedEvidence: market.evidence,
    allowedProviderIds: MARKET_PROVIDER_IDS,
    allowedTemplatePaths,
    dispatch,
  })

  const planning: ValuationPlanningPort = {
    async prepare(request) {
      const methodRequest = text(options.frozenInput.methodRequest)
      if (!isMethodRequest(methodRequest)) {
        const error = `冻结输入里的评估方法不合法（${methodRequest || '空'}）：只允许 market / income / cost`
        return { ok: false, errorKind: 'input-invalid', error, gaps: [error] }
      }
      if (methodRequest !== 'market') {
        const error = unsupportedMethodError(methodRequest)
        return { ok: false, errorKind: 'capability-gap', error, gaps: [error] }
      }
      if (options.principal() === undefined) {
        return { ok: false, errorKind: 'policy', error: '规划预检需要真实的本轮估值执行' }
      }
      const uploaded = uploadedTemplate()
      // An uploaded workbook bypasses the DWS template-directory catalog entirely; its
      // archived identity is the only registered original and is never a Wiki path.
      let catalog: WorkflowTemplateCatalog = { paths: [], sources: [] }
      if (uploaded === undefined) {
        catalog = await options.knowledge.templateCatalog()
      }
      allowedTemplatePaths.length = 0
      const candidates = uploaded === undefined ? catalog.paths : [uploaded.path]
      for (const path of candidates) {
        if (path !== '' && !allowedTemplatePaths.includes(path)) allowedTemplatePaths.push(path)
      }
      // The verified directory bodies become source-bound planning/binder context.
      const currentKnowledge = request.knowledge ?? []
      const mergedKnowledge = mergeCatalogSources(currentKnowledge, catalog.sources)
      const planningRequest = mergedKnowledge.length === currentKnowledge.length
        ? request
        : { ...request, knowledge: mergedKnowledge }
      return market.planning.prepare(planningRequest)
    },
  }

  return { planning, evidence, allowedTemplatePaths }
}
