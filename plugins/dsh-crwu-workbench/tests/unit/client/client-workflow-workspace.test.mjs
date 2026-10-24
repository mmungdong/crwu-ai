import assert from 'node:assert/strict'
import test from 'node:test'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'
import { createDeferred, createNodeDetail, createProgressView, createClarificationView } from '../../helpers/valuation-workflow-fixture.mjs'

const attr = (name) => (node) => node.props?.[name] !== undefined
const event = (value) => ({ currentTarget: { value } })
const propsOf = (patch = {}) => ({ progress: createProgressView(), detail: null, onRefresh() {}, onSelectNode() {}, onSubmitRevision() {}, ...patch })

test('node details are a dialog with decisions first and structured input/output last', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const opened = [], revised = []
  const props = propsOf({ detail: createNodeDetail({ sessionId: 'actual-node', gaps: ['请补充匹配小区的挂牌资料'],
    outputs: [{ field: 'samples', label: '样本', value: '[{"community":"测试小区","note":"第一行\\n第二行"}]', source: '模型输出' }] }),
    onOpenSession: (id) => opened.push(id), onSubmitRevision: (input) => revised.push(input) })
  let tree = render(ValuationWorkflowPane, props).tree
  const dialog = find(tree, (node) => node.props?.role === 'dialog')
  assert.ok(dialog, 'selected node must open a drawer dialog')
  assert.match(textOf(dialog), /未核与缺口/)
  assert.doesNotMatch(textOf(dialog), /修订会影响|完整记录|校正并重新执行/)
  assert.deepEqual(findAll(dialog, attr('data-workflow-detail')).map((node) => node.props['data-workflow-detail']), ['gaps', 'input', 'output'])
  assert.doesNotMatch(textOf(dialog), /第一行\n第二行/)
  find(tree, attr('data-workflow-open-node-session')).props.onClick()
  assert.deepEqual(opened, ['actual-node'])
  find(tree, attr('data-workflow-retry-answer')).props.onChange(event('已补充同小区真实挂牌资料，请重新检索'))
  tree = rerender(ValuationWorkflowPane, props)
  find(tree, attr('data-workflow-retry-submit')).props.onClick()
  assert.equal(revised[0].nodeId, 'rights')
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  const inspectorProps = { detail: props.detail, stale: false, busy: false, canRetry: false, retryAnswer: '', onRetryAnswerChange() {}, onRetrySubmit() {} }
  tree = render(NodeInspector, inspectorProps).tree
  find(tree, (node) => node.props?.['data-workflow-detail'] === 'output').props.onToggle({ currentTarget: { open: true } })
  tree = rerender(NodeInspector, inspectorProps)
  assert.match(textOf(tree), /第一行\n第二行/)
  assert.equal(revised[0].expectedRevision, 1)
  assert.deepEqual(revised[0].changes, [{ field: 'promptSupplement', value: '已补充同小区真实挂牌资料，请重新检索' }])
})

test('structured questions render choices and require every mandatory answer', async () => {
  const { ClarificationPanel } = await import('../../../src/client/modules/report-evaluation/ui/workflow/ClarificationPanel.tsx')
  const clarification = createClarificationView({ questions: [
    { questionId: 'q1', field: 'provider', prompt: '选择渠道', knownValue: '', source: '方案', control: 'radio', options: [{ value: 'fang', label: '房天下' }, { value: 'wuba', label: '58同城' }] },
    { questionId: 'q2', field: 'community', prompt: '小区名称', knownValue: '', source: '资料' },
  ] })
  const answers = [], props = { clarification, busy: false, answers: { provider: 'fang' }, onAnswerChange() {}, onSubmit: (...input) => answers.push(input) }
  let tree = render(ClarificationPanel, props).tree
  assert.equal(findAll(tree, (node) => node.type === 'input' && node.props?.type === 'radio').length, 2)
  assert.equal(find(tree, attr('data-workflow-answer-submit')).props.disabled, true)
  tree = render(ClarificationPanel, { ...props, answers: { provider: 'fang', community: '测试小区' } }).tree
  find(tree, attr('data-workflow-answer-submit')).props.onClick()
  assert.deepEqual(answers, [['clar-1', { provider: 'fang', community: '测试小区' }]])
})

test('global inputs can be changed and rerun without opening a node', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const revised = [], props = propsOf({ progress: createProgressView({ globalInputs: [
    { nodeId: 'valuation:realestate:elements', field: 'purpose', label: '评估目的', value: '内部参考', source: '已确认输入', editable: true },
  ] }), onSubmitRevision: (input) => revised.push(input) })
  let tree = render(ValuationWorkflowPane, props).tree
  assert.ok(find(tree, attr('data-workflow-global-state')))
  find(tree, attr('data-workflow-global-edit')).props.onClick()
  tree = rerender(ValuationWorkflowPane, props)
  find(tree, (node) => node.props?.['data-workflow-global-input'] === 'purpose').props.onChange(event('资产处置参考'))
  tree = rerender(ValuationWorkflowPane, props)
  find(tree, attr('data-workflow-global-submit')).props.onClick()
  assert.equal(revised[0].nodeId, 'valuation:realestate:elements')
  assert.deepEqual(revised[0].changes, [{ field: 'purpose', value: '资产处置参考' }])
})

test('the redesigned workface has no legacy clear action and returns to the overview without clearing the draft', async () => {
  const { AssetAssessmentWorkflow } = await import('../../../src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')
  const { initialValuationState } = await import('../../../src/client/modules/report-evaluation/model/valuation-state.ts')
  const calls = []
  const state = { current: { ok: true, empty: false, projectId: 'p1', parentSessionId: 'parent', phase: 'preparing', snapshot: null, progress: null }, detail: null, busy: false, loading: false, error: '' }
  const props = { workflow: { getState: () => state, subscribe: () => () => {}, clear: async () => { calls.push('clear'); return true } },
    evaluation: { getState: initialValuationState, subscribe: () => () => {}, resetDraft: () => calls.push('reset') },
    step: 'valuation', onStep: (step) => calls.push(step), onOpenParentSession() {} }
  const tree = render(AssetAssessmentWorkflow, props).tree
  assert.equal(find(tree, attr('data-asset-workflow-clear')), null, 'the legacy destructive clear is not part of the new page')
  assert.equal(find(tree, attr('data-asset-workflow-clear-confirm')), null)
  find(tree, (node) => node.props?.['data-back-overview'] === 'true').props.onClick()
  assert.deepEqual(calls, ['overview'])
})

test('selecting a node immediately opens its loading drawer', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const props = propsOf()
  let tree = render(ValuationWorkflowPane, props).tree
  find(tree, attr('data-workflow-node')).props.onClick()
  tree = rerender(ValuationWorkflowPane, props)
  assert.ok(find(tree, attr('data-workflow-node-loading')))
  assert.ok(find(tree, (node) => node.props?.role === 'dialog'))
})

test('a replacement run cannot keep the previous selected node in its drawer', async () => {
  const { ValuationWorkflowPane } = await import('../../../src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx')
  const props = propsOf({ detail: createNodeDetail() })
  let tree = render(ValuationWorkflowPane, props).tree
  find(tree, (node) => node.props?.['data-workflow-node'] === 'rights').props.onClick()
  const next = { ...props, progress: createProgressView({ runId: 'replacement-run', revision: 2 }),
    detail: createNodeDetail({ nodeId: 'plan', stage: 'plan', revision: 2, label: '新方案' }) }
  tree = rerender(ValuationWorkflowPane, next)
  for (const effect of [...globalThis.__crwuTestInstance.effects]) effect.callback()
  tree = rerender(ValuationWorkflowPane, next)
  const drawer = find(tree, attr('data-workflow-node-drawer'))
  assert.ok(drawer === null || drawer.props['data-workflow-node-drawer'] === 'plan')
  assert.equal(find(tree, (node) => node.props?.['data-workflow-node-detail'] === 'rights'), null)
})

test('the common workspace accepts a land graph without valuation business panels', async () => {
  const { WorkflowWorkspace } = await import('../../../src/client/ui/workflow/WorkflowWorkspace.tsx')
  const tree = render(WorkflowWorkspace, { graphId: 'valuation.land', graphVersion: '1',
    graph: { type: 'p', props: { children: '土地工作流节点' } }, selection: null, detail: null, onClose() {} }).tree
  assert.equal(find(tree, attr('data-workflow-workspace')).props['data-workflow-workspace'], 'valuation.land')
  assert.match(textOf(tree), /土地工作流节点/)
  assert.equal(find(tree, attr('data-workflow-plan')), null)
})
