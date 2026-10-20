import assert from 'node:assert/strict'
import test from 'node:test'

test('an explicitly selected unsupported method is disclosed before template reads or market work', async () => {
  const { createWorkflowPlanningPorts } = await import('../../../src/host/integrations/valuation-workflow/production/planning.ts')
  const calls = []
  const ports = createWorkflowPlanningPorts({ deps: { ctx: { get: (name) => calls.push(name) } },
    frozenInput: { methodRequest: 'income', files: [] }, planId: 'plan-fixture', casePath: () => '/synthetic/case',
    principal: () => ({ sessionId: 'parent-fixture', caseDir: '/synthetic/case', source: 'workflow-runtime' }),
    currentExecution: () => undefined,
    inference: { infer: async () => { calls.push('model'); return { ok: false } } },
    knowledge: { templatePaths: async () => { calls.push('template-catalog'); return [] },
      templateCatalog: async () => { calls.push('template-catalog'); return { paths: [], sources: [] } } },
  })
  const result = await ports.planning.prepare({ runId: 'run-fixture', revision: 1,
    object: { objectId: 'object-fixture', useLabel: '公寓', areaSqm: 100 }, purpose: '', baseDate: '',
    userInput: '', materials: [], knowledge: [], methodOutput: {} })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /收益法|income/)
  assert.deepEqual(calls, [])
})

test('production planning selection receives original choices and current confirmed object facts', async () => {
  const { createWorkflowPlanningPorts } = await import('../../../src/host/integrations/valuation-workflow/production/planning.ts')
  const initialInput = { userInput: 'synthetic original input', assetType: 'real-estate', methodRequest: 'market',
    purpose: null, baseDate: null, valueType: 'synthetic value', templateFileId: null, supplementalPrompt: '', inputDigest: null, files: [] }
  let selected
  const ports = createWorkflowPlanningPorts({ deps: { ctx: { get() { throw new Error('unexpected business IO') } } },
    frozenInput: { methodRequest: 'market', files: [] }, planId: 'synthetic-plan', casePath: () => '/synthetic/case',
    principal: () => ({ sessionId: 'synthetic-parent', caseDir: '/synthetic/case', source: 'workflow-runtime' }),
    currentExecution: () => undefined,
    inference: { infer: async (request) => { selected = request; return { ok: false, error: 'synthetic selection intentionally stopped' } } },
    knowledge: { templateCatalog: async () => ({ paths: ['synthetic-template.xlsx'], sources: [] }) },
  })
  const object = { objectId: 'synthetic-object', useLabel: '公寓', areaSqm: 90 }
  await ports.planning.prepare({ runId: 'synthetic-run', revision: 2, object, purpose: 'synthetic current purpose', baseDate: '',
    userInput: 'synthetic clarified input', materials: [], knowledge: [], methodOutput: {}, initialInput })
  assert.ok(selected, 'exercise the actual production selection boundary')
  assert.equal(selected.operation, 'planning-selection')
  assert.deepEqual(selected.facts.initialInput, initialInput)
  assert.deepEqual(selected.facts.object, object)
  assert.equal(selected.facts.purpose, 'synthetic current purpose')
  assert.equal(selected.facts.baseDate, '')
  assert.equal(selected.facts.userInput, 'synthetic clarified input')
  selected.facts.initialInput.valueType = 'changed by adapter'
  assert.equal(initialInput.valueType, 'synthetic value')
})

test('planning discloses separate filename and body identities with field-specific evidence limits', async () => {
  const { createWorkflowPlanningPorts } = await import('../../../src/host/integrations/valuation-workflow/production/planning.ts')
  let selected
  const ports = createWorkflowPlanningPorts({ deps: { ctx: { get() { throw new Error('unexpected business IO') } } },
    frozenInput: { methodRequest: 'market', files: [] }, planId: 'synthetic-plan', casePath: () => '/synthetic/case',
    principal: () => ({ sessionId: 'synthetic-parent', caseDir: '/synthetic/case', source: 'workflow-runtime' }),
    currentExecution: () => undefined,
    inference: { infer: async (request) => { selected = request; return { ok: false, error: 'isolated packet capture' } } },
    knowledge: { templateCatalog: async () => ({ paths: ['synthetic-template.xlsx'], sources: [] }) },
  })
  await ports.planning.prepare({ runId: 'synthetic-run', revision: 2,
    object: { objectId: 'synthetic-object', useLabel: '公寓', areaSqm: 90 }, purpose: '', baseDate: '',
    userInput: 'synthetic employee choice', promptSupplement: 'synthetic node correction',
    materials: [{ materialId: 'material-synthetic', fileName: 'synthetic-community.pdf', digest: 'sha256:synthetic', text: 'synthetic material body' }],
    knowledge: [{ sourceId: 'wiki:synthetic-policy', path: 'synthetic.md', digest: 'sha256:synthetic-policy', body: 'synthetic policy body', quote: 'synthetic', section: '' }],
    methodOutput: {} })
  assert.ok(selected)
  const catalog = selected.facts.sourceCatalog
  assert.ok(Array.isArray(catalog), 'the model must see actual accepted source identities')
  assert.deepEqual(catalog.map(({ sourceId, kind, allowedFields }) => ({ sourceId, kind, allowedFields })), [
    { sourceId: 'user-input', kind: 'user', allowedFields: ['city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath'] },
    { sourceId: 'material-synthetic', kind: 'material', allowedFields: ['city', 'community', 'nearbyCommunities'] },
    { sourceId: 'material-synthetic:file-name', kind: 'file-name', allowedFields: ['community'] },
    { sourceId: 'wiki:synthetic-policy', kind: 'knowledge', allowedFields: ['valueScope', 'providerOrder', 'templatePath'] },
  ])
  assert.equal(catalog.find((s) => s.kind === 'file-name').text, 'synthetic-community.pdf')
  assert.equal(catalog.find((s) => s.kind === 'user').text, 'synthetic employee choice\nsynthetic node correction')
  assert.equal(catalog.some((s) => s.sourceId === 'facts.confirmedFacts'), false)
})
