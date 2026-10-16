/**
 * 估值业务知识路由的**决策层**单元测试。
 *
 * 这一层决定"子会话拿到哪一版知识"，所以每条断言都对着一条**会静默出错**的规则：
 *
 * 1. **目录不是正文**：命中一个目录绝不算 found —— 把文件夹标题当规范用，
 *    得到的是一段空上下文加一套"按规范"编出来的说法。
 * 2. **同名多个 = ambiguous**：同目录同名文档（含不同后缀）多于一份时不许挑一份。
 * 3. **命名变体只折叠声明过的两类差异**（连字符 ↔ 空格、全角 ↔ 半角）：库侧改名不该让路由落空，
 *    但折叠过头会把两条不同的规则当成同一条。
 * 4. **错误空间 manifest 拒绝**：目录名像业务库不构成身份证明，必须看 manifest 的 `spaceName`。
 * 5. **镜像 hash 错误拒绝**：字节与 manifest/期望 digest 不符就不是 verified-mirror。
 * 6. **远程明确为空 ≠ 缺失**：空文档不能拿旧镜像掩盖。
 * 7. **除 manifest 读不到之外，任何缺失都不整体失败**（回归锚点见下）。
 * 8. **索引写失败不返回 ok**：知识落盘了但来源索引没写成功，不算物化完成。
 * 9. **没有本地 references 兜底**：Skill 的 `references/` 不再是生产正文来源。
 * 10. **规则段只认受 Schema 限制的数据**：可执行代码 / shell / 任意 URL / 选择器字段一律拒绝，
 *     `snapshotDigest` 对不上就整段不认，缺结构化参数返回缺口而不是默认值。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  TEXT_EXTENSIONS,
  VALUATION_KNOWLEDGE_SPACE,
  knowledgeDigest,
  knowledgeIdentityKey,
  knowledgeSnapshotDigest,
  loadVerifiedMirror,
  materializeKnowledge,
  wikiRouteFromPath,
  parseRuleParameters,
  parseValuationManifest,
  resolveRoute,
  toKnowledgeSourceDocument,
} = await import(new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)

const SUB = '01 估值与测算/01 房地产'

/** 一条文档路由（库内**完整**路径）。manifest 里的路径是相对 manifest 目录的，测试里直接给完整路径。 */
function route(routeId, path, kind = 'document') {
  return { routeId, path, kind, extensions: TEXT_EXTENSIONS }
}

const MARKET = route('method.market.guide', `${SUB}/02 估值方法/02 市场法.md`)
const SELECTION = route('method-selection', `${SUB}/01 房地产估值通用`)

// ── 替身：内存目录树 ────────────────────────────────────────────────────────

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * 一条库内节点。`body === undefined` 表示"节点在、正文还没取过"；
 * `empty: true` 表示服务端明确给了空正文。
 */
function node(path, options = {}) {
  const name = path.split('/').pop()
  return {
    name,
    path,
    extension: options.extension ?? extensionOf(name),
    updatedAt: options.updatedAt ?? '2026-10-01T00:00:00.000Z',
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.empty === true ? { empty: true } : {}),
  }
}

/** 从节点路径推出全部祖先目录（不含节点自身）。 */
function foldersOf(files, extra) {
  const set = new Set(extra)
  for (const file of files) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) set.add(parts.slice(0, index).join('/'))
  }
  return [...set]
}

function catalog(files, options = {}) {
  return {
    spaceName: options.spaceName ?? VALUATION_KNOWLEDGE_SPACE,
    verified: options.verified ?? true,
    files,
    folders: foldersOf(files, options.folders ?? []),
    failures: options.failures ?? [],
  }
}

const BODY = (name) => `# ${name}\n正文内容。\n`

/** 2026-10-14 22:45 从业务库实时观测到的层级（`dws wiki` 目录树输出的逐字名称，空格命名）。 */
function observedTree2026_10_14() {
  const methods = `${SUB}/02 估值方法`
  const cases = `${SUB}/03 案例选取`
  const params = `${SUB}/04 参数与税费`
  const templates = `${SUB}/05 计算表模板`
  return [
    node(`${methods}/01 房地产评估方法选择方案.md`, { body: BODY('方法选择') }),
    node(`${methods}/02 市场法.md`, { body: BODY('市场法') }),
    node(`${methods}/03 收益法（TODO）.md`, { empty: true }),
    node(`${methods}/04 成本法（TODO）.md`, { empty: true }),
    node(`${cases}/00 案例选取目录与适用范围.md`, { body: BODY('案例目录') }),
    node(`${params}/00 参数目录与来源原则.md`, { body: BODY('参数目录') }),
    node(`${templates}/00 模板使用目录说明.md`, { body: BODY('模板目录') }),
  ]
}

// ── resolveRoute：路径匹配 ──────────────────────────────────────────────────

test('resolveRoute：精确路径命中，返回库内真实路径与安全落点', () => {
  const resolution = resolveRoute(catalog([node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('市场法') })]), MARKET)
  assert.equal(resolution.state, 'found')
  assert.equal(resolution.ok, true)
  assert.equal(resolution.documents.length, 1)
  assert.equal(resolution.documents[0].path, `${SUB}/02 估值方法/02 市场法.md`)
  assert.equal(resolution.documents[0].channel, 'exact-route')
  assert.equal(resolution.documents[0].source, 'dws')
  assert.equal(resolution.documents[0].snapshotFile, 'method.market.guide/02 市场法.md')
  assert.equal(resolution.attempts[0].channel, 'exact-route')
  assert.equal(resolution.attempts[0].outcome, 'found')
})

test('目录不是正文：文档路由命中一个同名目录时不是 found', () => {
  // manifest 的 `methodSelection` 常常只写到目录（`01 房地产估值通用`），库里那就是一个文件夹。
  const folderRoute = route('method-selection', `${SUB}/02 估值方法/02 市场法`)
  const tree = [node(`${SUB}/02 估值方法/02 市场法/子文档.md`, { body: BODY('子文档') })]
  const resolution = resolveRoute(catalog(tree), folderRoute)
  assert.equal(resolution.state, 'empty')
  assert.equal(resolution.documents.length, 0)
  assert.equal(resolution.attempts.some((item) => /目录/.test(item.detail)), true, '要留下"命中的是目录"的查找记录')
})

test('空正文不算命中：节点存在但正文为空 → empty（未支持，不是 found）', () => {
  const tree = [node(`${SUB}/02 估值方法/02 市场法.md`, { empty: true })]
  const resolution = resolveRoute(catalog(tree), MARKET)
  assert.equal(resolution.state, 'empty')
  assert.equal(resolution.ok, false)
  assert.equal(resolution.documents[0].empty, true)
  assert.equal(resolution.attempts.some((item) => item.outcome === 'empty'), true)
})

test('同目录同名可命中（后缀不同也算）：按 route 声明的后缀逐个试并留痕', () => {
  const tree = [node(`${SUB}/02 估值方法/02 市场法.adoc`, { body: BODY('市场法') })]
  const resolution = resolveRoute(catalog(tree), MARKET)
  assert.equal(resolution.state, 'found', resolution.error)
  assert.equal(resolution.documents[0].channel, 'same-name')
  assert.equal(resolution.documents[0].path, `${SUB}/02 估值方法/02 市场法.adoc`)
  assert.equal(resolution.attempts.find((item) => item.channel === 'same-name').outcome, 'found')
})

test('同目录同名只在文件名的最后一段上比对：目录名不参与去后缀', () => {
  // 回归：`stemOf` 曾经被作用在整条路径上，于是 `…/02 估值方法/02 市场法.md` 的"同名"键里
  // 连目录都带了进去，同目录改用别的后缀就再也命不中（这条路由会静默变成"缺失"）。
  const tree = [node(`${SUB}/02 估值方法/02 市场法.txt`, { body: BODY('市场法') })]
  assert.equal(resolveRoute(catalog(tree), MARKET).state, 'found')
})

test('同目录同名多个 → ambiguous，不许选第一份', () => {
  const twoSameNameCandidates = catalog([
    node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('一份') }),
    node(`${SUB}/02 估值方法/02 市场法.adoc`, { body: BODY('另一份') }),
  ])
  const resolution = resolveRoute(twoSameNameCandidates, MARKET)
  assert.equal(resolution.state, 'ambiguous')
  assert.equal(resolution.documents.length, 0, '多命中时不许交出任何一份')
  assert.equal(resolution.attempts.some((item) => item.outcome === 'ambiguous'), true)
})

test('未命中 → missing，且两级都留痕（第二级说明"目标目录下没有同名文档"）', () => {
  const resolution = resolveRoute(catalog([]), MARKET)
  assert.equal(resolution.state, 'missing')
  assert.equal(resolution.documents.length, 0)
  const sameName = resolution.attempts.find((item) => item.channel === 'same-name')
  assert.equal(sameName.outcome, 'missing')
  assert.equal(sameName.target, `${SUB}/02 估值方法/02 市场法.*`, '同名级的查找目标要落在**文件名**上')
  assert.match(resolution.error, /02 市场法\.md/)
})

test('身份未验证 / 空间不对 → unreadable（目录名像不构成身份证明）', () => {
  const tree = [node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('市场法') })]
  const right = resolveRoute(catalog(tree, { verified: false }), MARKET)
  assert.equal(right.state, 'unreadable')

  const wrongSpace = resolveRoute(
    catalog(tree, { spaceName: '中瑞世联评估审核知识库', verified: false }),
    MARKET,
  )
  assert.equal(wrongSpace.state, 'unreadable')
  assert.equal(wrongSpace.attempts.some((item) => item.outcome === 'rejected-identity'), true)
})

test('目录树读取失败 + 无候选 → unreadable（探测失败 ≠ 节点不存在）', () => {
  const resolution = resolveRoute(
    catalog([], { failures: [{ step: 'node-list(root)', error: 'dws: 未登录' }] }),
    MARKET,
  )
  assert.equal(resolution.state, 'unreadable')
  assert.match(resolution.error, /未登录|读取失败/)
})

test('落点文件名去掉路径分隔符（库内节点名不该能拼出越界路径）', () => {
  const resolution = resolveRoute(catalog([node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('市场法') })]), MARKET)
  for (const document of resolution.documents) {
    assert.equal(document.snapshotFile.includes('..'), false)
    assert.match(document.snapshotFile, /^method\./)
  }
})

// ── P4 命名身份：连字符 / 空格 / 全角（显式折叠，不模糊匹配） ────────────────

test('命名身份折叠只折叠声明过的两类差异，其余一律不折叠', () => {
  // ① 连字符 ↔ 空格（2026-10-14 业务库把 `02-市场法` 改名为 `02 市场法`）
  assert.equal(knowledgeIdentityKey(`${SUB}/02-市场法.md`), knowledgeIdentityKey(`${SUB}/02 市场法.md`))
  assert.equal(knowledgeIdentityKey(`${SUB}/05-计算表模板/01-市场法`), knowledgeIdentityKey(`${SUB}/05 计算表模板/01 市场法`))
  // ② 全角 ↔ 半角（含全角连字符/括号）
  assert.equal(knowledgeIdentityKey('04－成本法（TODO）.md'), knowledgeIdentityKey('04-成本法(TODO).md'))
  // 不折叠：去掉分隔符、改变编号、改变后缀都属于**不同**节点。
  assert.notEqual(knowledgeIdentityKey('01-市场法'), knowledgeIdentityKey('01市场法'))
  assert.notEqual(knowledgeIdentityKey('02-市场法.md'), knowledgeIdentityKey('02-市场法.adoc'))
  assert.notEqual(knowledgeIdentityKey('02-市场法'), knowledgeIdentityKey('03-市场法'))
})

test('库侧改名不落空：manifest 声明的连字符名命中库里的空格名节点，并留痕', () => {
  const hyphen = route('method.market.guide', `${SUB}/02 估值方法/02-市场法.md`)
  const resolution = resolveRoute(catalog([node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('市场法') })]), hyphen)
  assert.equal(resolution.state, 'found')
  assert.equal(resolution.documents[0].path, `${SUB}/02 估值方法/02 市场法.md`, '命中的永远是库内真实路径')
  const hit = resolution.attempts.find((item) => item.outcome === 'found')
  assert.match(hit.detail, /命名变体/, '视图外改名要能从查找轨迹里看出来')
})

test('命名变体造成多命中 → ambiguous（保留全部候选路径，不选第一份）', () => {
  const hyphen = route('method.market.guide', `${SUB}/02 估值方法/02-市场法.md`)
  const both = catalog([
    node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('空格名') }),
    node(`${SUB}/02 估值方法/02-市场法.md`, { body: BODY('连字符名') }),
  ])
  const resolution = resolveRoute(both, hyphen)
  assert.equal(resolution.state, 'ambiguous')
  assert.match(resolution.error, /02 市场法\.md/)
  assert.match(resolution.error, /02-市场法\.md/)
})

test('仍然零命中 → missing，绝不回落到随包旧正文或模型记忆', () => {
  const missing = resolveRoute(catalog(observedTree2026_10_14()), route('method.income.guide', `${SUB}/02 估值方法/09 假设开发法.md`))
  assert.equal(missing.state, 'missing')
  assert.equal(missing.documents.length, 0)
  assert.equal(JSON.stringify(missing).includes('references/'), false)
})

// ── loadVerifiedMirror ─────────────────────────────────────────────────────

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** 造一个本地镜像目录（临时文件系统），manifest 与文件字节由调用方决定。 */
async function makeMirror({ spaceName, entries }) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-mirror-'))
  await mkdir(join(root, '01 估值与测算', '01 房地产', '02 估值方法'), { recursive: true })
  for (const entry of entries) {
    await writeFile(join(root, entry.path), entry.bytes, 'utf8')
  }
  await writeFile(join(root, '_manifest.json'), JSON.stringify({
    spaceName,
    entries: entries.map((entry) => ({
      path: entry.path,
      digest: entry.digest ?? sha256(entry.bytes),
      updatedAt: '2026-09-01T00:00:00.000Z',
    })),
  }), 'utf8')
  return root
}

test('镜像默认不启用：mirrorRoot 为空 → ok:false，不猜任何本地路径', async () => {
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: '' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reasonKind, 'disabled')
})

test('错误空间 manifest 拒绝：目录名像业务库也不算身份验证', async () => {
  const audit = await makeMirror({
    spaceName: '中瑞世联评估审核知识库',
    entries: [{ path: `${SUB}/02 估值方法/02 市场法.md`, bytes: BODY('审核库的市场法') }],
  })
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: audit })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reasonKind, 'identity')
  assert.equal(outcome.documents.length, 0)
  assert.equal(outcome.attempts.some((item) => item.outcome === 'rejected-identity'), true)
  await rm(audit, { recursive: true, force: true })
})

test('镜像 hash 错误拒绝：字节与 manifest digest 不符就不是 verified-mirror', async () => {
  const root = await makeMirror({
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    entries: [{
      path: `${SUB}/02 估值方法/02 市场法.md`,
      bytes: BODY('被改过的市场法'),
      // 声明一个与真实字节不符的 digest
      digest: `sha256:${'0'.repeat(64)}`,
    }],
  })
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: root })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reasonKind, 'digest')
  assert.equal(outcome.documents.length, 0)
  assert.equal(outcome.attempts.some((item) => item.outcome === 'rejected-digest'), true)
  await rm(root, { recursive: true, force: true })
})

test('镜像身份与 hash 都对 → verified-mirror，路径只给镜像内相对路径', async () => {
  const root = await makeMirror({
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    entries: [{ path: `${SUB}/02 估值方法/02 市场法.md`, bytes: BODY('镜像市场法') }],
  })
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: root })
  assert.equal(outcome.ok, true, outcome.reason)
  assert.equal(outcome.documents.length, 1)
  assert.equal(outcome.documents[0].source, 'verified-mirror')
  assert.equal(outcome.documents[0].relativePath, `${SUB}/02 估值方法/02 市场法.md`)
  assert.equal(outcome.documents[0].digest, sha256(BODY('镜像市场法')))
  assert.equal(JSON.stringify(outcome.documents).includes(root), false, '模型可见结果里不许出现镜像绝对路径')
  await rm(root, { recursive: true, force: true })
})

test('镜像 manifest 缺失 → unreadable（不是 missing，也不是自动放弃）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crwu-mirror-empty-'))
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: root })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reasonKind, 'unreadable')
  await rm(root, { recursive: true, force: true })
})

test('镜像里的越界路径被拒绝（不许用 `..` 读镜像根之外）', async () => {
  const root = await makeMirror({
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    entries: [{ path: `${SUB}/02 估值方法/02 市场法.md`, bytes: BODY('镜像市场法') }],
  })
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, '_manifest.json'), 'utf8'))
  manifest.entries[0].path = '../../../etc/passwd'
  await writeFile(join(root, '_manifest.json'), JSON.stringify(manifest), 'utf8')
  const outcome = await loadVerifiedMirror(MARKET, VALUATION_KNOWLEDGE_SPACE, { mirrorRoot: root })
  assert.equal(outcome.ok, false)
  await rm(root, { recursive: true, force: true })
})

// ── materializeKnowledge：manifest 驱动 ────────────────────────────────────

/** manifest 正文：JSON 围栏形态（权威形态）。`methods.<m>` 的两个键都必须在。 */
function manifestDoc(overrides = {}) {
  return [
    '# 知识目录与必需项',
    '',
    '```json',
    JSON.stringify({
      version: 1,
      methodSelection: '01 房地产估值通用',
      methods: {
        market: { guide: '02 估值方法/02 市场法.md', template: '05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx' },
        income: { guide: null, template: null },
        cost: { guide: null, template: null },
      },
      ...overrides,
    }, null, 2),
    '```',
    '',
  ].join('\n')
}

/** 把 manifest 声明的路径落到目录树里（`relative` 相对 manifest 所在目录）。 */
function treeFor(relatives) {
  return relatives.map((relative) => node(`${SUB}/${relative}`, { body: BODY(relative) }))
}

function makeDeps(tree, options = {}) {
  const written = new Map()
  const indexWrites = []
  const mirrorCalls = []
  const catalogValue = options.catalog ?? catalog(tree, options)
  const document = options.manifest ?? manifestDoc()
  return {
    written,
    indexWrites,
    mirrorCalls,
    document,
    deps: {
      spaceName: VALUATION_KNOWLEDGE_SPACE,
      manifestDir: SUB,
      loadManifest: options.loadManifest ?? (async () => ({ ok: true, document, error: '' })),
      // 镜像恢复由 Host 组合（`mirror.ts` 提供实现，`resolve.ts` 只声明依赖）。
      ...(options.mirror === undefined
        ? {}
        : {
          loadMirror: (spec) => {
            mirrorCalls.push(spec.routeId)
            return loadVerifiedMirror(spec, VALUATION_KNOWLEDGE_SPACE, options.mirror)
          },
        }),
      now: () => new Date('2026-10-14T00:00:00.000Z'),
      loadCatalog: async () => catalogValue,
      readBody: options.readBody ?? (async (item) => (
        item.body === undefined
          ? { ok: false, error: `未取到正文：${item.name}` }
          : { ok: true, body: item.body }
      )),
      readBinary: options.readBinary ?? (async () => ({ ok: true, bytes: new TextEncoder().encode('xlsx-bytes') })),
      writeSnapshot: options.writeSnapshot ?? (async ({ relativePath, content }) => {
        written.set(relativePath, content)
        return { ok: true, error: '' }
      }),
      writeIndex: options.writeIndex ?? (async ({ relativePath, document: text }) => {
        indexWrites.push(relativePath)
        written.set(relativePath, text)
        return { ok: true, error: '' }
      }),
    },
  }
}

const PROJECT = '估值-20261014-000000-aa11'
const GUIDE = 'method.market.guide'
/** manifest 声明里**除**方法正文与模板之外的全部槽位（用于"其余齐备"的构造）。 */
const DECLARED = ['method-selection', 'method.market.guide', 'method.market.template']

// ── Wiki 路径通道（协议 39 的主通道）────────────────────────────────────────

test('wikiRouteFromPath：由库内路径推槽位与形态；绝对路径 / 越界 / 未知后缀一律不猜', () => {
  const wiki = wikiRouteFromPath('01 估值与测算/01 房地产/wiki.md')
  assert.deepEqual(wiki, {
    routeId: 'wiki:01 估值与测算/01 房地产/wiki.md',
    path: '01 估值与测算/01 房地产/wiki.md',
    kind: 'document',
    extensions: ['md', 'adoc', 'txt'],
  })
  assert.equal(wikiRouteFromPath('05 计算表模板/01 市场法模板.xlsx').kind, 'binary')
  assert.deepEqual(wikiRouteFromPath('a/b.adoc').extensions, ['md', 'adoc', 'txt'])
  for (const bad of ['', '   ', '/绝对/路径.md', '~/home.md', '../越界.md', 'a/../b.md', 'a/./b.md', '没有后缀', 'a/b.docx']) {
    assert.equal(wikiRouteFromPath(bad), null, JSON.stringify(bad))
  }
})

test('按 Wiki 路径读取：**不需要 manifest** —— 入口 Wiki 与它的链接逐篇取回', async () => {
  const entry = '01 估值与测算/01 房地产/wiki.md'
  const method = '01 估值与测算/01 房地产/02 市场法.md'
  // 库内路径是**完整路径**（入口 Wiki 自己也一样）；`resolveRoute` 逐字匹配它。
  const tree = [
    node(entry, { body: `# 入口\n先读[市场法](02 市场法.md)。\n` }),
    node(method, { body: BODY('市场法') }),
  ]
  // manifest **读不到**：走 Wiki 路径通道时它只是"没有槽位清单可回报"，不是真停。
  const { deps, written } = makeDeps(tree, {
    loadManifest: async () => ({ ok: false, document: '', error: '入口文档被删除' }),
  })
  const manifest = await materializeKnowledge({ projectId: PROJECT, wikiPaths: [entry, method] }, deps)

  assert.equal(manifest.ok, true, manifest.error)
  assert.deepEqual(manifest.availableRouteIds, [], '没有 manifest 就没有槽位清单')
  assert.deepEqual(manifest.routeIds, [`wiki:${entry}`, `wiki:${method}`])
  assert.deepEqual(manifest.wikiPaths, [entry, method])
  assert.equal(manifest.entries.length, 2)
  // 落盘段名安全化：路由段里的 `/` 不进目录名（否则会散成一串嵌套目录）。
  assert.equal(written.has('wiki_01 估值与测算_01 房地产_wiki.md/wiki.md'), true,
    [...written.keys()].join('、'))
  assert.equal([...written.keys()].some((key) => key.startsWith('wiki:')), false, '落盘路径里不出现带冒号的原始路由 id')

  // 入口 Wiki 的链接被解析出来：Agent 据此决定下一跳。
  const entryOutcome = manifest.entries.find((item) => item.routeId === `wiki:${entry}`)
  assert.equal(entryOutcome.links.length, 1)
  assert.equal(entryOutcome.links[0].path, method)
  // 迁移警告与"manifest 读不到"的事实都如实带出来。
  assert.match(manifest.warnings.join('；'), /manifest 读不到/)
  assert.match(manifest.warnings.join('；'), /按 Wiki 路径读取/)
  assert.equal(manifest.capabilityGaps.length, 0, 'wiki 路径都取到了就没有缺口')
})

test('Wiki 路径只按完整路径匹配：没有这条路径就是 missing，不做前缀 / 模糊匹配', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({
    projectId: PROJECT,
    wikiPaths: [`${SUB}/02 估值方法/不存在的规范.md`, `${SUB}/02 市场法.md`],
  }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  // ① 不存在的名字、② 少一层目录：都不是"相近就取"（没有后缀属于**路径不可用**，另有用例）。
  for (const route of manifest.routes) {
    assert.equal(route.state, 'missing', `${route.routeId} 应当 missing（只按完整路径匹配）`)
  }
  assert.match(manifest.capabilityGaps.join('；'), /缺少知识正文/)
  // 后缀大小写属于既有的容忍口径（与槽位通道同一条），不另起一套规则。
  const tolerant = await materializeKnowledge({
    projectId: PROJECT,
    wikiPaths: [`${SUB}/02 估值方法/02 市场法.MD`],
  }, deps)
  assert.equal(tolerant.routes[0].state, 'found', '后缀写法差异沿用既有折叠口径，不另立规则')
})

test('Wiki 路径不可用（绝对路径 / 越界 / 未知后缀）→ input 错误，不取任何正文', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  for (const bad of ['/etc/passwd.md', '../外面.md', '别的格式.docx']) {
    const manifest = await materializeKnowledge({ projectId: PROJECT, wikiPaths: [bad] }, deps)
    assert.equal(manifest.ok, false, bad)
    assert.equal(manifest.errorKind, 'input')
    assert.match(manifest.error, /Wiki 路径不能用/)
  }
})

test('两条通道同时给：逐条都取，并说明这一轮有两条来源', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({
    projectId: PROJECT,
    routeIds: ['method.market.guide'],
    wikiPaths: [`${SUB}/02 估值方法/02 市场法.md`],
  }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.deepEqual(manifest.routeIds, ['method.market.guide', `wiki:${SUB}/02 估值方法/02 市场法.md`])
  assert.match(manifest.warnings.join('；'), /同时给了 routeIds 与 wikiPaths/)
  // 两条来源都必须真的取到（否则"都取了"只是一句话）。
  assert.deepEqual(manifest.routes.map((item) => item.state), ['found', 'found'])
})

test('正文里的库内相对链接被解析出来（Agent 的下一跳依据），外部与越界如实分类', async () => {
  const wikiBody = [
    '# 房地产估值 Wiki',
    '',
    '先读[输入与资料解释](<01 房地产估值通用/01 输入与资料解释.md>)。',
    '再读[市场法](02 估值方法/02 市场法.md#第-3-节)。',
    '外部参考见[资产评估法](https://www.beijing.gov.cn/zhengce/1.html)。',
    '坏的：[越界](../../../etc/passwd)。',
    '',
  ].join('\n')
  const { deps } = makeDeps([
    node(`${SUB}/wiki.md`, { body: wikiBody }),
    node(`${SUB}/02 估值方法/02 市场法.md`, { body: BODY('市场法') }),
  ], { manifest: manifestDoc({ methodSelection: 'wiki.md' }) })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: ['method-selection'] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  const links = manifest.entries[0].links
  assert.deepEqual(links.map((link) => link.kind), ['knowledge', 'knowledge', 'external', 'invalid'])
  // 基准是**当前文档所在库内目录**：`wiki.md` 与 `02 估值方法/` 同级。
  assert.equal(links[0].path, `${SUB}/01 房地产估值通用/01 输入与资料解释.md`)
  assert.equal(links[1].path, `${SUB}/02 估值方法/02 市场法.md`)
  assert.equal(links[1].anchor, '第-3-节')
  assert.equal(links[2].path, '', '外部链接不假装成库内路径')
  assert.match(links[3].error, /逃出知识库根/)
})

test('**回归锚点**：manifest 里 methodSelection 指向的目录为空、其余齐备 → ok:true（空目录不再阻断估值）', async () => {
  // `01 房地产估值通用` 在库里只是一个**空目录**，没有任何文件。这正是最原始那条报障。
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md', '05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx']), {
    folders: [`${SUB}/01 房地产估值通用`],
  })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: DECLARED }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.deepEqual(manifest.routes.map((item) => item.state), ['empty', 'found', 'found'])
  assert.equal(manifest.capabilityGaps.some((gap) => gap.includes('method-selection')), true, '缺口要如实报出来')
  assert.equal(manifest.errorKind, '', '缺失不是整体失败：真停只有 manifest 读不到一条')
})

test('唯一真停：manifest 读不到 → ok:false / capability-gap，且不取任何正文', async () => {
  const { deps, written } = makeDeps(treeFor(['02 估值方法/02 市场法.md']), {
    loadManifest: async () => ({ ok: false, document: '', error: 'dws: 未登录' }),
  })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.ok, false)
  assert.equal(manifest.errorKind, 'capability-gap')
  assert.match(manifest.error, /唯一真停/)
  assert.match(manifest.error, /未登录/)
  assert.equal(written.size, 0)
})

test('manifest 解析不了（缺 version）→ ok:false / capability-gap，错误说清是哪一处', async () => {
  const { deps } = makeDeps([], { manifest: manifestDoc({ version: 2 }) })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.ok, false)
  assert.equal(manifest.errorKind, 'capability-gap')
  assert.match(manifest.error, /version/)
})

test('请求 manifest 没声明的 routeId → ok:false / input，并列出本库声明了哪些', async () => {
  const { deps, written } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: ['method.income.guide'] }, deps)
  assert.equal(manifest.ok, false)
  assert.equal(manifest.errorKind, 'input')
  assert.match(manifest.error, /method\.income\.guide/)
  assert.match(manifest.error, /method\.market\.guide/)
  assert.equal(written.size, 0, '输入错误不取任何数')
})

test('routeIds 省略 = 只回报可用槽位，不落任何正文', async () => {
  const { deps, written, indexWrites } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.deepEqual(manifest.availableRouteIds, [...DECLARED].sort())
  assert.deepEqual(manifest.routeIds, [])
  assert.equal(manifest.entries.length, 0)
  assert.equal(written.size, 0)
  assert.equal(indexWrites.length, 0)
})

test('物化：命中 → 一条 entry（实际节点名 / 指纹 / 落点 / 轨迹），并写逐路由 schema 文档 + 汇总索引', async () => {
  const { deps, written, indexWrites } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, planId: 'plan-001', routeIds: [GUIDE] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.equal(manifest.spaceName, VALUATION_KNOWLEDGE_SPACE)
  assert.equal(manifest.spaceVerified, true)
  assert.deepEqual(manifest.routeIds, [GUIDE])
  assert.equal(manifest.entries.length, 1)
  assert.equal(manifest.entries[0].routeId, GUIDE)
  assert.equal(manifest.entries[0].nodeName, '02 市场法.md')
  assert.equal(manifest.entries[0].resolvedPath, `${SUB}/02 估值方法/02 市场法.md`)
  assert.match(manifest.entries[0].digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(manifest.entries[0].sizeBytes > 0, true)
  assert.equal(manifest.entries[0].bodyNonEmpty, true)
  assert.equal(manifest.entries[0].snapshotFile, `${GUIDE}/02 市场法.md`)
  assert.equal(manifest.entries[0].source, 'dws')
  assert.equal(manifest.lookupAttempts.some((item) => item.routeId === GUIDE), true)
  assert.equal([...written.keys()].some((path) => path.startsWith(`${GUIDE}/`)), true)
  assert.equal(indexWrites.length, manifest.routeIds.length + 1, '每条路由一份 schema 文档 + 一份汇总索引')
  // 模型可见结构里没有 nodeId。
  assert.equal(JSON.stringify(manifest).includes('nodeId'), false)
})

test('manifestDigest 等于 manifest 正文的 sha256（报告要能说清依据的是哪一版取数口径）', async () => {
  const { deps, document } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.manifestDigest, knowledgeDigest(document))
  assert.match(manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(manifest.manifestDigest, knowledgeDigest(`${document}\n`), '正文变了指纹就要变')
})

test('manifest 里的路径指向一个目录 → 该 routeId state=empty，物化仍然 ok', async () => {
  // 声明的是目录（`methodSelection` 常这么写），库里也确实只有这个目录：如实记 empty + 缺口，
  // 不把它当正文，也不让整轮物化失败。
  const { deps } = makeDeps(
    [node(`${SUB}/02 估值方法/02 市场法/子文档.md`, { body: BODY('子文档') })],
    {
      manifest: manifestDoc({ methodSelection: '02 估值方法/02 市场法' }),
      folders: [`${SUB}/02 估值方法/02 市场法`],
    },
  )
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: ['method-selection'] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.equal(manifest.routes[0].state, 'empty')
  assert.equal(manifest.entries.length, 0)
  assert.equal(manifest.capabilityGaps.some((gap) => gap.includes('method-selection')), true)
})

test('找不到的 routeId（missing）同样不整体失败：state 如实，其余路由照取', async () => {
  const { deps } = makeDeps(treeFor(['05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE, 'method.market.template'] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.deepEqual(manifest.routes.map((item) => item.state), ['missing', 'found'])
  assert.equal(manifest.entries.length, 1)
  assert.equal(manifest.entries[0].routeId, 'method.market.template')
})

test('二进制槽位：templateId 就是槽位名、templateVerified=true、sizeBytes 是字节数', async () => {
  const { deps } = makeDeps(treeFor(['05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: ['method.market.template'] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  const entry = manifest.entries[0]
  assert.equal(entry.templateId, 'method.market.template')
  assert.equal(entry.templateVerified, true)
  assert.equal(entry.sizeBytes, new TextEncoder().encode('xlsx-bytes').length)
})

test('远程明确为空 ≠ 缺失：empty 时不查镜像（空文档不许被旧副本掩盖）', async () => {
  const { deps, mirrorCalls } = makeDeps([node(`${SUB}/02 估值方法/02 市场法.md`, { empty: true })])
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.routes[0].state, 'empty')
  assert.equal(mirrorCalls.length, 0, 'empty 不是 missing，不该退到镜像')
})

test('远程缺失才允许身份已验证镜像恢复：source=verified-mirror 且留 mirror 轨迹', async () => {
  const mirror = await makeMirror({
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    entries: [{ path: `${SUB}/02 估值方法/02 市场法.md`, bytes: BODY('镜像市场法') }],
  })
  const { deps, written } = makeDeps([], { mirror: { mirrorRoot: mirror } })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.ok, true, manifest.error)
  assert.equal(manifest.routes[0].state, 'found')
  assert.equal(manifest.entries[0].source, 'verified-mirror')
  assert.equal(manifest.lookupAttempts.some((item) => item.channel === 'mirror'), true)
  assert.equal([...written.values()].includes(BODY('镜像市场法')), true)
  // 镜像根是 Host 内部事实：逐条 entry 只带镜像内**相对**路径。
  assert.equal(manifest.mirrorRoot, mirror)
  assert.equal(manifest.entries[0].resolvedPath, `${SUB}/02 估值方法/02 市场法.md`)
  assert.equal(manifest.entries[0].resolvedPath.startsWith('/'), false)
  await rm(mirror, { recursive: true, force: true })
})

test('错误空间：catalog 报的是审核库 → spaceVerified=false，且正文照样如实取（不假装验证过）', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']), {
    catalog: catalog(treeFor(['02 估值方法/02 市场法.md']), { spaceName: '中瑞世联评估审核知识库', verified: false }),
  })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.spaceVerified, false)
  assert.equal(manifest.spaceName, '中瑞世联评估审核知识库')
  assert.equal(manifest.routes[0].state, 'unreadable')
  assert.equal(manifest.ok, true, '身份不成立是逐条路由的事，不是整体失败')
})

test('索引写失败不返回 ok：知识落盘了但来源索引没写成功也不算完成', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']), {
    writeIndex: async () => ({ ok: false, error: '磁盘只读' }),
  })
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(manifest.ok, false)
  assert.equal(manifest.errorKind, 'infrastructure')
  assert.match(manifest.error, /磁盘只读/)
  assert.equal(manifest.entries.length, 1, '正文确实取到了，失败的是索引')
})

test('物化结果里没有本地 references 兜底：正文只来自 dws / verified-mirror', async () => {
  const { deps } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, routeIds: [GUIDE] }, deps)
  assert.equal(JSON.stringify(manifest).includes('references/'), false)
  for (const entry of manifest.entries) {
    assert.equal(['dws', 'verified-mirror'].includes(entry.source), true)
  }
})

test('schema 文档：落盘结构与 knowledge-source.schema.json 逐字一致（每路由一份）', async () => {
  const { deps, written } = makeDeps(treeFor(['02 估值方法/02 市场法.md']))
  const manifest = await materializeKnowledge({ projectId: PROJECT, planId: 'plan-001', routeIds: [GUIDE] }, deps)
  const perRoute = manifest.indexFiles.find((path) => path.includes(GUIDE))
  assert.ok(perRoute !== undefined, `indexFiles 里要有一条本路由的 schema 文档：${manifest.indexFiles.join('、')}`)
  const document = JSON.parse(written.get(perRoute))
  assert.equal(document.schemaVersion, 'crwu.valuation.knowledge-source.v1')
  assert.equal(document.projectId, PROJECT)
  assert.equal(document.planId, 'plan-001')
  assert.equal(document.spaceName, VALUATION_KNOWLEDGE_SPACE)
  assert.equal(document.spaceVerified, true)
  assert.equal(document.routeId, GUIDE)
  assert.equal(Object.hasOwn(document, 'stage'), false, '阶段不再是取数口径的一部分')
  assert.equal(document.entries.length, 1)
  assert.deepEqual(
    Object.keys(document.entries[0]).sort(),
    ['bodyNonEmpty', 'digest', 'nodeName', 'resolvedPath', 'snapshotFile', 'source', 'updatedAt'],
  )
  assert.equal(document.entries[0].source, 'dws')
  assert.equal(document.entries[0].bodyNonEmpty, true)
  assert.equal(typeof document.materializedAt, 'string')
  for (const attempt of document.lookupAttempts) {
    assert.deepEqual(Object.keys(attempt).sort(), ['channel', 'detail', 'outcome', 'target'])
  }
  assert.equal(Object.keys(document).includes('mirrorRoot'), false, '没有镜像来源时不写 mirrorRoot')

  // toKnowledgeSourceDocument 与落盘的这一份是同一个形状。
  const again = toKnowledgeSourceDocument(manifest, GUIDE)
  assert.deepEqual(Object.keys(again).sort(), Object.keys(document).sort())
})

// ── parseValuationManifest：契约留在解析层 ─────────────────────────────────

test('manifest 解析：routeId 由键位推导，模板槽位 kind=binary', () => {
  const parsed = parseValuationManifest(manifestDoc())
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(parsed.methodSelection, '01 房地产估值通用')
  assert.deepEqual(parsed.routes.map((item) => [item.routeId, item.kind]), [
    ['method-selection', 'document'],
    ['method.market.guide', 'document'],
    ['method.market.template', 'binary'],
  ])
})

test('manifest 解析：路径基准是 manifest 自己的目录，不是知识库根', () => {
  const parsed = parseValuationManifest(manifestDoc())
  const guide = parsed.routes.find((item) => item.routeId === GUIDE)
  assert.equal(guide.path, '02 估值方法/02 市场法.md', 'manifest 里的路径逐字保留')
})

test('manifest 解析：三态槽位 —— null 跳过、键缺失算写坏', () => {
  const absent = parseValuationManifest(manifestDoc({
    methods: { market: { guide: null, template: null } },
  }))
  assert.equal(absent.ok, true, absent.error)
  assert.deepEqual(absent.routes.map((item) => item.routeId), ['method-selection'])
  assert.deepEqual(absent.problems, [])

  const missingKey = parseValuationManifest(manifestDoc({
    methods: { market: { guide: '02 估值方法/02 市场法.md' } },
  }))
  assert.equal(missingKey.ok, false)
  assert.match(missingKey.problems[0], /缺少 `template` 键/)
})

test('manifest 解析：路径不许逃出知识库（绝对路径与 .. 都拒绝）', () => {
  const absolute = parseValuationManifest(manifestDoc({ methodSelection: '/etc/passwd' }))
  assert.equal(absolute.ok, false)
  assert.match(absolute.error, /绝对路径/)

  const escape = parseValuationManifest(manifestDoc({ methodSelection: '../../etc/passwd' }))
  assert.equal(escape.ok, false)
  assert.match(escape.error, /`\.\.`/)
})

test('manifest 解析：Markdown 清单表是 JSON 段缺席时的受控适配，未登记槽位整行报错', () => {
  const table = [
    '# 知识目录',
    '',
    '| routeId | 路径 | 说明 |',
    '| --- | --- | --- |',
    '| method-selection | 01 房地产估值通用 | 方法选择 |',
    '| method.market.guide | 02 估值方法/02 市场法.md | 市场法正文 |',
    '| method.market.template | 05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx | 市场法模板 |',
    '',
  ].join('\n')
  const adapted = parseValuationManifest(table)
  assert.equal(adapted.ok, true, adapted.error)
  assert.deepEqual(adapted.routes.map((item) => item.routeId), DECLARED)
  assert.deepEqual(adapted.routes.map((item) => item.kind), ['document', 'document', 'binary'])

  const withBadRow = parseValuationManifest(`${table}| method.market.openai | 别的地方.md |\n`)
  assert.equal(withBadRow.ok, false)
  assert.match(withBadRow.error, /不是已登记的槽位/)
})

test('manifest 解析：一段机器可读内容都没有 → 读不到入口，如实失败', () => {
  const parsed = parseValuationManifest('# 知识目录\n\n这张表还没建。\n')
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /没有机器可读/)
  assert.deepEqual(parsed.routes, [])
})

// ── 配置口径 ───────────────────────────────────────────────────────────────

test('评估配置里 manifestPath 是库内相对路径，其余额留空即不启用镜像', async () => {
  const { parseWorkbenchYaml } = await import(new URL('src/host/config/yaml.ts', ROOT).href)
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('config/crwu-workbench.yml', ROOT), 'utf8')
  const config = parseWorkbenchYaml(source, 'config/crwu-workbench.yml')
  const knowledge = config.runtime.valuation.knowledge
  assert.equal(knowledge.manifestPath.startsWith('/'), false, 'manifestPath 相对知识库根，不是文件系统路径')
  assert.equal(knowledge.manifestPath.includes('..'), false)
  assert.equal(typeof knowledge.mirrorRoot, 'string')
})

// ── parseRuleParameters ────────────────────────────────────────────────────

const RULE_DIGEST = `sha256:${'a'.repeat(64)}`

function ruleBlock(overrides = {}) {
  return {
    ruleSetVersion: 'crwu.valuation.rule-parameters.v1',
    routeId: 'method.market.guide',
    snapshotDigest: RULE_DIGEST,
    sectionId: 'market-adjustment',
    parameters: [{
      ruleId: 'market.comparable-count.min',
      label: '可比案例最少数量',
      valueKind: 'count',
      value: 3,
      unit: '个',
      comparison: 'gte',
      appliesTo: { propertyTypes: ['residential'], methods: ['market'] },
      sourceRef: '中瑞世联业务知识库/02 估值方法/02 市场法',
      basisGrade: 'industry-standard',
      strength: 'must',
      missingHandling: 'block',
    }],
    ...overrides,
  }
}

function bodyWith(rule) {
  return `${'# 市场法\n正文。\n'}\n\`\`\`json\n${JSON.stringify(rule, null, 2)}\n\`\`\`\n`
}

test('parseRuleParameters：合法数据段 → 结构化参数（带 ruleId 与快照摘要）', () => {
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: bodyWith(ruleBlock()),
  })
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(parsed.parameters.length, 1)
  assert.equal(parsed.parameters[0].ruleId, 'market.comparable-count.min')
  assert.equal(parsed.parameters[0].valueKind, 'count')
  assert.equal(parsed.snapshotDigest, RULE_DIGEST)
  assert.equal(parsed.ruleSetVersion, 'crwu.valuation.rule-parameters.v1')
})

test('parseRuleParameters：snapshotDigest 对不上就整段不认', () => {
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide',
    snapshotDigest: `sha256:${'b'.repeat(64)}`,
    body: bodyWith(ruleBlock()),
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'digest-mismatch')
  assert.equal(parsed.parameters.length, 0)
  assert.match(parsed.error, /snapshotDigest|摘要/)
})

test('parseRuleParameters：缺结构化参数 → 返回缺口，不给默认值', () => {
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: '# 市场法\n只有自然语言，没有结构化段。\n',
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'missing')
  assert.equal(parsed.parameters.length, 0)
  assert.equal(parsed.gaps.length > 0, true)
})

test('parseRuleParameters：拒绝可执行代码 / shell / 任意 URL / 选择器字段', () => {
  const cases = [
    ruleBlock({ parameters: [{ ...ruleBlock().parameters[0], value: "eval('1+1')" }] }),
    ruleBlock({ parameters: [{ ...ruleBlock().parameters[0], value: '0.05; rm -rf /' }] }),
    ruleBlock({ parameters: [{ ...ruleBlock().parameters[0], sourceRef: 'https://example.invalid/rule' }] }),
    ruleBlock({ parameters: [{ ...ruleBlock().parameters[0], script: 'return 1' }] }),
    ruleBlock({ parameters: [{ ...ruleBlock().parameters[0], selector: '#price' }] }),
    ruleBlock({ expression: 'a * b' }),
  ]
  for (const rule of cases) {
    const parsed = parseRuleParameters({
      routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: bodyWith(rule),
    })
    assert.equal(parsed.ok, false, `必须拒绝：${JSON.stringify(rule).slice(0, 120)}`)
    assert.equal(parsed.errorKind, 'unsafe-content')
    assert.equal(parsed.parameters.length, 0)
  }
})

test('parseRuleParameters：畸形 JSON 提到 ruleSetVersion → invalid（不是静默忽略）', () => {
  const bad = '```json\n{ "ruleSetVersion": "crwu.valuation.rule-parameters.v1", "parameters": [ }\n```\n'
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: `# 市场法\n${bad}`,
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'invalid')
})

test('parseRuleParameters：同一份正文里两段规则 → ambiguous（不选第一段）', () => {
  const body = `# 市场法\n${'```json\n'}${JSON.stringify(ruleBlock())}\n${'```'}\n${'```json\n'}${JSON.stringify(ruleBlock())}\n${'```'}\n`
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body,
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'ambiguous')
})

test('parseRuleParameters：缺少必填字段的数据段不是合法规则（缺结构化参数按缺口处理）', () => {
  const incomplete = ruleBlock({
    parameters: [{ ...ruleBlock().parameters[0], sourceRef: '' }],
  })
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: bodyWith(incomplete),
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'invalid')
  assert.equal(parsed.parameters.length, 0)
})

test('parseRuleParameters：fragment may omit routeId/snapshotDigest and Host binds both', () => {
  const fragment = ruleBlock()
  delete fragment.routeId
  delete fragment.snapshotDigest
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST, body: bodyWith(fragment),
  })
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(parsed.routeId, 'method.market.guide')
  assert.equal(parsed.snapshotDigest, RULE_DIGEST)
  assert.equal(parsed.parameters.length, 1)
})

test('parseRuleParameters：missing Host metadata rejects instead of inventing provenance', () => {
  const noRoute = parseRuleParameters({ routeId: '', snapshotDigest: RULE_DIGEST, body: bodyWith(ruleBlock()) })
  assert.equal(noRoute.ok, false)
  assert.equal(noRoute.errorKind, 'missing')
  const noDigest = parseRuleParameters({ routeId: 'method.market.guide', snapshotDigest: '', body: bodyWith(ruleBlock()) })
  assert.equal(noDigest.ok, false)
  assert.equal(noDigest.errorKind, 'missing')
})

test('parseRuleParameters：an explicitly mismatched routeId is still rejected', () => {
  const parsed = parseRuleParameters({
    routeId: 'method.market.guide', snapshotDigest: RULE_DIGEST,
    body: bodyWith(ruleBlock({ routeId: 'method.income.guide' })),
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'invalid')
  assert.equal(parsed.parameters.length, 0)
})

// ── 指纹 ───────────────────────────────────────────────────────────────────

test('knowledgeSnapshotDigest 对同一批来源稳定（顺序无关），内容变了就变', () => {
  const make = (routeId, digest) => ({
    routeId, nodeName: '', resolvedPath: '', source: 'dws', digest, sizeBytes: 0, snapshotFile: '',
    mediaType: '', updatedAt: '', bodyNonEmpty: true, channel: 'exact-route',
    sectionIds: [], ruleIds: [], templateId: null, templateContractVersion: null, templateVerified: null,
  })
  const a = [make('a', 'sha256:1'), make('b', 'sha256:2')]
  const b = [make('b', 'sha256:2'), make('a', 'sha256:1')]
  assert.equal(knowledgeSnapshotDigest(a), knowledgeSnapshotDigest(b))
  assert.match(knowledgeSnapshotDigest(a), /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(knowledgeSnapshotDigest(a), knowledgeSnapshotDigest([make('a', 'sha256:9'), make('b', 'sha256:2')]))
})

// ── 配置与目录名 ───────────────────────────────────────────────────────────

test('知识快照目录与索引文件名保持稳定（提示词与工具共用同一处口径）', () => {
  assert.equal(KNOWLEDGE_SNAPSHOT_DIR, '知识快照')
  assert.equal(KNOWLEDGE_INDEX_FILE, '.知识来源.json')
})
