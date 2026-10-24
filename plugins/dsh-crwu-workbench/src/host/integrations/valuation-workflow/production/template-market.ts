import { createMarketWorkbookPort } from '../services/market-workbook.ts'
import { createTemplateMarketEvidencePorts } from './template-market-evidence.ts'
import { readMarketEvidence } from '../services/market-evidence.ts'
import { marketCompleted, marketFailure } from './template-market-output.ts'
import type { TemplateMarketNodeId, TemplateMarketNodeInput, TemplateMarketNodeOutput, TemplateMarketNodeData,
  TemplateMarketPlan, TemplateMarketFact, TemplateMarketSourceRef } from '../../../../shared/contracts/valuation-template-market.ts'
import type { TemplateProfile } from '../../../../shared/contracts/valuation-template.ts'
import type { TemplateMarketPorts } from '../../../domains/report-evaluation/workflow/ports.ts'
import { bindElementFacts } from '../../../domains/report-evaluation/workflow/elements.ts'
import { bindTemplateRequirements } from '../../../domains/report-evaluation/workflow/case-collection.ts'
import { validateMarketSchema, TEMPLATE_MARKET_PLAN_SCHEMA, validateTemplateMarketOutput } from '../../../domains/report-evaluation/workflow/template-market-contracts.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { MARKET_PROVIDER_IDS } from '../../../domains/report-evaluation/browser/login-state.ts'
import { PROVIDER_SITES } from '../../../domains/report-evaluation/browser/providers.ts'
import { createWorkflowToolDispatcher } from '../execution.ts'
import { inspectWorkflowTemplate, type RegisteredWorkflowTemplate } from '../services/template-inspection.ts'
import { VALUATION_TOOL_NAMES } from '../../../tools/report-evaluation/consts.ts'
import type { CreateWorkflowPlanningOptions } from './planning.ts'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}
export function bindTemplateMarketPlan(value: unknown, context: {
  planId?: string; subject?: TemplateMarketPlan['subject']; profiles: TemplateProfile[]; knowledge: Array<TemplateMarketSourceRef & { body: string }>; providers: readonly string[]
}): { ok: true; plan: TemplateMarketPlan } | { ok: false; error: string } {
  if (!validateMarketSchema(TEMPLATE_MARKET_PLAN_SCHEMA, value).ok) return { ok: false, error: '采集方案结构无效' }
  const plan = structuredClone(value as TemplateMarketPlan)
  if (context.subject) plan.subject = structuredClone(context.subject)
  if (!context.profiles.some(profile => JSON.stringify(stable(profile)) === JSON.stringify(stable(plan.template)))) return { ok: false, error: '方案模板不属于本轮验真目录' }
  if (!plan.providers.length || new Set(plan.providers).size !== plan.providers.length || plan.providers.some(id => !context.providers.includes(id))) return { ok: false, error: '方案来源未登记' }
  const bound = bindTemplateRequirements(plan.requirements, plan.template, context.knowledge, { allowUnresolved: true })
  if (!bound.ok) return { ok: false, error: bound.gaps.join('；') }
  if (plan.proposedDispositions.some(d => d.acceptedBySubmissionId !== '' || !d.reason.trim()
    || d.scope.fieldIds.some(id => !plan.requirements.fields.some(f => f.fieldId === id))
    || (d.kind === 'accept-assumption' && (d.assumption?.value === null || d.assumption === null)))) return { ok: false, error: '待确认处置必须指向本轮字段，不能由模型预先批准或填入空假设' }
  if ((plan.budget.maxPages ?? 0) > 20 || (plan.budget.maxCandidates ?? 0) > 200 || (plan.budget.maxDurationMs ?? 0) > 120000) return { ok: false, error: '检索建议超出已声明的单次技术上限' }
  if (context.planId) plan.planId = context.planId
  plan.digest = knowledgeDigest(JSON.stringify(stable({ ...plan, digest: '' })))
  return { ok: true, plan }
}
export interface ProductionTemplateMarketOptions extends CreateWorkflowPlanningOptions {
  materials: () => Promise<Array<{ materialId: string; fileName: string; digest: string; text?: string }>>
}
export function templateMarketUserContext(input: TemplateMarketNodeInput, materials: Array<{ text?: string }>): string {
  return [input.initialInput?.userInput ?? '', input.initialInput?.supplementalPrompt ?? '',
    typeof input.facts.promptSupplement?.value === 'string' ? input.facts.promptSupplement.value : '',
    ...Object.values(input.answers).map(a => a.kind === 'other' ? a.text : a.kind === 'value' ? `${a.value}\n${a.supplement}`
      : a.kind === 'choice' ? `${a.values.join(' ')}\n${a.supplement}` : a.kind === 'defer' ? a.reason : ''),
    ...input.notes.map(n => n.text), input.upstream['confirm-plan']?.amendments ?? '', input.upstream['select-cases']?.supplement ?? '',
    ...materials.map(m => m.text ?? '')].join('\n')
}

export function createProductionTemplateMarketPorts(options: ProductionTemplateMarketOptions): TemplateMarketPorts {
  const templates = new Map<string, RegisteredWorkflowTemplate>()
  const dispatch = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const exec = options.currentExecution()
    if (!exec) throw new Error('本轮没有受控执行，请回到当前估值任务重试')
    return createWorkflowToolDispatcher({ ctx: options.deps.ctx,
      ...(options.deps.valuationScopes ? { valuationScopes: options.deps.valuationScopes } : {}) }, exec).dispatch(name, args, signal)
  }
  const infer = async <N extends TemplateMarketNodeId>(input: TemplateMarketNodeInput<N>, signal?: AbortSignal): Promise<TemplateMarketNodeOutput<N>> => {
    const result = await options.inference.infer({ runId: input.runId, revision: input.inputVersion, nodeId: input.nodeId,
      stage: 'plan', attempt: 1, correlationId: `${input.runId}:${input.nodeId}:${input.inputVersion}`, operation: 'template-market',
      facts: { nodeInput: input, allowedProviderIds: MARKET_PROVIDER_IDS, providerCapabilities: PROVIDER_SITES.map(p => ({ id: p.id, evidence: p.evidence, reason: p.evidenceNote })) },
      knowledge: input.knowledge.map(k => ({ sourceId: k.sourceId, path: k.location, section: '', quote: '', digest: k.digest, body: k.body })),
      materials: await options.materials(), ...(signal ? { signal } : {}) })
    if (!result.ok) {
      if (result.errorKind === 'stop-unknown') throw Object.assign(new Error('子会话停止状态尚未确认，请保留当前任务等待对账'), { errorKind: 'stop-unknown', sessionId: result.sessionId })
      return marketFailure(result.errorKind === 'output-contract' ? '模型成果未通过本节点契约校验，请重试当前节点' : '本节点推理未完成，请保留资料后重试')
    }
    return validateTemplateMarketOutput(input.nodeId, result.outputs).ok ? structuredClone(result.outputs) as unknown as TemplateMarketNodeOutput<N> : marketFailure('节点成果结构无效，未进入后续采集')
  }
  const workbooks = createMarketWorkbookPort(options.deps, options.principal)
  const evidence = createTemplateMarketEvidencePorts({ casePath: options.casePath, planId: options.planId, dispatch,
    readEvidence: async (path, digest) => { const principal = options.principal(); if (!principal) throw new Error('没有当前执行'); return readMarketEvidence(options.deps, principal, path, digest) },
    writeCandidates: workbooks.writeCandidates,
  })
  return {
    async readTemplates(input, signal) {
      const principal = options.principal()
      if (!principal) return marketFailure('模板检查需要本轮真实执行，请重新进入当前任务')
      const catalog = await options.knowledge.templateCatalog()
      const registered: RegisteredWorkflowTemplate[] = []
      const uploaded = options.frozenInput.files.find(f => f.fileId === options.frozenInput.templateFileId)
      if (uploaded) registered.push({ templateId: `upload-${uploaded.fileId}`, relativePath: uploaded.archiveRelativePath || uploaded.relativePath || '', digest: uploaded.sha256.startsWith('sha256:') ? uploaded.sha256 : `sha256:${uploaded.sha256}` })
      const limitations: string[] = []
      for (const path of catalog.paths) {
        if (signal?.aborted) return marketFailure('模板准备已取消，已取得目录仍保留')
        const materialized = await dispatch(VALUATION_TOOL_NAMES.templateMaterialize, { caseDir: principal.caseDir, planId: options.planId, method: 'market', wikiPath: path }, signal)
        const value = materialized.value as Record<string, unknown> | undefined
        if (!materialized.ok || value?.ok !== true || value.spaceVerified !== true || typeof value.snapshotFile !== 'string' || typeof value.digest !== 'string') {
          limitations.push(`模板未核：${path}；请核对知识库文件和访问能力后重试`)
          if (['capability-gap', 'infrastructure', 'policy'].includes(String(value?.errorKind ?? materialized.errorKind))) break
          continue
        }
        registered.push({ templateId: `kb-${knowledgeDigest(path).slice(-20)}`, relativePath: `知识快照/${value.snapshotFile}`, digest: value.digest })
      }
      const profiles: TemplateProfile[] = []
      for (const template of registered) {
        templates.set(template.templateId, template)
        const inspected = await inspectWorkflowTemplate({ planId: options.planId, templateId: template.templateId },
          { ...options.deps, resolveTemplate: id => templates.get(id) }, principal)
        if (!inspected.ok || !inspected.profile) {
          limitations.push(`模板未核：${template.relativePath}；${inspected.error}`)
          if (inspected.errorKind === 'capability-gap' || inspected.errorKind === 'infrastructure') break
          continue
        }
        profiles.push(inspected.profile)
      }
      if (!profiles.length) return marketFailure(`本轮未取得可填模板。${limitations.join('；') || '请上传 xlsx 计算表或修复知识库模板目录'}`)
      const out = marketCompleted<'templates'>({ catalog: profiles.map(p => ({ templateId: p.templateId, digest: p.digest, relativePath: p.relativePath })), profiles,
        instructions: catalog.sources.map(s => ({ sourceId: s.sourceId, digest: s.digest, location: s.path, body: s.body })),
        technicalStatus: profiles.map(p => ({ templateId: p.templateId, canFill: true, canCalculate: false, reasons: ['尚无验真的原模板重算引擎，允许回填底稿'] })) }, '已验真可填模板及已读取的知识目录')
      out.limitations = [...limitations, '目录读取范围为入口和直接链接文档，未读取更深目录；未宣称全部知识已核']
      return out
    },
    async readMaterials(input, signal) {
      const materials = await options.materials()
      const result = await options.inference.infer({ runId: input.runId, revision: input.inputVersion, nodeId: 'materials', stage: 'elements', attempt: 1,
        correlationId: `${input.runId}:materials:${input.inputVersion}`, materials, facts: { initialInput: input.initialInput, confirmedFacts: input.facts }, knowledge: [], ...(signal ? { signal } : {}) })
      if (!result.ok) {
        if (result.errorKind === 'stop-unknown') throw Object.assign(new Error('资料推理子会话停止尚未确认'), { errorKind: 'stop-unknown', sessionId: result.sessionId })
        return marketFailure('资料解析未完成，请核对资料读取状态后重试')
      }
      const bound = bindElementFacts({ sourceFacts: result.outputs?.sourceFacts ?? [], materials, current: { purpose: '', baseDate: '', useLabel: '', areaSqm: null } })
      if (!bound.ok) return marketFailure(bound.gaps.join('；') || '资料事实未通过出处核对')
      const subjectFacts: Record<string, TemplateMarketFact> = { ...input.facts }
      for (const f of bound.adopted) if (!subjectFacts[f.field]) subjectFacts[f.field] = { value: f.value, unit: f.field === 'areaSqm' ? '㎡' : '', status: 'verified',
        evidenceRefs: [{ sourceId: f.source.materialId, digest: f.source.digest, location: f.source.quote }] }
      return marketCompleted<'materials'>({ subjectFacts, sourceRefs: materials.map(m => ({ sourceId: m.materialId, digest: m.digest, location: m.fileName })), unverifiedFields: bound.conflicts }, '已提取有出处的资料事实')
    },
    async plan(input, signal) {
      const out = await infer(input, signal)
      if (!out.data || out.outcome === 'failed' || out.outcome === 'needs-user') return out
      const prepared = input.upstream.templates
      if (!prepared) return marketFailure('未取得验真模板，请重新准备模板')
      const objectId = input.facts.objectId
      if (objectId?.status !== 'verified' || typeof objectId.value !== 'string' || !objectId.value) return marketFailure('估价对象身份尚未登记，请核对本轮对象后重试')
      const area = input.facts.areaSqm, use = input.facts.useLabel
      const bound = bindTemplateMarketPlan(out.data.plan, { planId: options.planId, profiles: prepared.profiles, knowledge: input.knowledge, providers: MARKET_PROVIDER_IDS,
        subject: { objectId: objectId.value, areaSqm: area?.status === 'verified' && typeof area.value === 'number' ? area.value : null,
          useLabel: use?.status === 'verified' && typeof use.value === 'string' ? use.value : '' } })
      if (!bound.ok) return marketFailure(bound.error)
      const bodies = templateMarketUserContext(input, await options.materials())
      if (!bound.plan.filters.city || !bound.plan.filters.community || !bodies.includes(bound.plan.filters.city) || !bodies.includes(bound.plan.filters.community)) return {
        outcome: 'needs-user', summary: '请补充本次检索地点', data: null, limitations: [], failure: null,
        questions: ['city', 'community'].map(field => ({ questionId: `collection-plan:${field}`, field, nodeId: 'collection-plan',
          prompt: field === 'city' ? '本次估价对象位于哪个城市？' : '本次估价对象的小区或具体地址是什么？',
          knownValue: '', source: '资料正文尚未核实', answerProtocol: 2, control: 'text', required: true, version: input.inputVersion,
          applicable: true, reason: '检索前需要有依据的地点，文件名不能证明地址', allowDefer: false })) }

      return { ...out, data: { plan: bound.plan } }
    },
    search: evidence.search,
    writeCandidates: workbooks.writeCandidates,
    inspectDetails: evidence.inspectDetails,
    fillTemplate: workbooks.fillTemplate,
    verifyDelivery: workbooks.verifyDelivery,
  }
}
