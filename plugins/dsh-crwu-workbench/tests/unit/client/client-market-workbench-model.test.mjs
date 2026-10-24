import assert from 'node:assert/strict'
import test from 'node:test'

const NODE_IDS = ['templates', 'materials', 'collection-plan', 'confirm-plan', 'search-listings',
  'candidate-workbook', 'select-cases', 'inspect-details', 'check-inputs', 'fill-template', 'validate-delivery']

function graph(states = {}) {
  return {
    graphId: 'valuation-realestate-template-market',
    version: '2',
    nodes: NODE_IDS.map((id, index) => ({
      nodeId: `valuation:realestate:template-market:${id}`,
      templateMarketNodeId: id,
      label: id,
      state: states[id] ?? 'pending',
      gaps: [],
    })),
    edges: [],
  }
}

function progress(overrides = {}) {
  return {
    runId: 'run-1',
    revision: 3,
    status: 'waiting-user',
    outcome: null,
    deliveryKind: null,
    referenceDelivered: false,
    formalComplete: false,
    waiting: true,
    stages: [],
    acceptedTaskCount: 6,
    plannedTaskCount: null,
    percentage: null,
    clarification: null,
    updatedAt: '2026-10-22T05:30:00.000Z',
    graph: graph({
      templates: 'passed', materials: 'passed', 'collection-plan': 'passed', 'confirm-plan': 'passed',
      'search-listings': 'passed', 'candidate-workbook': 'passed', 'select-cases': 'waiting',
    }),
    plan: null,
    result: null,
    revisions: [],
    market: {
      currentNode: 'select-cases',
      plan: null,
      candidates: [
        { caseId: 'C01', recommendation: '同小区', status: 'eligible', selectionState: 'unselected' },
        { caseId: 'C02', recommendation: '面积接近', status: 'nearby', selectionState: 'unselected' },
      ],
      candidateVersion: 4,
      selectedCaseIds: [],
      artifacts: [],
    },
    ...overrides,
  }
}

test('market workface projects all eleven real nodes with the two parallel preparations first', async () => {
  const { deriveMarketView } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const view = deriveMarketView(progress())
  assert.equal(view.nodes.length, 11)
  assert.equal(view.nodes[0].parallel, true)
  assert.equal(view.nodes[1].parallel, true)
  assert.equal(view.nodes[2].edge, '汇合')
  assert.equal(view.nodes[7].conditional, true)
  assert.equal(view.nodes[9].conditional, true)
  assert.equal(view.currentNodeId, 'select-cases')
  assert.match(view.status.text, /等待/)
  assert.match(view.summary.progress.value, /07\s*\/\s*11/)
  assert.equal(view.status.tone, 'waiting')
})

test('market workface distinguishes executing, completed, restricted and failed states', async () => {
  const { deriveMarketView } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const cases = [
    [{ status: 'running', waiting: false, market: { ...progress().market, currentNode: 'inspect-details' }, graph: graph({ 'select-cases': 'passed', 'inspect-details': 'running' }) }, 'executing'],
    [{ status: 'completed', waiting: false, outcome: 'completed', market: { ...progress().market, currentNode: 'validate-delivery' }, graph: graph({ 'validate-delivery': 'passed' }) }, 'done'],
    [{ status: 'partial', waiting: false, outcome: 'partial', deliveryKind: 'workpaper', market: { ...progress().market, currentNode: 'validate-delivery' }, graph: graph({ 'validate-delivery': 'partial' }) }, 'restricted'],
    [{ status: 'failed', waiting: false, outcome: 'failed', market: { ...progress().market, currentNode: 'select-cases' }, graph: graph({ 'select-cases': 'failed' }) }, 'failed'],
  ]
  for (const [value, tone] of cases) {
    const view = deriveMarketView(progress(value))
    assert.equal(view.status.tone, tone)
    assert.notEqual(view.status.text, '')
  }
})

test('pending questions stay bound to the current node and never invent a demo answer', async () => {
  const { deriveMarketView } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const view = deriveMarketView(progress({
    questionnaire: {
      version: 2,
      questions: [
        { questionId: 'select-cases:caseIds', nodeId: 'select-cases', field: 'caseIds', prompt: '选择案例', control: 'multiselect', options: [], answerProtocol: 2, required: true, applicable: true, version: 1, answer: null },
        { questionId: 'select-cases:searchDecision', nodeId: 'select-cases', field: 'searchDecision', prompt: '是否补搜', control: 'radio', options: [], answerProtocol: 2, required: true, applicable: true, version: 1, answer: null },
      ],
      drafts: [], notes: [], legacy: [], submissions: [],
    },
  }))
  assert.equal(view.pendingQuestionCount, 2)
  assert.equal(view.selectedCaseIds.length, 0)
  assert.match(view.status.text, /2/)
})


test('a running materials node without a receipt never claims its inputs were read', async () => {
  const { deriveMarketView } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const value = progress({ status: 'running', waiting: false, graph: graph({ templates: 'running', materials: 'running' }),
    market: { ...progress().market, currentNode: 'templates', nodes: [] } })
  const view = deriveMarketView(value)
  assert.doesNotMatch(view.summary.materials.value, /已读取/)
  assert.match(view.summary.materials.value, /读取中/)
})

test('unrelated selected-node knowledge sources cannot change the materials summary count', async () => {
  const { deriveMarketView } = await import('../../../src/client/modules/report-evaluation/market/model.ts')
  const value = progress({ market: { ...progress().market, nodes: [{ nodeId: 'materials', state: 'passed', summary: '已核对资料事实', meta: '' }] } })
  const plain = deriveMarketView(value)
  const selected = deriveMarketView(value, { readSources: [{ sourceId: 'kb-1' }, { sourceId: 'kb-2' }] })
  assert.deepEqual(selected.summary.materials, plain.summary.materials)
  assert.equal(selected.summary.materials.value, '已读取')
})
