/**
 * Behavioral contract for the corrected nested valuation workflow graph.
 *
 * Production graph modules are loaded lazily: this is a tests-only assignment, so a
 * missing planned module must fail the behavior under test, never the test loader.
 *
 * Pinned public contracts:
 * - createValuationGraphRegistry() -> { register(id, compiledGraph), ids(), get(id) }
 *   register is synchronous and throws on a duplicate/empty id or invalid graph; get
 *   returns undefined when the id is absent.
 * - registerRealestateGraph(registry, runner) registers the compiled child id "realestate"
 * - compileRealestateGraph(runner) -> compiled seven-stage realestate graph
 * - compileValuationGraph({ registry, inferIntent }) -> compiled valuation intent graph
 * - compileWorkflowGraph({ valuation }) -> compiled root graph with a real valuation child
 * - inferIntent(input, registeredAssetIds) -> structured result or { ok: false, error }
 * - runner(stage, state) -> { status, outputs? }
 *
 * State/result fields: input, entry, stage, status, intent, intentSessionId, route,
 * outputs; rejected inference/validation also exposes a non-empty error. The graph
 * status vocabulary is running | waiting | blocked | completed. Intent status stays
 * the structured value from inference. Xray nesting names are "valuation:intent-router"
 * and "valuation:<registeredAssetId>:<stage>".
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

const STAGES = ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']

test('a business refusal retains its concrete reason and actual intent child identity', async () => {
  const { evaluateInference } = await import(pluginModule('src/host/graph/valuation/intent.ts'))
  const result = evaluateInference({ text: '合成估值', materials: [] }, ['realestate'], {
    ok: false, errorKind: 'blocked', error: '意图对象与当前已确认对象不一致', sessionId: 'actual-conflict-child',
  })
  assert.equal(result.error, '意图对象与当前已确认对象不一致')
  assert.equal(result.intentSessionId, 'actual-conflict-child')
  assert.equal(result.route, '')
})

const MATERIAL = {
  materialId: 'material-001',
  fileName: '不动产权证.txt',
  digest: 'sha256:material-001',
  text: '权利人：张三。用途：公寓。建筑面积：86.4 平方米。',
}

const SECOND_MATERIAL = {
  materialId: 'material-002',
  fileName: '身份证复印件.txt',
  digest: 'sha256:material-002',
  text: '附件为权利人身份证复印件。',
}

function pluginModule(relative) {
  return new URL(`../../../${relative}`, import.meta.url).href
}

const loadRegistry = () => import(pluginModule('src/host/graph/valuation/registry.ts'))
const loadValuationGraph = () => import(pluginModule('src/host/graph/valuation/graph.ts'))
const loadRealestateGraph = () => import(pluginModule('src/host/graph/valuation/realestate/graph.ts'))
const loadRealestateRegister = () => import(pluginModule('src/host/graph/valuation/realestate/register.ts'))
const loadWorkflowGraph = () => import(pluginModule('src/host/graph/graph.ts'))

async function createRegistry() {
  const { createValuationGraphRegistry } = await loadRegistry()
  return createValuationGraphRegistry()
}

async function registerRealestate(registry, runner) {
  const { registerRealestateGraph } = await loadRealestateRegister()
  return registerRealestateGraph(registry, runner)
}

async function compileValuation(registry, inferIntent) {
  const { compileValuationGraph } = await loadValuationGraph()
  return compileValuationGraph({ registry, inferIntent })
}

async function compileWorkflow(valuation) {
  const { compileWorkflowGraph } = await loadWorkflowGraph()
  return compileWorkflowGraph({ valuation })
}

async function buildRealestateWorkflow(inferIntent, runner) {
  const registry = await createRegistry()
  await registerRealestate(registry, runner)
  const valuation = await compileValuation(registry, inferIntent)
  return { registry, root: await compileWorkflow(valuation) }
}

function workflowInput(overrides = {}) {
  const { input: inputOverride, ...stateOverrides } = overrides
  return {
    input: {
      text: '',
      materials: [{ ...MATERIAL }],
      ...inputOverride,
    },
    entry: 'elements',
    stage: '',
    status: 'running',
    intent: null,
    ...stateOverrides,
  }
}

function resolvedIntent(overrides = {}) {
  return {
    business: 'valuation',
    assetType: 'realestate',
    status: 'resolved',
    objects: [{ objectId: 'object-001', materialIds: [MATERIAL.materialId] }],
    evidence: [{ materialId: MATERIAL.materialId, quote: '用途：公寓' }],
    questions: [],
    ...overrides,
  }
}

function intentResult(intent, overrides = {}) {
  return { ok: true, sessionId: 'intent-session-1', intent, ...overrides }
}

function snapshot(state) {
  return {
    stage: state.stage,
    status: state.status,
    intent: structuredClone(state.intent),
    intentSessionId: state.intentSessionId,
    route: state.route,
    outputs: structuredClone(state.outputs ?? {}),
  }
}

/**
 * Record each runner call, optionally holding the first plan attempt. Outputs are
 * accumulated by stage so the next runner can prove it saw the prior output.
 */
function createRecordingRunner(options = {}) {
  const calls = []
  let planAttempts = 0
  const runner = async (stage, state) => {
    calls.push({ stage, state: snapshot(state) })
    if (stage === 'plan' && options.waitAtPlan === true) {
      planAttempts += 1
      if (planAttempts === 1) {
        return { status: 'waiting', outputs: { [stage]: { note: `ran ${stage}` } } }
      }
    }
    return {
      status: stage === 'delivery' ? 'completed' : 'running',
      outputs: { [stage]: { note: `ran ${stage}` } },
    }
  }
  return { calls, runner }
}

test('the compiled root contains a real valuation -> realestate hierarchy', async () => {
  const { root } = await buildRealestateWorkflow(
    async () => { throw new Error('inference must not run to inspect graph structure') },
    async () => ({ status: 'completed' }),
  )
  const graph = await root.getGraphAsync({ xray: 2 })
  const nodeIds = new Set(Object.values(graph.nodes).map((node) => node.id))

  assert.equal(nodeIds.has('valuation:intent-router'), true,
    `missing the valuation intent router; nodes: ${[...nodeIds].join(', ')}`)
  for (const stage of STAGES) {
    assert.equal(nodeIds.has(`valuation:realestate:${stage}`), true,
      `missing nested realestate stage node: ${stage}; nodes: ${[...nodeIds].join(', ')}`)
  }
  assert.equal(nodeIds.has('elements'), false,
    'realestate stages must be compiled subgraph nodes, not flattened into the root')

  const subgraphs = []
  for await (const [namespace, child] of root.getSubgraphsAsync(undefined, true)) {
    subgraphs.push({ namespace, nodeIds: new Set(Object.keys(child.nodes)) })
  }
  const valuation = subgraphs.find((entry) => entry.namespace === 'valuation')
  assert.ok(valuation, `missing the valuation child subgraph; namespaces: ${subgraphs.map((entry) => entry.namespace).join(', ')}`)
  assert.equal(valuation.nodeIds.has('realestate'), true,
    'the valuation subgraph must contain the registered realestate child')
  const realestate = subgraphs.find((entry) => entry.namespace === 'valuation|realestate')
  assert.ok(realestate,
    `missing the realestate child subgraph; namespaces: ${subgraphs.map((entry) => entry.namespace).join(', ')}`)
  for (const stage of STAGES) {
    assert.equal(realestate.nodeIds.has(stage), true,
      `the realestate child subgraph must compile stage ${stage}`)
  }
})

test('file-only resolved intent routes seven stages and threads prior outputs', async () => {
  const intent = resolvedIntent()
  const { calls, runner } = createRecordingRunner()
  let seen = null
  const inferIntent = async (input, registeredAssetIds) => {
    seen = { input, registeredAssetIds }
    return { ok: true, sessionId: 'intent-session-7', intent }
  }
  const { root } = await buildRealestateWorkflow(inferIntent, runner)
  const result = await root.invoke(workflowInput())

  assert.ok(seen, 'file-only requests must still reach intent inference')
  assert.equal(seen.input.text, '')
  assert.equal(seen.input.materials.length, 1)
  assert.deepEqual(seen.input.materials[0], MATERIAL,
    'the submitted material body and identity must reach inferIntent')
  assert.deepEqual(seen.registeredAssetIds, ['realestate'])

  assert.deepEqual(calls.map((call) => call.stage), STAGES)
  assert.equal(result.status, 'completed')
  assert.equal(result.stage, 'delivery')
  assert.equal(result.route, 'realestate')
  assert.equal(result.intentSessionId, 'intent-session-7')
  assert.deepEqual(result.intent, intent)

  for (const [index, call] of calls.entries()) {
    assert.equal(call.state.route, 'realestate')
    assert.equal(call.state.intentSessionId, 'intent-session-7')
    assert.deepEqual(call.state.intent, intent)
    if (index > 0) {
      const previous = STAGES[index - 1]
      assert.deepEqual(call.state.outputs[previous], { note: `ran ${previous}` },
        `stage ${call.stage} must receive the ${previous} output`)
    }
  }
  for (const stage of STAGES) {
    assert.deepEqual(result.outputs[stage], { note: `ran ${stage}` })
  }
})

test('a waiting stage stops dependants and resume entry keeps intent without inference', async () => {
  const intent = resolvedIntent()
  let inferenceCalls = 0
  const inferIntent = async () => {
    inferenceCalls += 1
    return { ok: true, sessionId: 'intent-session-resume', intent }
  }
  const { calls, runner } = createRecordingRunner({ waitAtPlan: true })
  const { root } = await buildRealestateWorkflow(inferIntent, runner)

  const first = await root.invoke(workflowInput())
  assert.deepEqual(calls.map((call) => call.stage), ['elements', 'rights', 'plan'])
  assert.equal(first.status, 'waiting')
  assert.equal(first.stage, 'plan')
  assert.equal(first.route, 'realestate')
  assert.equal(first.intentSessionId, 'intent-session-resume')
  assert.deepEqual(first.intent, intent)
  assert.equal(inferenceCalls, 1)

  calls.length = 0
  const second = await root.invoke(workflowInput({
    entry: 'plan',
    intent: first.intent,
    intentSessionId: first.intentSessionId,
    route: first.route,
    outputs: first.outputs,
  }))

  assert.deepEqual(calls.map((call) => call.stage),
    ['plan', 'evidence', 'calculation', 'review', 'delivery'])
  assert.equal(inferenceCalls, 1, 'resume must not call inferIntent again')
  assert.equal(second.status, 'completed')
  assert.equal(second.intentSessionId, 'intent-session-resume')
  assert.deepEqual(second.intent, intent)
  assert.deepEqual(second.outputs.elements, { note: 'ran elements' })
  assert.deepEqual(second.outputs.rights, { note: 'ran rights' })
})

test('enterprise intent with a property attachment never falls back to realestate', async () => {
  const enterpriseIntent = resolvedIntent({
    assetType: 'enterprise',
    objects: [{ objectId: 'company-001', materialIds: [MATERIAL.materialId] }],
  })
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(
    async () => ({ ok: true, sessionId: 'enterprise-session', intent: enterpriseIntent }),
    runner,
  )
  const result = await root.invoke(workflowInput({
    input: {
      text: '企业整体转让估值，主营制造业，附件为一处厂房的不动产权证。',
      materials: [{ ...MATERIAL }],
    },
  }))

  assert.equal(calls.length, 0, 'no registered professional graph may run')
  assert.equal(result.route, '')
  assert.equal(result.status, 'blocked')
  assert.equal(result.intent.assetType, 'enterprise')
})

test('ambiguous, unregistered and malformed intents never execute an asset', async () => {
  const scenarios = [
    {
      name: 'unknown business',
      inference: {
        ok: true,
        sessionId: 'unknown-session',
        intent: {
          business: 'unknown',
          assetType: null,
          status: 'needs-clarification',
          objects: [],
          evidence: [],
          questions: ['请说明估值对象'],
        },
      },
      status: 'waiting',
    },
    {
      name: 'ambiguous asset type',
      inference: {
        ok: true,
        sessionId: 'ambiguous-session',
        intent: resolvedIntent({
          status: 'needs-clarification',
          objects: [],
          evidence: [],
          questions: ['是房地产还是企业整体？'],
        }),
      },
      status: 'waiting',
    },
    {
      name: 'unregistered asset type',
      inference: {
        ok: true,
        sessionId: 'unregistered-session',
        intent: resolvedIntent({ assetType: 'enterprise' }),
      },
      status: 'blocked',
    },
    {
      name: 'malformed intent',
      inference: {
        ok: true,
        sessionId: 'malformed-session',
        intent: {
          business: 'valuation',
          assetType: 'realestate',
          status: 'resolved',
          objects: 'object-001',
          evidence: [],
          questions: [],
        },
      },
      status: 'blocked',
    },
    {
      name: 'missing structured intent',
      inference: { ok: true, sessionId: 'missing-session' },
      status: 'blocked',
    },
    {
      name: 'inference failure',
      inference: { ok: false, error: 'intent inference failed' },
      status: 'blocked',
    },
  ]

  for (const scenario of scenarios) {
    const { calls, runner } = createRecordingRunner()
    const { root } = await buildRealestateWorkflow(async () => scenario.inference, runner)
    const result = await root.invoke(workflowInput())

    assert.equal(calls.length, 0, `${scenario.name}: no stage may execute`)
    assert.equal(result.route, '', `${scenario.name}: no route may be chosen`)
    assert.equal(result.status, scenario.status, scenario.name)
    if (scenario.inference.ok === true && scenario.inference.intent?.status === 'needs-clarification') {
      assert.equal(result.intent.status, 'needs-clarification')
      assert.ok(result.intent.questions.length > 0, `${scenario.name}: clarification must be explicit`)
    }
    if (scenario.inference.ok === false
      || scenario.name === 'malformed intent'
      || scenario.name === 'missing structured intent') {
      assert.ok(result.error, `${scenario.name}: rejection must be observable`)
    }
  }
})

test('resolved evidence must cite a submitted material and a real quote', async () => {
  const scenarios = [
    {
      name: 'material is not submitted',
      evidence: [{ materialId: 'material-999', quote: '用途：公寓' }],
    },
    {
      name: 'quote belongs to another submitted material',
      evidence: [{ materialId: SECOND_MATERIAL.materialId, quote: '用途：公寓' }],
    },
    {
      name: 'quote is absent from the body',
      evidence: [{ materialId: MATERIAL.materialId, quote: '用途：住宅' }],
    },
    {
      name: 'quote is empty',
      evidence: [{ materialId: MATERIAL.materialId, quote: '' }],
    },
  ]

  for (const scenario of scenarios) {
    const intent = resolvedIntent({ evidence: scenario.evidence })
    const { calls, runner } = createRecordingRunner()
    const { root } = await buildRealestateWorkflow(
      async () => ({ ok: true, sessionId: 'forged-session', intent }),
      runner,
    )
    const result = await root.invoke(workflowInput({
      input: { materials: [{ ...MATERIAL }, { ...SECOND_MATERIAL }] },
    }))

    assert.equal(calls.length, 0, `${scenario.name}: forged evidence must not execute`)
    assert.equal(result.route, '', `${scenario.name}: no route may be chosen`)
    assert.equal(result.status, 'blocked', scenario.name)
    assert.ok(result.error, `${scenario.name}: forged evidence must be observable`)
  }
})

test('empty text and readless materials yield clarification instead of realestate', async () => {
  const clarification = {
    business: 'unknown',
    assetType: null,
    status: 'needs-clarification',
    objects: [],
    evidence: [],
    questions: ['请说明资产类型或上传可读取的材料'],
  }
  const emptyInputs = [
    { name: 'no materials', input: { text: '', materials: [] } },
    {
      name: 'readless material',
      input: { text: '', materials: [{ ...MATERIAL, text: '   ' }] },
    },
  ]

  for (const scenario of emptyInputs) {
    const { calls, runner } = createRecordingRunner()
    const { root } = await buildRealestateWorkflow(
      async () => ({ ok: true, sessionId: 'clarification-session', intent: { ...clarification } }),
      runner,
    )
    const result = await root.invoke(workflowInput({ input: scenario.input }))

    assert.equal(calls.length, 0, `${scenario.name}: clarification must not execute a graph`)
    assert.equal(result.status, 'waiting', scenario.name)
    assert.equal(result.route, '', `${scenario.name}: clarification must not choose realestate`)
    assert.equal(result.intent.status, 'needs-clarification')
    assert.ok(result.intent.questions.length > 0)
  }

  // A model claiming a resolved property intent with no evidence must still not
  // auto-route the empty request into the realestate graph.
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(
    async () => intentResult(resolvedIntent({ objects: [], evidence: [], questions: [] })),
    runner,
  )
  const result = await root.invoke(workflowInput({ input: { text: '', materials: [] } }))

  assert.equal(calls.length, 0)
  assert.equal(result.route, '')
  assert.equal(result.status, 'blocked')
})

test('model prose is rejected instead of accepted as structured intent', async () => {
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(
    async () => ({
      ok: true,
      sessionId: 'prose-session',
      intent: '这是一套公寓房地产，应当进入房地产估值流程。',
    }),
    runner,
  )
  const result = await root.invoke(workflowInput())

  assert.equal(calls.length, 0)
  assert.equal(result.route, '')
  assert.equal(result.status, 'blocked')
  assert.notEqual(typeof result.intent, 'string', 'prose must not be exposed as intent')
  assert.ok(result.error)
})

test('duplicate, empty or invalid graph registration fails', async () => {
  const { compileRealestateGraph } = await loadRealestateGraph()
  const realestate = await compileRealestateGraph(async () => ({ status: 'completed' }))
  const registry = await createRegistry()
  registry.register('realestate', realestate)
  assert.equal(registry.get('realestate'), realestate)

  assert.throws(() => registry.register('realestate', realestate), Error,
    'a duplicate asset id must not replace or duplicate the registered child')
  assert.throws(() => registry.register('', realestate), Error, 'an empty asset id must fail')
  assert.throws(() => registry.register('   ', realestate), Error, 'a blank asset id must fail')
  assert.throws(() => registry.register('synthetic', null), Error, 'a missing graph must fail')
  assert.throws(() => registry.register('synthetic', {}), Error, 'an empty graph must fail')
  assert.deepEqual(registry.ids(), ['realestate'])
})

test('separate registry instances are isolated', async () => {
  const registryA = await createRegistry()
  const runnerA = createRecordingRunner()
  await registerRealestate(registryA, runnerA.runner)

  const registryB = await createRegistry()
  assert.deepEqual(registryB.ids(), [])
  assert.equal(registryB.get('realestate'), undefined)

  const runnerB = createRecordingRunner()
  await registerRealestate(registryB, runnerB.runner)
  const valuation = await compileValuation(registryB,
    async () => ({ ok: true, sessionId: 'isolated-session', intent: resolvedIntent() }))
  const root = await compileWorkflow(valuation)
  const result = await root.invoke(workflowInput())

  assert.equal(runnerA.calls.length, 0, 'compilation must not consult another registry')
  assert.deepEqual(runnerB.calls.map((call) => call.stage), STAGES)
  assert.equal(result.route, 'realestate')
  assert.equal(result.status, 'completed')
})

test('a synthetic registered asset composes and runs without editing the valuation graph', async () => {
  const registry = await createRegistry()
  const realestate = createRecordingRunner()
  await registerRealestate(registry, realestate.runner)

  const SyntheticState = Annotation.Root({
    stage: Annotation({ reducer: (_, next) => next, default: () => '' }),
    status: Annotation({ reducer: (_, next) => next, default: () => 'running' }),
    outputs: Annotation({ reducer: (current, next) => ({ ...current, ...next }), default: () => ({}) }),
  })
  const probes = []
  const synthetic = new StateGraph(SyntheticState)
    .addNode('probe', async (state) => {
      probes.push(structuredClone(state))
      return { stage: 'probe', status: 'completed', outputs: { probe: { ok: true } } }
    })
    .addEdge(START, 'probe')
    .addEdge('probe', END)
    .compile()
  registry.register('synthetic', synthetic)

  const intent = resolvedIntent({ assetType: 'synthetic' })
  let registeredIds = null
  const inferIntent = async (_input, ids) => {
    registeredIds = ids
    return { ok: true, sessionId: 'synthetic-session', intent }
  }
  const valuation = await compileValuation(registry, inferIntent)
  const root = await compileWorkflow(valuation)

  const subgraphs = []
  for await (const [namespace, child] of root.getSubgraphsAsync(undefined, true)) {
    subgraphs.push({ namespace, nodeIds: new Set(Object.keys(child.nodes)) })
  }
  const syntheticSubgraph = subgraphs.find((entry) => entry.namespace === 'valuation|synthetic')
  assert.ok(syntheticSubgraph,
    `missing the synthetic child subgraph; namespaces: ${subgraphs.map((entry) => entry.namespace).join(', ')}`)
  assert.equal(syntheticSubgraph.nodeIds.has('probe'), true)

  const result = await root.invoke(workflowInput())
  assert.deepEqual([...registeredIds].sort(), ['realestate', 'synthetic'])
  assert.equal(realestate.calls.length, 0, 'the unrelated registered graph must not run')
  assert.equal(probes.length, 1)
  assert.equal(result.route, 'synthetic')
  assert.equal(result.status, 'completed')
  assert.equal(result.stage, 'probe')
  assert.deepEqual(result.intent, intent)
  assert.deepEqual(result.outputs.probe, { ok: true })
})

test('text-only requests bind intent evidence to the user input', async () => {
  const text = '请估算一套公寓的价值'
  const intent = resolvedIntent({
    objects: [{ objectId: 'object-001', materialIds: [] }],
    evidence: [{ source: 'user-input', quote: '一套公寓' }],
  })
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(async () => intentResult(intent), runner)
  const result = await root.invoke(workflowInput({ input: { text, materials: [] } }))
  assert.equal(result.route, 'realestate')
  assert.deepEqual(calls.map((call) => call.stage), STAGES)
})

test('unbound text evidence and narrative extras are rejected', async () => {
  for (const invalid of [
    resolvedIntent({ evidence: [{ source: 'user-input', quote: '不存在的用户输入' }] }),
    { ...resolvedIntent(), commentary: '我将认真分析后再为您处理' },
  ]) {
    const { calls, runner } = createRecordingRunner()
    const { root } = await buildRealestateWorkflow(async () => intentResult(invalid), runner)
    const result = await root.invoke(workflowInput())
    assert.equal(calls.length, 0)
    assert.equal(result.status, 'blocked')
    assert.ok(result.error)
  }
})

test('intent stop uncertainty retains the actual child identity and blocks downstream work', async () => {
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(async () => ({
    ok: false, errorKind: 'stop-unknown', sessionId: 'actual-hung-intent',
    error: 'synthetic-private-diagnostic',
  }), runner)
  const result = await root.invoke(workflowInput())
  assert.equal(calls.length, 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'stop-unknown')
  assert.equal(result.intentSessionId, 'actual-hung-intent')
  assert.doesNotMatch(result.error, /synthetic-private-diagnostic/)
})

test('intent cancellation is propagated without starting a professional stage', async () => {
  const { calls, runner } = createRecordingRunner()
  const { root } = await buildRealestateWorkflow(async () => ({
    ok: false, errorKind: 'cancelled', sessionId: 'cancelled-intent', error: 'cancelled',
  }), runner)
  const result = await root.invoke(workflowInput())
  assert.equal(calls.length, 0)
  assert.equal(result.status, 'cancelled')
})

test('the graph shown to users declares only executable conditional destinations', async () => {
  const { compileRealestateGraph } = await loadRealestateGraph()
  const graph = await compileRealestateGraph(async () => ({ status: 'running' })).getGraphAsync()
  const next = graph.edges.filter((edge) => edge.source === 'elements').map((edge) => edge.target).sort()
  assert.deepEqual(next, ['__end__', 'rights'])
  const registry = await createRegistry()
  await registerRealestate(registry, async () => ({ status: 'running' }))
  const valuation = await compileValuation(registry, async () => intentResult(resolvedIntent()))
  const routes = (await valuation.getGraphAsync()).edges.filter((edge) => edge.source === 'intent-router').map((edge) => edge.target).sort()
  assert.deepEqual(routes, ['__end__', 'realestate'])
})
