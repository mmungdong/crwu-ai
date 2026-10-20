import assert from 'node:assert/strict'
import test from 'node:test'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { createFixturePorts, createStartInput, loadWorkflowService } from '../../helpers/valuation-workflow-fixture.mjs'

async function fixture() {
  const { createValuationWorkflowRuntime } = await import('../../../src/host/integrations/valuation-workflow/runtime.ts')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'project-a', projectId: 'project-a', sessionId: 'parent-a', parentSessionId: 'parent-a',
    casePath: '/workspace/project-a', workspaceId: 'workspace-a', workspacePath: '/workspace', openedAt: 1,
    snapshot: { valuationId: 'project-a', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'frozen', files: [], frozenAt: '2026-10-17' } })
  const f = createFixturePorts()
  const runtime = createValuationWorkflowRuntime({ scopes, createRunner: async () => ({
    service: createValuationWorkflowService(f.ports), startInput: async () => createStartInput({ runId: 'project-a' }),
  }) })
  const agent = { id: 'parent-a', session: { id: 'parent-a' } }
  const exec = { token: Symbol('actual-control'), rootCallId: 'root-control', agent,
    signal: new AbortController().signal }
  const command = runtime.register({ projectId: 'project-a', parentSessionId: 'parent-a' })
  const call = (patch = {}) => ({ callId: 'call-a', token: Symbol('registry-execution'), rootCallId: 'root-control',
    name: 'crwu_valuation_market_search', arguments: {}, agent, signal: exec.signal, ...patch })
  return { ...f, runtime, exec, command, call }
}

test('a workflow parent can only enter the graph control through the official tool pipeline', async () => {
  const f = await fixture()
  assert.equal(typeof f.runtime.guard, 'function')
  assert.equal(typeof f.runtime.guard(f.call()), 'string', 'no direct market call outside Graph')
  assert.equal(typeof f.runtime.guard(f.call({ name: 'bash' })), 'string')
  assert.equal(f.runtime.guard(f.call({ name: 'crwu_valuation_workflow_run' })), undefined)
  assert.equal(f.runtime.guard(f.call({ name: 'run_code' })), undefined, 'PTC transport remains usable; its inner calls are guarded')
  assert.equal(f.runtime.guard(f.call({ agent: { id: 'other', session: { id: 'other' } } })), undefined)
  f.runtime.dispose()
})

test('nested business calls require the exact active control token, agent and root call', async () => {
  const f = await fixture()
  assert.equal(typeof f.runtime.guard, 'function')
  const infer = f.ports.inference.infer
  let inspected = false
  f.ports.inference.infer = async (input) => {
    inspected = true
    assert.equal(f.runtime.guard(f.call({ parent: f.exec.token })), undefined)
    assert.equal(typeof f.runtime.guard(f.call({ parent: Symbol('foreign') })), 'string')
    assert.equal(typeof f.runtime.guard(f.call({ parent: f.exec.token, rootCallId: 'foreign-root' })), 'string')
    assert.equal(typeof f.runtime.guard(f.call({ parent: f.exec.token, agent: { ...f.exec.agent } })), 'string')
    return infer(input)
  }
  await f.runtime.execute(f.command.commandId, f.exec)
  assert.equal(inspected, true)
  assert.equal(typeof f.runtime.guard(f.call({ parent: f.exec.token })), 'string', 'a settled control token is no longer active')
  f.runtime.dispose()
})
