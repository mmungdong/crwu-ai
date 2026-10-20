import assert from 'node:assert/strict'
import test from 'node:test'

const quote = '相似性及可靠性接近的挂牌报价可以取原始单价算术平均，仅供参考，不作修正和折扣。'
const source = { sourceId: 'reference-policy', path: '市场法.adoc', digest: 'sha256:policy', body: quote }
const observations = () => [1, 2].map((index) => ({
  sourceId: `fang:${index}`, caseId: `case-${index}`, unitPrice: 30000 + index * 1000,
  listingKind: 'listing', transactionType: '挂牌', sourceUrl: `https://example.invalid/listing/${index}`,
  capturedAt: '2026-10-17T00:00:00Z', provider: 'fang', community: '合成小区', propertyType: '公寓',
  screenshot: index === 1 ? '推理结果/图片/合成案例.png' : '',
  screenshotDigest: index === 1 ? 'sha256:synthetic-image' : '', screenshotMissing: index !== 1,
}))
const assessments = () => observations().map((sample) => ({ sourceId: sample.sourceId,
  status: 'qualified', reason: '同小区公寓挂牌，面积接近，按知识库作报价参考',
  knowledge: { sourceId: source.sourceId, digest: source.digest, quote } }))
const input = () => ({ projectId: 'project-1', planId: 'plan-1', inputDigest: 'sha256:frozen',
  observations: observations(), assessments: assessments(),
  materials: [{ materialId: 'title-1', fileName: '合成产权证.pdf', digest: 'sha256:material' }],
  request: { runId: 'run-1', revision: 2, objectId: 'object-1', operation: 'listing-reference-mean',
    samples: observations().map(({ sourceId, unitPrice }) => ({ sourceId, unitPrice })), areaSqm: 86.4,
    subject: { useLabel: '公寓', purpose: '测试参考', baseDate: '' }, knowledge: [source],
    assessment: { mode: 'listing-reference', objectId: 'object-1', areaSqm: 86.4, revision: 2,
      retrievalAttempts: [{ provider: 'lianjia', outcome: 'waiting-user', stage: 'search', reason: '合成验证码' }],
      plan: { method: 'market', valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
        digest: 'sha256:approved-plan', revision: 1, accepted: true, ready: true, gaps: [],
        sources: [], basis: [{ sourceId: source.sourceId, quote }], limitations: ['原始公寓用途保留'],
        template: { fileName: '受控参考表.xlsx', relativePath: '模板/受控参考表.xlsx', digest: 'sha256:table',
          verified: true, mapping: [{ field: 'unitPrice', sheet: '估值结果', range: 'B5' }],
          formulaChecks: [{ name: '独立计算', ok: true }] } } } } })
async function build(value) {
  const { buildWorkflowListingPayload } = await import('../../../src/host/domains/report-evaluation/workflow/listing-payload.ts')
  return buildWorkflowListingPayload(value)
}

test('the fixed builder input preserves raw rights, selected observations, knowledge and image identity', async () => {
  const result = await build(input())
  assert.equal(result.ok, true, result.error)
  const data = result.payload
  assert.equal(data.valuationMode, 'listing-reference')
  assert.equal(data.objects.length, 1)
  assert.equal(data.objects[0].propertyType, '公寓')
  assert.equal(Number(data.objects[0].buildingArea), 86.4)
  assert.equal(data.objects[0].valueScope, undefined, 'unknown rights scope must not be invented')
  assert.equal(data.baseDate, null)
  assert.equal(data.purpose, '测试参考')
  assert.equal(data.template.relativePath, input().request.assessment.plan.template.relativePath)
  assert.equal(data.template.digest, input().request.assessment.plan.template.digest)
  assert.equal(data.cases.length, 2)
  assert.equal(Number(data.cases[0].unitPrice), 31000)
  assert.equal(data.cases[0].transactionType, '挂牌')
  assert.equal(data.cases[0].sourceUrl, observations()[0].sourceUrl)
  assert.equal(data.caseEvidence.length, 1)
  assert.equal(data.caseEvidence[0].relativePath, observations()[0].screenshot)
  assert.equal(data.caseEvidence[0].digest, observations()[0].screenshotDigest)
  assert.ok(JSON.stringify(data.knowledgeSources).includes(source.digest))
  assert.ok(JSON.stringify(data.materials).includes('sha256:material'))
  assert.equal(data.retrievalAttempts[0].providerId, 'lianjia')
  assert.equal(data.retrievalAttempts[0].stage, 'search')
  assert.equal(data.retrievalAttempts[0].reasonCode, '合成验证码')
  assert.deepEqual(data.referencePolicy.rounding, { mode: 'half-up', digits: 2 })
})

test('source prices, listing identity and each adopted case assessment must be verifiable', async () => {
  const mutations = [
    (value) => { value.request.samples[0].unitPrice = 99999 },
    (value) => { value.observations[0].listingKind = 'transaction' },
    (value) => { value.assessments = [] },
    (value) => { value.assessments[0].knowledge.quote = '知识库没有这条依据' },
    (value) => { value.assessments[0].knowledge.sourceId = 'unread-source' },
    (value) => { value.assessments[0].knowledge.digest = 'sha256:wrong' },
    (value) => { value.observations[1].sourceUrl = value.observations[0].sourceUrl },
    (value) => { value.request.assessment.plan.accepted = false },
    (value) => { value.request.assessment.plan.algorithm = 'invented-discount' },
  ]
  for (const mutate of mutations) {
    const value = input()
    mutate(value)
    const result = await build(value)
    assert.equal(result.ok, false)
    assert.equal(result.payload, undefined)
  }
})

test('only selected observations are included and a missing screenshot is never synthesized', async () => {
  const value = input()
  value.request.samples = value.request.samples.slice(1)
  value.assessments = value.assessments.slice(1)
  const result = await build(value)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.payload.cases.length, 1)
  assert.equal(result.payload.cases[0].sourceUrl, observations()[1].sourceUrl)
  assert.deepEqual(result.payload.caseEvidence, [])
})

test('evidence inference has an enforceable per-case assessment and requirement shape', async () => {
  const { createInferenceContext, createSubagentProvider, createSubagentRun, createSubagentRuntime,
    createWorkflowInferenceRequest } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const structured = { samples: [{ sourceId: 'fang:1', unitPrice: 31000 }], requirements: [], assessments: assessments() }
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const inference = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const result = await inference.infer(createWorkflowInferenceRequest({ stage: 'evidence' }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs.assessments, assessments())
  const schema = runtime.calls.starts[0].request.outputSchema
  assert.equal(schema.properties.assessments.items.additionalProperties, false)
  assert.equal(schema.properties.requirements.items.additionalProperties, false)
  assert.ok(schema.properties.requirements.items.properties.source)
})
