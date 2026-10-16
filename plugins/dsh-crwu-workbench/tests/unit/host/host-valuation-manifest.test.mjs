/**
 * 知识库侧 manifest 的**解析层**单元测试（设计稿 §4.1）。
 *
 * 这一层决定"哪几份知识要被取"，所以每条断言都对着一条**会静默读错**的规则：
 *
 * 1. **`null` ≠ 写坏了**：`guide` / `template` 为 `null` 是"该项还没写"（收益法、成本法正文
 *    当前在库中为空，走的就是这一路）；**字段缺失**才是 manifest 写坏了。混同会让整份 manifest
 *    因为一个还没写的 TODO 方法而作废，或者反过来让一个漏写的键静默变成"不支持"。
 * 2. **路径不许逃出知识库**：`..` 与绝对路径一律拒绝，否则 manifest 能指向库外文件。
 * 3. **两个 slot 指同一份文件是合法的**：不得因"重复"报错 —— 方法之间共用一份正文是正常配置。
 * 4. **解析不了就说清要哪一种形态**：不静默降级成"没有规则"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { manifestRoutePath, parseValuationManifest } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/manifest.ts', ROOT).href
)

const MANIFEST = {
  version: 1,
  methodSelection: '02 估值方法/01 房地产评估方法选择方案.md',
  methods: {
    market: {
      guide: '02 估值方法/02 市场法.md',
      template: '05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx',
    },
    income: { guide: '02 估值方法/03 收益法（TODO）.md', template: null },
    cost: { guide: '02 估值方法/04 成本法（TODO）.md', template: null },
  },
}

const fenced = (payload) => ['# 知识目录与必需项', '', '```json', JSON.stringify(payload, null, 2), '```', ''].join('\n')

const routeIds = (result) => result.routes.map((route) => route.routeId)

test('JSON 围栏里的 manifest 解析出方法选择与三个方法的槽位', () => {
  const result = parseValuationManifest(fenced(MANIFEST))

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.problems, [])
  assert.equal(result.methodSelection, '02 估值方法/01 房地产评估方法选择方案.md')
  assert.deepEqual(routeIds(result).sort(), [
    'method-selection',
    'method.cost.guide',
    'method.income.guide',
    'method.market.guide',
    'method.market.template',
  ])
})

test('kind 由槽位决定：正文是 document，计算表模板是 binary', () => {
  const result = parseValuationManifest(fenced(MANIFEST))
  const kindOf = (routeId) => result.routes.find((route) => route.routeId === routeId)?.kind

  assert.equal(kindOf('method-selection'), 'document')
  assert.equal(kindOf('method.market.guide'), 'document')
  assert.equal(kindOf('method.market.template'), 'binary')
})

test('template 为 null 是"该方法还没有模板"，不是 manifest 写坏了', () => {
  const result = parseValuationManifest(fenced(MANIFEST))

  assert.equal(result.ok, true, result.error)
  assert.ok(!routeIds(result).includes('method.income.template'))
})

test('template 字段缺失才是 manifest 写坏了', () => {
  const broken = {
    ...MANIFEST,
    methods: { market: { guide: '02 估值方法/02 市场法.md' } },
  }
  const result = parseValuationManifest(fenced(broken))

  assert.equal(result.ok, false)
  assert.ok(result.problems.length > 0, '缺 template 键必须报 problem，不得静默当成 null')
})

test('guide 为 null 是"该方法的正文还没写"，不是 manifest 写坏了', () => {
  const pending = {
    version: 1,
    methodSelection: MANIFEST.methodSelection,
    methods: { income: { guide: null, template: null } },
  }
  const result = parseValuationManifest(fenced(pending))

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(routeIds(result), ['method-selection'])
})

test('guide 字段缺失才是 manifest 写坏了', () => {
  const broken = {
    version: 1,
    methodSelection: MANIFEST.methodSelection,
    methods: { market: { template: null } },
  }
  const result = parseValuationManifest(fenced(broken))

  assert.equal(result.ok, false)
  assert.ok(result.problems.length > 0, '缺 guide 键必须报 problem')
})

test('不支持的 version 拒绝', () => {
  const result = parseValuationManifest(fenced({ ...MANIFEST, version: 2 }))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /version|版本/)
})

test('路径含 .. 拒绝，不得逃出知识库根', () => {
  const escaping = {
    version: 1,
    methodSelection: '../../../../etc/passwd',
    methods: {},
  }
  const result = parseValuationManifest(fenced(escaping))

  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('..')), result.problems.join('；'))
})

test('绝对路径拒绝', () => {
  const absolute = {
    version: 1,
    methodSelection: '/etc/passwd',
    methods: {},
  }
  const result = parseValuationManifest(fenced(absolute))

  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('绝对')), result.problems.join('；'))
})

test('两个槽位指向同一份文件是合法配置，不得因重复报错', () => {
  const shared = {
    version: 1,
    methodSelection: MANIFEST.methodSelection,
    methods: {
      market: { guide: '02 估值方法/02 市场法.md', template: null },
      income: { guide: '02 估值方法/02 市场法.md', template: null },
    },
  }
  const result = parseValuationManifest(fenced(shared))

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(routeIds(result).sort(), ['method-selection', 'method.income.guide', 'method.market.guide'])
})

test('既没有 JSON 围栏也没有清单表时，说清需要哪一种形态而不是"没有规则"', () => {
  const result = parseValuationManifest('# 知识目录\n\n这里只有散文，没有任何机器可读段。\n')

  assert.equal(result.ok, false)
  assert.ok(result.error.length > 0)
  assert.match(result.error, /json|清单表/i)
})

test('methodSelection 为 null 同样是"还没写"，不是写坏了', () => {
  const pending = {
    version: 1,
    methodSelection: null,
    methods: { market: { guide: '02 估值方法/02 市场法.md', template: null } },
  }
  const result = parseValuationManifest(fenced(pending))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.methodSelection, null)
  assert.deepEqual(routeIds(result), ['method.market.guide'])
})

test('Markdown 清单表能被适配成同一套槽位', () => {
  const table = [
    '# 知识目录',
    '',
    '| routeId | 路径 |',
    '| --- | --- |',
    '| method-selection | 02 估值方法/01 房地产评估方法选择方案.md |',
    '| method.market.guide | 02 估值方法/02 市场法.md |',
    '| method.market.template | 05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx |',
    '',
  ].join('\n')
  const result = parseValuationManifest(table)

  assert.equal(result.ok, true, result.error)
  assert.equal(result.methodSelection, '02 估值方法/01 房地产评估方法选择方案.md')
  assert.deepEqual(routeIds(result), ['method-selection', 'method.market.guide', 'method.market.template'])
})

test('清单表里没登记的 routeId 整行报 problem，不猜', () => {
  const table = [
    '| routeId | 路径 |',
    '| --- | --- |',
    '| method-selection | 02 估值方法/01 房地产评估方法选择方案.md |',
    '| 市场法 | 02 估值方法/02 市场法.md |',
    '',
  ].join('\n')
  const result = parseValuationManifest(table)

  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('市场法')), result.problems.join('；'))
})

test('manifest 内的路径相对 manifest 自己所在的目录拼接', () => {
  const path = manifestRoutePath('01 估值与测算/01 房地产', {
    routeId: 'method.market.guide',
    path: '02 估值方法/02 市场法.md',
    kind: 'document',
  })

  assert.equal(path, '01 估值与测算/01 房地产/02 估值方法/02 市场法.md')
})
