import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest } from '../../helpers/valuation-workflow-fixture.mjs'

const profile = () => ({
  templateId: 'template-fixture', digest: `sha256:${'a'.repeat(64)}`, relativePath: '材料/fixture.xlsx',
  sheets: [{ name: '候选', rows: 6, columns: 5, mergedRanges: ['A1:E1'] }],
  cells: [{ sheet: '候选', cell: 'A2', value: '建筑面积', formula: '' },
    { sheet: '候选', cell: 'A3', value: '所在楼层', formula: '' }],
  definedNames: [], coverage: { complete: true, issues: [] },
})
const knowledge = [{ sourceId: 'method-fixture', body: '逐案取得建筑面积和所在楼层；面积缺失时不能判断规模差异。' }]
const requirements = () => ({ templateId: 'template-fixture', templateDigest: `sha256:${'a'.repeat(64)}`, version: 1,
  fields: [{ fieldId: 'building-area', label: '建筑面积', labelRef: { sheet: '候选', cell: 'A2' },
    targetRefs: [{ sheet: '候选', cell: 'B2' }, { sheet: '候选', cell: 'C2' }, { sheet: '候选', cell: 'D2' }, { sheet: '候选', cell: 'E2' }],
    category: 'source-fact', applicability: 'applicable', criticalFor: ['eligibility', 'calculation'],
    basis: [{ sourceId: 'method-fixture', quote: '逐案取得建筑面积和所在楼层' }] }], questions: [] })

async function domain() {
  const loaded = await import('../../../src/host/domains/report-evaluation/workflow/case-collection.ts').catch(() => null)
  assert.equal(typeof loaded?.bindTemplateRequirements, 'function', 'template requirements must have an evidence binder')
  return loaded
}

test('requirements follow actual template cells and support more than three case slots', async () => {
  const { bindTemplateRequirements } = await domain()
  const candidate = requirements()
  const result = bindTemplateRequirements(candidate, profile(), knowledge)
  assert.equal(result.ok, true, JSON.stringify(result.gaps))
  assert.equal(result.requirements.fields[0].targetRefs.length, 4)
  candidate.fields[0].label = 'overwritten'
  assert.equal(result.requirements.fields[0].label, '建筑面积')
  const other = profile(); other.cells[0].value = '可出租面积'
  assert.equal(bindTemplateRequirements(requirements(), other, knowledge).ok, false)
})

test('invented cells, changed templates and unverified method requirements fail closed', async () => {
  const { bindTemplateRequirements } = await domain()
  for (const mutate of [
    (x) => { x.templateDigest = `sha256:${'b'.repeat(64)}` },
    (x) => { x.templateId = 'foreign-template' },
    (x) => { x.fields[0].labelRef.cell = 'A4' },
    (x) => { x.fields[0].targetRefs[0].cell = 'Z999' },
    (x) => { x.fields[0].targetRefs[0].sheet = 'invented' },
    (x) => { x.fields[0].basis[0].sourceId = 'invented' },
    (x) => { x.fields[0].basis[0].quote = 'all missing values are zero' },
    (x) => { x.fields[0].category = 'auto' },
    (x) => { x.fields[0].applicability = 'automatic' },
    (x) => { x.fields.push(structuredClone(x.fields[0])) },
    (x) => { x.fields = [] },
    (x) => { x.defaultCoefficient = 1 },
  ]) {
    const candidate = requirements(); mutate(candidate)
    assert.equal(bindTemplateRequirements(candidate, profile(), knowledge).ok, false, JSON.stringify(candidate))
  }
})

test('incomplete template coverage and unresolved requirements cannot become a ready collection contract', async () => {
  const { bindTemplateRequirements } = await domain()
  const incomplete = profile(); incomplete.coverage = { complete: false, issues: ['cell limit reached'] }
  assert.equal(bindTemplateRequirements(requirements(), incomplete, knowledge).ok, false)
  const pending = requirements(); pending.questions = [{ field: 'building-area', prompt: '面积口径尚未确认' }]
  const result = bindTemplateRequirements(pending, profile(), knowledge)
  assert.equal(result.ok, false)
  assert.match(result.gaps.join(' '), /面积口径/)
})

test('template analysis receives actual cell facts through a strict isolated operation without business tools', async () => {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: requirements() }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const inference = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent-fixture' } })
  const result = await inference.infer(createWorkflowInferenceRequest({ stage: 'plan', operation: 'template-analysis',
    facts: { templateProfile: profile() }, knowledge: [] }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs, requirements())
  const request = runtime.calls.starts[0].request
  assert.equal(request.outputSchema.additionalProperties, false)
  assert.deepEqual(request.toolFilter, { allow: [] })
})

test('inspection admits only a live actor, registered plan and Host-resolved template identity before IO', async () => {
  const loaded = await import('../../../src/host/integrations/valuation-workflow/services/template-inspection.ts').catch(() => null)
  assert.equal(typeof loaded?.inspectWorkflowTemplate, 'function', 'a scoped read-only template inspection service is required')
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'fixture-project', projectId: 'fixture-project', sessionId: 'fixture-parent',
    parentSessionId: 'fixture-parent', casePath: '/synthetic/case', workspaceId: 'fixture-workspace',
    workspacePath: '/synthetic', planIds: ['fixture-plan'], openedAt: 1,
    snapshot: { valuationId: 'fixture-project', method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:fixture', files: [], frozenAt: '2026-10-19' } })
  const calls = []
  const deps = { valuationScopes: scopes, ctx: { get: () => { calls.push('fs'); throw Error('unexpected IO') } },
    config: {}, world: { platform: async () => { calls.push('platform'); return 'darwin-arm64' } },
    access: { runShell: async () => { calls.push('shell'); throw Error('unexpected IO') } },
    python: { check: async () => { calls.push('python'); return { ok: false } } },
    resolveTemplate: () => undefined }
  const principal = { sessionId: 'fixture-parent', caseDir: '/synthetic/case', source: 'workflow-runtime' }
  for (const [input, actor] of [
    [{ planId: 'fixture-plan', templateId: 'unknown' }, principal],
    [{ planId: '../other', templateId: 'unknown' }, principal],
    [{ planId: 'fixture-plan', templateId: 'unknown' }, { ...principal, sessionId: 'foreign' }],
    [{ planId: 'fixture-plan', templateId: 'unknown', relativePath: '/private/secret.xlsx' }, principal],
  ]) {
    assert.equal((await loaded.inspectWorkflowTemplate(input, deps, actor)).ok, false)
    assert.deepEqual(calls, [])
  }
})

test('template requirements reject malformed and ambiguous proposals without mutating inputs', async () => {
  const { bindTemplateRequirements } = await domain()
  for (const value of [null, [], {}, { ...requirements(), version: 0 },
    { ...requirements(), fields: [null] }, { ...requirements(), questions: [{}] }]) {
    assert.equal(bindTemplateRequirements(value, profile(), knowledge).ok, false)
  }
  for (const mutate of [
    (x) => { x.fields[0].criticalFor = ['automatic'] },
    (x) => { x.fields[0].basis = [] },
    (x) => { x.fields[0].targetRefs.push({ sheet: '候选', cell: 'B2' }) },
    (x) => { x.fields[0].applicability = 'pending' },
    (x) => { x.fields[0].targetRefs[0].cell = '$B$2' },
    (x) => { x.fields[0].defaultCoefficient = 1 },
  ]) {
    const candidate = requirements(); mutate(candidate)
    const original = structuredClone(candidate)
    assert.equal(bindTemplateRequirements(candidate, profile(), knowledge).ok, false)
    assert.deepEqual(candidate, original)
  }
})

test('template analysis rejects malformed nested output and carries real cell facts in its prompt', async () => {
  for (const mutate of [
    (x) => { x.fields[0].defaultCoefficient = 1 },
    (x) => { x.questions = [{}] },
    (x) => { x.fields = [] },
  ]) {
    const output = requirements(); mutate(output)
    const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
      run: createSubagentRun({ structured: output }),
    })
    const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
    const inference = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent-fixture' } })
    const result = await inference.infer(createWorkflowInferenceRequest({ stage: 'plan', operation: 'template-analysis',
      facts: { templateProfile: profile() }, knowledge: [] }))
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(runtime.calls.starts[0].request.prompt), /建筑面积/)
    assert.match(JSON.stringify(runtime.calls.starts[0].request.prompt), /template-analysis/)
  }
})

async function inspectionFixture() {
  const service = await import('../../../src/host/integrations/valuation-workflow/services/template-inspection.ts')
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'fixture-project', projectId: 'fixture-project', sessionId: 'fixture-parent',
    casePath: '/synthetic/case', workspaceId: 'fixture-workspace', workspacePath: '/synthetic',
    planIds: ['fixture-plan'], openedAt: 1, snapshot: { valuationId: 'fixture-project', method: 'market',
      baseDate: '', supplementalPrompt: '', digest: 'sha256:fixture', files: [], frozenAt: '2026-10-19' } })
  const calls = []
  const stagedFiles = new Map()
  const registered = { templateId: profile().templateId, digest: profile().digest, relativePath: profile().relativePath }
  const response = { ok: true, profile: profile() }; delete response.profile.relativePath
  const deps = {
    valuationScopes: scopes, config: {}, resolveTemplate: () => registered,
    python: { check: async () => { calls.push('python'); return { ok: true, path: '/synthetic/python', state: 'ready' } } },
    world: { platform: async () => { calls.push('platform'); return 'darwin-arm64' } },
    ctx: { get: () => ({
      resolve: async (path) => ({ targetKey: path }),
      writeText: async (target, content) => { calls.push(['write', target.targetKey]); stagedFiles.set(target.targetKey, content) },
      readText: async (target) => stagedFiles.get(target.targetKey),
    }) },
    access: { authorize: () => ({ ok: true }), runShell: async (call, command) => {
      calls.push(['shell', call, command]); return { ok: true, exitCode: 0, stdout: JSON.stringify(response) }
    } },
  }
  const principal = { sessionId: 'fixture-parent', caseDir: '/synthetic/case', source: 'workflow-runtime' }
  const inspect = () => service.inspectWorkflowTemplate({ planId: 'fixture-plan', templateId: registered.templateId }, deps, principal)
  return { scopes, calls, registered, response, deps, principal, inspect }
}

test('authorized inspection probes Python, stages only its script and binds a read-only receipt', async () => {
  const f = await inspectionFixture()
  const result = await f.inspect()
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.profile, profile())
  assert.equal(f.calls[0], 'python')
  assert.deepEqual(f.calls.filter(Array.isArray).map((call) => call[0]), ['write', 'shell'])
  assert.equal(f.calls.find((call) => call[0] === 'write')[1], '/synthetic/case/scripts/inspect_template.py')
  const shell = f.calls.find((call) => call[0] === 'shell')
  assert.equal(shell[1].operation, 'python.script.run')
  for (const arg of ['--case-root', '--expected-sha256', '--template-id']) assert.ok(shell[2].includes(arg))
})

test('inspection rejects unsafe registered paths, missing runtime and changed or revoked receipts', async () => {
  for (const path of ['/private/secret.xlsx', '../other.xlsx', 'C:\\private\\secret.xlsx', 'a/../b.xlsx']) {
    const f = await inspectionFixture(); f.registered.relativePath = path
    assert.equal((await f.inspect()).ok, false)
    assert.deepEqual(f.calls, [])
  }
  const missing = await inspectionFixture()
  missing.deps.python.check = async () => { missing.calls.push('python'); return { ok: false, state: 'missing-package' } }
  assert.equal((await missing.inspect()).errorKind, 'capability-gap')
  assert.deepEqual(missing.calls, ['python'])
  for (const mutate of [
    (f) => { f.response.profile.digest = `sha256:${'b'.repeat(64)}` },
    (f) => { f.response.profile.sheets = [] },
    (f) => { f.scopes.close('fixture-project') },
    (f) => { f.registered.digest = `sha256:${'b'.repeat(64)}` },
  ]) {
    const f = await inspectionFixture()
    const shell = f.deps.access.runShell
    f.deps.access.runShell = async (...args) => { mutate(f); return shell(...args) }
    assert.equal((await f.inspect()).ok, false)
  }
  const secret = await inspectionFixture()
  secret.deps.access.runShell = async () => { throw Error('Bearer synthetic-private-token') }
  const failure = await secret.inspect()
  assert.equal(failure.ok, false)
  assert.doesNotMatch(JSON.stringify(failure), /Bearer|synthetic-private-token/)
})

test('inspection checks local access before Python or staging and rechecks scope after asynchronous probes', async () => {
  const denied = await inspectionFixture()
  denied.deps.access.authorize = () => ({ ok: false, error: 'Bearer synthetic-private-token' })
  const result = await denied.inspect()
  assert.equal(result.ok, false)
  assert.deepEqual(denied.calls, [])
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-token/)
  for (const mutate of [
    (f) => f.scopes.close('fixture-project'),
    (f) => { f.registered.digest = `sha256:${'b'.repeat(64)}` },
    (f) => { f.deps.access.authorize = () => ({ ok: false }) },
  ]) {
    const f = await inspectionFixture()
    f.deps.python.check = async () => { f.calls.push('python'); mutate(f); return { ok: true, path: '/synthetic/python' } }
    assert.equal((await f.inspect()).ok, false)
    assert.deepEqual(f.calls, ['python'])
  }
})

test('inspection admits profiles larger than shell defaults and reports truncated coverage explicitly', async () => {
  const f = await inspectionFixture()
  f.response.profile.sheets[0].rows = 1000
  f.response.profile.cells = Array.from({ length: 1000 }, (_, i) => ({ sheet: '候选', cell: `A${i + 1}`, value: '模板字段', formula: '' }))
  const payload = JSON.stringify(f.response)
  assert.ok(Buffer.byteLength(payload) > 65_536)
  f.deps.access.runShell = async (_call, _command, options) => ({ ok: true, exitCode: 0,
    stdout: Buffer.from(payload).subarray(0, options.stdoutMaxBytes ?? 65_536).toString(),
    truncated: Buffer.byteLength(payload) > (options.stdoutMaxBytes ?? 65_536) })
  assert.equal((await f.inspect()).ok, true)
  f.deps.access.runShell = async () => ({ ok: true, exitCode: 0, truncated: true, stdout: payload })
  const truncated = await f.inspect()
  assert.equal(truncated.ok, false)
  assert.match(truncated.error, /截断|上限/)
})
