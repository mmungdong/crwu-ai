import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'
import { render, rerender, find, findAll } from '../../helpers/render.mjs'
import { WORKBENCH_PROTOCOL } from '../../../src/shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../../src/shared/access/types.ts'
registerTsxLoader()
const { createModuleStore } = await import('../../../src/client/shell/module-store.ts')
const { environmentStateOf } = await import('../../../src/client/modules/environment/api.ts')

const env = { ok: true, allOk: true, blocked: [], services: [], me: { name: '', org: '', userId: '' },
  workspace: { chosen: true, path: '/synthetic/workspace', title: '合成工作区', id: 'w1', missing: false, source: 'manual' },
  state: { status: 'ready', proceed: true, capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    userSetup: {}, systemHealth: {}, issues: [], blocked: [], allOk: true, passed: 1, total: 1, checkError: '' } }

test('the actual evaluation shell mounts a business workflow instead of the old valuation tab', async () => {
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
  assert.ok(find(opened, (node) => node.props?.['data-workflow-step'] === 'valuation'))
})

test('production Client assembly owns and passes the actual workflow controller to its mounted entry', async () => {
  const root = new URL('../../../src/client/', import.meta.url)
  const apply = await readFile(new URL('apply.ts', root), 'utf8')
  const panel = await readFile(new URL('shell/WorkbenchPanel.tsx', root), 'utf8')
  assert.match(apply, /createValuationWorkflowController\(/)
  assert.match(apply, /workflow[,:]/)
  assert.match(panel, /<AssetAssessmentWorkflow\b/)
  assert.doesNotMatch(panel, /^\s*return <ReportEvaluationPane\b/m, 'a standalone new component does not replace the old actual entry')
})

test('an unavailable workflow Host cannot expose the legacy start path', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const state = { current: null, detail: null, loading: false, busy: false, error: '当前流程服务尚未就绪' }
  const workflow = { getState: () => state, subscribe: () => () => {} }
  const evaluation = { getState: initialValuationState, subscribe: () => () => {} }
  const mounted = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession() {} })
  assert.ok(find(mounted.tree, (node) => node.props?.['data-asset-workflow-error'] === 'true'))
  assert.equal(Boolean(find(mounted.tree, (node) => node.props?.['data-asset-workflow-intake'] === 'true')), false)
})

test('material preparation shows the known parent and cannot expose a second intake', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const state = { current: { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: 'run-1',
    phase: 'preparing', snapshot: null, progress: null, error: '' }, detail: null, loading: false, busy: false, error: '' }
  const workflow = { getState: () => state, subscribe: () => () => {} }
  const opened = []
  const evaluation = { getState: initialValuationState, subscribe: () => () => {} }
  const mounted = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession: (id) => opened.push(id) })
  assert.ok(find(mounted.tree, (node) => node.props?.['data-asset-workflow-preparing'] === 'true'))
  assert.equal(find(mounted.tree, (node) => node.props?.['data-asset-workflow-cancel'] === 'true'), null, 'pre-business preparation has no cancellable Graph run yet')
  assert.equal(Boolean(find(mounted.tree, (node) => node.props?.['data-asset-workflow-intake'] === 'true')), false)
  find(mounted.tree, (node) => node.props?.['data-asset-workflow-open-session'] === 'true').props.onClick()
  assert.deepEqual(opened, ['parent-1'])
})

test('a known empty current task does not let an old recent-session shortcut suppress a fresh intake', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const evaluationState = { ...initialValuationState(), recentSessionId: 'old-completed-parent' }
  const workflow = { getState: () => ({ current: { ok: true, empty: true }, detail: null, loading: false, busy: false, error: '' }),
    subscribe: () => () => {} }
  const evaluation = { getState: () => evaluationState, subscribe: () => () => {} }
  const tree = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession() {} }).tree
  assert.ok(find(tree, (node) => node.props?.['data-asset-workflow-intake'] === 'true'))
})


test('delivered workbook buttons send a closed artifact kind instead of an archived filename or path', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const { createProgressView } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const opened = []
  const state = { current: { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: 'run-1',
    phase: 'partial', progress: createProgressView({ runId: 'run-1' }), snapshot: { delivery: {
      artifacts: ['方案/plan-1/推理结果/修订-1/估值底稿.xlsx', '估值报告.html', '计算轨迹.json', '估值报告数据.json'],
    } } }, detail: null, loading: false, busy: false, error: '' }
  const workflow = { getState: () => state, subscribe: () => () => {}, openArtifact: async (kind) => { opened.push(kind); return true } }
  const evaluation = { getState: initialValuationState, subscribe: () => () => {} }
  const tree = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession() {} }).tree
  const button = find(tree, (node) => node.props?.['data-asset-workflow-artifact'] === 'workbook')
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(opened, ['workbook'])
  const kinds = new Set(findAll(tree, (node) => node.props?.['data-asset-workflow-artifact']).map((node) => node.props['data-asset-workflow-artifact']))
  assert.deepEqual([...kinds].sort(), ['data', 'report', 'trace', 'workbook'])
})


test('failed preparation directs employees to the session without claiming background progress', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const state = { current: { ok: true, empty: false, projectId: 'project-1', parentSessionId: 'parent-1', runId: '',
    phase: 'failed', snapshot: null, progress: null, errorKind: 'environment', error: '合成运行时探测失败' }, detail: null, loading: false, busy: false, error: '' }
  const workflow = { getState: () => state, subscribe: () => () => {} }
  const evaluation = { getState: initialValuationState, subscribe: () => () => {} }
  const mounted = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession() {} })
  const textOf = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node !== null && typeof node === 'object' ? textOf(node.props?.children) : ''
  const body = textOf(mounted.tree)
  assert.equal(body.includes('不影响后台准备'), false)
  assert.doesNotMatch(body, /重新对接/)
  assert.match(body, /打开估值会话/)
  assert.ok(find(mounted.tree, (node) => node.props?.['data-asset-workflow-open-session'] === 'true'))
})

test('valuation toolbar removes reconnect and JSON transfer controls in every task state', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const { createProgressView } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { textOf } = await import('../../helpers/render.mjs')
  for (const current of [null, { ok: true, empty: true },
    { ok: true, empty: false, phase: 'preparing', parentSessionId: 'parent' },
    { ok: true, empty: false, phase: 'running', parentSessionId: 'parent', progress: createProgressView() }]) {
    const state = { current, detail: null, loading: current === null, busy: false, error: '' }
    const tree = render(AssetAssessmentWorkflow, {
      workflow: { getState: () => state, subscribe: () => () => {} },
      evaluation: { getState: initialValuationState, subscribe: () => () => {} },
      step: 'valuation', onStep() {}, onOpenParentSession() {},
    }).tree
    const toolbar = find(tree, (node) => node.props?.['data-asset-workflow-toolbar'])
    assert.doesNotMatch(textOf(toolbar), /重新对接|导出\s*JSON|导入\s*JSON/)
    assert.match(textOf(toolbar), /刷新/)
    assert.ok(find(tree, (node) => node.props?.['data-asset-workflow-clear']))
    assert.equal(find(tree, (node) => node.type === 'input' && node.props?.accept?.includes('json')), null)
  }
})

test('the graph workspace shows the Host block reason before a node is selected', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const { createProgressView } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const error = '当前只支持单一估值对象：请确认本次对象'
  const state = { current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 'parent',
    phase: 'blocked', error, progress: createProgressView({ status: 'blocked' }), snapshot: {} },
    detail: null, loading: false, busy: false, error: '' }
  const workflow = { getState: () => state, subscribe: () => () => {} }
  const evaluation = { getState: initialValuationState, subscribe: () => () => {} }
  const tree = render(AssetAssessmentWorkflow, { workflow, evaluation, step: 'valuation', onStep() {}, onOpenParentSession() {} }).tree
  const textOf = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node !== null && typeof node === 'object' ? textOf(node.props?.children) : ''
  const alert = find(tree, (node) => node.props?.role === 'alert' && textOf(node).includes(error))
  assert.ok(alert, 'a status badge alone does not explain why the business stopped')
})
