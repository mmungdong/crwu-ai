import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { startChild } from '../../../src/host/domains/report-audit/spawn.ts'
import { REQUIRED_AUDIT_CHILD_TOOLS } from '../../../src/host/tools/report-audit/consts.ts'

const DENIED = ['crwu_h3yun_record_get', 'crwu_h3yun_files_list', 'crwu_audit_case_bootstrap']

test('activation restrictions use the installed SDK scope for visibility and execution', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const tools = new ToolRuntime(ctx)
  let executions = 0
  const parent = { id: 'parent', session: { header: { id: 'parent' } } }
  const agents = new Map([[parent.id, parent]])
  ctx.provide('agents', { get: (id) => agents.get(id) })
  for (const name of [...DENIED, ...REQUIRED_AUDIT_CHILD_TOOLS]) {
    tools.register({
      name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      async execute() { executions += 1; return {} },
    })
  }
  ctx.provide('subagents', {
    list: () => ['spawn'],
    getProvider: () => ({ prepareContinuable() {}, capabilities: { agentPreset: true } }),
    async startActivation(spec) {
      const child = {
        id: spec.childId, status: 'running',
        session: { header: { id: spec.childId, parentSession: parent.id } },
      }
      const scope = createScope(ctx, child)
      child.ctx = scope.ctx
      agents.set(child.id, child)
      await ctx.serial(scopeTarget(child, child), 'agent/created', { agent: child })
      for (const name of DENIED) assert.equal(tools.get(name, child), undefined)
      return {
        childId: child.id, result: new Promise(() => {}),
        async dispose() { agents.delete(child.id); await scope.dispose() },
      }
    },
  })
  try {
    const result = await startChild(ctx, { label: 'audit', prompt: 'test', parentSessionId: parent.id })
    assert.equal(result.ok, true, result.error)
    const child = result.localAgent
    const schemas = tools.schemas(child).map((schema) => schema.name)
    for (const name of DENIED) {
      assert.equal(schemas.includes(name), false)
      const outcome = await tools.execute({
        callId: `call-${name}`, name, arguments: {}, agent: child, signal: new AbortController().signal,
      })
      assert.equal(outcome.isError, true)
      assert.ok(tools.get(name, parent), 'parent visibility must remain intact')
    }
    assert.equal(executions, 0, 'denied calls must never enter tool bodies')
    for (const name of REQUIRED_AUDIT_CHILD_TOOLS) assert.equal(schemas.includes(name), true)
    result.handle.abort()
    await result.handle.run.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})
