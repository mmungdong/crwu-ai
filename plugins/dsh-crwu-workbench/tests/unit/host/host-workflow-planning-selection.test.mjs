import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
  createWorkflowInferenceRequest,
} from '../../helpers/valuation-workflow-fixture.mjs'

const context = () => ({
  userInput: '',
  materials: [{ materialId: 'material-1', fileName: '合成小区权证.txt', digest: 'sha256:fixture', text: '坐落：北京市朝阳区合成小区；规划用途：公寓' }],
  knowledge: [{ sourceId: 'policy', path: '来源与模板.adoc', digest: 'sha256:policy', body: '参考口径：先尝试链家，失败后可使用房天下、安居客和58同城；范围为房地合一；模板链接：[市场模板](./市场模板.xlsx)' }],
  allowedProviderIds: ['lianjia', 'fang', 'anjuke', 'wuba'],
  allowedTemplatePaths: ['市场模板.xlsx'],
})
const selection = () => ({
  city: '北京市', community: '合成小区', nearbyCommunities: [], valueScope: '房地合一',
  providerOrder: ['lianjia', 'fang', 'anjuke', 'wuba'], templatePath: '市场模板.xlsx',
  basis: [
    { field: 'city', sourceId: 'material-1', quote: '坐落：北京市朝阳区合成小区' },
    { field: 'community', sourceId: 'material-1', quote: '坐落：北京市朝阳区合成小区' },
    { field: 'providerOrder', sourceId: 'policy', quote: '先尝试链家，失败后可使用房天下、安居客和58同城' },
    { field: 'templatePath', sourceId: 'policy', quote: '模板链接：[市场模板](./市场模板.xlsx)' },
    { field: 'valueScope', sourceId: 'policy', quote: '范围为房地合一' },
  ], questions: [],
})

test('planning selection has a strict isolated schema and no free-form plan commentary', async () => {
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: selection() }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const inference = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await inference.infer(createWorkflowInferenceRequest({ stage: 'plan', operation: 'planning-selection', facts: context() }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs, selection())
  const request = runtime.calls.starts[0].request
  assert.equal(request.outputSchema.additionalProperties, false)
  assert.deepEqual(request.toolFilter, { allow: [] })
})

test('a source-bound market query and exact registered template path can be adopted', async () => {
  const { bindWorkflowPlanningSelection } = await import('../../../src/host/domains/report-evaluation/workflow/planning-selection.ts')
  const result = bindWorkflowPlanningSelection(selection(), context())
  assert.equal(result.ok, true, result.error)
  assert.equal(result.selection.community, '合成小区')
  assert.equal(result.selection.city, '北京市')
  assert.deepEqual(result.selection.providerOrder, ['lianjia', 'fang', 'anjuke', 'wuba'])
})

test('invented places, unverified templates and unsupported providers fail before business IO', async () => {
  const { bindWorkflowPlanningSelection } = await import('../../../src/host/domains/report-evaluation/workflow/planning-selection.ts')
  for (const patch of [
    { city: '上海市' }, { community: '虚构小区' }, { nearbyCommunities: ['另一个虚构小区'] },
    { valueScope: '仅建筑物' },
    { templatePath: '猜测目录/市场模板.xlsx' }, { templatePath: 'https://example.invalid/arbitrary.xlsx' },
    { providerOrder: ['unknown-provider'] }, { providerOrder: ['fang', 'fang'] },
    { basis: selection().basis.map((item) => ({ ...item, quote: '没有出现在原文中的依据' })) },
    { unitPrice: 99999 },
  ]) {
    const result = bindWorkflowPlanningSelection({ ...selection(), ...patch }, context())
    assert.equal(result.ok, false, JSON.stringify(patch))
    assert.equal(result.selection, undefined)
  }
})

test('a filename is an explicit community clue and never substitutes for a city source', async () => {
  const { bindWorkflowPlanningSelection } = await import('../../../src/host/domains/report-evaluation/workflow/planning-selection.ts')
  const input = context()
  input.materials[0].text = '坐落：北京市朝阳区某街道；规划用途：公寓'
  const candidate = selection()
  candidate.basis[0].quote = '坐落：北京市朝阳区某街道'
  candidate.basis[1] = { field: 'community', sourceId: 'material-1:file-name', quote: '合成小区权证.txt' }
  const accepted = bindWorkflowPlanningSelection(candidate, input)
  assert.equal(accepted.ok, true, accepted.error)
  candidate.city = '上海市'
  assert.equal(bindWorkflowPlanningSelection(candidate, input).ok, false)
})
