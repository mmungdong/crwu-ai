import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'
import { WORKBENCH_PROTOCOL } from '../../../src/shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../../src/shared/access/types.ts'
registerTsxLoader()
const { createModuleStore } = await import('../../../src/client/shell/module-store.ts')
const { environmentStateOf } = await import('../../../src/client/modules/environment/api.ts')
const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
const { createValuationExperienceController } = await import('../../../src/client/modules/report-evaluation/valuation/controller.ts')
const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')

const env = { ok: true, allOk: true, blocked: [], services: [], me: { name: '', org: '', userId: '' },
  workspace: { chosen: true, path: '/synthetic/workspace', title: '合成工作区', id: 'w1', missing: false, source: 'manual' },
  state: { status: 'ready', proceed: true, capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    userSetup: {}, systemHealth: {}, issues: [], blocked: [], allOk: true, passed: 1, total: 1, checkError: '' } }

function fakeEvaluation() {
  let state = initialValuationState()
  const listeners = new Set()
  const calls = []
  const emit = () => { for (const listener of [...listeners]) listener(state) }
  const set = (patch) => { state = { ...state, ...patch }; emit() }
  return {
    calls,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    pickFiles: () => { calls.push('pickFiles') },
    pickFolder: () => { calls.push('pickFolder') },
    removeSelection: () => {},
    excludeFile: () => {},
    reincludeFile: () => {},
    undoRemoval: () => {},
    rescan: () => {},
    setAssetType: () => {},
    setMethod: () => {},
    setPurpose: () => {},
    setValueType: () => {},
    setBaseDate: () => {},
    setPrompt: () => {},
    pickTemplate: () => {},
    clearTemplate: () => {},
    preparePreview: () => { set({ phase: 'confirmation' }) },
    backToEdit: () => {},
    confirm: () => { set({ phase: 'handed-off', projectId: 'p1', parentSessionId: 's1' }) },
    openCreatedSession: () => {},
    invalidate: () => {},
    resetDraft: () => {},
    markStale: () => {},
    checkAuth: () => {},
    recheckAuth: () => {},
    login: () => {},
    cancelLogin: () => {},
    openVerification: () => {},
  }
}

function fakeWorkflow(initial = {}) {
  let state = { current: null, detail: null, loading: false, busy: false, error: '', questionDrafts: {}, ...initial }
  const listeners = new Set()
  const calls = []
  const emit = () => { for (const listener of [...listeners]) listener(state) }
  return {
    calls,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setState: (patch) => { state = { ...state, ...patch }; emit() },
    activate: async () => {},
    deactivate: () => {},
    refresh: async () => { calls.push('refresh') },
    approvePlan: async (input) => { calls.push(['approvePlan', input]); return true },
    submitQuestions: async (input) => { calls.push(['submitQuestions', input]); return true },
    openArtifact: async (kind) => { calls.push(['openArtifact', kind]) },
  }
}

function mountProps(step = 'overview') {
  const evaluation = fakeEvaluation()
  const workflow = fakeWorkflow()
  const experience = createValuationExperienceController({ evaluation, workflow })
  const props = {
    workflow,
    evaluation,
    experience,
    step,
    onStep: (next) => { props.step = next },
    onOpenParentSession: () => {},
  }
  return { props, experience, evaluation, workflow }
}

test('the actual evaluation shell mounts the asset overview and enters the intake', async () => {
  const { WorkbenchPanel } = await import('../../../src/client/shell/WorkbenchPanel.tsx')
  const modules = createModuleStore()
  modules.navigateNode('valuation', { state: environmentStateOf(env) })
  const state = { current: null, detail: null, loading: false, busy: false, error: '' }
  const workflow = { getState: () => state, subscribe: () => () => {}, activate: async () => {}, deactivate() {}, refresh: async () => {} }
  const props = { modules, workflow, services: {}, envStatus: { get: () => ({ env, busy: false, error: '' }), subscribe: () => () => {}, refresh: async () => env },
    build: { get: () => ({ ok: true, protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
      buildKind: 'dev', version: 'test', parentSessionId: '' }), subscribe: () => () => {}, refresh: async () => ({}) } }
  const mounted = render(WorkbenchPanel, props)
  assert.ok(find(mounted.tree, (node) => node.props?.['data-asset-assessment-workflow'] === 'true'), 'the real shell must mount the new entry')
  assert.equal(findAll(mounted.tree, (node) => node.props?.role === 'tab' && node.props?.id?.includes('valuation')).length, 0)
  const step = find(mounted.tree, (node) => node.props?.['data-business-step'] === 'valuation')
  assert.ok(step)
  step.props.onClick()
  const opened = rerender(WorkbenchPanel, props)
  assert.ok(find(opened, (node) => node.props?.['data-intake-stage'] === 'object'))
  assert.ok(find(opened, (node) => node.props?.['data-workflow-step'] === 'valuation'))
})

test('production Client assembly owns and passes the valuation experience controller', async () => {
  const root = new URL('../../../src/client/', import.meta.url)
  const apply = await readFile(new URL('apply.ts', root), 'utf8')
  const panel = await readFile(new URL('shell/WorkbenchPanel.tsx', root), 'utf8')
  assert.match(apply, /createValuationExperienceController\(/)
  assert.match(apply, /experience[,:]/)
  assert.match(panel, /<AssetAssessmentWorkflow\b/)
  assert.match(panel, /experience=\{experienceController\}/)
  assert.doesNotMatch(panel, /^\s*return <ReportEvaluationPane\b/m, 'a standalone new component does not replace the actual entry')
})

test('a Host project opens directly on the six-step workface instead of the intake', () => {
  const progress = {
    revision: 2,
    status: 'waiting-user',
    updatedAt: '2026-10-23T06:00:00.000Z',
    questionnaire: { version: 1, questions: [] },
  }
  const workflow = fakeWorkflow({
    current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 's1', phase: 'waiting-user', progress },
    progress,
  })
  const evaluation = fakeEvaluation()
  const experience = createValuationExperienceController({ evaluation, workflow })
  const props = { workflow, evaluation, experience, step: 'overview', onStep: (next) => { props.step = next }, onOpenParentSession: () => {} }
  let mounted = render(AssetAssessmentWorkflow, props)
  find(mounted.tree, (node) => node.props?.['data-business-step'] === 'valuation').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.equal(experience.getState().view, 'workspace')
  assert.ok(find(mounted.tree, (node) => node.props?.['data-workspace-step'] === 'docs'))
  assert.ok(find(mounted.tree, (node) => node.props?.['data-workspace-step'] === 'caseCheck'))
  assert.match(textOf(mounted.tree), /资料与模板/)
  experience.dispose()
})

test('a Host error stays visible instead of being hidden behind a fake success state', () => {
  const workflow = fakeWorkflow({ error: '估值服务暂时不可用', current: null })
  const evaluation = fakeEvaluation()
  const experience = createValuationExperienceController({ evaluation, workflow })
  const props = { workflow, evaluation, experience, step: 'overview', onStep: (next) => { props.step = next }, onOpenParentSession: () => {} }
  const mounted = render(AssetAssessmentWorkflow, props)
  const alert = find(mounted.tree, (node) => node.props?.['data-overview-host-error'] === 'true')
  assert.ok(alert)
  assert.match(textOf(alert), /估值服务暂时不可用/)
  experience.dispose()
})

test('returning to the overview keeps the intake draft and the entered workspace', () => {
  const { props, experience } = mountProps('valuation')
  experience.loadDemo()
  experience.setView('workspace')
  const mounted = render(AssetAssessmentWorkflow, props)
  find(mounted.tree, (node) => node.props?.['data-back-overview'] === 'true').props.onClick()
  assert.equal(props.step, 'overview')
  assert.equal(experience.getState().view, 'workspace', 'going back does not clear the draft')
  assert.equal(experience.getState().mode, 'demo')
  experience.dispose()
})

test('a template-market run projects into the new six-step workface instead of the old graph', () => {
  const ids = ['templates', 'materials', 'collection-plan', 'confirm-plan', 'search-listings',
    'candidate-workbook', 'select-cases', 'inspect-details', 'check-inputs', 'fill-template', 'validate-delivery']
  const graph = { graphId: 'market.v2', version: '2', edges: [], nodes: ids.map((id) => ({
    nodeId: `valuation:realestate:template-market:${id}`, templateMarketNodeId: id, label: id,
    state: id === 'select-cases' ? 'waiting' : 'pending', gaps: [],
  })) }
  const progress = { runId: 'run-market', revision: 1, status: 'waiting-user', outcome: null, deliveryKind: null,
    referenceDelivered: false, formalComplete: false, waiting: true, stages: [], acceptedTaskCount: 6, plannedTaskCount: null,
    percentage: null, clarification: null, updatedAt: '2026-10-22T00:00:00.000Z', graph, plan: null, result: null, revisions: [],
    market: { currentNode: 'select-cases', plan: null, candidates: [], candidateVersion: 4, selectedCaseIds: [], artifacts: [] } }
  const state = { current: { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: 'run-market',
    phase: 'waiting-user', progress, snapshot: { templateMarket: { flowVersion: 'template-market-v2' } } }, detail: null, loading: false, busy: false, error: '' }
  const workflow = fakeWorkflow(state)
  const evaluation = fakeEvaluation()
  const experience = createValuationExperienceController({ evaluation, workflow })
  const tree = render(AssetAssessmentWorkflow, {
    workflow,
    evaluation,
    experience,
    step: 'valuation', onStep() {}, onOpenParentSession() {},
  }).tree
  assert.equal(find(tree, (node) => node.props?.['data-market-workflow'] === 'true'), null,
    'the old eleven-node market workface is not the default new page')
  assert.ok(find(tree, (node) => node.props?.['data-workspace-step'] === 'cases'))
  assert.match(textOf(tree), /案例获取/)
  experience.dispose()
})
