import { TEMPLATE_MARKET_NODES, type TemplateMarketState, type TemplateMarketNodeId, type TemplateMarketNodeInput,
  type TemplateMarketNodeOutput, type TemplateMarketNodeReceipt, type TemplateMarketNodeData } from '../../../../shared/contracts/valuation-template-market.ts'
import type { ValuationWorkflowInitialInput, ValuationWorkflowQuestion } from '../../../../shared/contracts/valuation-workflow.ts'
import type { ValuationQuestionAnswer, ValuationWorkflowQuestionnaire } from '../../../../shared/contracts/valuation-questionnaire.ts'
import { compileTemplateMarketGraph, type TemplateMarketNodeResult } from '../../../graph/valuation/realestate/template-market.ts'
import type { TemplateMarketPorts } from './ports.ts'
import { TemplateMarketPortError } from './ports.ts'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { admitQuestions, effectiveQuestionAnswers, emptyQuestionnaire, restoreQuestionnaire } from './questionnaire.ts'
import { bindTemplateRequirements } from './case-collection.ts'
import { evaluateTemplateMarketInputs, templateMarketConditionsKey } from './template-market-dispositions.ts'
import { validateTemplateMarketBinding, validateTemplateMarketInput, validateTemplateMarketOutput, TEMPLATE_MARKET_STATE_DATA_SCHEMA, validateMarketSchema } from './template-market-contracts.ts'

const clone = <T>(value: T): T => structuredClone(value)
const now = (): string => new Date().toISOString()
export interface TemplateMarketPersistence {
  save(state: TemplateMarketState): Promise<void>
  questionnaire?: () => ValuationWorkflowQuestionnaire
}
export interface TemplateMarketFlow {
  drive(state: TemplateMarketState, entry: TemplateMarketNodeId, signal?: AbortSignal): Promise<TemplateMarketState>
  invalidate(state: TemplateMarketState, changedFields: string[]): TemplateMarketState
}
export function createTemplateMarketState(input: { runId: string; initialInput: ValuationWorkflowInitialInput | null }): TemplateMarketState {
  return { flowVersion: 'template-market-v2', runId: input.runId, inputVersion: 1, status: 'running', currentNode: 'templates',
    initialInput: clone(input.initialInput), facts: {}, knowledge: [], capabilities: [], receipts: {}, plan: null,
    approvedPlanDigest: null, candidates: [], candidateVersion: 0, selectedCaseIds: [], selectionVersion: null,
    dispositions: [], budgetUsed: { pages: 0, candidates: 0, durationMs: 0 }, resumeTasks: [], artifacts: [],
    questionnaire: emptyQuestionnaire(), error: '', updatedAt: now() }
}
const completed = <N extends TemplateMarketNodeId>(data: TemplateMarketNodeData[N], summary: string): TemplateMarketNodeOutput<N> =>
  ({ outcome: 'completed', summary, data, questions: [], limitations: [], failure: null })
function failed(reason: string, kind: 'system' | 'output-contract' = 'output-contract'): TemplateMarketNodeOutput {
  return { outcome: 'failed', summary: reason, data: null, questions: [], limitations: [],
    failure: { kind, reason, requirements: [reason], actions: ['保留已保存回答和资料，核对当前节点后重试'] } }
}
function question(nodeId: TemplateMarketNodeId, field: string, prompt: string, options: Array<{ value: string; label: string }>, control: 'radio' | 'multiselect' = 'radio'): ValuationWorkflowQuestion {
  return { questionId: `${nodeId}:${field}`, nodeId, field, prompt, knownValue: '', source: '当前工作流',
    answerProtocol: 2, control, options, required: true, version: 1, applicable: true, reason: '执行前需要你的明确选择', allowDefer: false }
}
function choice(answer: ValuationQuestionAnswer | undefined): string[] { return answer?.kind === 'choice' ? answer.values : [] }
function answerFor(state: TemplateMarketState, field: string): ValuationQuestionAnswer | undefined {
  const q = state.questionnaire.questions.find(q => q.nodeId === state.currentNode && q.field === field && !q.needsConfirmation)
  return q?.answer ?? undefined
}
function makeInput<N extends TemplateMarketNodeId>(state: TemplateMarketState, nodeId: N): TemplateMarketNodeInput<N> {
  const upstream: TemplateMarketNodeInput['upstream'] = {}
  for (const id of TEMPLATE_MARKET_NODES) {
    const data = state.receipts[id]?.output?.data
    if (data !== null && data !== undefined && ['passed', 'partial'].includes(state.receipts[id]!.state)) {
      Object.assign(upstream, { [id]: clone(data) })
    }
  }
  if (upstream['search-listings']) upstream['search-listings'].candidates = clone(state.candidates)
  return { runId: state.runId, nodeId, candidateVersion: state.candidateVersion, inputVersion: state.inputVersion, initialInput: clone(state.initialInput),
    facts: clone(state.facts), upstream, knowledge: clone(state.knowledge), capabilities: clone(state.capabilities),
    answers: effectiveQuestionAnswers(state.questionnaire),
    notes: state.questionnaire.notes.map(({ noteId, nodeId, text }) => ({ noteId, nodeId, text })), dispositions: clone(state.dispositions) }
}

export function createTemplateMarketFlow(ports: TemplateMarketPorts, persistence: TemplateMarketPersistence, checkpointer?: BaseCheckpointSaver): TemplateMarketFlow {
  return {
    async drive(saved, entry, signal) {
      const state = clone(saved)
      state.status = 'running'; state.error = ''
      let tail: Promise<void> = Promise.resolve()
      const persist = async (): Promise<void> => {
        const live = persistence.questionnaire?.()
        if (live && JSON.stringify(live.drafts) !== JSON.stringify(state.questionnaire.drafts)) {
          state.questionnaire.drafts = clone(live.drafts)
          state.questionnaire.version = Math.max(state.questionnaire.version, live.version) + 1
        }
        state.updatedAt = now()
        const image = clone(state)
        tail = tail.then(() => persistence.save(image))
        try { await tail } catch { throw new Error('运行状态未能持久化，已停止后续业务操作') }
      }
      const wait = (nodeId: TemplateMarketNodeId, questions: ValuationWorkflowQuestion[], data: TemplateMarketNodeOutput['data'] = null): TemplateMarketNodeOutput => {
        state.questionnaire = admitQuestions(state.questionnaire, nodeId, questions)
        return { outcome: 'needs-user', summary: '等待你的选择，回答已保存后再执行下一步', data, questions, limitations: [], failure: null }
      }
      const execute = async (nodeId: TemplateMarketNodeId): Promise<TemplateMarketNodeResult> => {
        if (signal?.aborted) { state.status = 'cancelled'; await persist(); return { status: 'cancelled' } }
        if ((nodeId === 'templates' || nodeId === 'materials') && state.receipts[nodeId]?.state === 'passed') return { status: 'running' }
        if (nodeId === 'collection-plan' && ['templates', 'materials'].some(id => state.receipts[id as TemplateMarketNodeId]?.state !== 'passed'
          && state.receipts[id as TemplateMarketNodeId]?.state !== 'partial')) {
          if (state.status !== 'failed') state.status = 'waiting-user'
          await persist()
          return { status: state.status === 'failed' ? 'failed' : 'waiting' }
        }
        if (nodeId !== 'templates' && nodeId !== 'materials') state.currentNode = nodeId
        const input = makeInput(state, nodeId)
        const receipt: TemplateMarketNodeReceipt = { nodeId, state: 'running', attempt: (state.receipts[nodeId]?.attempt ?? 0) + 1,
          inputVersion: state.inputVersion, inputs: input, output: null, updatedAt: now() }
        state.receipts[nodeId] = receipt
        await persist()
        let out: TemplateMarketNodeOutput
        let nextNode: TemplateMarketNodeId | undefined
        const validInput = validateTemplateMarketInput(nodeId, input)
        if (!validInput.ok) out = failed(validInput.errors.join('；'))
        else try {
          switch (nodeId) {
            case 'templates': out = await ports.readTemplates(input as TemplateMarketNodeInput<'templates'>, signal); break
            case 'materials': out = await ports.readMaterials(input as TemplateMarketNodeInput<'materials'>, signal); break
            case 'collection-plan': out = await ports.plan(input as TemplateMarketNodeInput<'collection-plan'>, signal); break
            case 'confirm-plan': {
              if (!state.plan) { out = failed('尚无可确认的采集方案'); break }
              const approvalQuestion = question(nodeId, 'approval', '请确认采集方案、模板、渠道、筛选条件和价格口径；未核项保留在底稿中',
                [{ value: 'accept', label: '按此方案采集，缺项保留待核' }, { value: 'amend', label: '修改方案后再确认' }])
              approvalQuestion.version = state.inputVersion * 1000 + (state.receipts['collection-plan']?.attempt ?? 1)
              state.questionnaire = admitQuestions(state.questionnaire, nodeId, [approvalQuestion])
              const approval = answerFor(state, 'approval')
              if (!approval) { out = wait(nodeId, [approvalQuestion]); break }
              if (choice(approval)[0] !== 'accept') {
                nextNode = 'collection-plan'
                out = completed<'confirm-plan'>({ planDigest: state.plan.digest, accepted: false,
                  amendments: approval.kind === 'other' ? approval.text : approval.kind === 'choice' ? approval.supplement : '' }, '已保留修改意见，重新制定方案')
                state.approvedPlanDigest = null
                break
              }
              if (Object.values(state.plan.budget).some(value => value === null)) { out = failed('检索预算尚未确定，请修改并确认具体预算'); break }
              out = completed<'confirm-plan'>({ planDigest: state.plan.digest, accepted: true, amendments: approval.kind === 'choice' ? approval.supplement : '' }, '采集方案已确认')
              state.approvedPlanDigest = state.plan.digest
              const submission = [...state.questionnaire.submissions].reverse().find(s => s.nodeId === nodeId)
              if (submission) {
                const scope = { objectId: state.plan.subject.objectId, templateDigest: state.plan.template.digest,
                  fieldIds: state.plan.requirements.fields.map(f => f.fieldId), caseIds: [], conditions: templateMarketConditionsKey(state.plan) }
                state.dispositions.push({ dispositionId: `${submission.submissionId}:blank`, kind: 'leave-blank', scope,
                  reason: approval.kind === 'choice' && approval.supplement.trim() ? approval.supplement : '按已确认方案保留缺项，交付范围以实际核验为准', assumption: null, acceptedBySubmissionId: submission.submissionId })
                for (const proposal of state.plan.proposedDispositions) state.dispositions.push({ ...clone(proposal),
                  scope: { ...scope, fieldIds: proposal.scope.fieldIds }, acceptedBySubmissionId: submission.submissionId })
              }
              break
            }
            case 'search-listings': {
              if (!state.plan || state.approvedPlanDigest !== state.plan.digest) { out = failed('采集方案未经当前版本确认'); break }
              out = await ports.search(input as TemplateMarketNodeInput<'search-listings'>, signal); break
            }
            case 'candidate-workbook': out = await ports.writeCandidates(input as TemplateMarketNodeInput<'candidate-workbook'>, signal); break
            case 'select-cases': {
              const options = state.candidates.filter(c => c.status !== 'rejected').map(c => ({ value: c.caseId,
                label: `${c.caseId} · ${c.recommendation || '待核案例'}` }))
              const questions = [question(nodeId, 'caseIds', '选择需要读取详情和截图的案例', options.length ? options : [{ value: 'none', label: '当前没有可选案例，先整理已得底稿' }], 'multiselect'),
                question(nodeId, 'searchDecision', '本轮是否继续补充检索？', [{ value: 'stop', label: '停止补搜，使用当前选择继续' },
                  ...(state.resumeTasks.length ? [{ value: 'continue', label: '在剩余预算内继续检索' }] : [])])]
              questions[0]!.allowDefer = true
              const assumptions = state.plan?.proposedDispositions.filter(d => d.kind === 'accept-assumption') ?? []
              if (assumptions.length) questions.push(question(nodeId, 'assumptions',
                `是否将以下情景假设用于本次所选案例？${assumptions.map(d => `${d.scope.fieldIds.join('、')} = ${d.assumption?.value ?? ''} ${d.assumption?.unit ?? ''}（${d.reason}）`).join('；')}`,
                [{ value: 'accept', label: '明确接受这些假设，按所选案例整理情景底稿' }, { value: 'blank', label: '不使用假设，缺项留空待核' }]))
              for (const q of questions) q.version = Math.max(1, state.candidateVersion)
              state.questionnaire = admitQuestions(state.questionnaire, nodeId, questions)
              const selected = answerFor(state, 'caseIds'), search = answerFor(state, 'searchDecision')
              const assumptionAnswer = answerFor(state, 'assumptions')
              if (!selected || !search || (assumptions.length && !assumptionAnswer)) { out = wait(nodeId, questions); break }
              const selectedCaseIds = choice(selected).filter(id => id !== 'none')
              const searchDecision = choice(search)[0] === 'continue' ? 'continue' : 'stop'
              out = completed<'select-cases'>({ candidateVersion: state.candidateVersion, selectedCaseIds,
                searchDecision, supplement: selected.kind === 'other' ? selected.text : selected.kind === 'choice' ? selected.supplement : '' }, '已保存拟核实案例选择')
              if (selected.kind === 'other' || search.kind === 'other' || assumptionAnswer?.kind === 'other') nextNode = 'collection-plan'
              else if (searchDecision === 'continue' && state.resumeTasks.length) nextNode = 'search-listings'
              else if (state.plan) {
                const submission = [...state.questionnaire.submissions].reverse().find(s => s.nodeId === nodeId)
                if (submission && selected.kind === 'defer') state.dispositions.push({ dispositionId: `${submission.submissionId}:defer-cases`,
                  kind: 'defer-verification', scope: { objectId: state.plan.subject.objectId, templateDigest: state.plan.template.digest,
                    fieldIds: state.plan.requirements.fields.filter(f => f.owner === 'case').map(f => f.fieldId), caseIds: [],
                    conditions: templateMarketConditionsKey(state.plan) }, reason: selected.reason, assumption: null, acceptedBySubmissionId: submission.submissionId })
                if (submission && choice(assumptionAnswer)[0] === 'accept') for (const proposal of assumptions) {
                  state.dispositions.push({ ...clone(proposal), dispositionId: `${submission.submissionId}:${proposal.dispositionId}`,
                    scope: { objectId: state.plan.subject.objectId, templateDigest: state.plan.template.digest,
                      fieldIds: clone(proposal.scope.fieldIds), caseIds: clone(selectedCaseIds), conditions: templateMarketConditionsKey(state.plan) },
                    acceptedBySubmissionId: submission.submissionId })
                }
                if (submission) state.dispositions.push({ dispositionId: `${submission.submissionId}:stop`, kind: 'stop-search',
                  scope: { objectId: state.plan.subject.objectId, templateDigest: state.plan.template.digest, fieldIds: [], caseIds: selectedCaseIds,
                    conditions: templateMarketConditionsKey(state.plan) }, reason: search.kind === 'choice' && search.supplement.trim() ? search.supplement : '使用当前选择继续，停止本轮补搜',
                  assumption: null, acceptedBySubmissionId: submission.submissionId })
              }
              break
            }
            case 'inspect-details': {
              if (state.selectionVersion !== state.candidateVersion) { out = failed('案例选择版本已变化，请重新核对'); break }
              out = await ports.inspectDetails(input as TemplateMarketNodeInput<'inspect-details'>, signal); break
            }
            case 'check-inputs': {
              const decision = evaluateTemplateMarketInputs(state)
              out = completed<'check-inputs'>({ decision, missingFields: decision.missingFields, requiredJudgments: [] }, '已确定本轮可交付范围')
              out.limitations = decision.limitations
              if (decision.limitations.length) out.outcome = 'completed-with-limits'
              break
            }
            case 'fill-template': out = await ports.fillTemplate(input as TemplateMarketNodeInput<'fill-template'>, signal); break
            case 'validate-delivery': out = await ports.verifyDelivery(input as TemplateMarketNodeInput<'validate-delivery'>, signal); break
          }
        } catch (error) {
          if (error && typeof error === 'object' && 'errorKind' in error && error.errorKind === 'stop-unknown') throw error
          if (signal?.aborted) { state.status = 'cancelled'; receipt.state = 'cancelled'; await persist(); return { status: 'cancelled' } }
          out = failed(error instanceof TemplateMarketPortError || (error instanceof Error && error.message === '运行状态未能持久化，已停止后续业务操作')
            ? error.message : '当前节点执行失败，已保留取得的资料和回答', 'system')
          if (error instanceof TemplateMarketPortError) out.failure!.actions = [error.message]
        }
        if (out.outcome === 'needs-user') state.questionnaire = admitQuestions(state.questionnaire, nodeId, out.questions)
        const valid = validateTemplateMarketBinding(nodeId, out, state)
        if (!valid.ok) out = failed(valid.errors.join('；'))
        if (nodeId === 'collection-plan' && out.data !== null && out.outcome !== 'failed') {
          const plan = (out.data as TemplateMarketNodeData['collection-plan']).plan
          const bound = bindTemplateRequirements(plan.requirements, plan.template, state.knowledge, { allowUnresolved: true })
          if (!bound.ok) out = failed(bound.gaps.join('；'))
        }
        receipt.output = clone(out); receipt.updatedAt = now()
        receipt.state = out.outcome === 'failed' ? 'failed' : out.outcome === 'needs-user' ? 'waiting'
          : out.outcome === 'completed-with-limits' ? 'partial' : 'passed'
        if (out.outcome === 'failed') { state.status = 'failed'; state.currentNode = nodeId; state.error = out.failure!.reason }
        else if (out.outcome === 'needs-user') { state.status = 'waiting-user'; state.currentNode = nodeId }
        else if (out.data !== null) {
          switch (nodeId) {
            case 'templates': state.knowledge = clone((out.data as TemplateMarketNodeData['templates']).instructions); break
            case 'materials': Object.assign(state.facts, clone((out.data as TemplateMarketNodeData['materials']).subjectFacts)); break
            case 'collection-plan': {
              if (state.plan !== null) state.inputVersion += 1
              for (const id of TEMPLATE_MARKET_NODES.slice(TEMPLATE_MARKET_NODES.indexOf('confirm-plan'))) delete state.receipts[id]
              state.plan = clone((out.data as TemplateMarketNodeData['collection-plan']).plan)
              state.approvedPlanDigest = null; state.selectedCaseIds = []; state.selectionVersion = null
              state.candidates = []; state.resumeTasks = []; state.dispositions = []; state.artifacts = []
              state.budgetUsed = { pages: 0, candidates: 0, durationMs: 0 }
              break
            }
            case 'search-listings': {
              const data = out.data as TemplateMarketNodeData['search-listings']
              state.candidates = clone(data.candidates); state.budgetUsed = clone(data.budgetUsed); state.resumeTasks = clone(data.resumeTasks)
              state.candidateVersion += 1
              break
            }
            case 'candidate-workbook': {
              const data = out.data as TemplateMarketNodeData['candidate-workbook']
              if (data.candidateVersion !== state.candidateVersion) { out = failed('候选表版本与当前候选不一致'); receipt.output = out; receipt.state = 'failed'; state.status = 'failed'; state.error = out.summary }
              else state.artifacts = [...state.artifacts.filter(a => a.kind !== 'candidates'), clone(data.artifact)]
              break
            }
            case 'select-cases': {
              const data = out.data as TemplateMarketNodeData['select-cases']
              state.selectedCaseIds = clone(data.selectedCaseIds); state.selectionVersion = data.candidateVersion
              break
            }
            case 'inspect-details': {
              const data = out.data as TemplateMarketNodeData['inspect-details']
              for (const c of data.candidates) {
                const at = state.candidates.findIndex(item => item.caseId === c.caseId)
                if (at >= 0 && state.selectedCaseIds.includes(c.caseId)) state.candidates[at] = clone(c)
              }
              state.artifacts = [...state.artifacts.filter(a => a.kind !== 'candidates'), clone(data.updatedArtifact)]
              if (data.reselectionCaseIds.length) { state.selectionVersion = null; state.candidateVersion += 1; nextNode = 'candidate-workbook' }
              break
            }
            case 'fill-template': {
              const data = out.data as TemplateMarketNodeData['fill-template']
              const incoming = clone(data.artifacts)
              state.artifacts = [...state.artifacts.filter(a => !incoming.some(b => b.kind === a.kind)), ...incoming]
              state.candidates = state.candidates.map(c => ({ ...c, selectionState: data.adoptedCaseIds.includes(c.caseId) ? 'adopted' : c.selectionState }))
              break
            }
            case 'validate-delivery': {
              const data = out.data as TemplateMarketNodeData['validate-delivery']
              state.artifacts = clone(data.verifiedArtifacts)
              state.status = data.deliveryKind === 'workpaper' || data.unverifiedItems.length || out.limitations.length ? 'partial' : 'completed'
              break
            }
          }
        }
        await persist()
        return { status: state.status === 'failed' ? 'failed' : state.status === 'waiting-user' ? 'waiting'
          : state.status === 'completed' || state.status === 'partial' ? 'completed' : 'running',
          outputs: { [nodeId]: clone(out) as unknown as Record<string, unknown> }, ...(nextNode ? { nextNode } : {}) }
      }
      await persist()
      const graph = compileTemplateMarketGraph(execute, checkpointer)
      const outputs = Object.fromEntries(TEMPLATE_MARKET_NODES.map(id => [id, state.receipts[id]?.output ?? {}]))
      await graph.invoke({ entry, status: 'running', marketOutcomes: Object.fromEntries(TEMPLATE_MARKET_NODES.map(id => [id, 'running' as const])), marketNext: '', outputs },
        { recursionLimit: 50, configurable: { thread_id: state.runId } })
      if (signal?.aborted) state.status = 'cancelled'
      await persist()
      return clone(state)
    },
    invalidate(saved, changedFields) {
      const state = clone(saved)
      if (changedFields.every(field => ['note', 'promptSupplement'].includes(field))) return state
      const from = changedFields.includes('template') ? 'templates' : changedFields.some(field => ['areaSqm', 'useLabel', 'materials'].includes(field)) ? 'materials' : 'collection-plan'
      for (const node of TEMPLATE_MARKET_NODES) {
        if (node === 'templates' && from !== 'templates') continue
        if (node === 'materials' && from !== 'materials') continue
        delete state.receipts[node]
      }
      state.approvedPlanDigest = null; state.selectionVersion = null; state.plan = null
      state.inputVersion += 1; state.currentNode = from; state.status = 'running'
      return state
    },
  }
}

export function parseTemplateMarketState(value: unknown): TemplateMarketState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as TemplateMarketState
  const expected = Object.keys(createTemplateMarketState({ runId: 'validation', initialInput: null }))
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))
    || state.flowVersion !== 'template-market-v2' || typeof state.runId !== 'string' || !state.runId.trim()
    || !Number.isSafeInteger(state.inputVersion) || state.inputVersion < 1
    || !TEMPLATE_MARKET_NODES.includes(state.currentNode) || !state.receipts || !Array.isArray(state.candidates)
    || !Array.isArray(state.selectedCaseIds) || !Array.isArray(state.artifacts) || !restoreQuestionnaire(state.questionnaire)
    || !['running', 'waiting-user', 'completed', 'partial', 'failed', 'cancelled'].includes(state.status)) return null
  const { receipts: _receipts, questionnaire: _questionnaire, ...data } = state
  if (!validateMarketSchema(TEMPLATE_MARKET_STATE_DATA_SCHEMA, data).ok) return null
  if (new Set(state.candidates.map(c => c.caseId)).size !== state.candidates.length || new Set(state.selectedCaseIds).size !== state.selectedCaseIds.length) return null
  if (state.approvedPlanDigest !== null && state.approvedPlanDigest !== state.plan?.digest) return null
  if (state.selectedCaseIds.some(id => !state.candidates.some(c => c.caseId === id))) return null
  for (const [id, receipt] of Object.entries(state.receipts)) {
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'attempt,inputVersion,inputs,nodeId,output,state,updatedAt' || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1
      || !Number.isSafeInteger(receipt.inputVersion) || receipt.inputVersion < 1 || receipt.inputVersion > state.inputVersion || typeof receipt.updatedAt !== 'string'
      || !['pending', 'running', 'waiting', 'passed', 'partial', 'failed', 'cancelled'].includes(receipt.state)
      || !TEMPLATE_MARKET_NODES.includes(id as TemplateMarketNodeId) || receipt.nodeId !== id
      || (receipt.inputs !== null && !validateTemplateMarketInput(id as TemplateMarketNodeId, receipt.inputs).ok)
      || (receipt.output !== null && !validateTemplateMarketOutput(id as TemplateMarketNodeId, receipt.output).ok)) return null
  }
  return clone(state)
}
