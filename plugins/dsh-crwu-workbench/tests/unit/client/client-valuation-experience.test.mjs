import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'
import { render, find, findAll, textOf } from '../../helpers/render.mjs'
registerTsxLoader()

const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
const { createValuationExperienceController } = await import('../../../src/client/modules/report-evaluation/valuation/controller.ts')
const model = await import('../../../src/client/modules/report-evaluation/valuation/model.ts')
const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')

function fakeEvaluation(initial = {}) {
  let state = initialValuationState(initial)
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
    removeSelection: (path) => { calls.push(['removeSelection', path]); set({ selection: state.selection.filter((item) => item !== path) }) },
    excludeFile: (path) => { calls.push(['excludeFile', path]); set({ excluded: [...state.excluded, path] }) },
    reincludeFile: (path) => { calls.push(['reincludeFile', path]); set({ excluded: state.excluded.filter((item) => item !== path) }) },
    undoRemoval: () => {},
    rescan: () => { calls.push('rescan') },
    setAssetType: (value) => { calls.push(['setAssetType', value]); set({ assetType: value }) },
    setMethod: (value) => { calls.push(['setMethod', value]); set({ method: value }) },
    setPurpose: (value) => { set({ purpose: value }) },
    setValueType: (value) => { set({ valueType: value }) },
    setBaseDate: (value) => { calls.push(['setBaseDate', value]); set({ baseDate: value }) },
    setPrompt: (value) => { set({ supplementalPrompt: value }) },
    pickTemplate: () => { calls.push('pickTemplate') },
    clearTemplate: () => { set({ templatePath: '' }) },
    preparePreview: () => { calls.push('preparePreview'); set({ phase: 'confirmation' }) },
    backToEdit: () => { set({ phase: 'draft' }) },
    confirm: () => { calls.push('confirm'); set({ phase: 'handed-off', projectId: 'project-1', parentSessionId: 'parent-1' }) },
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

function fakeWorkflow(patch = {}) {
  let state = {
    current: null,
    detail: null,
    loading: false,
    busy: false,
    error: '',
    questionDrafts: {},
    ...patch,
  }
  const listeners = new Set()
  const calls = []
  const emit = () => { for (const listener of [...listeners]) listener(state) }
  return {
    calls,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setState: (next) => { state = { ...state, ...next }; emit() },
    activate: async () => {},
    deactivate: () => {},
    refresh: async () => { calls.push('refresh') },
    approvePlan: async (input) => { calls.push(['approvePlan', input]); return true },
    submitQuestions: async (input) => { calls.push(['submitQuestions', input]); return true },
    openArtifact: async (kind) => { calls.push(['openArtifact', kind]) },
  }
}

test('new valuation starts empty and never invents a project', () => {
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow: fakeWorkflow() })
  const state = experience.getState()
  assert.equal(state.view, 'intake')
  assert.equal(state.intakeStage, 'object')
  assert.equal(state.mode, 'empty')
  assert.equal(state.draft.category, '')
  assert.equal(state.draft.projectName, '')
  assert.equal(state.materials.length, 0)
  assert.equal(state.plan, null)
  assert.equal(state.candidates.length, 0)
  experience.dispose()
})

test('demo fixture is explicit, keeps the area conflict, and gates the review step', () => {
  let experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow: fakeWorkflow() })
  experience.loadDemo()
  let state = experience.getState()
  assert.equal(state.mode, 'demo')
  assert.equal(state.draft.projectName.includes('滨江花园'), true)
  assert.equal(state.materials.length, 2)
  const rows = model.materialRows(state)
  assert.equal(model.materialStats(rows).included, 7)
  assert.equal(model.activeConflict(state)?.choice, null)
  assert.equal(model.conflictPending(state), true)
  experience.setIntakeStage('review')
  experience.chooseArea('material')
  state = experience.getState()
  assert.equal(state.draft.area, '89.5')
  assert.equal(state.draft.areaSource, 'material')
  assert.equal(model.conflictPending(state), false)
  experience.dispose()
})

test('saving information generates a version and invalidates an existing plan', () => {
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow: fakeWorkflow() })
  experience.loadDemo()
  experience.setField('area', '88.8')
  experience.chooseArea('user')
  experience.setIntakeStage('review')
  experience.confirmIntake()
  experience.generatePlan()
  let state = experience.getState()
  assert.equal(state.view, 'workspace')
  assert.equal(state.plan?.status, 'pending')
  const before = state.infoVersion
  experience.setInfoTab('fields')
  experience.saveInfo({ area: '88.8', floor: '18 / 26' })
  state = experience.getState()
  assert.equal(state.infoVersion, before + 1)
  assert.equal(model.planStatusOf(state), 'stale')
  assert.equal(state.adopted.length, 0)
  experience.dispose()
})

test('demo plan confirm gates case retrieval and the checklist completes', () => {
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow: fakeWorkflow() })
  experience.loadDemo()
  experience.chooseArea('user')
  experience.confirmIntake()
  experience.generatePlan()
  experience.submitPlan()
  experience.toggleAck()
  experience.confirmPlan()
  assert.equal(experience.getState().plan?.status, 'confirmed')
  assert.equal(experience.getState().candidates.length, 0)
  experience.retrieveCases()
  const cases = experience.getState().candidates
  assert.equal(cases.length > 0, true)
  experience.toggleAdopt(cases[0].id)
  assert.equal(experience.getState().adopted.length, 1)
  for (const key of model.CHECK_KEYS) experience.toggleCheck(cases[0].id, key)
  experience.completeCaseCheck()
  assert.equal(experience.getState().checks.caseCheck, 'done')
  const csv = experience.exportCsv()
  assert.match(csv, /采用状态/)
  assert.match(csv, /已核对/)
  experience.dispose()
})

test('host projection maps questionnaire fields, the plan receipt and candidates', () => {
  const progress = {
    revision: 3,
    status: 'waiting-user',
    updatedAt: '2026-10-23T05:00:00.000Z',
    questionnaire: {
      version: 2,
      questions: [
        {
          questionId: 'check:area', nodeId: 'check', field: 'area', prompt: '建筑面积',
          knownValue: '89.5', source: '不动产权证 p.2', control: 'number', required: true,
          applicable: true, answer: null,
        },
        {
          questionId: 'check:rights', nodeId: 'check', field: 'rights', prompt: '权利性质',
          knownValue: '出让 / 商品房', source: '不动产权证 p.1', control: 'text', required: false,
          applicable: true, answer: { kind: 'value', value: '出让', supplement: '' },
        },
      ],
    },
    market: {
      currentNode: 'select-cases',
      plan: {
        planId: 'plan-1',
        digest: 'sha256:plan-1',
        template: { relativePath: '方案/模板/市场法.xlsx', digest: 'sha256:t', verified: true },
        requirements: { templateId: 't', templateDigest: 'sha256:t', version: 1, fields: [], questions: [] },
        subject: { objectId: 'o1', useLabel: '住宅', areaSqm: 89.5 },
        filters: { city: '杭州市', district: '滨江区', community: '滨江花园', propertyType: 'residential', areaMin: 80, areaMax: 105 },
        priceBasis: 'listing',
        providers: ['lianjia', 'fang'],
        budget: { maxPages: 10, maxCandidates: 6, maxDurationMs: null },
        stopRules: ['达到目标数即停止'],
        proposedDispositions: [],
      },
      candidates: [
        {
          caseId: 'case-1', providerId: 'lianjia', sourceUrl: 'https://example.com/1',
          listFacts: { areaSqm: { value: 88, unit: '㎡' }, unitPrice: { value: 46000, unit: '元/㎡' }, community: { value: '滨江花园' } },
          detailFacts: {}, duplicateRefs: [], status: 'eligible', similarities: ['同小区'], differences: [], missingFields: [], recommendation: '可比', selectionState: 'selected',
        },
      ],
      selectedCaseIds: ['case-1'],
      nodes: [{ nodeId: 'confirm-plan', state: 'passed', summary: '', meta: '' }],
    },
    plan: { accepted: true, revision: 3, digest: 'sha256:plan-1', ready: true, gaps: [], limitations: [] },
    graph: { graphId: 'g', nodes: [{ nodeId: 'confirm-plan', templateMarketNodeId: 'confirm-plan', state: 'passed', label: '确认', gaps: [] }], edges: [] },
  }
  const workflow = fakeWorkflow({
    current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 's1', phase: 'waiting-user', progress },
    progress,
  })
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow })
  experience.setView('workspace')
  const state = experience.getState()
  assert.equal(state.mode, 'host')
  assert.equal(state.fields.find((field) => field.key === 'area')?.tag, '材料摘取')
  assert.equal(state.fields.find((field) => field.key === 'rights')?.tag, '用户更正')
  assert.equal(state.plan?.status, 'confirmed')
  assert.equal(state.plan?.conditions.channels.length, 2)
  assert.equal(state.candidates.length, 1)
  assert.equal(state.adopted.length, 1)
  assert.equal(state.workspaceStep, 'cases')
  experience.dispose()
})

test('host information edits are submitted as answers, not local overrides', async () => {
  const progress = {
    revision: 4,
    status: 'waiting-user',
    questionnaire: {
      version: 3,
      questions: [{
        questionId: 'check:area', nodeId: 'check', field: 'area', prompt: '建筑面积',
        knownValue: '89.5', source: '不动产权证 p.2', control: 'number', required: true,
        applicable: true, answer: null,
      }],
    },
  }
  const workflow = fakeWorkflow({
    current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 's1', phase: 'waiting-user', progress },
    progress,
  })
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow })
  experience.setView('workspace')
  experience.saveInfo({ area: '90.2' })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const call = workflow.calls.find((item) => Array.isArray(item) && item[0] === 'submitQuestions')
  assert.ok(call, 'the edit must reach the Host questionnaire')
  assert.equal(call[1].nodeId, 'check')
  assert.equal(call[1].answers['check:area'].kind, 'value')
  assert.equal(call[1].answers['check:area'].value, '90.2')
  experience.dispose()
})

test('template-market plans are confirmed through the approval question, not the legacy receipt', async () => {
  const progress = {
    revision: 7,
    status: 'waiting-user',
    updatedAt: '2026-10-23T07:00:00.000Z',
    questionnaire: {
      version: 4,
      questions: [{
        questionId: 'confirm-plan:approval', nodeId: 'confirm-plan', field: 'approval',
        prompt: '请确认采集方案', knownValue: '', source: '', control: 'radio',
        options: [{ value: 'accept', label: '按此方案采集' }, { value: 'amend', label: '修改方案' }],
        required: true, applicable: true, answer: null,
      }],
    },
    market: {
      currentNode: 'confirm-plan',
      plan: {
        planId: 'plan-9', digest: 'sha256:plan-9',
        template: { relativePath: '模板/市场法.xlsx', digest: 'sha256:t', verified: false },
        requirements: { templateId: 't', templateDigest: 'sha256:t', version: 1, fields: [], questions: [] },
        subject: { objectId: 'o1', useLabel: '住宅', areaSqm: 89.5 },
        filters: { city: '', district: '', community: '', propertyType: '', areaMin: null, areaMax: null },
        priceBasis: 'listing', providers: ['lianjia'],
        budget: { maxPages: null, maxCandidates: null, maxDurationMs: null }, stopRules: [], proposedDispositions: [],
      },
      candidates: [], selectedCaseIds: [], nodes: [],
    },
    plan: null,
    revisions: [],
    graph: { graphId: 'g', nodes: [], edges: [] },
  }
  const workflow = fakeWorkflow({
    current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 's1', phase: 'waiting-user', progress },
    progress,
  })
  const experience = createValuationExperienceController({ evaluation: fakeEvaluation(), workflow })
  experience.setView('workspace')
  experience.toggleAck()
  experience.confirmPlan()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const submission = workflow.calls.find((item) => Array.isArray(item) && item[0] === 'submitQuestions')
  assert.ok(submission, 'market confirmation must submit the approval question')
  assert.equal(submission[1].nodeId, 'confirm-plan')
  assert.deepEqual(submission[1].answers['confirm-plan:approval'], { kind: 'choice', values: ['accept'], supplement: '' })
  assert.equal(workflow.calls.some((item) => Array.isArray(item) && item[0] === 'approvePlan'), false,
    'the legacy plan receipt is null here, so approvePlan must not be used')
  experience.dispose()
})

test('overview → intake → review → workspace renders the prototype flow', () => {
  const evaluation = fakeEvaluation()
  const workflow = fakeWorkflow()
  const experience = createValuationExperienceController({ evaluation, workflow })
  const props = {
    workflow,
    evaluation,
    experience,
    step: 'overview',
    onStep: (step) => { props.step = step },
    onOpenParentSession: () => {},
  }
  let mounted = render(AssetAssessmentWorkflow, props)
  assert.ok(find(mounted.tree, (node) => node.props?.['data-asset-assessment-workflow'] === 'true'))
  find(mounted.tree, (node) => node.props?.['data-business-step'] === 'valuation').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.equal(props.step, 'valuation')
  assert.ok(find(mounted.tree, (node) => node.props?.['data-intake-stage'] === 'object'))

  find(mounted.tree, (node) => node.props?.['data-object-category'] === 'realestate').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  find(mounted.tree, (node) => node.props?.['data-intake-next-info'] === 'true').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.ok(find(mounted.tree, (node) => node.props?.['data-intake-doc-panel'] === 'true'))
  assert.equal(find(mounted.tree, (node) => node.props?.['data-intake-next-review'] === 'true').props.disabled, true)

  find(mounted.tree, (node) => node.props?.['data-load-demo'] === 'true').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.equal(experience.getState().mode, 'demo')
  assert.ok(find(mounted.tree, (node) => node.props?.['data-usage-conflict']) === null)
  find(mounted.tree, (node) => node.props?.['data-intake-next-review'] === 'true').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.ok(find(mounted.tree, (node) => node.props?.['data-area-conflict'] === 'true'))
  assert.equal(find(mounted.tree, (node) => node.props?.['data-intake-confirm'] === 'true').props.disabled, true)
  const material = findAll(mounted.tree, (node) => node.props?.type === 'radio' && node.props?.value === 'material')[0]
  material.props.onChange()
  mounted = render(AssetAssessmentWorkflow, props)
  find(mounted.tree, (node) => node.props?.['data-intake-confirm'] === 'true').props.onClick()
  mounted = render(AssetAssessmentWorkflow, props)
  assert.equal(experience.getState().view, 'workspace')
  assert.ok(find(mounted.tree, (node) => node.props?.['data-workspace-step'] === 'docs'))
  assert.ok(find(mounted.tree, (node) => node.props?.['data-workspace-step'] === 'reasoning'))
  experience.dispose()
})

test('host intake handoff sends the supported subset and enters the workspace', async () => {
  const evaluation = fakeEvaluation()
  const workflow = fakeWorkflow()
  const experience = createValuationExperienceController({ evaluation, workflow })
  experience.selectObject('realestate')
  experience.setField('area', '90')
  experience.setField('baseDate', '2026-09-30')
  experience.setField('note', '优先同小区')
  experience.goInfo()
  experience.goReview()
  experience.confirmIntake()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.deepEqual(evaluation.calls.filter((call) => Array.isArray(call)).map((call) => call[0]),
    ['setAssetType', 'setMethod', 'setBaseDate'])
  assert.equal(evaluation.calls.includes('preparePreview'), true)
  assert.equal(evaluation.calls.includes('confirm'), true)
  assert.equal(experience.getState().view, 'workspace')
  experience.dispose()
})
