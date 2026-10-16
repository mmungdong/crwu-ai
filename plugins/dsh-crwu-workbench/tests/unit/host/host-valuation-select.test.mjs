/**
 * 候选的**批量筛选与优选**（协议 39 · 设计稿 §7.2 / §7.3）。
 *
 * 这一层只做"机械"：硬性排除、确定性排序、名额截断；**名额 / 优先级 / 渠道顺序都由知识声明**，
 * 代码里没有默认值。这里逐条钉住：
 *
 * 1. 缺 `maxAdopted` / `order` / `sourceOrder` 一律拒绝（绝不补一个"惯例 3"）；
 * 2. 挂牌 / 无证据被**硬性排除**，且不能因为"数量不够"被启用；
 * 3. 排序是逐级比较、完全确定（同一批输入同一批入选 —— 稳定编号的前提）；
 * 4. 落选理由具体到差额 / 名次 / 名额。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { hardExclusionOf, normalizeSelectionRule, selectCandidates } = await import(
  new URL('src/host/domains/report-evaluation/market/select.ts', ROOT).href)

/** 一条候选（默认是可用案例；要造不能用的就 patch）。 */
function caseOf(patch = {}) {
  return {
    source: 'lianjia', sourceLabel: '链家', url: 'https://example.invalid/a',
    title: '', community: '阳光小区', purpose: '', propertyNature: '',
    buildingArea: 100, floor: '', totalFloors: '', builtYear: '', decoration: '',
    price: 5_000_000, unitPrice: 50_000, transactionType: '成交', publishedAt: '2026-09-01',
    capturedAt: '2026-10-15T00:00:00.000Z', evidence: '来源证据/a.html',
    ...patch,
  }
}

const ruleOf = (patch = {}) => ({ maxAdopted: 3, order: [{ key: 'transaction-first' }], sourceOrder: [], ...patch })

// Knowledge assessment carried on the selection rule (extra property today).
const assessmentOf = (url, status, patch = {}) => ({
  url, status, reason: '按知识正文判定', knowledgeRef: '02 市场法 §2.1', ...patch,
})

// ── 规则收窄：没有默认值 ────────────────────────────────────────────────────

test('缺名额 / 缺顺序 / 缺渠道顺序一律拒绝（代码里没有默认值）', () => {
  const noQuota = normalizeSelectionRule({ order: [{ key: 'transaction-first' }] })
  assert.equal(noQuota.ok, false)
  assert.match(noQuota.error, /业务事实/)
  assert.match(noQuota.error, /没有默认名额/)
  assert.equal(normalizeSelectionRule({ maxAdopted: 0, order: [{ key: 'transaction-first' }] }).ok, false)
  assert.equal(normalizeSelectionRule({ maxAdopted: 3 }).ok, false, '缺 order')
  assert.match(normalizeSelectionRule({ maxAdopted: 3 }).error, /没有默认顺序/)
  assert.equal(normalizeSelectionRule(null).ok, false)
  assert.equal(normalizeSelectionRule({ maxAdopted: 3, order: [{ key: '瞎编' }] }).ok, false)
  assert.equal(normalizeSelectionRule({ maxAdopted: 3, order: 'x' }).ok, false)
  // source-rank 必须配 sourceOrder；差值比较必须给出对象侧的值。
  assert.match(normalizeSelectionRule({ maxAdopted: 3, order: [{ key: 'source-rank' }] }).error, /渠道顺序是业务事实/)
  assert.match(normalizeSelectionRule({ maxAdopted: 3, order: [{ key: 'area-delta-asc' }] }).error, /需要 subjectArea/)
  assert.match(normalizeSelectionRule({ maxAdopted: 2, order: [{ key: 'unit-price-delta-asc' }] }).error, /需要 subjectUnitPrice/)

  const good = normalizeSelectionRule({ maxAdopted: 3, order: [{ key: 'transaction-first' }], sourceOrder: [] })
  assert.equal(good.ok, true, good.error)
  assert.equal(good.rule.maxAdopted, 3)
})

// ── 硬性排除 ────────────────────────────────────────────────────────────────

test('挂牌 / 询价不能直接作可比实例；没有页面证据的也不能', () => {
  assert.equal(hardExclusionOf(caseOf()), '')
  assert.match(hardExclusionOf(caseOf({ transactionType: '挂牌' })), /挂牌 \/ 询价只能作观察/)
  assert.match(hardExclusionOf(caseOf({ transactionType: '询价' })), /挂牌 \/ 询价只能作观察/)
  assert.match(hardExclusionOf(caseOf({ evidence: '' })), /没有页面证据/)
  // 交易性质未知（空串）**不得**进入可比案例：未知不等于成交，缺省朝安全一侧倒。
  // 当前实现把空串当作可用（见 2026-10-16 诊断 §3.3），这条断言现在是红的。
  const unknown = hardExclusionOf(caseOf({ transactionType: '' }))
  assert.notEqual(unknown, '', '未知交易性质必须被排除，并给出"未确认"的具体理由')
  assert.match(unknown, /交易性质|未确认|未知|挂牌/)
})

test('硬性排除的案例**不会**因为名额没满被启用，理由逐条留下', () => {
  const outcome = selectCandidates([
    caseOf({ url: 'https://example.invalid/sold', transactionType: '成交' }),
    caseOf({ url: 'https://example.invalid/listed', transactionType: '挂牌' }),
    caseOf({ url: 'https://example.invalid/noev', evidence: '' }),
  ], ruleOf({
    maxAdopted: 3,
    assessments: [
      assessmentOf('https://example.invalid/sold', 'qualified', { reason: '成交且字段完整' }),
      assessmentOf('https://example.invalid/listed', 'excluded', { reason: '挂牌不可直接作可比实例' }),
      assessmentOf('https://example.invalid/noev', 'excluded', { reason: '没有页面证据' }),
    ],
  }))
  assert.deepEqual(outcome.adopted.map((item) => item.url), ['https://example.invalid/sold'])
  assert.equal(outcome.rejected.length, 2)
  assert.match(outcome.rejected[0].reason + outcome.rejected[1].reason, /挂牌 \/ 询价只能作观察/)
  assert.match(outcome.rejected[0].reason + outcome.rejected[1].reason, /没有页面证据/)
  assert.match(outcome.notes.join('；'), /硬性排除 2 条/)
  assert.match(outcome.notes.join('；'), /不要\*\*用不可用的案例凑数|不要.*凑数/)
  assert.match(outcome.notes.join('；'), /少于知识声明的名额 3 条/)
})

// ── 排序与名额 ──────────────────────────────────────────────────────────────

test('逐级比较与名额截断：面积最接近的先入选，落选理由具体到名次与名额', () => {
  const near = caseOf({ url: 'https://example.invalid/1', buildingArea: 104 })
  const mid = caseOf({ url: 'https://example.invalid/2', buildingArea: 160 })
  const far = caseOf({ url: 'https://example.invalid/3', buildingArea: 200 })
  const rule = {
    maxAdopted: 2,
    order: [{ key: 'area-delta-asc', subjectArea: 100 }],
    sourceOrder: [],
    assessments: [
      assessmentOf('https://example.invalid/1', 'qualified'),
      assessmentOf('https://example.invalid/2', 'qualified'),
      assessmentOf('https://example.invalid/3', 'qualified'),
    ],
  }
  const outcome = selectCandidates([far, mid, near], rule)
  assert.deepEqual(outcome.adopted.map((item) => item.url),
    ['https://example.invalid/1', 'https://example.invalid/2'], '面积最接近的先入选')
  const quota = outcome.rejected.find((item) => item.case.url === 'https://example.invalid/3')
  assert.notEqual(quota, undefined)
  assert.match(quota.reason, /排在第 3 名/)
  assert.match(quota.reason, /超出本轮名额（2 条）/)
  assert.match(quota.reason, /可按编号纳入重算/)
  assert.match(quota.reason, /area-delta-asc/, '理由里带上是按哪套优先级排的')

  // 稳定性：换一个输入顺序，入选集合不变。
  const again = selectCandidates([near, far, mid], rule)
  assert.deepEqual(again.adopted.map((item) => item.url), outcome.adopted.map((item) => item.url))
})

test('来源渠道顺序由知识给：渠道之外的排最后，但没有被硬性排除', () => {
  const inOrder = caseOf({ url: 'https://example.invalid/lianjia', source: 'lianjia' })
  const other = caseOf({ url: 'https://example.invalid/wuba', source: 'wuba' })
  const outcome = selectCandidates([other, inOrder], {
    maxAdopted: 1, order: [{ key: 'source-rank' }], sourceOrder: ['lianjia', 'anjuke'],
    assessments: [
      assessmentOf('https://example.invalid/lianjia', 'qualified'),
      assessmentOf('https://example.invalid/wuba', 'qualified'),
    ],
  })
  assert.deepEqual(outcome.adopted.map((item) => item.source), ['lianjia'])
  assert.equal(outcome.rejected[0].case.source, 'wuba')
  assert.match(outcome.rejected[0].reason, /超出本轮名额/)
})

test('发布时间新的优先；没有发布时间的排最后（不是"最旧"）', () => {
  const newest = caseOf({ url: 'https://example.invalid/new', publishedAt: '2026-10-01' })
  const older = caseOf({ url: 'https://example.invalid/old', publishedAt: '2026-01-01' })
  const unknown = caseOf({ url: 'https://example.invalid/unknown', publishedAt: '' })
  const outcome = selectCandidates([unknown, older, newest], {
    maxAdopted: 3, order: [{ key: 'published-desc' }], sourceOrder: [],
    assessments: [
      assessmentOf('https://example.invalid/new', 'qualified'),
      assessmentOf('https://example.invalid/old', 'qualified'),
      assessmentOf('https://example.invalid/unknown', 'qualified'),
    ],
  })
  assert.deepEqual(outcome.adopted.map((item) => item.url), [
    'https://example.invalid/new', 'https://example.invalid/old', 'https://example.invalid/unknown',
  ])
})

test('没有可用候选时不报错，但如实说明"一条都没有"', () => {
  const outcome = selectCandidates([caseOf({ transactionType: '挂牌' })], ruleOf())
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.adopted, [])
  assert.equal(outcome.rejected.length, 1)
  assert.match(outcome.notes.join('；'), /可用候选只有 0 条/)
})

test('面积差额写进说明（按对象基准，不四舍五入成"差不多"）', () => {
  const outcome = selectCandidates([caseOf({ buildingArea: 100.5 })], {
    maxAdopted: 1,
    order: [{ key: 'area-delta-asc', subjectArea: 100.25 }],
    sourceOrder: [],
    assessments: [assessmentOf('https://example.invalid/a', 'qualified')],
  })
  assert.match(outcome.notes.join('；'), /面积差额以对象 100\.25 ㎡ 为基准/)
})

// ── 协议 40 · 交易性质未确认 / 规则写法（红测，先于实现）──────────────────────

test('交易性质未知（空串或「未知」）不进入 adopted，并留下"未确认"的具体理由', () => {
  const outcome = selectCandidates([
    caseOf({ url: 'https://example.invalid/known', transactionType: '成交' }),
    caseOf({ url: 'https://example.invalid/blank', transactionType: '' }),
    caseOf({ url: 'https://example.invalid/unknown', transactionType: '未知' }),
  ], ruleOf({
    maxAdopted: 3,
    assessments: [assessmentOf('https://example.invalid/known', 'qualified', { reason: '成交且字段完整' })],
  }))

  assert.deepEqual(outcome.adopted.map((item) => item.url), ['https://example.invalid/known'],
    '未知交易性质不是"可以用"的候选：它不能靠名额没满被启用')
  const unknownReasons = outcome.rejected
    .filter((item) => item.case.transactionType === '' || item.case.transactionType === '未知')
    .map((item) => item.reason)
  assert.equal(unknownReasons.length, 2, `未知候选都要有落选理由：${JSON.stringify(outcome.rejected)}`)
  for (const reason of unknownReasons) {
    assert.match(reason, /交易性质|未确认|未知|挂牌/, `未知候选的理由要具体：${reason}`)
  }
})

test('名额 / 顺序项的写法不合法一律拒绝，不静默截断或忽略', () => {
  // 小数名额不是"向下取整"，是没写清楚。
  const fractional = normalizeSelectionRule({
    maxAdopted: 2.7, order: [{ key: 'transaction-first' }], sourceOrder: [],
  })
  assert.equal(fractional.ok, false, `小数名额必须拒绝：${JSON.stringify(fractional)}`)
  assert.match(fractional.error, /整数|名额/)

  // 顺序数组里有认不出的项不是"跳过它"：配置写坏了就要报出来。
  const badEntry = normalizeSelectionRule({
    maxAdopted: 3,
    order: [{ key: 'transaction-first' }, 'transaction-first', null],
    sourceOrder: [],
  })
  assert.equal(badEntry.ok, false, `顺序数组里的非法项必须拒绝：${JSON.stringify(badEntry)}`)
  assert.match(badEntry.error, /顺序|order|比较键/)
})

// Selection assessments are the knowledge gate: only assessed, eligible cases may be adopted.

test('未评估的候选不进入 adopted，并说清"等待知识评估"', () => {
  const outcome = selectCandidates([
    caseOf({ url: 'https://example.invalid/a' }),
    caseOf({ url: 'https://example.invalid/b' }),
  ], ruleOf({ maxAdopted: 3 }))
  assert.deepEqual(outcome.adopted, [], 'without an assessment the case is unreviewed')
  assert.equal(outcome.rejected.length, 2)
  assert.match(outcome.notes.join('；'), /未评估|待评估|评估/)
})

test('qualified / near-miss / excluded 各有理由与 knowledgeRef，只有 qualified 采用', () => {
  const outcome = selectCandidates([
    caseOf({ url: 'https://example.invalid/q' }),
    caseOf({ url: 'https://example.invalid/n' }),
    caseOf({ url: 'https://example.invalid/x' }),
  ], ruleOf({
    maxAdopted: 3,
    assessments: [
      assessmentOf('https://example.invalid/q', 'qualified', { reason: '成交且字段完整' }),
      assessmentOf('https://example.invalid/n', 'near-miss', { reason: '面积偏差超过规则上限' }),
      assessmentOf('https://example.invalid/x', 'excluded', { reason: '挂牌不可直接作可比实例' }),
    ],
  }))
  assert.deepEqual(outcome.adopted.map((item) => item.url), ['https://example.invalid/q'])
  const byUrl = new Map((outcome.assessments ?? []).map((item) => [item.url, item]))
  for (const url of ['https://example.invalid/q', 'https://example.invalid/n', 'https://example.invalid/x']) {
    const assessment = byUrl.get(url)
    assert.notEqual(assessment, undefined, `outcome must carry the assessment for ${url}`)
    assert.notEqual(assessment.reason, '')
    assert.notEqual(assessment.knowledgeRef, '')
  }
})

test('排序把 near-miss 排在最前也不采用它：名额只从 qualified 里取', () => {
  const outcome = selectCandidates([
    caseOf({ url: 'https://example.invalid/near', buildingArea: 101 }),
    caseOf({ url: 'https://example.invalid/q', buildingArea: 160 }),
  ], {
    maxAdopted: 1,
    order: [{ key: 'area-delta-asc', subjectArea: 100 }],
    sourceOrder: [],
    assessments: [
      assessmentOf('https://example.invalid/near', 'near-miss', { reason: '面积偏差接近上限' }),
      assessmentOf('https://example.invalid/q', 'qualified', { reason: '满足可比条件' }),
    ],
  })
  assert.deepEqual(outcome.adopted.map((item) => item.url), ['https://example.invalid/q'])
  const near = outcome.rejected.find((item) => item.case.url === 'https://example.invalid/near')
  assert.notEqual(near, undefined)
  assert.match(near.reason, /相近|near|评估|未达标/)
})

test('评估写法不合法一律拒绝：状态未知 / URL 重复 / 理由或出处为空', () => {
  const base = { maxAdopted: 2, order: [{ key: 'transaction-first' }], sourceOrder: [] }
  // Rejection may happen when narrowing the rule or when selecting; either layer counts.
  const rejects = (assessments) => {
    const narrowed = normalizeSelectionRule({ ...base, assessments })
    if (!narrowed.ok) return true
    return selectCandidates([caseOf({ url: 'https://x/1' })], { ...base, assessments }).ok === false
  }
  assert.equal(rejects([assessmentOf('https://x/1', 'maybe')]), true, 'unsupported status must be rejected')
  assert.equal(rejects([
    assessmentOf('https://x/1', 'qualified'), assessmentOf('https://x/1', 'near-miss'),
  ]), true, 'duplicate assessment URL must be rejected')
  assert.equal(rejects([
    assessmentOf('https://x/1', 'qualified', { reason: '  ' }),
  ]), true, 'blank reason must be rejected')
  assert.equal(rejects([
    assessmentOf('https://x/1', 'qualified', { knowledgeRef: '' }),
  ]), true, 'blank knowledgeRef must be rejected')
})

test('事实不合格的候选即使标 qualified 也不进 adopted', () => {
  const eligible = caseOf({ url: 'https://example.invalid/ok' })
  const adopted = selectCandidates([eligible], ruleOf({
    maxAdopted: 1, assessments: [assessmentOf('https://example.invalid/ok', 'qualified')],
  }))
  assert.deepEqual(adopted.adopted.map((item) => item.url), ['https://example.invalid/ok'])

  const ineligible = [
    ['未知交易性质', caseOf({ url: 'https://example.invalid/unknown', transactionType: '' })],
    ['挂牌', caseOf({ url: 'https://example.invalid/listing', transactionType: '挂牌' })],
    ['缺证据', caseOf({ url: 'https://example.invalid/noev', evidence: '' })],
    ['缺面积', caseOf({ url: 'https://example.invalid/noarea', buildingArea: null })],
    ['缺价格', caseOf({ url: 'https://example.invalid/noprice', price: null, unitPrice: null })],
  ]
  for (const [label, item] of ineligible) {
    const outcome = selectCandidates([item], ruleOf({
      maxAdopted: 1, assessments: [assessmentOf(item.url, 'qualified', { reason: '模型标注为合格' })],
    }))
    assert.deepEqual(outcome.adopted, [], `${label}: a model label cannot override the factual guard`)
  }
})
