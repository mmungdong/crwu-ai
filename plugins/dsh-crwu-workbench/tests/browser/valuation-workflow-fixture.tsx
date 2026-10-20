import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../../src/client/shell/WorkbenchPanel.tsx'
import { createModuleStore } from '../../src/client/shell/module-store.ts'
import { environmentStateOf } from '../../src/client/modules/environment/api.ts'
import { createReportEvaluationController } from '../../src/client/modules/report-evaluation/controller.ts'
import { createValuationWorkflowController } from '../../src/client/modules/report-evaluation/workflow-controller.ts'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'
import { WORKBENCH_PROTOCOL } from '../../src/shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../src/shared/access/types.ts'
import type { ValuationWorkflowQuestionnaire } from '../../src/shared/contracts/valuation-questionnaire.ts'

// Synthetic fixtures exercise the real shell and ports without an account or filesystem.
const stages = ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery'] as const
const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? ''
const contractFailure = scenario === 'questionnaire-failure'
const scenarioNodeStates: Record<string, string> = { initializing: 'pending', running: 'running', failed: 'failed', blocked: 'blocked' }
const labels = ['基本要素', '权属与面积', '估值方案', '案例取证', '计算测算', '复核', '成果交付']
const graph = { graphId: 'fixture.workflow', version: '1', nodes: stages.map((stage, i) => ({
  nodeId: `valuation:realestate:${stage}`, stage, label: labels[i],
  state: scenario === 'preparing' ? 'pending' : contractFailure && i === 1 ? 'failed' : i < 2 ? 'passed' : i === 2 ? (scenarioNodeStates[scenario] ?? 'waiting') : 'pending', gaps: [],
})), edges: stages.slice(1).map((stage, i) => ({ source: `valuation:realestate:${stages[i]}`, target: `valuation:realestate:${stage}`, conditional: false })) }
const plan = { revision: 1, digest: 'sha256:synthetic-plan', ready: true, accepted: false, gaps: [], method: 'market',
  valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
  sources: [{ providerId: 'fang', state: 'verified', community: '合成测试小区', detailUrl: 'https://example.invalid/synthetic/1',
    fields: { unitPrice: 32000, areaSqm: 100 }, transactionType: 'listing', evidence: '合成测试证据' }],
  template: { verified: true, fileName: '挂牌参考计算表.xlsx', relativePath: '方案/fixture/模板/挂牌参考计算表.xlsx', digest: 'sha256:synthetic-template',
    mapping: [{ field: 'unitPrice', sheet: '估值结果', range: 'B5' }], formulaChecks: [{ name: '合成模板检查', ok: true }] },
  basis: [{ sourceId: 'synthetic-rule', quote: '合成规则：按可核对挂牌单价提供参考。' }], limitations: ['这是隔离 UI 测试数据，不是估值结果。'] }
let present = !params.has('empty')
const durable = scenario.startsWith('questionnaire')
const questionnaireKey = `crwu-synthetic-questionnaire-${scenario}`
const questionNodeId = 'valuation:realestate:rights'
const initialQuestionnaire: ValuationWorkflowQuestionnaire = { version: 2,
  questions: [
    { questionId: 'A', field: 'community', prompt: '确认小区名称', control: 'text', answer: { value: '已保存小区 A' } },
    { questionId: 'B', field: 'rented', prompt: '当前是否出租', control: 'boolean', answer: null },
    { questionId: 'C', field: 'description', prompt: '房屋状况', control: 'textarea', answer: null },
    { questionId: 'N', field: 'amount', prompt: '租金金额', control: 'number', answer: null },
    { questionId: 'D', field: 'leaseDate', prompt: '租约日期', control: 'date', answer: null },
    { questionId: 'S', field: 'purpose', prompt: '用途选择', control: 'select', options: [{ value: 'living', label: '居住' }], answer: null },
    { questionId: 'R', field: 'source', prompt: '资料来源', control: 'radio', options: [{ value: 'material', label: '产权材料' }], answer: null },
    { questionId: 'M', field: 'facilities', prompt: '配套设施', control: 'multiselect', options: [{ value: 'lift', label: '电梯' }], answer: null },
    { questionId: 'I', field: 'irrelevant', prompt: '不适用旧问题', control: 'text', answer: { value: '保留旧答案' }, applicable: false, inapplicabilityReason: '本轮不涉及' },
  ].map((question) => ({ ...question, nodeId: questionNodeId, source: '合成资料', knownValue: '', required: true,
    version: 1, applicable: question.applicable !== false, needsConfirmation: question.answer === null })) as ValuationWorkflowQuestionnaire['questions'],
  drafts: [], notes: [{ noteId: 'note-1', nodeId: questionNodeId, text: '已保存补充说明', history: ['更早的原文'] }],
  submissions: [], legacy: [{ nodeId: questionNodeId, text: '旧版补充原文不猜类型', revision: 1 }] }
let storedQuestionnaire = contractFailure ? { ...initialQuestionnaire, questions: [] } : initialQuestionnaire
if (durable) {
  const saved = localStorage.getItem(questionnaireKey)
  if (saved !== null) storedQuestionnaire = JSON.parse(saved) as ValuationWorkflowQuestionnaire
}
const progress = { runId: 'fixture-run', revision: 1, status: contractFailure ? 'failed' : ['running', 'initializing', 'questionnaire-running'].includes(scenario) ? 'running' : ['failed', 'blocked'].includes(scenario) ? scenario : 'waiting-user', outcome: null, deliveryKind: null,
  questionnaire: durable ? storedQuestionnaire : undefined,
  referenceDelivered: false, formalComplete: false, waiting: !['running', 'initializing', 'failed', 'blocked'].includes(scenario), plannedTaskCount: null, percentage: null, acceptedTaskCount: 2,
  stages: stages.map((stage, i) => ({ stage, state: graph.nodes[i].state, objectCount: 1, passedCount: i < 2 ? 1 : 0, waitingCount: i === 2 ? 1 : 0, gaps: [] })),
  graph, plan, result: null, revisions: [], clarification: scenario === 'questions' ? {
    clarificationId: 'fixture-questions', revision: 1, questions: [
      { questionId: 'q-mode', field: 'mode', prompt: '请选择评估口径', knownValue: '', source: '用户输入', control: 'radio',
        options: [{ value: 'listing-reference', label: '挂牌参考' }, { value: 'formal', label: '正式评估' }] },
      { questionId: 'q-community', field: 'community', prompt: '请确认小区名称', knownValue: '', source: '资料' },
    ],
  } : null, updatedAt: '2026-10-18T00:00:00Z',
  globalInputs: [
    { nodeId: 'valuation:realestate:elements', field: 'purpose', label: '评估目的', value: '内部参考', source: '已确认输入', editable: true },
    { nodeId: 'valuation:realestate:elements', field: 'baseDate', label: '评估基准日', value: '2026-10-18', source: '已确认输入', editable: true },
    { nodeId: 'valuation:realestate:rights', field: 'useLabel', label: '原始用途', value: '公寓', source: '资料', editable: true },
    { nodeId: 'valuation:realestate:rights', field: 'areaSqm', label: '建筑面积（㎡）', value: '100', source: '资料', editable: true },
  ],
}
const current = () => present ? { ok: true, empty: false, projectId: 'fixture-project', runId: 'fixture-run', parentSessionId: 'fixture-parent',
  phase: scenario === 'preparing' ? 'preparing' : progress.status,
  snapshot: scenario === 'preparing' ? null : { ...progress, decision: { mode: 'listing-reference', accepted: false }, object: { objectId: 'fixture-subject', useLabel: '公寓', areaSqm: 100 } }, graph,
  progress: scenario === 'preparing' ? null : progress }
  : { ok: true, empty: true }
const calls = { current: 0, node: [] as string[], action: [] as unknown[], intake: [] as unknown[], start: [] as unknown[], open: 0 }
const workflow = createValuationWorkflowController({
  current: async () => { calls.current++; return current() },
  node: async (input) => {
    calls.node.push(input.nodeId)
    await new Promise((resolve) => setTimeout(resolve, 350))
    return { ok: true, detail: { nodeId: input.nodeId, stage: input.nodeId.split(':').at(-1), label: graph.nodes.find((node) => node.nodeId === input.nodeId)?.label ?? '节点', revision: 1, current: true,
    sessionId: 'fixture-node-session', inputs: [{ field: 'useLabel', label: '原始用途', value: '公寓', sourceKind: 'material', source: '合成材料原文', editable: true },
      { field: 'areaSqm', label: '建筑面积', value: '100', sourceKind: 'material', source: '合成材料原文', editable: true },
      { field: 'promptSupplement', label: '节点补充说明', value: '', sourceKind: 'user', source: '用户输入', editable: true }],
    outputs: [{ field: 'useLabel', label: '已采纳用途', value: '公寓', sourceKind: 'model', source: '来源绑定的模型输出', editable: false },
      { field: 'samples', label: '样本信息', value: '[{"community":"合成测试小区","note":"第一行\\n第二行"}]', sourceKind: 'model', source: '来源绑定的模型输出', editable: false }],
    knowledge: [{ sourceId: 'synthetic-rule', path: '合成知识/权属', section: '用途', quote: '保留材料记载用途' }], readSources: [], gaps: ['合成未核项：请补充同小区挂牌资料'],
    ...(contractFailure ? { failure: { kind: 'output-contract', reason: '方法字段 method 类型不符合节点契约',
      requirements: ['method 必须为字符串', 'questions 须包含完整题型与问题定义'], actions: ['重新执行该节点以按契约重新生成，已保存答案无需重填。'] } } : {}),
    dependents: graph.nodes.slice(2).map(({ nodeId, label }) => ({ nodeId, label })), rawInputs: { useLabel: '公寓', areaSqm: 100 }, rawOutputs: { useLabel: '公寓', samples: [{ community: '合成测试小区', note: '第一行\n第二行' }] } } }
  },
  action: async (input) => {
    calls.action.push(input)
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (durable && (input.action === 'questions-draft' || input.action === 'questions-submit')) {
      if (scenario === 'questionnaire-conflict' && calls.action.length === 1) storedQuestionnaire.version += 1
      if (input.payload.expectedQuestionVersion !== storedQuestionnaire.version) {
        return { ok: false, errorKind: 'questionnaire-conflict', error: '另一页面已更新问卷，版本冲突' }
      }
      const payload = input.payload as unknown as import('../../src/shared/contracts/valuation-questionnaire.ts').ValuationQuestionSubmit
      storedQuestionnaire.version += 1
      if (input.action === 'questions-draft') {
        storedQuestionnaire.drafts = [{ nodeId: payload.nodeId, answers: payload.answers, supplement: payload.supplement, noteEdits: payload.noteEdits, updatedAt: new Date().toISOString() }]
      } else {
        for (const question of storedQuestionnaire.questions) {
          if (question.applicable && payload.answers[question.questionId]) { question.answer = payload.answers[question.questionId]; question.needsConfirmation = false }
        }
        for (const note of storedQuestionnaire.notes) {
          if (payload.noteEdits[note.noteId] !== undefined) {
            note.history.push(note.text); note.text = payload.noteEdits[note.noteId]
          }
        }
        if (payload.supplement) storedQuestionnaire.notes.push({ noteId: `note-${storedQuestionnaire.version}`, nodeId: payload.nodeId, text: payload.supplement, history: [] })
        storedQuestionnaire.submissions.push({ submissionId: payload.submissionId, nodeId: payload.nodeId, version: storedQuestionnaire.version,
          answers: payload.answers, notes: structuredClone(storedQuestionnaire.notes), updatedAt: new Date().toISOString() })
        storedQuestionnaire.drafts = []
      }
      progress.questionnaire = structuredClone(storedQuestionnaire)
      localStorage.setItem(questionnaireKey, JSON.stringify(storedQuestionnaire))
      return { ok: true, questionnaire: structuredClone(storedQuestionnaire) }
    }
    return { ok: true }
  },
  preview: async () => ({ ok: true, supersededNodeIds: stages.slice(1) }),
  cancel: async () => ({ ok: true }), reconcile: async () => ({ ok: true }),
  export: async () => ({ ok: true, serialized: '{"format":"synthetic-ui-fixture"}' }),
  load: async () => ({ ok: false, error: '合成测试拒绝加载' }), clear: async () => { present = false; localStorage.removeItem(questionnaireKey); return { ok: true } },
  openArtifact: async () => ({ ok: true }),
}, { autoPoll: false })

const path = '/fixture/materials/合成产权证.pdf'
const file = { fileId: 'fixture-material', fileName: '合成产权证.pdf', absolutePath: path, archiveRelativePath: '资料/合成产权证.pdf', kind: 'pdf',
  sizeBytes: 1024, sha256: 'a'.repeat(64), createdAt: null, modifiedAt: null, readable: true, duplicateOf: null }
const evaluation = createReportEvaluationController({
  ready: () => ({ ok: true, error: '' }), fileInput: async () => [{ path, name: file.fileName }],
  scan: async () => ({ ok: true, files: [{ path, name: file.fileName, kind: 'pdf', sizeBytes: 1024, parentPath: path }], items: [], fileCount: 1, readableCount: 1 }),
  intake: async (input) => { calls.intake.push(input); return { ok: true, error: '', previewId: 'fixture-preview', projectId: 'fixture-project',
    inputDigest: 'sha256:synthetic-input', assetType: input.assetType, methodRequest: input.method, baseDate: null, purpose: null, valueType: null,
    templateFileId: null, supplementalPrompt: '', files: [file], fileCount: 1, overLimit: false, skipped: [], capabilityGaps: [], expiresAt: '2099-01-01T00:00:00Z' } },
  preflight: async () => ({ ok: true, rows: [], sites: [], loginJobs: [] }),
  start: async (input) => { calls.start.push(input); present = true; return { ok: true, error: '', projectId: 'fixture-project', parentSessionId: 'fixture-parent', dispatchAccepted: true, reused: false } },
  openSession: async () => { calls.open++; return { ok: true, error: '' } },
}, { initial: { assetType: 'real-estate', method: 'market', selection: [path], files: [{ path, name: file.fileName, kind: 'pdf', status: 'scanned', sizeBytes: 1024, fileCount: 1, reason: '', dirHint: '' }],
  fileRows: [{ path, name: file.fileName, kind: 'pdf', sizeBytes: 1024, parentPath: path, state: 'included' }], fileCount: 1, readableCount: 1, scanState: 'ready' },
  onHandoff: async () => { await workflow.refresh() } })

const env = { ok: true, allOk: true, blocked: [], services: [], me: { name: '', org: '', userId: '' },
  workspace: { id: 'fixture-ws', path: '/fixture/workspace', title: '合成工作区', chosen: true, missing: false, source: 'manual' },
  state: { status: 'ready', proceed: true, capabilities: { global: true, auditCore: true, delivery: true, externalData: true }, userSetup: {}, systemHealth: {}, issues: [], blocked: [], allOk: true, passed: 1, total: 1, checkError: '' } }
const boot = { ok: true, protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION, buildKind: 'dev', version: 'fixture', parentSessionId: '' }
window.fetch = (async () => new Response(JSON.stringify({ ok: false, error: '隔离测试不访问真实 Host' }), { status: 200 })) as typeof window.fetch
Object.assign(window, { fixtureWorkflowCalls: calls, fixtureWorkflow: workflow, fixtureEvaluation: evaluation })
const modules = createModuleStore()
modules.navigate('eval', { state: environmentStateOf(env) })
void workflow.refresh()
createRoot((document.getElementById('workflow-fixture-root') ?? document.getElementById('root')) as HTMLElement).render(<>
  <style>{WORKBENCH_STYLE_TEXT}</style>
  <style>{'html,body,#root{height:100%;margin:0}[data-crwu-scope="workbench"]{--dsw-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}'}</style>
  <WorkbenchPanel services={{}} modules={modules} evaluation={evaluation} workflow={workflow}
    envStatus={{ get: () => ({ env, busy: false, error: '', checkedAt: '' }), subscribe: () => () => {}, refresh: async () => env }}
    build={{ get: () => boot, subscribe: () => () => {}, refresh: async () => boot }} />
</>)
