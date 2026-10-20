import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { VALUATION_TOOL_NAMES } from '../../../src/host/tools/report-evaluation/consts.ts'

const load = () => import('../../../src/host/integrations/valuation-workflow/execution.ts')

function fixture(execute = async () => ({ isError: false, value: { ok: true, cases: [] }, content: [] })) {
  const scopes = new ValuationScopes()
  const scope = {
    valuationId: 'project', projectId: 'project', casePath: '/workspace/project', sessionId: 'parent',
    parentSessionId: 'parent', workspaceId: 'w1', workspacePath: '/workspace', openedAt: 1,
    planIds: ['reference-1'],
    snapshot: { valuationId: 'project', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:fixture', files: [], frozenAt: '2026-10-17T00:00:00Z' },
  }
  scopes.open(scope)
  const calls = []
  const runtime = { execute: async (request) => { calls.push(request); return execute(request) } }
  const exec = {
    agent: { id: 'parent', session: { id: 'parent' } }, token: Symbol('registry-owned-test-token'),
    callId: ToolCallId('outer-call'), rootCallId: ToolCallId('root-call'), signal: new AbortController().signal,
    deferContext() {}, concludeTurn() {},
  }
  return { deps: { ctx: { get: (name) => name === 'tools' ? runtime : undefined }, valuationScopes: scopes }, exec, scope, scopes, calls }
}

test('workflow business dispatch uses the official runtime with the genuine outer execution identity', async () => {
  const f = fixture()
  const { createWorkflowToolDispatcher } = await load()
  const dispatcher = createWorkflowToolDispatcher(f.deps, f.exec)
  const args = { caseDir: f.scope.casePath, planId: 'reference-1', keyword: '合成公寓', city: '合成市' }
  const result = await dispatcher.dispatch(VALUATION_TOOL_NAMES.marketSearch, args)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { ok: true, cases: [] })
  assert.equal(f.calls.length, 1)
  const request = f.calls[0]
  assert.equal(request.parent, f.exec.token)
  assert.equal(request.rootCallId, f.exec.rootCallId)
  assert.equal(request.agent, f.exec.agent)
  assert.notEqual(request.callId, f.exec.callId)
  assert.equal(request.name, VALUATION_TOOL_NAMES.marketSearch)
  assert.deepEqual(request.arguments, args)
  assert.ok(request.signal instanceof AbortSignal)
})

test('the graph can materialize the exact knowledge template only under its registered plan', async () => {
  const f = fixture()
  const { createWorkflowToolDispatcher } = await load()
  const dispatcher = createWorkflowToolDispatcher(f.deps, f.exec)
  const args = { caseDir: f.scope.casePath, planId: 'reference-1', method: 'market', wikiPath: '模板/已核验计算表.xlsx' }
  const result = await dispatcher.dispatch(VALUATION_TOOL_NAMES.templateMaterialize, args)
  assert.equal(result.ok, true, result.error)
  assert.equal(f.calls[0].name, VALUATION_TOOL_NAMES.templateMaterialize)
  assert.equal(f.calls[0].parent, f.exec.token)
  assert.equal((await dispatcher.dispatch(VALUATION_TOOL_NAMES.templateMaterialize, { ...args, planId: 'foreign' })).ok, false)
  assert.equal(f.calls.length, 1)
})

test('unknown callers, foreign cases, unregistered plans and arbitrary tools never dispatch', async () => {
  const { createWorkflowToolDispatcher } = await load()
  for (const [alter, name, args] of [
    [(f) => { f.exec.agent.id = 'unknown' }, VALUATION_TOOL_NAMES.marketSearch, { caseDir: '/workspace/project', planId: 'reference-1' }],
    [() => {}, VALUATION_TOOL_NAMES.marketSearch, { caseDir: '/workspace/other', planId: 'reference-1' }],
    [() => {}, VALUATION_TOOL_NAMES.marketSearch, { caseDir: '/workspace/project', planId: 'foreign-plan' }],
    [() => {}, 'run_shell', { cmd: 'untrusted' }],
    [(f) => { delete f.exec.token }, VALUATION_TOOL_NAMES.marketSearch, { caseDir: '/workspace/project', planId: 'reference-1' }],
  ]) {
    const f = fixture()
    alter(f)
    const result = await createWorkflowToolDispatcher(f.deps, f.exec).dispatch(name, args)
    assert.equal(result.ok, false)
    assert.equal(f.calls.length, 0)
  }
})

test('a closed scope cannot be reused by a captured dispatcher', async () => {
  const f = fixture()
  const { createWorkflowToolDispatcher } = await load()
  const dispatcher = createWorkflowToolDispatcher(f.deps, f.exec)
  f.scopes.close('project')
  assert.equal((await dispatcher.dispatch(VALUATION_TOOL_NAMES.marketSearch, { caseDir: f.scope.casePath, planId: 'reference-1' })).ok, false)
  assert.equal(f.calls.length, 0)
})

test('completed dispatches release cancellation listeners from the parent signal', async () => {
  const f = fixture()
  const { createWorkflowToolDispatcher } = await load()
  const dispatcher = createWorkflowToolDispatcher(f.deps, f.exec)
  for (let n = 0; n < 4; n += 1) {
    await dispatcher.dispatch(VALUATION_TOOL_NAMES.marketSearch, { caseDir: f.scope.casePath, planId: 'reference-1' })
  }
  assert.equal(getEventListeners(f.exec.signal, 'abort').length, 0)
})

test('runtime exceptions are sanitized and cancelled dispatch cannot publish a late success', async () => {
  const { createWorkflowToolDispatcher } = await load()
  const failed = fixture(async () => { throw new Error('synthetic-private-runtime-token') })
  const result = await createWorkflowToolDispatcher(failed.deps, failed.exec)
    .dispatch(VALUATION_TOOL_NAMES.marketSearch, { caseDir: failed.scope.casePath, planId: 'reference-1' })
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-runtime-token/)
  let finish
  const f = fixture(async () => new Promise((resolve) => { finish = resolve }))
  const abort = new AbortController()
  const pending = createWorkflowToolDispatcher(f.deps, f.exec)
    .dispatch(VALUATION_TOOL_NAMES.marketSearch, { caseDir: f.scope.casePath, planId: 'reference-1' }, abort.signal)
  await new Promise((resolve) => setTimeout(resolve, 0))
  abort.abort()
  assert.equal(f.calls[0].signal.aborted, true)
  finish({ isError: false, value: { ok: true }, content: [] })
  const late = await pending
  assert.equal(late.ok, false)
  assert.equal(late.errorKind, 'cancelled')
})
