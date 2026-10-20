/**
 * Client rendering for the planned valuation workflow pane (tests-only).
 *
 * The pane renders Host-supplied facts and submits structured user decisions:
 * progress/waiting/partial are distinct; no percentage is invented; a correction
 * keeps correction provenance internally; a stale revision blocks retries.
 *
 * Expanded with the existing minimal render helper; no browser runtime is added.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'
import { render, rerender, find, findAll, textOf } from '../../helpers/render.mjs'
import {
  createClarificationView,
  createNodeDetail,
  createProgressView,
  createStageViews,
  loadWorkflowPane,
} from '../../helpers/valuation-workflow-fixture.mjs'

// Register before any `.tsx` dynamic import; idempotent with render.mjs.
registerTsxLoader()

/** Native DOM inputs receive an event; the pane must read `currentTarget.value`. */
const inputEvent = (value) => ({ currentTarget: { value } })

async function expandedDetail(detail) {
  const { NodeInspector } = await import('../../../src/client/modules/report-evaluation/ui/workflow/NodeInspector.tsx')
  const props = { detail, stale: false, busy: false, canRetry: false, retryAnswer: '', onRetryAnswerChange() {}, onRetrySubmit() {} }
  let tree = render(NodeInspector, props).tree
  for (const section of ['input', 'output']) {
    find(tree, (node) => node.props?.['data-workflow-detail'] === section).props.onToggle({ currentTarget: { open: true } })
    tree = rerender(NodeInspector, props)
  }
  return tree
}

function paneProps(overrides = {}, handlers = {}) {
  return {
    progress: createProgressView(overrides.progress ?? {}),
    detail: overrides.detail ?? null,
    busy: overrides.busy ?? false,
    onSelectNode: () => {},
    onRefresh: () => {},
    onSubmitRevision: () => {},
    onAnswerClarification: () => {},
    onCancel: () => {},
    ...handlers,
  }
}

const attr = (name) => (node) => node.props?.[name] !== undefined

test('Host progress, waiting and a delivered partial result render as distinct facts', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()

  const running = render(ValuationWorkflowPane, paneProps({
    progress: {
      status: 'running',
      outcome: null,
      deliveryKind: null,
      referenceDelivered: false,
      formalComplete: false,
      waiting: false,
      stages: createStageViews({ calculation: { state: 'running' } }),
    },
  })).tree
  assert.equal(find(running, attr('data-workflow-status')).props['data-workflow-status'], 'running')
  assert.equal(find(running, attr('data-workflow-waiting')).props['data-workflow-waiting'], 'false')
  assert.equal(find(running, attr('data-workflow-clarification')), null)

  const waiting = render(ValuationWorkflowPane, paneProps({
    progress: {
      status: 'waiting-user',
      outcome: null,
      deliveryKind: null,
      referenceDelivered: false,
      formalComplete: false,
      waiting: true,
      clarification: createClarificationView(),
      stages: createStageViews({ evidence: { state: 'waiting' } }),
    },
  })).tree
  assert.equal(find(waiting, attr('data-workflow-waiting')).props['data-workflow-waiting'], 'true')
  const clarification = find(waiting, attr('data-workflow-clarification'))
  assert.ok(clarification, 'a waiting run must show its clarification card')
  assert.equal(findAll(clarification, attr('data-workflow-question')).length, 2)
  assert.match(textOf(clarification), /请指定本次评估目的/)
  assert.match(textOf(clarification), /请指定本次评估基准日/)

  const partial = render(ValuationWorkflowPane, paneProps()).tree
  assert.equal(find(partial, attr('data-workflow-outcome')).props['data-workflow-outcome'], 'partial')
  const delivery = find(partial, attr('data-workflow-delivery'))
  assert.ok(delivery, 'a delivered reference must have its own delivery fact')
  assert.equal(delivery.props['data-workflow-delivery'], 'listing-reference')
  assert.equal(delivery.props['data-workflow-reference-delivered'], 'true')
  assert.equal(delivery.props['data-workflow-formal-complete'], 'false')
})

test('an unknown task total is not turned into a percentage and partial is never formal success', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()

  const unknown = render(ValuationWorkflowPane, paneProps({
    progress: { plannedTaskCount: null, percentage: null },
  })).tree
  assert.equal(findAll(unknown, attr('data-workflow-percentage')).length, 0, 'no percentage may be inferred')
  assert.doesNotMatch(textOf(unknown), /\d+\s*%/, 'the pane must not print a percentage it was not given')

  const known = render(ValuationWorkflowPane, paneProps({
    progress: { plannedTaskCount: 10, percentage: 40 },
  })).tree
  assert.equal(find(known, attr('data-workflow-percentage')).props['data-workflow-percentage'], '40')

  const partial = render(ValuationWorkflowPane, paneProps()).tree
  assert.equal(findAll(partial, (node) => node.props?.['data-workflow-formal-complete'] === 'true').length, 0)
  assert.equal(find(partial, attr('data-workflow-formal-complete')).props['data-workflow-formal-complete'], 'false')
})

test('selecting a node exposes read-only input and output in a drawer with the original 公寓 use', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const selected = []
  const tree = render(ValuationWorkflowPane, paneProps(
    { detail: createNodeDetail() },
    { onSelectNode: (nodeId) => { selected.push(nodeId) } },
  )).tree

  for (const section of ['input', 'output']) {
    assert.ok(find(tree, (node) => node.props?.['data-workflow-detail'] === section), `missing section ${section}`)
  }
  const expanded = await expandedDetail(createNodeDetail())
  const inputText = textOf(find(expanded, (node) => node.props?.['data-workflow-detail'] === 'input'))
  assert.match(inputText, /公寓/, 'the original use must be shown verbatim')
  assert.doesNotMatch(inputText, /住宅/, 'the pane must not rename the original use')
  assert.ok(find(tree, (node) => node.props?.role === 'dialog'))
  assert.equal(find(tree, attr('data-workflow-revision-form')), null)

  const button = find(tree, (node) => node.props?.['data-workflow-node'] === 'rights')
  assert.ok(button, 'the node list must expose the stage node')
  button.props.onClick()
  assert.deepEqual(selected, ['rights'])
})

test('a stale node receipt cannot submit a supplemental answer', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const submissions = []
  const props = paneProps({ progress: { revision: 2 },
    detail: createNodeDetail({ revision: 1, current: false, gaps: ['合成未核项'] }) },
    { onSubmitRevision: (input) => submissions.push(input) })
  let tree = render(ValuationWorkflowPane, props).tree
  assert.match(textOf(tree), /刷新|版本|更新/)
  const answer = find(tree, attr('data-workflow-retry-answer'))
  if (answer) {
    answer.props.onChange(inputEvent('补充说明'))
    tree = rerender(ValuationWorkflowPane, props)
  }
  const submit = find(tree, attr('data-workflow-retry-submit'))
  assert.ok(submit)
  assert.equal(submit.props.disabled, true)
  submit.props.onClick()
  assert.equal(submissions.length, 0)
})

test('busy state prevents node retry dispatch', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const submissions = []
  const props = paneProps({ detail: createNodeDetail({ gaps: ['合成未核项'] }) },
    { onSubmitRevision: (input) => submissions.push(input) })
  let tree = render(ValuationWorkflowPane, props).tree
  find(tree, attr('data-workflow-retry-answer')).props.onChange(inputEvent('合成补充'))
  tree = rerender(ValuationWorkflowPane, { ...props, busy: true })
  const submit = find(tree, attr('data-workflow-retry-submit'))
  assert.equal(submit.props.disabled, true)
  submit.props.onClick()
  assert.equal(submissions.length, 0)
})

test('the displayed graph uses the Host topology and submits actual node identities', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const selected = []
  const graph = { graphId: 'valuation.realestate', version: '1', nodes: [
    { nodeId: 'valuation:intent-router', label: '识别估值意图', state: 'passed' },
    { nodeId: 'valuation:realestate:rights', label: '核对估值对象', state: 'running', stage: 'rights' },
  ], edges: [{ source: 'valuation:intent-router', target: 'valuation:realestate:rights', conditional: true }] }
  const tree = render(ValuationWorkflowPane, paneProps({ progress: {
    graph, status: 'running', outcome: null, deliveryKind: null, referenceDelivered: false,
  } },
    { onSelectNode: (id) => selected.push(id) })).tree
  const nodes = findAll(tree, attr('data-workflow-node'))
  assert.deepEqual(nodes.map((node) => node.props['data-workflow-node']), graph.nodes.map((node) => node.nodeId))
  assert.ok(find(tree, (node) => node.props?.['data-workflow-edge-from'] === graph.edges[0].source
    && node.props?.['data-workflow-edge-to'] === graph.edges[0].target))
  nodes[0].props.onClick()
  assert.deepEqual(selected, ['valuation:intent-router'])
  assert.match(textOf(tree), /识别估值意图/)
})

test('plan confirmation shows the exact calculation table and real numeric route and binds the accepted digest', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const accepted = []
  const opened = []
  const plan = { revision: 1, digest: 'sha256:synthetic-plan', ready: true, accepted: false, method: 'market',
    valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean', gaps: [],
    sources: [{ providerId: 'lianjia', state: 'verified', community: '合成测试小区', detailUrl: 'https://example.invalid/1',
      fields: { unitPrice: 32000, areaSqm: 100 }, transactionType: 'listing', evidence: '合成详情证据' }],
    template: { fileName: '合成知识模板.xlsx', relativePath: '模板/合成知识模板.xlsx', digest: 'sha256:synthetic-template',
      verified: true, mapping: [{ field: 'unitPrice', sheet: '计算', range: 'B2' }], formulaChecks: [{ name: '合成公式试算', ok: true }] },
    basis: [{ sourceId: 'synthetic-policy', quote: '合成规则原文' }], limitations: ['合成挂牌参考限制'] }
  const props = paneProps({ progress: {
    status: 'waiting-user', outcome: null, deliveryKind: null, referenceDelivered: false, waiting: true, plan,
  } },
    { onApprovePlan: (input) => accepted.push(input), onOpenArtifact: (kind) => opened.push(kind) })
  const tree = render(ValuationWorkflowPane, props).tree
  assert.match(textOf(tree), /合成知识模板\.xlsx/)
  assert.match(textOf(tree), /合成测试小区/)
  assert.match(textOf(tree), /链家/)
  assert.match(textOf(tree), /市场法/)
  assert.match(textOf(tree), /元\/㎡/)
  assert.ok(find(tree, (node) => node.type === 'a' && node.props?.href === 'https://example.invalid/1'))
  assert.match(textOf(tree), /B2/)
  const tableButton = find(tree, attr('data-workflow-open-template'))
  assert.ok(tableButton, 'the exact proposed calculation table can be opened before approval')
  tableButton.props.onClick()
  assert.deepEqual(opened, ['template'])
  const button = find(tree, attr('data-workflow-plan-confirm'))
  assert.ok(button, 'the verified proposal needs an explicit confirmation action')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(accepted, [{ expectedRevision: 1, planDigest: 'sha256:synthetic-plan' }])
  const blocked = render(ValuationWorkflowPane, { ...props, busy: true }).tree
  const disabled = find(blocked, attr('data-workflow-plan-confirm'))
  assert.equal(disabled.props.disabled, true)
  disabled.props.onClick()
  assert.equal(accepted.length, 1)
})

test('clarification has editable answers and sends the current clarification identity', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const answers = []
  const clarification = createClarificationView({ questions: [
    { questionId: 'q-purpose', field: 'purpose', prompt: '请补充评估目的', knownValue: '', source: '用户输入' },
  ] })
  const props = paneProps({ progress: {
    status: 'waiting-user', outcome: null, deliveryKind: null, referenceDelivered: false, waiting: true, clarification,
  } },
    { onAnswerClarification: (input) => answers.push(input) })
  let tree = render(ValuationWorkflowPane, props).tree
  const input = find(tree, (node) => node.props?.['data-workflow-answer'] === 'purpose')
  assert.ok(input, 'a question must provide an actual answer field')
  input.props.onChange(inputEvent('内部试算'))
  tree = rerender(ValuationWorkflowPane, props)
  const button = find(tree, attr('data-workflow-answer-submit'))
  assert.ok(button)
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(answers.length, 1)
  assert.equal(answers[0].clarificationId, clarification.clarificationId)
  assert.deepEqual(answers[0].answers, { purpose: '内部试算' })
})

test('the node drawer exposes its actual DSH conversation, gaps and complete input and output', async () => {
  const { ValuationWorkflowPane } = await loadWorkflowPane()
  const opened = []
  const detail = createNodeDetail({ sessionId: 'session-real-node-2', readSources: [{ sourceId: 'read-1',
    path: '合成已读规则.adoc', digest: 'sha256:read', kind: 'prose' }], gaps: ['合成未核项'],
    rawInputs: { retainedField: '完整输入合成值' }, rawOutputs: { retainedOutput: '完整输出合成值' } })
  const tree = render(ValuationWorkflowPane, { ...paneProps({ detail }), onOpenSession: (id) => opened.push(id) }).tree
  assert.ok(find(tree, (node) => node.props?.role === 'dialog'))
  assert.match(textOf(tree), /合成未核项/)
  assert.doesNotMatch(textOf(tree), /完整输入合成值|完整输出合成值/)
  const expanded = await expandedDetail(detail)
  assert.match(textOf(expanded), /完整输入合成值/)
  assert.match(textOf(expanded), /完整输出合成值/)
  const button = find(tree, attr('data-workflow-open-node-session'))
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(opened, ['session-real-node-2'])
})


test('a confirmed upstream input is never labeled as a knowledge-library citation', async () => {
  const detail = createNodeDetail({ inputs: [{ field: 'purpose', label: '评估目的', value: '内部参考',
    sourceKind: 'confirmed', source: '已确认输入', editable: false }] })
  const tree = await expandedDetail(detail)
  const badges = findAll(tree, (node) => node.props?.className === 'crwu-valuation-workflow-field-kind').map(textOf)
  assert.ok(badges.includes('已确认输入'))
  assert.equal(badges.includes('知识库'), false)
})
