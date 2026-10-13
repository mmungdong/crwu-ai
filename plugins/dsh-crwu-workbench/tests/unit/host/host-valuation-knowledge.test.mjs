/**
 * 估值业务知识路由（协议 32）的决策层单元测试。
 *
 * 这一层决定"子会话拿到哪一版知识"，所以每条断言都对着一条**会静默出错**的规则：
 *
 * 1. **本地 fallback 显式列表**，绝不按文件名/编号猜。本地 `07-cost-method.md` 对应库内
 *    `04-成本法` —— 按编号猜的话成本法会读到"案例选取"的正文，而且不报任何错。
 * 2. **DSW 优先**：节点在库里就用库里的正文（本地那份只是备份）。
 * 3. **探测失败 ≠ 节点不存在**：前者要进 `capability_gaps`（否则"知识库挂过"永远查不出来），
 *    后者只是正常降级。
 * 4. **`01-房地产估值通用` 两边都缺 → 停止估值**，不是"继续 + 缺口"。
 * 5. **空正文不算命中**：节点存在但导出为空时若算命中，子会话会拿一段空上下文去"按规范"编。
 * 6. 每条来源都带 `digest`，且指纹按路由排序算 —— 同一批正文换个取数顺序，指纹必须不变。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  KNOWLEDGE_SUBDOMAIN,
  VALUATION_KNOWLEDGE_ROUTES,
  VALUATION_KNOWLEDGE_SPACE,
  missingLocalReferences,
  knowledgeSnapshotDigest,
  knowledgeSourcesView,
  resolveKnowledgePlan,
  routeByPath,
  routesForMethod,
  emptyKnowledgeProbe,
  localKnowledgeProbe,
  localReferencePath,
} = await import(new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)

/** 一个只回固定事实的探针。 */
function probe(dws = {}, local = {}) {
  const calls = { dws: [], local: [] }
  return {
    calls,
    probe: {
      dws(route) { calls.dws.push(route.node); return dws[route.node] ?? { found: false } },
      local(route) { calls.local.push(route.node); return local[route.node] ?? { found: false } },
    },
  }
}

const BODY = (name) => `# ${name}\n正文内容。\n`

// ── 路由表 ──────────────────────────────────────────────────────────────────

test('路由表：七条库内节点逐一列出，路径统一落在「估值与测算/房地产」下', () => {
  assert.equal(VALUATION_KNOWLEDGE_ROUTES.length, 7)
  assert.deepEqual(
    VALUATION_KNOWLEDGE_ROUTES.map((route) => route.node),
    ['01-房地产估值通用', '02-市场法', '03-收益法', '04-成本法', '05-案例选取', '06-参数与税费', '07-计算表模板'],
  )
  for (const route of VALUATION_KNOWLEDGE_ROUTES) {
    assert.equal(route.route, `${KNOWLEDGE_SUBDOMAIN}/${route.node}`)
    assert.match(route.localReference, /^references\/.+\.md$/)
    assert.ok(route.when.length > 0, `${route.node} 要说清什么时候读它`)
  }
  assert.equal(VALUATION_KNOWLEDGE_SPACE, '中瑞世联业务知识库', '业务库与审核库不是同一个')
})

test('只有「01-房地产估值通用」是必需知识', () => {
  const required = VALUATION_KNOWLEDGE_ROUTES.filter((route) => route.required)
  assert.deepEqual(required.map((route) => route.node), ['01-房地产估值通用'])
})

test('本地 fallback 映射**逐个写死**，编号不一致也不许按编号推导', () => {
  const mapping = Object.fromEntries(
    VALUATION_KNOWLEDGE_ROUTES.map((route) => [route.node, route.localReference]),
  )
  assert.equal(mapping['01-房地产估值通用'], 'references/01-realestate-valuation.md')
  assert.equal(mapping['02-市场法'], 'references/02-market-method.md')
  assert.equal(mapping['03-收益法'], 'references/03-income-method.md')
  // ⚠️ 关键一条：库内 04 是成本法，而本地 04 是「案例选取」。
  assert.equal(mapping['04-成本法'], 'references/07-cost-method.md')
  assert.equal(mapping['05-案例选取'], 'references/04-case-selection.md')
  assert.equal(mapping['06-参数与税费'], 'references/05-parameter-mapping.md')
  assert.equal(mapping['07-计算表模板'], 'references/06-workbook-contract.md')
})

test('路由表里的本地参考文件**全部真实存在**（重命名不许让 fallback 静默失效）', () => {
  assert.deepEqual(missingLocalReferences(VALUATION_KNOWLEDGE_ROUTES), [],
    '有文件不见了：fallback 会在知识库不可达时变成"两边都没有"进而停止估值')
  for (const route of VALUATION_KNOWLEDGE_ROUTES) {
    assert.notEqual(localReferencePath(route), '')
  }
})

test('按方法裁剪需要哪些知识：选市场法就不必读收益法 / 成本法', () => {
  const market = routesForMethod('market').map((route) => route.node)
  assert.deepEqual(market, ['01-房地产估值通用', '02-市场法', '05-案例选取', '06-参数与税费', '07-计算表模板'])
  const income = routesForMethod('income').map((route) => route.node)
  assert.equal(income.includes('03-收益法'), true)
  assert.equal(income.includes('02-市场法'), false)
  const auto = routesForMethod('auto').map((route) => route.node)
  assert.equal(auto.length, 7, 'auto 需要全部方法类知识（方法由 AI 判定）')
})

test('routeByPath 逐字匹配（不折叠大小写、不猜前缀）', () => {
  assert.equal(routeByPath(`${KNOWLEDGE_SUBDOMAIN}/02-市场法`)?.node, '02-市场法')
  assert.equal(routeByPath(`${KNOWLEDGE_SUBDOMAIN}/02-市场`) , undefined)
  assert.equal(routeByPath('02-市场法'), undefined, '必须是完整业务路由')
})

// ── 决策：优先级与降级 ──────────────────────────────────────────────────────

test('DSW 有节点就用 DSW 的正文（本地那份只是备份）', async () => {
  const { probe: p, calls } = probe(
    { '02-市场法': { found: true, body: BODY('库内市场法'), updatedAt: '2026-10-01T00:00:00Z' } },
    { '02-市场法': { found: true, body: BODY('本地市场法') } },
  )
  const resolved = await resolveKnowledgePlan({ method: 'market', probe: p })
  const market = resolved.sources.find((item) => item.node === '02-市场法')
  assert.equal(market.source, 'dws')
  assert.equal(market.updatedAt, '2026-10-01T00:00:00Z')
  assert.equal(resolved.bodies.find((item) => item.node === '02-市场法').body, BODY('库内市场法'))
  assert.equal(calls.local.includes('02-市场法'), false, 'DSW 命中就不必读本地')
})

test('DSW 没有该节点 → 用本地参考（sanctioned 降级，只记观察不记缺口）', async () => {
  const { probe: p } = probe({}, { '03-收益法': { found: true, body: BODY('本地收益法') } })
  const resolved = await resolveKnowledgePlan({
    method: 'income', probe: p,
    routes: VALUATION_KNOWLEDGE_ROUTES.filter((route) => route.node === '03-收益法'),
  })
  const income = resolved.sources[0]
  assert.equal(income.source, 'local')
  assert.equal(income.digest.startsWith('sha256:'), true)
  assert.equal(income.updatedAt, '', '本地文件不拿 mtime 冒充知识库更新时间')
  assert.equal(resolved.capabilityGaps.length, 0, '有本地备份不算能力缺口')
  assert.equal(resolved.warnings.some((item) => /知识库里没有这个节点/.test(item)), true)
})

test('DSW 探测**失败**（不是"没有"）→ 记能力缺口，再走本地', async () => {
  const { probe: p } = probe(
    { '05-案例选取': { found: false, error: 'dws 命令失败：退出码 1' } },
    { '05-案例选取': { found: true, body: BODY('本地案例选取') } },
  )
  const resolved = await resolveKnowledgePlan({
    method: 'market', probe: p,
    routes: VALUATION_KNOWLEDGE_ROUTES.filter((route) => route.node === '05-案例选取'),
  })
  assert.equal(resolved.sources[0].source, 'local')
  assert.equal(resolved.capabilityGaps.length, 1)
  assert.match(resolved.capabilityGaps[0], /知识库读取失败/)
  assert.match(resolved.capabilityGaps[0], /退出码 1/, '真实原因要带出来')
})

test('探针自己抛错也要收敛成缺口，不许把整轮估值打崩', async () => {
  const throwing = {
    dws: () => { throw new Error('profile 未登录') },
    local: () => ({ found: true, body: BODY('本地') }),
  }
  const resolved = await resolveKnowledgePlan({
    method: 'market', probe: throwing,
    routes: VALUATION_KNOWLEDGE_ROUTES.filter((route) => route.node === '06-参数与税费'),
  })
  assert.equal(resolved.ok, true, resolved.error)
  assert.match(resolved.capabilityGaps[0], /profile 未登录/)
})

test('其它路由两边都缺 → 继续能算的部分 + capability gap（点名缺哪一份）', async () => {
  const { probe: p } = probe({}, { '01-房地产估值通用': { found: true, body: BODY('通用') } })
  const resolved = await resolveKnowledgePlan({ method: 'market', probe: p })
  assert.equal(resolved.ok, true, resolved.error)
  const missing = resolved.sources.filter((item) => item.source === 'missing').map((item) => item.node)
  assert.deepEqual(missing, ['02-市场法', '05-案例选取', '06-参数与税费', '07-计算表模板'])
  for (const node of missing) {
    assert.equal(resolved.capabilityGaps.some((item) => item.includes(node)), true, `${node} 要出现在缺口里`)
  }
  assert.equal(resolved.sources.find((item) => item.node === '02-市场法').missingReason.length > 0, true)
})

test('必需知识「01-房地产估值通用」两边都缺 → **停止估值**（不是继续 + 缺口）', async () => {
  const { probe: p } = probe({ '02-市场法': { found: true, body: BODY('市场法') } })
  const resolved = await resolveKnowledgePlan({ method: 'market', probe: p })
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /01-房地产估值通用/)
  assert.match(resolved.error, /停止/)
  assert.equal(resolved.capabilityGaps.some((item) => /缺少必需知识/.test(item)), true)
  // 已经拿到的其它来源要如实带回去（诊断要看得出"只差这一份"）。
  assert.equal(resolved.sources.some((item) => item.node === '02-市场法' && item.source === 'dws'), true)
})

test('空正文不算命中：节点在但导出为空时按"没有"处理', async () => {
  const { probe: p } = probe(
    {
      '01-房地产估值通用': { found: true, body: '   \n' },
      '02-市场法': { found: true, body: '' },
    },
    { '01-房地产估值通用': { found: true, body: BODY('本地通用') } },
  )
  const resolved = await resolveKnowledgePlan({ method: 'market', probe: p })
  assert.equal(resolved.sources.find((item) => item.node === '01-房地产估值通用').source, 'local',
    '空正文要退到本地，而不是当成"库里有"')
  assert.equal(resolved.sources.find((item) => item.node === '02-市场法').source, 'missing')
})

test('一个探针都不给（两边都没有）时：必需知识缺失 → 停止', async () => {
  const resolved = await resolveKnowledgePlan({ method: 'auto', probe: emptyKnowledgeProbe() })
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /缺少必需的业务知识/)
})

// ── 指纹与视图 ──────────────────────────────────────────────────────────────

test('来源指纹按路由排序计算：取数顺序不影响结果', async () => {
  const routes = VALUATION_KNOWLEDGE_ROUTES
  const bodies = Object.fromEntries(routes.map((route) => [route.node, { found: true, body: BODY(route.node) }]))
  const forward = await resolveKnowledgePlan({ method: 'auto', probe: probe(bodies).probe, routes })
  const reversed = await resolveKnowledgePlan({ method: 'auto', probe: probe(bodies).probe, routes: [...routes].reverse() })
  assert.equal(forward.digest, reversed.digest)
  assert.match(forward.digest, /^sha256:[0-9a-f]{64}$/)
  // 正文改了，指纹必须变。
  const changed = await resolveKnowledgePlan({
    method: 'auto', routes,
    probe: probe({ ...bodies, '02-市场法': { found: true, body: BODY('改过的市场法') } }).probe,
  })
  assert.notEqual(changed.digest, forward.digest)
})

test('来源视图只给可核对的事实（路由 / 来源 / 更新时间 / 指纹），不带正文', async () => {
  const { probe: p } = probe({ '01-房地产估值通用': { found: true, body: BODY('通用') } })
  const resolved = await resolveKnowledgePlan({
    method: 'income', probe: p, routes: [VALUATION_KNOWLEDGE_ROUTES[0]],
  })
  const view = knowledgeSourcesView(resolved.sources)
  assert.deepEqual(Object.keys(view[0]).sort(), ['digest', 'route', 'source', 'updatedAt'])
  assert.equal(JSON.stringify(view).includes('正文'), false, '正文不进视图')
})

test('落点文件名去掉路径分隔符（库内节点名不该能拼出越界路径）', async () => {
  const { probe: p } = probe({ '01-房地产估值通用': { found: true, body: BODY('通用') } })
  const resolved = await resolveKnowledgePlan({
    method: 'income', probe: p, routes: [VALUATION_KNOWLEDGE_ROUTES[0]], dir: '知识快照',
  })
  assert.equal(resolved.bodies[0].file, '知识快照/01-房地产估值通用.md')
  for (const body of resolved.bodies) {
    assert.equal(body.file.includes('..'), false)
    assert.match(body.file, /^知识快照\//)
  }
})

test('knowledgeSnapshotDigest 对同一批来源稳定（大小写与顺序无关）', () => {
  const make = (route, digest) => ({ route, node: '', source: 'dws', file: '', digest, bytes: 1, updatedAt: '', when: '', missingReason: '' })
  const a = [make('a', 'sha256:1'), make('b', 'sha256:2')]
  const b = [make('b', 'sha256:2'), make('a', 'sha256:1')]
  assert.equal(knowledgeSnapshotDigest(a), knowledgeSnapshotDigest(b))
  assert.notEqual(knowledgeSnapshotDigest(a), knowledgeSnapshotDigest([make('a', 'sha256:9'), make('b', 'sha256:2')]))
})

// ── 本地读取器 ──────────────────────────────────────────────────────────────

test('本地读取器真的读得到技能自带的参考文件（不是空正文）', async () => {
  const local = localKnowledgeProbe()
  for (const route of VALUATION_KNOWLEDGE_ROUTES) {
    const result = await local(route)
    assert.equal(result.found, true, `${route.localReference} 读不到`)
    assert.ok(String(result.body).length > 200, `${route.localReference} 正文太短，怀疑读错了文件`)
  }
})

test('本地读取器按路由表映射文件：成本法读到的是成本法正文', async () => {
  const local = localKnowledgeProbe()
  const cost = VALUATION_KNOWLEDGE_ROUTES.find((route) => route.node === '04-成本法')
  const result = await local(cost)
  const body = String(result.body)
  assert.match(body, /成本法/)
  assert.equal(/案例选取/.test(body.slice(0, 400)), false, '成本法不许读到案例选取的正文')
})

test('SKILL.md 的映射表与路由表一致（AI 读到的与工具取到的必须是同一份）', async () => {
  // 两处都描述"库内节点 → 本地文件"，但消费者不同：SKILL.md 给 AI 看，路由表驱动工具。
  // 一旦漂移，AI 会以为某条规范在 A 文件、工具却把 B 文件倒进案例目录 —— 两边都不报错。
  const { readFile } = await import('node:fs/promises')
  const skill = await readFile(new URL('skills/biz/crwU-biz-valuation-realestate/SKILL.md'.replace('crwU', 'crwu'), ROOT), 'utf8')
  for (const route of VALUATION_KNOWLEDGE_ROUTES) {
    const expected = `\`${route.node}\` | [${route.localReference.replace('references/', '')}](references/${route.localReference.replace('references/', '')})`
    assert.equal(skill.includes(expected), true, `SKILL.md 缺少映射行：${expected}`)
  }
})

test('references/ 里出现的库内节点名**全部**是路由表里的合法节点（禁止旧编号残留）', async () => {
  // 正文之间互相引用（"细则见 `06-参数与税费`"）。编号换过一次（本地写作顺序 → 库内业务路由），
  // 残留的旧编号不会报错 —— 只会让 AI 去找一个不存在的节点，或落到**错的**节点上。
  // 这条断言把它变成红灯。
  const { readFile, readdir } = await import('node:fs/promises')
  const skillDir = new URL('skills/biz/crwu-biz-valuation-realestate/', ROOT)
  const known = new Set(VALUATION_KNOWLEDGE_ROUTES.map((route) => route.node))
  const referenced = new Set()
  for (const name of await readdir(new URL('references/', skillDir))) {
    if (!name.endsWith('.md')) continue
    const body = await readFile(new URL(`references/${name}`, skillDir), 'utf8')
    for (const match of body.matchAll(/`(0[1-9]-[^`]{2,12})`/g)) {
      if (/^0[1-9]-/.test(match[1])) referenced.add(match[1])
    }
  }
  assert.ok(referenced.size > 0, '前提：正文之间确实互相引用（否则这条断言没有意义）')
  for (const node of referenced) {
    assert.equal(known.has(node), true, `references 里引用了不存在的库内节点：${node}`)
  }
})
