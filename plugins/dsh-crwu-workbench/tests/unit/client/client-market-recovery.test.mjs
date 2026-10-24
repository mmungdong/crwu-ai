import assert from 'node:assert/strict'
import test from 'node:test'
import { render, find } from '../../helpers/render.mjs'
import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'
registerTsxLoader()

async function fixture(retryAllowed = true) {
  const { createTemplateMarketState } = await import('../../../src/host/domains/report-evaluation/workflow/template-market-flow.ts')
  const { deriveMarketView, MARKET_NODE_IDS } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const market = createTemplateMarketState({ runId: 'failed-run', initialInput: null })
  const progress = { runId: 'failed-run', revision: 2, status: 'failed', outcome: 'failed', waiting: false,
    graph: { graphId: 'v2', version: '2', nodes: MARKET_NODE_IDS.map(id => ({ nodeId: `graph:${id}`, templateMarketNodeId: id,
      label: id, state: id === 'templates' ? 'failed' : 'pending', gaps: id === 'templates' ? ['模板读取失败'] : [] })), edges: [] },
    market: { ...market, recovery: { retryAllowed, reason: retryAllowed ? '模板读取失败' : '子会话停止状态尚未确认' } },
    questionnaire: market.questionnaire, revisions: [], updatedAt: '2026-10-23T01:00:00Z' }
  return { progress, view: deriveMarketView(progress) }
}

test('failed-node retry targets the opened graph node even before its detail has loaded', async () => {
  const { MarketWorkflowView } = await import('../../../src/client/modules/report-evaluation/market/MarketWorkflow.tsx')
  const { progress, view } = await fixture()
  const calls = []
  const tree = render(MarketWorkflowView, { view, progress, detail: null, activeNode: view.nodes[0], busy: false,
    onOpen() {}, onClose() {}, onRefresh() {}, onSaveQuestionDraft() {}, onSubmitQuestions() {}, onRetry: id => calls.push(id) }).tree
  const retry = find(tree, n => n.props?.['data-market-retry'] === true)
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  assert.deepEqual(calls, ['graph:templates'])
})

test('unknown child stop visibly blocks replacement retry', async () => {
  const { MarketWorkflowView } = await import('../../../src/client/modules/report-evaluation/market/MarketWorkflow.tsx')
  const { progress, view } = await fixture(false)
  const tree = render(MarketWorkflowView, { view, progress, detail: null, activeNode: view.nodes[0], busy: false,
    onOpen() {}, onClose() {}, onRefresh() {}, onSaveQuestionDraft() {}, onSubmitQuestions() {}, onRetry() {} }).tree
  assert.equal(find(tree, n => n.props?.['data-market-retry'] === true).props.disabled, true)
})
