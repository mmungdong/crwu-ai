import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

const load = () => import('../../../src/host/tools/report-evaluation/workflow.ts')

function execution() {
  let conclusions = 0
  return {
    context: { token: Symbol('actual-execution'), rootCallId: 'actual-root',
      agent: { id: 'actual-parent', session: { id: 'actual-parent' } },
      signal: new AbortController().signal, concludeTurn: () => { conclusions += 1 } },
    conclusions: () => conclusions,
  }
}

test('the workflow control tool forwards the genuine execution and concludes at the graph pause', async () => {
  const { valuationWorkflowTools } = await load()
  const exec = execution()
  const calls = []
  const tools = valuationWorkflowTools({ workflowRuntime: { execute: async (...args) => {
    calls.push(args)
    return { ok: true, snapshot: { runId: 'actual-run', revision: 1, status: 'waiting-user' } }
  } } })
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'crwu_valuation_workflow_run')
  assertObjectJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
  assert.equal(tool.parameters.type, 'object', 'the registered SDK tool needs a canonical object schema')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['commandId'], 'no caller-supplied path, prompt, route or tool name')
  assert.deepEqual(tool.parameters.required, ['commandId'])
  assert.equal(tool.parameters.additionalProperties, false)
  const result = await tool.execute({ commandId: 'host-command' }, exec.context)
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.status, 'waiting-user')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'host-command')
  assert.equal(calls[0][1], exec.context)
  assert.equal(exec.conclusions(), 1)
})

test('control tool failure is sanitized and does not leave the outer skill free to repeat the workflow', async () => {
  const { valuationWorkflowTools } = await load()
  const exec = execution()
  const [tool] = valuationWorkflowTools({ workflowRuntime: { execute: async () => {
    throw new Error('Bearer synthetic-private-token')
  } } })
  const result = await tool.execute({ commandId: 'host-command' }, exec.context)
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-token/)
  assert.equal(exec.conclusions(), 1)
})

test('the model render carries bounded status while the canonical result retains the node snapshot', async () => {
  const { valuationWorkflowTools } = await load()
  const exec = execution()
  const [tool] = valuationWorkflowTools({ workflowRuntime: { execute: async () => ({ ok: true,
    snapshot: { runId: 'actual-run', revision: 7, status: 'waiting-user',
      stages: { evidence: { outputs: { sourceText: 'SYNTHETIC_FULL_RECEIPT_DO_NOT_REPEAT' } } } },
  }) } })
  const result = await tool.execute({ commandId: 'host-command' }, exec.context)
  assert.equal(result.snapshot.stages.evidence.outputs.sourceText, 'SYNTHETIC_FULL_RECEIPT_DO_NOT_REPEAT')
  const rendered = tool.output.render({ commandId: 'host-command' }, result)
  assert.doesNotMatch(JSON.stringify(rendered), /SYNTHETIC_FULL_RECEIPT_DO_NOT_REPEAT|stages|sourceText/)
  const status = JSON.parse(rendered[0].text)
  assert.deepEqual(status, { ok: true, errorKind: '', error: '', runId: 'actual-run', revision: 7,
    status: 'waiting-user', waiting: true })
})
