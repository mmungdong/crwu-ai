/**
 * Shared fixtures for the planned valuation workflow tests (tests-only).
 *
 * No production module is imported at module scope: the planned units do not exist
 * yet, so each loader is a lazy dynamic import and a missing module fails only the
 * test that needs it.
 */
import { createHash } from 'node:crypto'

/** Plugin package root (`tests/helpers/../../`). */
export const ROOT = new URL('../../', import.meta.url)

export function pluginUrl(relative) {
  return new URL(relative, ROOT).href
}

export const loadSharedContracts = () => import(pluginUrl('src/shared/contracts/valuation-workflow.ts'))
export const loadWorkflowService = () => import(pluginUrl('src/host/domains/report-evaluation/workflow/service.ts'))
export const loadWorkflowPorts = () => import(pluginUrl('src/host/domains/report-evaluation/workflow/ports.ts'))
export const loadRequirements = () => import(pluginUrl('src/host/domains/report-evaluation/knowledge/requirements.ts'))
export const loadListingReferenceAsset = () => import(
  pluginUrl('src/host/domains/report-evaluation/assets/realestate/listing-reference.ts'))
export const loadWorkflowPane = () => import(
  pluginUrl('src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx'))
export const loadWorkflowInference = () => import(
  pluginUrl('src/host/integrations/valuation-workflow/inference.ts'))

/** Seven visible stages, in dependency order. Mirrors the planned shared contract. */
export const WORKFLOW_STAGES = ['elements', 'rights', 'plan', 'evidence', 'calculation', 'review', 'delivery']

/** The four listing-reference artifacts the existing delivery contract requires. */
export const REFERENCE_ARTIFACTS = ['计算轨迹.json', '估值底稿.xlsx', '估值报告数据.json', '估值报告.html']

/** Synthetic listing samples (explicitly test data, never business defaults). */
export const LISTING_SAMPLES = [
  { sourceId: 'listing:case-001', unitPrice: 31000, listingKind: 'listing' },
  { sourceId: 'listing:case-002', unitPrice: 33000, listingKind: 'listing' },
]

export const OBJECT_AREA = 86.4
export const EXPECTED_UNIT_PRICE = 32000
export const EXPECTED_TOTAL_PRICE = Math.round(EXPECTED_UNIT_PRICE * OBJECT_AREA * 100) / 100

export function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A macrotask tick: enough for every pending microtask (no long timers in tests). */
export const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

export function digestOf(body) {
  return `sha256:${createHash('sha256').update(String(body)).digest('hex')}`
}

// ---------------------------------------------------------------------------
// Host run fixtures
// ---------------------------------------------------------------------------

export function createStartInput(patch = {}) {
  return {
    runId: 'run-0001',
    object: { objectId: 'object-a', useLabel: '公寓', areaSqm: OBJECT_AREA },
    materials: [{ materialId: 'material-001', fileName: '资产表.xlsx', digest: 'sha256:material-001' }],
    purpose: '转让',
    baseDate: '2026-08-31',
    mode: 'listing-reference',
    ...patch,
  }
}

function defaultStageOutput(input) {
  switch (input.stage) {
    case 'elements':
      return {
        purpose: input.facts.purpose ?? null,
        baseDate: input.facts.baseDate ?? null,
        mode: input.facts.mode ?? null,
      }
    case 'rights':
      return {
        objectId: input.facts.objectId,
        useLabel: input.facts.useLabel,
        areaSqm: input.facts.areaSqm,
      }
    case 'plan':
      return { method: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean' }
    case 'evidence':
      return {
        samples: LISTING_SAMPLES.map((sample) => ({ ...sample })),
        requirements: [syntheticReferenceCandidate()],
      }
    case 'calculation':
      return { boundInputs: ['samples', 'areaSqm'] }
    case 'review':
      return { checked: true, limitations: ['参考口径，非正式评估结论'] }
    case 'delivery':
      return { artifacts: [...REFERENCE_ARTIFACTS] }
    default:
      return {}
  }
}

/**
 * In-memory capability ports. Every call is recorded under `calls` so a test can
 * assert which capability actually ran, in which order and with which identity.
 *
 * `options.infer(input, calls, fallback)` can override a single stage and delegate
 * the rest back to `fallback`. `options.gate(input)` is awaited before the default
 * inference result, which lets a test hold a run in flight.
 *
 * The inference port returns a **distinct actual session id** per attempt, the way
 * the DSH adapter returns the real started child id; the request only carries a
 * correlation key the service proposed.
 */
export function createFixturePorts(options = {}) {
  const calls = { inference: [], inferenceReturns: [], knowledge: [], calculator: [], verification: [] }
  const sources = options.sources ?? [syntheticReferencePolicy(), syntheticPolicyTable()]
  let sessionSeq = 0
  const actualSessionId = () => `inference-session-${++sessionSeq}`

  const fallbackInfer = async (input) => {
    if (typeof options.gate === 'function') await options.gate(input)
    return { ok: true, sessionId: actualSessionId(), outputs: defaultStageOutput(input) }
  }

  const ports = {
    inference: {
      infer: async (input) => {
        calls.inference.push(input)
        let result
        if (typeof options.infer === 'function') result = await options.infer(input, calls, fallbackInfer)
        if (result === undefined) result = await fallbackInfer(input)
        if (result !== null && typeof result === 'object' && result.ok === true && typeof result.sessionId !== 'string') {
          result = { ...result, sessionId: actualSessionId() }
        }
        calls.inferenceReturns.push(result)
        return result
      },
    },
    knowledge: {
      read: async (input) => {
        calls.knowledge.push(input)
        if (typeof options.readKnowledge === 'function') return options.readKnowledge(input, calls)
        return { ok: true, sources, samples: LISTING_SAMPLES.map((sample) => ({ ...sample })) }
      },
    },
    calculator: {
      compute: async (input) => {
        calls.calculator.push(input)
        if (typeof options.compute === 'function') return options.compute(input, calls)
        const prices = input.samples.map((sample) => Number(sample.unitPrice))
        const unitPrice = prices.length === 0
          ? 0
          : Math.round((prices.reduce((total, price) => total + price, 0) / prices.length) * 100) / 100
        return {
          ok: true,
          unitPrice,
          totalPrice: Math.round(unitPrice * Number(input.areaSqm) * 100) / 100,
        }
      },
    },
    verification: {
      verify: async (input) => {
        calls.verification.push(input)
        if (typeof options.verify === 'function') return options.verify(input, calls)
        return { ok: true, verified: [...input.artifacts], missing: [] }
      },
    },
  }
  return { ports, calls }
}

/** The last inference request/result pair recorded for a stage. */
export function lastInferenceFor(calls, stage) {
  for (let index = calls.inference.length - 1; index >= 0; index -= 1) {
    if (calls.inference[index].stage === stage) {
      return { request: calls.inference[index], result: calls.inferenceReturns[index] }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// DSH subagent fixtures for the runtime inference adapter
// ---------------------------------------------------------------------------

/** A provider descriptor with the four eligibility facts made explicit. */
export function createSubagentProvider(name, options = {}) {
  return {
    name,
    inheritsParentContext: options.inheritsParentContext ?? false,
    capabilities: {
      agentOptions: options.agentOptions ?? true,
      outputSchema: options.outputSchema ?? true,
      depthLimit: options.depthLimit ?? false,
      toolFilter: options.toolFilter ?? true,
      persona: options.persona ?? false,
    },
  }
}

/** A published one-shot run handle with a controllable result/dispose. */
export function createSubagentRun(options = {}) {
  const id = options.id ?? 'child-session-1'
  return {
    id,
    localAgent: options.localAgent ?? { id },
    result: options.result ?? Promise.resolve({
      output: [{ type: 'text', text: 'done' }],
      structured: options.structured ?? { useLabel: '公寓', areaSqm: OBJECT_AREA },
      stopReason: 'completed',
    }),
    dispose: options.dispose ?? (async () => {}),
  }
}

/** In-memory `ctx.subagents`: list / getProvider / start, with call recording. */
export function createSubagentRuntime(providers, options = {}) {
  const calls = { starts: [], getProvider: [], list: 0 }
  const runtime = {
    calls,
    list() { calls.list += 1; return Object.keys(providers) },
    getProvider(name) { calls.getProvider.push(name); return providers[name] },
    start: async (name, request) => {
      calls.starts.push({ name, request })
      if (typeof options.start === 'function') return options.start(name, request, calls)
      return createSubagentRun(options.run)
    },
  }
  if (options.withoutGetProvider === true) delete runtime.getProvider
  return runtime
}

/**
 * A `0.2.x` provider descriptor: `agentPreset` replaces `toolFilter`/`persona`,
 * and a `prepareContinuable` method marks the in-process (local) backend.
 */
export function createActivationProvider(name, options = {}) {
  return {
    name,
    inheritsParentContext: options.inheritsParentContext ?? false,
    capabilities: {
      agentOptions: options.agentOptions ?? true,
      agentPreset: options.agentPreset ?? true,
      outputSchema: options.outputSchema ?? true,
      depthLimit: options.depthLimit ?? true,
    },
    ...(options.local === false ? {} : { prepareContinuable: () => Promise.resolve({}) }),
  }
}

/** A `0.2.x` activation receipt: `{ childId, result, dispose }`. */
export function createSubagentActivation(options = {}) {
  const childId = options.childId ?? 'child-session-1'
  return {
    childId,
    result: options.result ?? Promise.resolve({
      output: [{ type: 'text', text: 'done' }],
      structured: options.structured ?? { useLabel: '公寓', areaSqm: OBJECT_AREA },
      stopReason: 'completed',
    }),
    dispose: options.dispose ?? (async () => {}),
  }
}

/** In-memory `ctx.subagents` for the `0.2.x` line: startActivation, with call recording. */
export function createActivationSubagentRuntime(providers, options = {}) {
  const calls = { activations: [], getProvider: [], list: 0, restrictions: [], listeners: 0 }
  const listeners = new Set()
  const runtime = {
    calls,
    onCreated(callback) {
      listeners.add(callback)
      calls.listeners = listeners.size
      return () => { listeners.delete(callback); calls.listeners = listeners.size }
    },
    list() { calls.list += 1; return Object.keys(providers) },
    getProvider(name) { calls.getProvider.push(name); return providers[name] },
    startActivation: async (spec) => {
      calls.activations.push(spec)
      if (typeof options.startActivation === 'function') return options.startActivation(spec, calls)
      const activation = createSubagentActivation(options.activation)
      if (spec.childId !== undefined) activation.childId = spec.childId
      const child = { id: activation.childId, session: { header: { id: activation.childId, parentSession: spec.request.parent.id } },
        ctx: { get: (name) => name === 'tools' ? { restrict: (filter) => {
          calls.restrictions.push({ id: activation.childId, filter })
          return () => {}
        } } : undefined } }
      for (const listener of listeners) await listener({ agent: child, source: 'create' })
      return activation
    },
  }
  if (options.withoutGetProvider === true) delete runtime.getProvider
  if (options.withoutStartActivation === true) delete runtime.startActivation
  return runtime
}

/** A minimal Cordis-like context exposing only `subagents`. */
export function createInferenceContext(runtime) {
  return { get: (name) => (name === 'subagents' ? runtime : undefined),
    ...(typeof runtime?.onCreated !== 'function' ? {} : {
      on: (event, callback) => {
        if (event !== 'agent/created') throw new Error('Unexpected lifecycle event')
        return runtime.onCreated(callback)
      },
    }),
  }
}

/** The request shape shared with the fixture service inference port. */
export function createWorkflowInferenceRequest(patch = {}) {
  return {
    runId: 'run-0001',
    revision: 1,
    nodeId: 'rights',
    stage: 'rights',
    attempt: 1,
    correlationId: 'corr-rights-1',
    facts: { objectId: 'object-a', useLabel: '公寓', areaSqm: OBJECT_AREA },
    knowledge: [{
      sourceId: 'synthetic-policy-prose',
      path: '01 估值与测算/01 房地产/合成政策.adoc',
      section: '合成条款甲',
      quote: '可比案例数量不得少于 3 个。',
    }],
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Knowledge requirement fixtures (explicitly synthetic policy text)
// ---------------------------------------------------------------------------

export function syntheticPolicyProse() {
  const body = [
    '# 合成政策（显式测试用，非真实业务阈值）',
    '',
    '以下条款只用于自动化测试，不代表任何真实业务规则。',
    '合成条款甲：可比案例数量不得少于 3 个。',
    '合成条款乙：可比案例数量不得少于 5 个。',
    '',
  ].join('\n')
  return {
    sourceId: 'synthetic-policy-prose',
    spaceName: '合成业务知识库（显式测试用）',
    path: '01 估值与测算/01 房地产/合成政策.adoc',
    digest: digestOf(body),
    body,
    kind: 'prose',
  }
}

export function syntheticPolicyTable() {
  const body = [
    '# 合成参数表（显式测试用，非真实业务阈值）',
    '',
    '| 参数 | 取值 | 单位 |',
    '| --- | --- | --- |',
    '| 合成挂牌调整系数 | 1.00 | 无量纲 |',
    '',
  ].join('\n')
  return {
    sourceId: 'synthetic-policy-table',
    spaceName: '合成业务知识库（显式测试用）',
    path: '01 估值与测算/01 房地产/合成参数表.adoc',
    digest: digestOf(body),
    body,
    kind: 'table',
  }
}

/**
 * The reference-policy source used by the graph happy path.
 *
 * It is deliberately separate from the binder-only prose fixture (which states a
 * minimum of 3): the happy path has 2 real samples, so a matching policy must say 2.
 */
export function syntheticReferencePolicy() {
  const body = [
    '# 合成参考政策（显式测试用，非真实业务阈值）',
    '',
    '合成参考条款：挂牌参考样本数量不得少于 2 个。',
    '合成参考口径：原始挂牌单价算术平均，不修正、不折扣。',
    '',
  ].join('\n')
  return {
    sourceId: 'synthetic-reference-policy',
    spaceName: '合成业务知识库（显式测试用）',
    path: '01 估值与测算/01 房地产/合成参考政策.adoc',
    digest: digestOf(body),
    body,
    kind: 'prose',
  }
}

/** A source-bound candidate that really matches `syntheticReferencePolicy`. */
export function syntheticReferenceCandidate(patch = {}) {
  const source = syntheticReferencePolicy()
  return {
    requirementId: 'synthetic.reference-sample-count.min',
    source: {
      sourceId: source.sourceId,
      digest: source.digest,
      section: '合成参考条款',
      quote: '合成参考条款：挂牌参考样本数量不得少于 2 个。',
    },
    statement: '挂牌参考样本数量不得少于 2 个。',
    strength: 'must',
    appliesTo: {
      objectIds: ['object-a'],
      stages: ['evidence'],
      methods: ['listing-reference'],
      modes: ['listing-reference'],
    },
    parameter: { name: 'referenceSampleCount.min', value: 2, unit: '个', evidenceQuote: '不得少于 2 个' },
    executor: null,
    ...patch,
  }
}

export function syntheticContext(patch = {}) {
  return {
    objectId: 'object-a',
    stage: 'evidence',
    mode: 'listing-reference',
    method: 'listing-reference',
    useLabel: '公寓',
    facts: { areaSqm: OBJECT_AREA },
    sourceScope: {
      spaceName: '合成业务知识库（显式测试用）',
      paths: [
        '01 估值与测算/01 房地产/合成政策.adoc',
        '01 估值与测算/01 房地产/合成参数表.adoc',
      ],
    },
    allowedCalculatorIds: ['listing-reference.mean'],
    ...patch,
  }
}

export function syntheticCountCandidate(patch = {}) {
  const source = syntheticPolicyProse()
  return {
    requirementId: 'synthetic.comparable-count.min',
    source: {
      sourceId: source.sourceId,
      digest: source.digest,
      section: '合成条款甲',
      quote: '可比案例数量不得少于 3 个。',
    },
    statement: '可比案例数量不得少于 3 个。',
    strength: 'must',
    appliesTo: {
      objectIds: ['object-a'],
      stages: ['evidence'],
      methods: ['listing-reference'],
      modes: ['listing-reference'],
    },
    parameter: { name: 'comparableCount.min', value: 3, unit: '个', evidenceQuote: '不得少于 3 个' },
    executor: null,
    ...patch,
  }
}

export function syntheticTableCandidate(patch = {}) {
  const source = syntheticPolicyTable()
  return {
    requirementId: 'synthetic.listing-adjustment',
    source: {
      sourceId: source.sourceId,
      digest: source.digest,
      section: '合成参数表',
      quote: '| 合成挂牌调整系数 | 1.00 | 无量纲 |',
    },
    statement: '合成挂牌调整系数为 1.00，单位无量纲。',
    strength: 'must',
    appliesTo: {
      objectIds: ['object-a'],
      stages: ['calculation'],
      methods: ['listing-reference'],
      modes: ['listing-reference'],
    },
    parameter: { name: 'listingAdjustment', value: 1, unit: '无量纲', evidenceQuote: '1.00 | 无量纲' },
    executor: null,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Client view fixtures
// ---------------------------------------------------------------------------

export function createStageViews(patch = {}) {
  return WORKFLOW_STAGES.map((stage) => ({
    stage,
    state: stage === 'delivery' ? 'partial' : 'passed',
    objectCount: 1,
    passedCount: stage === 'delivery' ? 0 : 1,
    waitingCount: 0,
    gaps: [],
    ...(patch[stage] ?? {}),
  }))
}

export function createClarificationView(patch = {}) {
  return {
    clarificationId: 'clar-1',
    revision: 1,
    questions: [
      { questionId: 'q-purpose', field: 'purpose', prompt: '请指定本次评估目的', knownValue: '', source: '用户输入' },
      { questionId: 'q-base-date', field: 'baseDate', prompt: '请指定本次评估基准日', knownValue: '', source: '用户输入' },
    ],
    ...patch,
  }
}

export function createProgressView(patch = {}) {
  return {
    runId: 'run-0001',
    revision: 1,
    status: 'completed',
    outcome: 'partial',
    deliveryKind: 'listing-reference',
    referenceDelivered: true,
    formalComplete: false,
    waiting: false,
    stages: createStageViews(),
    acceptedTaskCount: 4,
    // Unknown total means unknown; the pane must not turn it into a percentage.
    plannedTaskCount: null,
    percentage: null,
    clarification: null,
    updatedAt: '2026-10-17T00:00:00.000Z',
    ...patch,
  }
}

export function createNodeDetail(patch = {}) {
  return {
    nodeId: 'rights',
    stage: 'rights',
    label: '对象核实',
    revision: 1,
    current: true,
    inputs: [
      { field: 'useLabel', label: '原始用途', value: '公寓', source: '权证', editable: false },
      { field: 'areaSqm', label: '建筑面积（㎡）', value: String(OBJECT_AREA), source: '资产表', editable: true },
    ],
    outputs: [
      { field: 'useLabel', label: '原始用途', value: '公寓', source: 'rights' },
      { field: 'areaSqm', label: '建筑面积（㎡）', value: String(OBJECT_AREA), source: 'rights' },
    ],
    knowledge: [
      {
        sourceId: 'synthetic-policy-prose',
        path: '01 估值与测算/01 房地产/合成政策.adoc',
        section: '合成条款甲',
        quote: '可比案例数量不得少于 3 个。',
      },
    ],
    dependents: [
      { nodeId: 'plan', label: '方法与计算方案' },
      { nodeId: 'calculation', label: '按口径测算' },
      { nodeId: 'delivery', label: '成果验收与交付' },
    ],
    ...patch,
  }
}
