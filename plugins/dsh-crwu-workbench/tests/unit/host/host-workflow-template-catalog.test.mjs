import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeDigest } from '../../../src/host/domains/report-evaluation/knowledge/snapshot.ts'
import { parseWikiLinks } from '../../../src/host/domains/report-evaluation/knowledge/wiki-links.ts'

const entryPath = '估值/房地产/wiki.adoc'
const directoryPath = '估值/房地产/模板目录.adoc'
function document(path, body) {
  return { ok: true, source: { sourceId: `wiki:${path}`, spaceName: '合成业务库', path,
    digest: knowledgeDigest(body), body, kind: 'prose' }, links: parseWikiLinks(body, path) }
}

test('the template catalog follows real entry links to a directory and retains its verified basis', async () => {
  const { collectWorkflowTemplateCatalog } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  assert.equal(typeof collectWorkflowTemplateCatalog, 'function')
  const docs = new Map([
    [entryPath, document(entryPath, '[计算表目录](模板目录.adoc)')],
    [directoryPath, document(directoryPath, '计算表原始件：[市场法](表格/市场法.xlsx)')],
  ])
  const reads = []
  const result = await collectWorkflowTemplateCatalog({ entryWikiPath: entryPath,
    loadDocument: async (path) => { reads.push(path); return docs.get(path) } })
  assert.deepEqual(result.paths, ['估值/房地产/表格/市场法.xlsx'])
  assert.ok(result.sources.some((source) => source.path === directoryPath && source.body.includes('市场法.xlsx')))
  assert.deepEqual(reads, [entryPath, directoryPath])
})

test('a changed directory body cannot register a template path under its former digest', async () => {
  const { collectWorkflowTemplateCatalog } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  const root = document(entryPath, '[目录](模板目录.adoc)')
  const changed = document(directoryPath, '[真实模板](表格/真实.xlsx)')
  changed.source.body = '[伪造模板](表格/伪造.xlsx)'
  changed.links = parseWikiLinks(changed.source.body, directoryPath)
  const result = await collectWorkflowTemplateCatalog({ entryWikiPath: entryPath,
    loadDocument: async (path) => path === entryPath ? root : changed })
  assert.deepEqual(result.paths, [])
})

test('catalog discovery does not follow external links, traverse out of the library, or walk cycles', async () => {
  const { collectWorkflowTemplateCatalog } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  const root = document(entryPath, '[目录](模板目录.adoc) [外部](https://example.invalid/x.adoc) [越界](../../../outside.adoc)')
  const directory = document(directoryPath, '[回到入口](wiki.adoc) [表](表格/市场法.xlsx)')
  const reads = []
  const result = await collectWorkflowTemplateCatalog({ entryWikiPath: entryPath, loadDocument: async (path) => {
    reads.push(path); assert.ok([entryPath, directoryPath].includes(path)); return path === entryPath ? root : directory
  } })
  assert.deepEqual(reads, [entryPath, directoryPath])
  assert.deepEqual(result.paths, ['估值/房地产/表格/市场法.xlsx'])
})

test('failed document reads still consume the bounded catalog traversal budget', async () => {
  const { collectWorkflowTemplateCatalog } = await import('../../../src/host/integrations/valuation-workflow/production/knowledge.ts')
  const root = document(entryPath, Array.from({ length: 40 }, (_, i) => `[缺失${i}](缺失${i}.adoc)`).join('\n'))
  const reads = []
  const result = await collectWorkflowTemplateCatalog({ entryWikiPath: entryPath, loadDocument: async (path) => {
    reads.push(path); return path === entryPath ? root : undefined
  } })
  assert.ok(reads.length <= 12, `attempted ${reads.length} document reads`)
  assert.deepEqual(result.paths, [])
})
