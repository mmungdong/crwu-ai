/**
 * 资产入口 Wiki 的**库内链接解析**（`knowledge/wiki-links.ts`）。
 *
 * 交付目录里的正文用的是知识库相对路径（`<01 房地产估值通用/01 输入与资料解释.md>`），
 * 所以"以当前文档所在库内目录为基准解析、并核对唯一节点身份"必须是一条真的能力 ——
 * 这里钉住它的纯函数部分（基准、越界、外部链接、锚点、同名歧义留给目录树侧）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { parseWikiLinks, resolveWikiTarget } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/wiki-links.ts', ROOT).href)
const { resolveRoute, wikiRouteFromPath } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/resolve.ts', ROOT).href)
const { catalogFromTree } = await import(
  new URL('src/host/tools/report-evaluation/catalog.ts', ROOT).href)

const SPACE = '中瑞世联业务知识库'
const SUB = '01 估值与测算/01 房地产'

/** 直接用目录事实造一个已验证的 catalog（`resolveRoute` 的输入）。 */
function catalogOf(files) {
  return {
    spaceName: SPACE,
    verified: true,
    files: files.map((file, index) => ({
      nodeId: file.nodeId ?? `n-${String(index)}`,
      name: file.name,
      path: file.path,
      extension: file.extension,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    folders: [],
    failures: [],
  }
}

/** 把库内路径当 Wiki 路径通道的一条请求来解析。 */
function resolveByPath(path, catalog) {
  const spec = wikiRouteFromPath(path)
  assert.notEqual(spec, null, `wikiRouteFromPath(${path}) 必须是可用路由`)
  return resolveRoute(catalog, spec)
}

function dwsFile(nodeId, name, extension) {
  return {
    nodeId, name, type: 'file', extension, contentType: '', parentFolderId: '',
    updatedAt: '', hasChildren: false, children: [],
    page: { autoPageComplete: true, pagesFetched: 1, itemsInPage: 1 },
  }
}

function dwsFolder(nodeId, name, children) {
  return {
    nodeId, name, type: 'folder', extension: '', contentType: '', parentFolderId: '',
    updatedAt: '', hasChildren: true, children,
    page: { autoPageComplete: true, pagesFetched: 1, itemsInPage: 1 },
  }
}

const WIKI = '01 估值与测算/01 房地产/wiki.md'

test('基准是**当前文档所在目录**，不是知识库根', () => {
  assert.deepEqual(
    resolveWikiTarget(WIKI, '01 房地产估值通用/01 输入与资料解释.md'),
    { ok: true, path: '01 估值与测算/01 房地产/01 房地产估值通用/01 输入与资料解释.md', anchor: '' },
  )
  // 上级目录是允许的（只要不逃出知识库根）：从 `02 估值方法/01 …方案.md` 的 `../02 市场法.md`
  // 落回 `01 房地产/02 市场法.md`。
  assert.deepEqual(
    resolveWikiTarget('01 估值与测算/01 房地产/02 估值方法/01 房地产评估方法选择方案.md', '../02 市场法.md'),
    { ok: true, path: '01 估值与测算/01 房地产/02 市场法.md', anchor: '' },
  )
})

test('尖括号包住的路径、百分号转义、锚点都能解析', () => {
  assert.deepEqual(
    resolveWikiTarget(WIKI, '<01 房地产估值通用/01 输入与资料解释.md>'),
    { ok: true, path: '01 估值与测算/01 房地产/01 房地产估值通用/01 输入与资料解释.md', anchor: '' },
  )
  assert.deepEqual(
    resolveWikiTarget(WIKI, '01%20房地产估值通用/01%20输入与资料解释.md'),
    { ok: true, path: '01 估值与测算/01 房地产/01 房地产估值通用/01 输入与资料解释.md', anchor: '' },
  )
  const anchored = resolveWikiTarget(WIKI, '02 估值方法/02 市场法.md#第-3-节-修正')
  assert.equal(anchored.ok, true)
  assert.equal(anchored.path, '01 估值与测算/01 房地产/02 估值方法/02 市场法.md')
  assert.equal(anchored.anchor, '第-3-节-修正')
})

test('不许逃出知识库根，也不接受绝对路径', () => {
  const escaped = resolveWikiTarget(WIKI, '../../../../etc/passwd')
  assert.equal(escaped.ok, false)
  assert.match(escaped.error, /逃出知识库根/)
  const absolute = resolveWikiTarget(WIKI, '/etc/passwd')
  assert.equal(absolute.ok, false)
  assert.match(absolute.error, /绝对路径/)
  const empty = resolveWikiTarget(WIKI, '   ')
  assert.equal(empty.ok, false)
})

test('外部地址与纯锚点不假装成库内路径', () => {
  assert.equal(resolveWikiTarget(WIKI, 'https://example.com/x').ok, false)
  assert.equal(resolveWikiTarget(WIKI, '#第-5-节').ok, false)
})

test('parseWikiLinks 区分四类目标，并保留原始 target', () => {
  const body = [
    '# 房地产估值 Wiki',
    '',
    '先读[输入与资料解释](<01 房地产估值通用/01 输入与资料解释.md>)。',
    '再读[对象分类与价值范围](01 房地产估值通用/02 对象分类与价值范围.md#第二节)。',
    '外部参考见[资产评估法](https://www.beijing.gov.cn/zhengce/1.html)。',
    '跳回[本节](#房地产估值-wiki)。',
    '这条是坏的：[坏链接](../../../outside.md)。',
    '',
    '```text',
    '[代码块里的方括号](不该被当成链接.md)',
    '```',
  ].join('\n')
  const links = parseWikiLinks(body, WIKI)
  assert.deepEqual(links.slice(0, 4).map((link) => link.kind), ['knowledge', 'knowledge', 'external', 'anchor'])
  assert.equal(links[0].path, '01 估值与测算/01 房地产/01 房地产估值通用/01 输入与资料解释.md')
  assert.equal(links[1].anchor, '第二节')
  assert.equal(links[1].path, '01 估值与测算/01 房地产/01 房地产估值通用/02 对象分类与价值范围.md')
  assert.equal(links[2].target, 'https://www.beijing.gov.cn/zhengce/1.html')
  assert.equal(links[3].anchor, '房地产估值-wiki')
  // 坏链接要**如实报**：它进 capabilityGaps，不许静默丢掉。
  const bad = parseWikiLinks('见[坏链接](../../../outside.md)。', WIKI)
  assert.deepEqual(bad.map((link) => link.kind), ['invalid'])
  assert.match(bad[0].error, /逃出知识库根/)

  // 代码块里的方括号**不该**被当成链接（解析器不做 Markdown 语法树，但尖括号形式可以区分）。
  const code = parseWikiLinks('```\n[标题](路径.md)\n```', WIKI)
  assert.equal(code.some((link) => link.path === '01 估值与测算/01 房地产/路径.md'), true,
    '行内形式在代码块里也会被读出来 —— 这是已知的保守取舍，不在解析层猜 Markdown 结构')
})

// ── 协议 40 · 目录树侧的路径身份（红测，先于实现）──────────────────────────────
//
// 2026-10-16 诊断 §3.1：`wikiRouteFromPath` 把允许后缀**钉死为声明后缀**
//（`extensions: [extension]`），而 `catalogFromTree` 又把 `adoc` 节点的**路径**改写成 `.md`、
// `extension` 仍留 `adoc`。于是"声明 `.md`、真实 `adoc`"（或反过来）会被 `resolveRoute`
// 报成 `missing`，唯一业务入口直接取不到；两种声明写法在这一层无法互相恢复。
//
// 这里用当前 API 复现：`catalogFromTree` 造真实目录事实，`wikiRouteFromPath` + `resolveRoute`
// 走 Wiki 路径通道。断言失败即复现；本轮不改产品源码。

test('adoc 节点按等价的 .md 导出路径声明时仍可读（保留真实 extension）', () => {
  const catalog = catalogFromTree([
    dwsFolder('f-00', '01 估值与测算', [
      dwsFolder('f-01', '01 房地产', [dwsFile('d-1', 'wiki', 'adoc')]),
    ]),
  ], SPACE, [])

  // 先钉住目录事实：adoc 节点在 catalog 里的落盘路径是 .md，但服务端 extension 仍是 adoc。
  assert.equal(catalog.files[0].path, `${SUB}/wiki.md`)
  assert.equal(catalog.files[0].extension, 'adoc')

  const resolution = resolveByPath(`${SUB}/wiki.md`, catalog)
  assert.equal(resolution.state, 'found', resolution.error)
  assert.equal(resolution.ok, true)
  assert.equal(resolution.documents.length, 1)
  assert.equal(resolution.documents[0].extension, 'adoc', '真实服务端 extension 必须保留')
  assert.equal(resolution.documents[0].source, 'dws')
})

test('md 节点按等价的 .adoc 声明时仍可读（后缀按形态给集合，不钉死一个）', () => {
  const catalog = catalogOf([{ name: 'wiki.md', path: `${SUB}/wiki.md`, extension: 'md' }])
  const resolution = resolveByPath(`${SUB}/wiki.adoc`, catalog)
  assert.equal(resolution.state, 'found', resolution.error)
  assert.equal(resolution.ok, true)
  assert.equal(resolution.documents[0].extension, 'md')
})

test('同名 md 与 adoc 同时存在时是 ambiguous，不能挑第一份', () => {
  const catalog = catalogOf([
    { name: 'wiki.md', path: `${SUB}/wiki.md`, extension: 'md' },
    { name: 'wiki.adoc', path: `${SUB}/wiki.adoc`, extension: 'adoc' },
  ])
  const resolution = resolveByPath(`${SUB}/wiki.md`, catalog)
  assert.equal(resolution.state, 'ambiguous',
    `同名多份必须请人工确认，不许替用户选第一份：${JSON.stringify(resolution.documents.map((item) => item.path))}`)
  assert.equal(resolution.ok, false)
})

test('二进制模板不得被同名文本节点顶替，声明文本时也不许拿模板凑', () => {
  const catalog = catalogOf([
    { name: '模板.md', path: `${SUB}/模板.md`, extension: 'md' },
    { name: '模板.xlsx', path: `${SUB}/模板.xlsx`, extension: 'xlsx' },
  ])
  const binary = resolveByPath(`${SUB}/模板.xlsx`, catalog)
  assert.equal(binary.state, 'found', binary.error)
  assert.equal(binary.documents[0].extension, 'xlsx')

  const text = resolveByPath(`${SUB}/模板.md`, catalog)
  assert.equal(text.state, 'found', text.error)
  assert.equal(text.documents[0].extension, 'md')

  // 只有模板、却声明文本规则：必须是 missing，二进制模板不能当文本正文读。
  const onlyBinary = catalogOf([{ name: '模板.xlsx', path: `${SUB}/模板.xlsx`, extension: 'xlsx' }])
  const missing = resolveByPath(`${SUB}/模板.md`, onlyBinary)
  assert.equal(missing.state, 'missing', '二进制模板不能当文本规则读')
  assert.equal(missing.ok, false)
})
