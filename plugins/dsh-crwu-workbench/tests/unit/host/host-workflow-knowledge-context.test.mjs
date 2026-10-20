import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeDigest } from '../../../src/host/domains/report-evaluation/knowledge/snapshot.ts'
import { parseWikiLinks } from '../../../src/host/domains/report-evaluation/knowledge/wiki-links.ts'

test('production source selection keeps the requested method separate from reference mode and carries the actual material body', async () => {
  const module = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  assert.equal(typeof module.buildWorkflowKnowledgeSelectionRequest, 'function')
  const body = '[通用流程](流程.adoc)'
  const entrySource = { sourceId: 'wiki:合成/入口.adoc', spaceName: '合成业务库', path: '合成/入口.adoc',
    body, digest: knowledgeDigest(body), kind: 'prose' }
  const material = { materialId: 'synthetic-pdf', fileName: '合成.pdf', digest: 'sha256:synthetic', text: '规划用途：公寓；建筑面积86.4㎡' }
  const request = { runId: 'synthetic-run', revision: 1, stage: 'elements', objectId: 'synthetic-object', mode: '',
    wikiPaths: [], knownSourceDigests: [], userInput: '估值方法：市场法（market）', materials: [material],
    object: { objectId: 'synthetic-object', useLabel: '', areaSqm: null }, assetType: 'realestate', purpose: '', baseDate: '',
    promptSupplement: '保持原始规划用途' }
  const packet = module.buildWorkflowKnowledgeSelectionRequest({ request, entrySource,
    allowedLinks: parseWikiLinks(body, entrySource.path), methodRequest: 'market' })
  assert.equal(packet.operation, 'knowledge-selection')
  assert.deepEqual(packet.materials, [material])
  assert.equal(packet.facts.userInput, request.userInput)
  assert.equal(packet.facts.methodRequest, 'market')
  assert.equal(packet.facts.mode, '')
  assert.equal(packet.facts.assetType, 'realestate')
  assert.equal(packet.facts.purpose, '')
  assert.equal(packet.facts.baseDate, '')
  assert.equal(packet.facts.promptSupplement, request.promptSupplement)
  assert.equal(packet.facts.stage, 'elements')
  assert.deepEqual(packet.facts.applicableRoles, ['common'])
  packet.materials[0].text = 'MUTATION'
  assert.equal(material.text, '规划用途：公寓；建筑面积86.4㎡')
})

test('native knowledge selection carries the canonical original choices and never replaces an unknown method', async () => {
  const { buildWorkflowKnowledgeSelectionRequest } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const { createSubagentRuntime, createSubagentProvider, createSubagentRun, createInferenceContext } =
    await import('../../helpers/valuation-workflow-fixture.mjs')
  const body = '[通用流程](流程.adoc)'
  const entrySource = { sourceId: 'wiki:合成/入口.adoc', spaceName: '合成业务库', path: '合成/入口.adoc',
    body, digest: knowledgeDigest(body), kind: 'prose' }
  const original = { userInput: 'synthetic original scope', assetType: 'real-estate', methodRequest: null, purpose: null,
    baseDate: null, valueType: 'synthetic-original-value-marker', templateFileId: null, supplementalPrompt: '', inputDigest: null,
    files: [{ fileId: 'm1', fileName: 'synthetic.txt', relativePath: '资料/synthetic.txt', digest: 'sha256:synthetic' }] }
  const request = { runId: 'synthetic-run', revision: 1, stage: 'elements', objectId: 'synthetic-object', mode: '',
    wikiPaths: [], knownSourceDigests: [], userInput: 'synthetic current scope', materials: [], initialInput: original }
  const packet = buildWorkflowKnowledgeSelectionRequest({ request, entrySource,
    allowedLinks: parseWikiLinks(body, entrySource.path), methodRequest: 'market' })
  assert.deepEqual(packet.facts.initialInput, original)
  assert.equal(packet.facts.methodRequest, null)
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ structured: { entryDigest: entrySource.digest,
      selections: [{ path: '合成/流程.adoc', role: 'common', quote: body }], questions: [] } }),
  })
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'synthetic-parent' } })
  assert.equal((await adapter.infer(packet)).ok, true)
  assert.ok(runtime.calls.starts[0].request.prompt.some((block) => block.text?.includes('synthetic-original-value-marker')))
  packet.facts.initialInput.files[0].fileName = 'changed by adapter'
  assert.equal(original.files[0].fileName, 'synthetic.txt')
})

test('the native selector receives exact navigation quotations and a correction bound to the same root', async () => {
  const { buildWorkflowKnowledgeSelectionRequest } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  const body = '先读[输入](<通用/输入.md>)，整理本轮材料。\n| 方法 | [市场法](市场法.md) | 核对适用条件 |\n[外部](https://example.invalid)'
  const entrySource = { sourceId: 'wiki:synthetic-root', spaceName: '合成库', path: '合成/入口.md',
    body, digest: knowledgeDigest(body), kind: 'prose' }
  const request = { runId: 'synthetic-run', revision: 2, stage: 'plan', objectId: 'synthetic-object', mode: '',
    wikiPaths: [], knownSourceDigests: [], userInput: 'synthetic current scope', materials: [] }
  const packet = buildWorkflowKnowledgeSelectionRequest({ request, entrySource,
    allowedLinks: parseWikiLinks(body, entrySource.path).filter((l) => l.kind === 'knowledge'),
    correction: { error: 'synthetic-quote-correction-same-root' } })
  assert.deepEqual(packet.facts.navigationQuotes, [
    { path: '合成/通用/输入.md', quote: body.split('\n')[0] },
    { path: '合成/市场法.md', quote: body.split('\n')[1] },
  ])
  assert.deepEqual(packet.facts.selectionCorrection, { error: 'synthetic-quote-correction-same-root' })
  assert.equal(packet.facts.entryDigest, entrySource.digest)
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const { createSubagentRuntime, createSubagentProvider, createSubagentRun, createInferenceContext } =
    await import('../../helpers/valuation-workflow-fixture.mjs')
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, { run: createSubagentRun({ structured: {
    entryDigest: entrySource.digest, selections: [{ path: '合成/市场法.md', role: 'method', quote: body.split('\n')[1] }], questions: [],
  } }) })
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'synthetic-parent' } })
  assert.equal((await adapter.infer(packet)).ok, true)
  const prompt = runtime.calls.starts[0].request.prompt.map((b) => b.text ?? '').join('\n')
  const facts = JSON.parse(prompt.split('\n').find((line) => line.startsWith('已确认事实：')).slice('已确认事实：'.length))
  assert.deepEqual(facts.navigationQuotes, packet.facts.navigationQuotes)
  assert.equal(facts.selectionCorrection.error, 'synthetic-quote-correction-same-root')
})
