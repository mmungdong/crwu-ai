import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const load = () => import('../../../src/host/integrations/valuation-workflow/visual.ts')
async function fixture(t, modalities = ['text', 'image']) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-workflow-visual-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const casePath = join(root, 'case')
  const relative = '提取-权证-pages/第1页-图1.png'
  await mkdir(join(casePath, '提取结果', '提取-权证-pages'), { recursive: true })
  await writeFile(join(casePath, '提取结果', relative), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJtkAAAAASUVORK5CYII=', 'base64'))
  const calls = { admissions: [], inference: [], probes: [] }
  const parentAgent = { id: 'parent', options: { provider: 'fixture', model: 'vision' } }
  const ctx = { get: (name) => name === 'llm' ? {
    resolveModelInfo: async (...args) => { calls.probes.push(args); return { provider: 'fixture', id: 'vision', ...(modalities === null ? {} : { inputModalities: modalities }) } },
  } : name === 'attachments' ? {
    saveImage: async (input) => { calls.admissions.push(input); return { attachmentId: 'actual-image', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 } },
  } : undefined }
  const inference = { infer: async (input) => {
    calls.inference.push(input)
    return { ok: true, sessionId: 'actual-visual-session', outputs: { pages: [{ index: 1, text: '规划用途：公寓；建筑面积：86.4平方米；套内建筑面积：68.2平方米', uncertainties: [] }] } }
  } }
  const extracted = { fileName: '权证.pdf', fileType: 'pdf', text: '', tables: [], images: [{ path: relative, description: '权证.pdf#第1页图片#1' }], extractedFields: {}, warnings: [], capabilityGaps: ['第1页无文本层'], pageCount: 1, pagesWithoutText: 1, pages: [{ index: 1, hasTextLayer: false, chars: 0 }] }
  const input = { casePath, materialId: 'material-a', digest: 'sha256:source', fileName: '权证.pdf', extracted, signal: new AbortController().signal }
  const { createDshWorkflowVisualReader } = await load()
  return { reader: createDshWorkflowVisualReader({ ctx, parentAgent, inference }), calls, input, root, parentAgent, inference }
}

test('a scanned page is admitted as an actual image and returns traceable reading coverage', async (t) => {
  const f = await fixture(t)
  const result = await f.reader.read(f.input)
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /规划用途：公寓/)
  assert.deepEqual(result.readPages, [1])
  assert.ok(result.sessionIds.includes('actual-visual-session'))
  assert.equal(f.calls.probes.length, 1)
  assert.equal(f.calls.admissions.length, 1)
  assert.equal(f.calls.inference[0].operation, 'page-reading')
  assert.equal(f.calls.inference[0].images[0].attachmentId, 'actual-image')
  assert.ok(!JSON.stringify(f.calls.inference[0].facts).includes(f.input.casePath))
})

test('explicitly text-only models stop before attachment admission or visual inference', async (t) => {
  const f = await fixture(t, ['text'])
  const result = await f.reader.read(f.input)
  assert.equal(result.ok, false)
  assert.equal(f.calls.admissions.length, 0)
  assert.equal(f.calls.inference.length, 0)
})

test('undisclosed model modalities use actual page reading rather than being treated as text-only', async (t) => {
  const f = await fixture(t, null)
  const result = await f.reader.read(f.input)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.readPages, [1])
  assert.match(result.text, /建筑面积：86.4平方米/)
  assert.equal(f.calls.inference.length, 1)
  assert.equal(f.calls.inference[0].images[0].attachmentId, 'actual-image')
  assert.ok(result.uncertainties.some(item => item.includes('未披露')))
})

test('an undisclosed model with no actual reading never receives page coverage', async (t) => {
  const f = await fixture(t, null)
  f.inference.infer = async input => { f.calls.inference.push(input); return { ok: false, errorKind: 'failed' } }
  const result = await f.reader.read(f.input)
  assert.equal(f.calls.inference.length, 1)
  assert.equal(result.ok, false)
  assert.equal(result.text, '')
  assert.deepEqual(result.readPages, [])
})

test('an image locator cannot escape the case or substitute an external symlink', async (t) => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside.png')
  await writeFile(outside, 'external')
  const link = join(f.input.casePath, '提取结果', '提取-权证-pages', '第1页-图2.png')
  try { await symlink(outside, link) } catch (error) { if (error.code === 'EPERM') { t.skip('platform symlink permissions'); return } throw error }
  for (const path of ['../../outside.png', '提取-权证-pages/第1页-图2.png',
    join(f.input.casePath, '提取结果', '提取-权证-pages/第1页-图1.png'),
    '提取-权证-pages/../提取-权证-pages/第1页-图1.png']) {
    f.input.extracted.images[0].path = path
    assert.equal((await f.reader.read(f.input)).ok, false)
  }
  assert.equal(f.calls.admissions.length, 0)
  assert.equal(f.calls.inference.length, 0)
})

test('page reading sends actual image content through the existing isolated inference adapter', async () => {
  const { createSubagentRuntime, createSubagentRun, createSubagentProvider, createInferenceContext, createWorkflowInferenceRequest } =
    await import('../../helpers/valuation-workflow-fixture.mjs')
  const output = { pages: [{ index: 1, text: '规划用途：公寓', uncertainties: [] }] }
  const runtime = createSubagentRuntime({ spawn: createSubagentProvider('spawn') }, {
    run: createSubagentRun({ id: 'actual-page-session', structured: output }),
  })
  const { createDshWorkflowInference } = await import('../../../src/host/integrations/valuation-workflow/inference.ts')
  const adapter = createDshWorkflowInference({ ctx: createInferenceContext(runtime), parentAgent: { id: 'parent' } })
  const ref = { attachmentId: 'admitted-image', mediaType: 'image/png', bytes: 99, width: 10, height: 10 }
  const result = await adapter.infer(createWorkflowInferenceRequest({ operation: 'page-reading', images: [ref], facts: { pageIndexes: [1] } }))
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.outputs, output)
  const request = runtime.calls.starts[0].request
  assert.deepEqual(request.prompt.find((block) => block.type === 'image').attachment, ref)
  assert.deepEqual(request.toolFilter, { allow: [] })
  assert.equal(request.outputSchema.additionalProperties, false)
})


test('visual capability follows the parent current request route after a model switch', async (t) => {
  const f = await fixture(t)
  f.parentAgent.session = { requestHeader: () => ({ config: { provider: 'current-provider', model: 'current-vision-model' } }) }
  assert.equal((await f.reader.read(f.input)).ok, true)
  assert.deepEqual(f.calls.probes[0].slice(0, 2), ['current-provider', 'current-vision-model'])
})

test('duplicate or unrequested page results never become verified reading coverage', async (t) => {
  const f = await fixture(t)
  const page = { index: 1, text: '合成判读文字', uncertainties: [] }
  for (const pages of [[page, page], [page, { ...page, index: 999 }]]) {
    f.inference.infer = async () => ({ ok: true, sessionId: 'actual-session', outputs: { pages } })
    const result = await f.reader.read(f.input)
    assert.equal(result.ok, false, 'ambiguous page attribution must be refused')
    assert.deepEqual(result.readPages, [])
  }
})

test('an unknown child stop halts the visual batch and preserves its actual session identity', async (t) => {
  const f = await fixture(t)
  const second = '提取-权证-pages/第2页-图1.png'
  await writeFile(join(f.input.casePath, '提取结果', second), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJtkAAAAASUVORK5CYII=', 'base64'))
  f.input.extracted.images.push({ path: second, description: '权证.pdf#第2页图片#1' })
  let count = 0
  f.inference.infer = async () => { count += 1; return { ok: false, errorKind: 'stop-unknown', sessionId: 'unknown-child' } }
  const result = await f.reader.read(f.input)
  assert.equal(count, 1, 'no replacement child may start while the previous one could still run')
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'stop-unknown')
  assert.deepEqual(result.sessionIds, ['unknown-child'])
})

test('an already cancelled visual read performs no model probe or image admission', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  const result = await f.reader.read({ ...f.input, signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'cancelled')
  assert.equal(f.calls.probes.length, 0)
  assert.equal(f.calls.admissions.length, 0)
})

test('unknown child quiescence takes priority over the cancellation that triggered disposal', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.inference.infer = async () => {
    controller.abort()
    return { ok: false, errorKind: 'stop-unknown', sessionId: 'cancelled-but-running' }
  }
  const result = await f.reader.read({ ...f.input, signal: controller.signal })
  assert.equal(result.errorKind, 'stop-unknown')
  assert.deepEqual(result.sessionIds, ['cancelled-but-running'])
})
