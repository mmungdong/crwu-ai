import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { parseWikiLinks } from '../../../src/host/domains/report-evaluation/knowledge/wiki-links.ts'

const load = () => import('../../../src/host/domains/report-evaluation/knowledge/workflow.ts')
const spaceName = '中瑞世联业务知识库'
const entryWikiPath = '01 估值与测算/01 房地产/wiki.adoc'
const digest = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`
const entryBody = '[通用流程](<../00 通用/流程.md>)\n[挂牌参考](<挂牌参考.md>)\n[案例口径](<案例.md>)\n[成果要求](<成果.md>)'
const links = parseWikiLinks(entryBody, entryWikiPath)
const roles = ['common', 'method', 'evidence', 'output']
const doc = (path, body) => ({ sourceId: `wiki:${path}`, spaceName, path, digest: digest(body), body, kind: 'prose' })
const entry = doc(entryWikiPath, entryBody)
const docs = new Map([
  [entryWikiPath, { source: entry, links }],
  ...links.map((link, index) => [link.path, { source: doc(link.path, `合成测试正文（非真实专业规则）：${roles[index]}。`), links: [] }]),
])
const request = (stage = 'elements', patch = {}) => ({
  runId: 'run-1', revision: 1, stage, objectId: 'object-1', mode: 'listing-reference',
  wikiPaths: [], knownSourceDigests: [], ...patch,
})
function selection(patch = {}) {
  return {
    ok: true, sessionId: 'actual-knowledge-selection', entryDigest: entry.digest,
    selections: links.map((link, index) => ({ path: link.path, role: roles[index], quote: entryBody.split('\n')[index] })),
    questions: [], ...patch,
  }
}
async function fixture(overrides = {}) {
  const { createWorkflowKnowledgeReader } = await load()
  const calls = { loads: [], selections: [] }
  const reader = createWorkflowKnowledgeReader({
    entryWikiPath, spaceName,
    loadDocument: async (path, input) => {
      calls.loads.push({ path, input })
      return (await overrides.loadDocument?.(path, input)) ?? { ok: true, ...docs.get(path) }
    },
    selectSources: async (input) => {
      calls.selections.push(input)
      return overrides.selectSources?.(input) ?? selection()
    },
  })
  return { reader, calls }
}

test('knowledge follows verified resolved links by stage and reuses the same source version', async () => {
  const { reader, calls } = await fixture()
  assert.equal(reader.stageAware, true)
  const first = await reader.read(request())
  assert.equal(first.ok, true, first.error)
  assert.deepEqual(first.sources.map((source) => source.path), [links[0].path])
  assert.deepEqual(calls.loads.map((call) => call.path), [entryWikiPath, links[0].path])
  assert.equal(calls.selections.length, 1)
  assert.equal(calls.selections[0].entrySource.body, entryBody)
  const second = await reader.read(request('plan'))
  assert.equal(second.ok, true, second.error)
  assert.ok(second.sources.some((source) => source.path === links[1].path))
  assert.ok(second.sources.some((source) => source.path === links[2].path), 'the first plan needs the source policy before probing providers')
  assert.ok(second.sources.some((source) => source.path === links[3].path), 'the first plan must disclose the knowledge-selected output template')
  assert.equal(calls.selections.length, 2, 'a common-only elements selection cannot decide later method requirements')
  await reader.read(request('plan', { knownSourceDigests: second.sources.map((source) => source.digest) }))
  assert.equal(calls.loads.length, 5, 'unchanged source bodies must not be exported repeatedly')
  assert.equal(calls.loads.some((call) => call.path === links[1].target), false)
  const evidence = await reader.read(request('evidence'))
  assert.ok(evidence.sources.some((source) => source.path === links[2].path))
  const review = await reader.read(request('review'))
  assert.equal(review.sources.length, 4)
})

test('a recognized mode change selects corresponding knowledge again without changing the library', async () => {
  const { reader, calls } = await fixture()
  await reader.read(request('elements', { mode: '' }))
  await reader.read(request('rights', { mode: 'listing-reference' }))
  assert.equal(calls.selections.length, 2)
  assert.equal(calls.loads.filter((call) => call.path === entryWikiPath).length, 1)
})

test('wrong library identity or snapshot digest is refused before selection', async () => {
  for (const source of [
    { ...entry, spaceName: '中瑞世联审核知识库' },
    { ...entry, digest: 'sha256:wrong' },
  ]) {
    const { reader, calls } = await fixture({ loadDocument: async () => ({ ok: true, source, links }) })
    const result = await reader.read(request())
    assert.equal(result.ok, false)
    assert.equal(calls.selections.length, 0)
    assert.equal(calls.loads.length, 1)
  }
})

test('unregistered paths, forged quotes and stale selection versions cause no further I/O', async () => {
  for (const result of [
    selection({ selections: [{ path: '../../private.adoc', role: 'common', quote: entryBody }] }),
    selection({ selections: [{ path: links[0].path, role: 'common', quote: '不存在的原文' }] }),
    selection({ entryDigest: 'sha256:previous-version' }),
  ]) {
    const { reader, calls } = await fixture({ selectSources: async () => result })
    assert.equal((await reader.read(request())).ok, false)
    assert.equal(calls.loads.length, 1)
  }
})

test('ordinary prose and tables are usable without a proprietary JSON rule block', async () => {
  const source = doc(links[0].path, '适用要求以本项目事实核对。\n| 测试参数 | 数值 |\n| --- | --- |\n| 合成参数 | 2 |')
  const { reader } = await fixture({ loadDocument: async (path) => path === links[0].path ? { ok: true, source, links: [] } : undefined })
  const result = await reader.read(request())
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sources[0].body, source.body)
  assert.equal(result.sources[0].digest, source.digest)
})

test('a valid quote for another navigation link cannot authorize this document', async () => {
  const { reader, calls } = await fixture({ selectSources: async () => selection({
    selections: [{ path: links[1].path, role: 'common', quote: entryBody.split('\n')[0] }],
  }) })
  assert.equal((await reader.read(request())).ok, false)
  assert.equal(calls.loads.length, 1)
})

test('empty source bodies and unanswered selection questions do not become adopted knowledge', async () => {
  const empty = doc(entryWikiPath, '')
  const one = await fixture({ loadDocument: async () => ({ ok: true, source: empty, links }) })
  assert.equal((await one.reader.read(request())).ok, false)
  assert.equal(one.calls.selections.length, 0)
  const two = await fixture({ selectSources: async () => selection({ questions: ['测试适用范围尚未确认'] }) })
  const result = await two.reader.read(request())
  assert.equal(result.ok, false)
  assert.ok(result.gaps.some((gap) => gap.includes('尚未确认')))
  assert.equal(two.calls.loads.length, 1)
})


test('source selections are bound to stage, revision and user context while verified bodies remain reusable', async () => {
  const { reader, calls } = await fixture()
  const initial = request('elements', { userInput: '仅估合成甲', materials: [{ materialId: 'm', digest: 'sha256:1', text: '合成材料' }] })
  await reader.read(initial)
  await reader.read({ ...initial, knownSourceDigests: ['sha256:already-read'] })
  assert.equal(calls.selections.length, 1)
  await reader.read({ ...initial, userInput: '更正为合成乙' })
  assert.equal(calls.selections.length, 2, 'a revised user scope cannot borrow the prior source selection')
  await reader.read({ ...initial, revision: 2 })
  assert.equal(calls.selections.length, 3)
  await reader.read({ ...initial, stage: 'rights' })
  assert.equal(calls.selections.length, 4)
  assert.equal(calls.loads.filter((item) => item.path === entryWikiPath).length, 1)
  assert.equal(calls.loads.filter((item) => item.path === links[0].path).length, 1)
})

test('a navigation quote without its link gets one corrected selection before any target read', async () => {
  let attempt = 0
  const { reader, calls } = await fixture({ selectSources: async (input) => {
    attempt += 1
    if (attempt === 1) return selection({ selections: [{ path: links[0].path, role: 'common', quote: '通用流程' }] })
    assert.equal(calls.loads.length, 1, 'the rejected quote cannot authorize a body read')
    assert.ok(input.correction.error.includes(links[0].path))
    return selection({ selections: [{ path: links[0].path, role: 'common', quote: entryBody.split('\n')[0] }] })
  } })
  const result = await reader.read(request())
  assert.equal(result.ok, true, result.error)
  assert.equal(calls.selections.length, 2)
  assert.deepEqual(result.sources.map((s) => s.path), [links[0].path])
  await reader.read(request())
  assert.equal(calls.selections.length, 2, 'only the corrected valid result is reusable')
})

test('source-quote correction is bounded and never silently adopts the original invalid selection', async () => {
  const bad = selection({ selections: [{ path: links[0].path, role: 'common', quote: '通用流程' }] })
  const { reader, calls } = await fixture({ selectSources: async () => bad })
  assert.equal((await reader.read(request())).ok, false)
  assert.equal(calls.selections.length, 2)
  assert.equal(calls.loads.length, 1)
})

test('foreign paths, stale roots and business questions do not trigger source-quote retries', async () => {
  for (const invalid of [
    selection({ entryDigest: 'sha256:foreign' }),
    selection({ selections: [{ path: '../../private.md', role: 'common', quote: entryBody }] }),
    selection({ questions: ['synthetic business question remains unresolved'] }),
    selection({ selections: [{ path: links[0].path, role: 'common', quote: 'not in root' }] }),
    selection({ selections: [
      { path: links[0].path, role: 'common', quote: '通用流程' },
      { path: '../../private.md', role: 'common', quote: entryBody },
    ] }),
    selection({ selections: [{ path: links[0].path, role: 'common', quote: '通用流程' }],
      questions: ['synthetic unresolved business question'] }),
  ]) {
    const { reader, calls } = await fixture({ selectSources: async () => invalid })
    assert.equal((await reader.read(request())).ok, false)
    assert.equal(calls.selections.length, 1)
    assert.equal(calls.loads.length, 1)
  }
})

test('malformed question lists fail as structured source errors before any retry or target read', async () => {
  const { reader, calls } = await fixture({ selectSources: async () => selection({ questions: null }) })
  const result = await reader.read(request())
  assert.equal(result.ok, false)
  assert.equal(calls.selections.length, 1)
  assert.equal(calls.loads.length, 1)
})

test('duplicate role paths are not a repairable missing-link quote error', async () => {
  const item = { path: links[0].path, role: 'common', quote: '通用流程' }
  const { reader, calls } = await fixture({ selectSources: async () => selection({ selections: [item, { ...item }] }) })
  assert.equal((await reader.read(request())).ok, false)
  assert.equal(calls.selections.length, 1)
  assert.equal(calls.loads.length, 1)
})
