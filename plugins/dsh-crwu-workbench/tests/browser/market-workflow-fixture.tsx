import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { MarketWorkflowView } from '../../src/client/modules/report-evaluation/market/MarketWorkflow.tsx'
import { MARKET_NODE_META, deriveMarketView } from '../../src/client/modules/report-evaluation/market/model.ts'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'
import type { ValuationWorkflowNodeView, ValuationWorkflowProgressView } from '../../src/shared/contracts/valuation-workflow.ts'
import type { TemplateMarketCandidate, TemplateMarketPlan } from '../../src/shared/contracts/valuation-template-market.ts'
import type { ValuationQuestionEdit, ValuationWorkflowQuestionnaire } from '../../src/shared/contracts/valuation-questionnaire.ts'

const NODE_IDS = MARKET_NODE_META.map((node) => node.id)
const stateOf = (id: string, phase: string): string => {
  const index = NODE_IDS.indexOf(id as never)
  if (phase === 'executing') return index <= 6 ? 'passed' : index === 7 ? 'running' : 'pending'
  if (phase === 'submitting' || phase === 'queued') return index <= 5 ? 'passed' : index === 6 ? 'waiting' : 'pending'
  if (phase === 'done') return index <= 7 ? 'passed' : index === 8 ? 'waiting' : 'pending'
  if (phase === 'restricted') return index <= 8 ? 'passed' : index === 9 ? 'partial' : 'partial'
  if (phase === 'failed') return index <= 5 ? 'passed' : index === 6 ? 'failed' : 'pending'
  if (phase === 'awaiting') return index <= 5 ? 'passed' : index === 6 ? 'waiting' : 'pending'
  return 'pending'
}
function graph(phase: string) {
  return { graphId: 'fixture.template-market.v2', version: '2', nodes: MARKET_NODE_META.map((node) => ({
    nodeId: `valuation:realestate:template-market:${node.id}`,
    templateMarketNodeId: node.id,
    label: node.label,
    state: stateOf(node.id, phase),
    gaps: node.id === 'select-cases' && phase === 'failed' ? ['保存回答失败：已保留本地草稿，可重试同一轮'] : [],
  })), edges: [] }
}
const plan: TemplateMarketPlan = {
  planId: 'fixture-plan', digest: 'sha256:' + 'a'.repeat(64),
  template: { templateId: 'fixture-template', digest: 'sha256:' + 'b'.repeat(64), relativePath: '知识快照/市场法计算表模板-住宅.xlsx',
    sheets: [], cells: [], definedNames: [], coverage: { complete: true, issues: [] } },
  requirements: { templateId: 'fixture-template', templateDigest: 'sha256:' + 'b'.repeat(64), version: 1, fields: [], questions: [] },
  subject: { objectId: 'fixture-subject', useLabel: '住宅', areaSqm: 89.6 },
  filters: { city: '北京市', district: '朝阳区', community: '合成小区', propertyType: '二手住宅', areaMin: 70, areaMax: 110 },
  priceBasis: 'listing', providers: ['lianjia', 'fang'],
  budget: { maxPages: 4, maxCandidates: 24, maxDurationMs: 120000 },
  stopRules: ['达到页数或候选上限即停', '来源不可用时保留已有数据并停止该渠道'],
  proposedDispositions: [],
}
function candidate(id: string, name: string, area: number, price: number, source: string, recommended: boolean, missing: string[]): TemplateMarketCandidate {
  return {
    caseId: id, providerId: source, sourceUrl: `https://example.invalid/${id}`,
    sourceRefs: [{ sourceId: source, digest: 'sha256:' + 'c'.repeat(64), location: `列表页 ${id}` }],
    listFacts: {
      community: { value: name, unit: '', status: 'verified', evidenceRefs: [] },
      areaSqm: { value: area, unit: '㎡', status: 'verified', evidenceRefs: [] },
      unitPrice: { value: price, unit: '元/㎡', status: 'verified', evidenceRefs: [] },
    },
    detailFacts: {}, duplicateRefs: [], status: recommended ? 'eligible' : 'nearby',
    similarities: recommended ? ['同区', '面积接近'] : ['同区'], differences: missing.length ? ['装修待核'] : [],
    missingFields: missing, recommendation: recommended ? '同小区近月挂牌，建议优先核实' : '面积段相近，待确认权利状况',
    selectionState: 'unselected',
  }
}
const candidates = [
  candidate('C01', '合成锦绣家园', 89.6, 58200, 'lianjia', true, []),
  candidate('C02', '合成望京西园', 102.4, 61500, 'fang', true, ['装修']),
  candidate('C03', '合成丽水嘉园', 76.8, 56800, '58', false, ['产权']),
  candidate('C04', '合成和平里北街', 84.1, 64300, 'lianjia', false, ['朝向']),
  candidate('C05', '合成康营家园', 95.2, 52400, 'fang', false, ['挂牌有效期']),
]

function questionnaire(phase: string): ValuationWorkflowQuestionnaire {
  const questions = [
    { questionId: 'select-cases:caseIds', nodeId: 'select-cases', field: 'caseIds', prompt: '选择需要读取详情和截图的案例',
      knownValue: '', source: '候选表版本 4', control: 'multiselect' as const, options: candidates.map((c) => ({ value: c.caseId, label: `${c.caseId} · ${c.listFacts.community?.value ?? c.caseId}` })),
      required: true, version: 4, applicable: true, reason: '仅所选案例会读取详情', answerProtocol: 2 as const, allowDefer: false, needsConfirmation: false,
      answer: phase === 'done' || phase === 'restricted' || phase === 'queued' ? { kind: 'choice' as const, values: ['C01', 'C02'], supplement: '' } : null },
    { questionId: 'select-cases:searchDecision', nodeId: 'select-cases', field: 'searchDecision', prompt: '候选数量有限，接下来如何处理？',
      knownValue: '', source: '当前候选表', control: 'radio' as const, options: [
        { value: 'stop', label: '停止补搜，使用当前选择继续' }, { value: 'continue', label: '在剩余预算内继续检索' }],
      required: true, version: 4, applicable: true, reason: '决定是否继续消耗检索预算', answerProtocol: 2 as const, allowDefer: true, needsConfirmation: false,
      answer: phase === 'done' || phase === 'restricted' || phase === 'queued' ? { kind: 'choice' as const, values: ['stop'], supplement: '' } : null },
  ]
  const submitted = phase === 'done' || phase === 'restricted' || phase === 'queued'
  return { version: 4, questions, drafts: [], notes: [], legacy: [], submissions: submitted ? [{
    submissionId: 'fixture-submission', nodeId: 'select-cases', version: 4,
    answers: { 'select-cases:caseIds': { kind: 'choice', values: ['C01', 'C02'], supplement: '' },
      'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' } },
    notes: [], questions, updatedAt: '2026-10-22T06:25:00.000Z' }] : [] }
}

function detailFor(nodeId: string): ValuationWorkflowNodeView {
  const meta = MARKET_NODE_META.find((node) => `valuation:realestate:template-market:${node.id}` === nodeId)
  return {
    nodeId, stage: null, label: meta?.label ?? '节点', revision: 4, current: true, sessionId: '',
    inputs: [{ field: 'template', label: '采用模板', value: plan.template.relativePath, source: '知识快照', sourceKind: 'material' }],
    outputs: [{ field: 'summary', label: '节点结果', value: meta?.description ?? '', source: 'Host 回执', sourceKind: 'program' }],
    knowledge: [{ sourceId: 'fixture-rule', path: '知识/市场法', section: '案例要求', quote: '比较案例应位于同一供需圈并核实挂牌性质。' }],
    readSources: [], gaps: [], dependents: [], rawInputs: {}, rawOutputs: {},
  }
}

function progressFor(phase: string): ValuationWorkflowProgressView {
  const node = phase === 'restricted' ? 'validate-delivery' : phase === 'done' ? 'check-inputs' : phase === 'executing' ? 'inspect-details' : 'select-cases'
  return {
    runId: 'fixture-market-run', revision: 4,
    status: phase === 'failed' ? 'failed' : phase === 'restricted' ? 'partial' : phase === 'done' || phase === 'awaiting' ? 'waiting-user' : 'running',
    outcome: phase === 'failed' ? 'failed' : phase === 'restricted' ? 'partial' : null,
    deliveryKind: phase === 'restricted' ? 'workpaper' : null, referenceDelivered: phase === 'restricted', formalComplete: false,
    waiting: phase === 'awaiting' || phase === 'done', stages: [], acceptedTaskCount: 8, plannedTaskCount: null, percentage: null,
    clarification: null, questionnaire: questionnaire(phase), updatedAt: '2026-10-22T06:30:00.000Z',
    graph: graph(phase), plan, result: null, revisions: [{ revision: 3, status: 'waiting-user', outcome: null, result: null, reason: '确认采集方案', source: '员工确认', supersededNodeIds: [], updatedAt: '2026-10-22T06:20:00.000Z' },
      { revision: 2, status: 'waiting-user', outcome: null, result: null, reason: '保存案例选择草稿', source: '员工输入', supersededNodeIds: [], updatedAt: '2026-10-22T06:10:00.000Z' }],
    market: { currentNode: node, plan, candidates,
      ...(phase === 'failed' ? { recovery: { retryAllowed: !params.has('stopUnknown'), reason: params.has('stopUnknown') ? '子会话停止状态尚未确认，请核对后恢复' : '本节点执行失败，已保留已有输入与回执' } } : {}), candidateVersion: 4, selectedCaseIds: phase === 'done' || phase === 'restricted' ? ['C01', 'C02'] : [],
      artifacts: phase === 'restricted' ? [{ relativePath: '方案/fixture/候选案例表.xlsx', digest: 'sha256:' + 'd'.repeat(64), bytes: 12800, kind: 'candidates' },
        { relativePath: '方案/fixture/估值底稿.xlsx', digest: 'sha256:' + 'e'.repeat(64), bytes: 28672, kind: 'workpaper' },
        { relativePath: '方案/fixture/计算轨迹.json', digest: 'sha256:' + 'f'.repeat(64), bytes: 4096, kind: 'trace' }] : [] },
  }
}

const params = new URLSearchParams(location.search)
const initialPhase = params.get('state') ?? 'awaiting'
const phases = ['awaiting', 'submitting', 'queued', 'executing', 'done', 'restricted', 'failed'] as const
type Phase = typeof phases[number]

function Fixture(): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>((phases.includes(initialPhase as Phase) ? initialPhase : 'awaiting') as Phase)
  const [active, setActive] = React.useState<string | null>(phase === 'restricted' ? 'validate-delivery' : phase === 'executing' ? 'inspect-details' : 'select-cases')
  const focusRef = React.useRef<{ focus?: () => void } | null>(null)
  const [draft, setDraft] = React.useState<{ status: 'unsaved' | 'saving' | 'saved' | 'error' | 'queued'; error: string } | undefined>({ status: phase === 'queued' ? 'queued' : 'saved', error: '' })
  const progress = React.useMemo(() => progressFor(phase), [phase])
  const view = React.useMemo(() => deriveMarketView(progress, null, { queued: phase === 'queued' }), [progress, phase])
  const activeNode = active === null ? null : view.nodes.find((node) => node.id === active) ?? null
  const detail = active === null ? null : detailFor(`valuation:realestate:template-market:${active}`)
  const save = (edit: ValuationQuestionEdit): void => {
    setDraft({ status: 'saving', error: '' })
    setTimeout(() => { setDraft({ status: 'saved', error: '' }) }, 220)
  }
  const submit = (): void => {
    setDraft({ status: 'saving', error: '' })
    setTimeout(() => { setPhase('done'); setDraft({ status: 'saved', error: '' }); setActive('check-inputs') }, 700)
  }
  const open = (node: typeof view.nodes[number], target?: { focus?: () => void } | null): void => { focusRef.current = target ?? null; setActive(node.id) }
  return <>
    <div data-fixture-bar="true" style={{ position: 'fixed', left: 16, bottom: 12, zIndex: 2000, display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', border: '1px dashed #b5cef3', borderRadius: 8, background: '#fff', fontSize: 12 }}>
      <strong>交互夹具 · 非生产数据</strong>
      <label>状态 <select value={phase} onChange={(event) => {
        const next = event.currentTarget.value as Phase
        setPhase(next)
        setDraft({ status: next === 'queued' ? 'queued' : 'saved', error: '' })
        setActive(next === 'restricted' ? 'validate-delivery' : next === 'executing' ? 'inspect-details' : 'select-cases')
      }}>
        {phases.map((item) => <option key={item} value={item}>{item}</option>)}
      </select></label>
      <label><input type="checkbox" onChange={(event) => { document.body.toggleAttribute('data-ds-dark-theme', event.currentTarget.checked) }} />深色</label>
    </div>
    <MarketWorkflowView view={view} detail={detail} progress={progress}
      activeNode={activeNode} busy={phase === 'submitting'} localDraft={draft === undefined ? undefined : { edit: { nodeId: active ?? '', expectedRevision: 4, expectedQuestionVersion: 4, answers: {}, supplement: '', noteEdits: {} }, status: draft.status, error: draft.error }}
      onOpen={open} onClose={() => { setActive(null) }} onRefresh={() => { /* fixture: state is local */ }}
      onSaveQuestionDraft={save} onSubmitQuestions={submit}
      onApprovePlan={() => { setPhase('executing'); setActive('inspect-details') }}
      onOpenArtifact={() => { /* fixture: no real file */ }} onRetry={(nodeId) => { document.body.dataset.retryNode = nodeId; setPhase('awaiting'); setActive('select-cases') }}
      returnFocusTo={focusRef} fixture />
  </>
}

const style = document.createElement('style')
style.textContent = WORKBENCH_STYLE_TEXT + '\nhtml,body,#root{height:100%;margin:0;background:#f5f5f7}'
document.head.appendChild(style)
createRoot(document.getElementById('root') as HTMLElement).render(<Fixture />)
