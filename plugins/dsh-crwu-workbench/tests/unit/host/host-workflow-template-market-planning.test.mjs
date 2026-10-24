import test from 'node:test'
import assert from 'node:assert/strict'
import { plan, profile, source } from '../../helpers/template-market-fixture.mjs'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

test('plan admits only observed templates, allowed providers and source-bound fields without market IO', async () => {
  const module = await import('../../../src/host/integrations/valuation-workflow/production/template-market.ts').catch(() => null)
  assert.equal(typeof module?.bindTemplateMarketPlan, 'function')
  const context = { profiles: [profile()], knowledge: [{ ...source(), body: '取得建筑面积' }], providers: ['lianjia'] }
  const bound = module.bindTemplateMarketPlan(plan(), context)
  assert.equal(bound.ok, true)
  assert.notEqual(bound.plan.digest, plan().digest)
  for (const mutate of [p => { p.template.relativePath = 'unregistered.xlsx' }, p => { p.template.digest = `sha256:${'b'.repeat(64)}` },
    p => { p.providers = ['unknown'] }, p => { p.requirements.fields[0].basis[0].quote = '伪造知识' }, p => { p.shell = 'exec' }]) {
    const bad = plan(); mutate(bad)
    assert.equal(module.bindTemplateMarketPlan(bad, context).ok, false)
  }
})

test('native inference schema uses supported DSH subset and domain retains stricter validation', async () => {
  const module = await import('../../../src/host/integrations/valuation-workflow/template-market-schema.ts').catch(() => null)
  assert.equal(typeof module?.templateMarketInferenceSchema, 'function')
  assert.doesNotThrow(() => assertSupportedJsonSchema(module.templateMarketInferenceSchema('collection-plan')))
  assert.doesNotThrow(() => assertSupportedJsonSchema(module.templateMarketInferenceSchema('materials')))
})

test('location provenance includes accepted cross-node amendments, ordinary supplements and latest notes', async () => {
  const { templateMarketUserContext } = await import('../../../src/host/integrations/valuation-workflow/production/template-market.ts')
  assert.equal(typeof templateMarketUserContext, 'function')
  const { input } = await import('../../helpers/template-market-fixture.mjs')
  const request = input('collection-plan')
  request.initialInput = { userInput: '估价资料', supplementalPrompt: '对象在上海' }
  request.answers = { approval: { kind: 'choice', values: ['amend'], supplement: '小区改为新小区' } }
  request.notes = [{ noteId: 'n', nodeId: 'confirm-plan', text: '检索地点以当前补充为准' }]
  request.upstream['confirm-plan'] = { amendments: '保留我的修改意见' }
  const context = templateMarketUserContext(request, [])
  for (const part of ['上海', '新小区', '检索地点以当前补充为准', '保留我的修改意见']) assert.ok(context.includes(part))
})

test('plan subject is bound to Host identity and verified facts rather than model defaults', async () => {
  const { bindTemplateMarketPlan } = await import('../../../src/host/integrations/valuation-workflow/production/template-market.ts')
  const p = plan(); p.subject = { objectId: 'model-invented', areaSqm: 999, useLabel: '厂房' }
  const subject = { objectId: 'host-object', areaSqm: null, useLabel: '住宅' }
  const result = bindTemplateMarketPlan(p, { profiles: [profile()], knowledge: [{ ...source(), body: '取得建筑面积' }], providers: ['lianjia'], subject })
  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.subject, subject)
})
