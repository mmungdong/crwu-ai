/**
 * 项目 → 方案 → 对象 + 任务图（设计稿 §7.1 / §7.2 / §7.3，计划 Task 6）。
 *
 * 这一层钉三类"错了会静默算出错数"的事：
 *
 * 1. **分组**：「同小区」只是候选信号，不能成为共用计价面积/权益/修正系数的理由；
 *    住宅与商业必须拆方案；一个对象不能被两个方案同时认领。
 * 2. **方法**：「业务不适用」与「当前未实现」是两种状态 —— 把后者写成前者，就是
 *    「成本法软件没支持，所以业务不适用」这类看起来合理、实际是把能力缺口当业务结论。
 *    用户指定的方法是**约束**：不可用就记冲突并请确认，不能悄悄换成市场法。
 * 3. **房地分别评估**：土地/建筑物/汇总必须是**有依赖的一张图**，且三个价值范围互斥；
 *    土地能力不存在时**阻断该方案**，不重复计算土地价值。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { validateGrouping, planDirectoryName, blockerFromGroupingConflict } = await import(
  new URL('src/host/domains/report-evaluation/project/grouping.ts', ROOT).href)
const { validateMethodAssessment } = await import(
  new URL('src/host/domains/report-evaluation/project/methods.ts', ROOT).href)
const { isPropertyType } = await import(
  new URL('src/host/domains/report-evaluation/project/coverage.ts', ROOT).href)
const {
  buildTaskGraph, validateValueScopes, detectCycle, readyTaskIds,
  taskGraphOwnsObjects, LAND_EXECUTION_CAPABILITY, BUILDING_ONLY_CAPABILITY,
} = await import(new URL('src/host/domains/report-evaluation/project/task-graph.ts', ROOT).href)

/**
 * 一个对象夹具（P15 起：`registeredUse` 与 `classificationBasis` 是**必填**的两件事）。
 *
 * 默认给一个成立的分类依据，好让不关心分类的用例只测它自己那一件事；
 * 要测"依据缺失"的用例显式把 `classificationBasis` 置空。
 */
function objectOf(objectId, propertyType = 'residential', fields = {}) {
  return {
    objectId,
    displayName: `对象 ${objectId}`,
    propertyType,
    registeredUse: '成套住宅',
    classificationBasis: `不动产权证：登记用途（material-001#${objectId}）`,
    sourceRefs: [`material-001#${objectId}`],
    fields,
    missingFields: [],
  }
}

function planOf(overrides = {}) {
  return {
    planId: 'plan-001', title: '同小区住宅', propertyType: 'residential', objectIds: ['object-001', 'object-002', 'object-003'],
    methodRequest: 'auto', methodAssessment: null, baseDate: null, valuationPath: 'combined',
    groupReason: '同一小区、同口径', groupEvidenceRefs: ['material-001#page-2'], conflicts: [],
    status: 'ready-for-method-selection', ...overrides,
  }
}

// ── 分组 ───────────────────────────────────────────────────────────────────

test('同小区同口径三套住宅可以同方案，但仍是三个对象', () => {
  const objects = [objectOf('object-001'), objectOf('object-002'), objectOf('object-003')]
  const outcome = validateGrouping(objects, [
    {
      planId: 'plan-001', objectIds: ['object-001', 'object-002', 'object-003'], propertyType: 'residential',
      purpose: '转让', valueType: '市场价值', baseDate: '2026-09-30', rightsBasis: '完全产权、卖方税费正常负担',
      groupReason: '同一小区、同口径', groupEvidenceRefs: ['material-001#page-2'],
    },
  ])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.plans.length, 1)
  assert.deepEqual(outcome.plans[0].objectIds, ['object-001', 'object-002', 'object-003'])
  assert.equal(outcome.plans[0].status, 'ready-for-method-selection')
  // 「同小区」出现在分组理由里必须留一条提醒：它只是候选信号。
  assert.equal(outcome.notes.some((note) => note.includes('候选信号')), true)
})

test('住宅 + 商业必须拆方案：合在一个方案里就是 incompatib​le-field 冲突', () => {
  const objects = [objectOf('object-001', 'residential'), objectOf('object-002', 'commercial')]
  const merged = validateGrouping(objects, [
    { planId: 'plan-001', objectIds: ['object-001', 'object-002'], propertyType: 'residential' },
  ])
  assert.equal(merged.ok, false)
  const conflict = merged.conflicts.find((row) => row.kind === 'incompatible-field')
  assert.equal(conflict.field, 'propertyType')
  assert.equal(conflict.label, '物业类型')
  assert.match(conflict.resolution, /拆成多个方案/)

  const split = validateGrouping(objects, [
    { planId: 'plan-001', objectIds: ['object-001'], propertyType: 'residential' },
    { planId: 'plan-002', objectIds: ['object-002'], propertyType: 'commercial' },
  ])
  assert.equal(split.ok, true)
  assert.equal(split.plans.length, 2)
})

test('同小区但权益/基准日不同就是冲突，不自动合并', () => {
  const objects = [objectOf('object-001'), objectOf('object-002')]
  const outcome = validateGrouping(objects, [
    {
      planId: 'plan-001', objectIds: ['object-001', 'object-002'], propertyType: 'residential',
      purpose: '转让', valueType: '市场价值', baseDate: '2026-09-30', rightsBasis: '完全产权',
    },
    { planId: 'plan-002', objectIds: [], propertyType: 'residential', baseDate: '2026-06-30' },
  ])
  // 第二个空方案有自己的冲突；第一个方案本身没有字段冲突。
  assert.equal(outcome.plans[0].conflicts.length, 0)
  assert.equal(outcome.plans[1].objectIds.length, 0)
  assert.equal(outcome.conflicts.some((row) => row.kind === 'empty-plan'), true)
})

test('对象漏归属 / 未知 id / 被两个方案认领都是冲突', () => {
  const objects = [objectOf('object-001'), objectOf('object-002')]
  const outcome = validateGrouping(objects, [
    { planId: 'plan-001', objectIds: ['object-001', 'object-002'] },
    { planId: 'plan-002', objectIds: ['object-002', 'object-999'] },
  ])
  assert.equal(outcome.ok, false)
  const kinds = outcome.conflicts.map((row) => row.kind)
  assert.equal(kinds.includes('duplicate-membership'), true)
  assert.equal(kinds.includes('unknown-object'), true)
  assert.deepEqual(outcome.duplicateObjectIds, ['object-002'])
  assert.deepEqual(outcome.unknownObjectIds, ['object-999'])
  // 重复认领的对象在方案里仍然只出现一次（不许被算两次）。
  for (const plan of outcome.plans) {
    assert.equal(new Set(plan.objectIds).size, plan.objectIds.length)
  }
  const blocker = blockerFromGroupingConflict(outcome.conflicts.find((row) => row.kind === 'duplicate-membership'))
  assert.equal(blocker.stage, 'grouping')
  assert.equal(blocker.missing.length > 0, true)
  assert.equal(blocker.checked.length > 0, true)
})

test('P15：业务分类依据缺失的对象**挂起**，其余对象继续（不因为名字里有「公寓」就套住宅）', () => {
  // 原始权证登记用途与业务分类是**两个字段**：登记用途是资料原文，业务分类是知识规则下的判定。
  const named = {
    ...objectOf('object-001', 'residential', { 用途: '公寓' }),
    registeredUse: '公寓', classificationBasis: '',
  }
  const grounded = {
    ...objectOf('object-002', 'residential'),
    registeredUse: '成套住宅',
    classificationBasis: '不动产权证：城镇住宅用地/成套住宅（material-001#page-2）',
  }
  const outcome = validateGrouping([named, grounded], [
    { planId: 'plan-001', objectIds: ['object-001', 'object-002'], propertyType: 'residential' },
  ])
  // 依据缺失的那一个对象被挂起，不进任何方案；另一个照常继续。
  assert.deepEqual(outcome.suspendedObjectIds, ['object-001'])
  assert.deepEqual(outcome.plans[0].objectIds, ['object-002'], '挂起一个对象不等于整轮停摆')
  const conflict = outcome.conflicts.find((row) => row.kind === 'unclassified-object')
  assert.notEqual(conflict, undefined, '依据缺失必须如实报冲突，不许静默按住宅算')
  assert.equal(conflict.label, '业务分类依据')
  assert.match(conflict.reason, /依据/)
  assert.match(conflict.resolution, /登记用途|分类依据/)
  const blocker = blockerFromGroupingConflict(conflict)
  assert.equal(blocker.stage, 'grouping')
  assert.equal(blocker.missing.length > 0, true)
  // 被挂起的对象不再同时报"没有归属"（挂起与漏归属是两件事）。
  assert.equal(outcome.unassignedObjectIds.includes('object-001'), false)
  // 登记用途不许被业务分类覆盖：两者并存。
  assert.equal(grounded.registeredUse, '成套住宅')
  assert.equal(outcome.plans[0].propertyType, 'residential')
})

test('没有对象被认领时如实报 unassigned，不静默丢掉', () => {
  const objects = [objectOf('object-001'), objectOf('object-002')]
  const outcome = validateGrouping(objects, [{ planId: 'plan-001', objectIds: ['object-001'] }])
  assert.deepEqual(outcome.unassignedObjectIds, ['object-002'])
  assert.equal(outcome.ok, false)
})

test('公寓是**有依据的业务分类**：isPropertyType 收窄通过，不再要求按住宅二次确认', () => {
  assert.equal(isPropertyType('apartment'), true)
  assert.equal(isPropertyType('residential'), true)
  assert.equal(isPropertyType('apartment '), false, '取值仍要逐字收窄')
  assert.equal(isPropertyType('公寓'), false, '显示名不是分类值')
})

test('规划用途为公寓且依据齐备：不挂起、不产生待确认冲突；住宅/商业仍必须拆', () => {
  const apartment = {
    ...objectOf('object-001', 'apartment'),
    // 原始权证/规划用途逐字保留；业务分类依据引用资料坐标。
    registeredUse: '公寓（规划用途：商品房）',
    classificationBasis: '建设工程规划许可证：公寓 / 商品房（material-001#page-1）',
  }
  const outcome = validateGrouping([apartment], [
    { planId: 'plan-001', objectIds: ['object-001'], propertyType: 'apartment' },
  ])
  assert.deepEqual(outcome.suspendedObjectIds, [], '依据齐备的公寓不得被挂起')
  assert.deepEqual(outcome.conflicts, [], '公寓不得再触发"按住宅确认"这类冲突')
  assert.deepEqual(outcome.plans[0].objectIds, ['object-001'])
  assert.equal(outcome.plans[0].propertyType, 'apartment')
  assert.equal(apartment.registeredUse, '公寓（规划用途：商品房）', '登记用途逐字保留，不被分类覆盖')

  // 住宅 + 商业仍必须拆：公寓不改变原有兼容字段口径。
  const mixed = validateGrouping(
    [objectOf('object-001', 'residential'), objectOf('object-002', 'commercial')],
    [{ planId: 'plan-001', objectIds: ['object-001', 'object-002'], propertyType: 'residential' }],
  )
  assert.equal(mixed.ok, false)
  assert.equal(mixed.conflicts.some((row) => row.kind === 'incompatible-field' && row.field === 'propertyType'), true)

  // 依据缺失仍然挂起（公寓不是免检牌）。
  const ungrounded = validateGrouping([{ ...apartment, classificationBasis: '' }], [
    { planId: 'plan-001', objectIds: ['object-001'], propertyType: 'apartment' },
  ])
  assert.deepEqual(ungrounded.suspendedObjectIds, ['object-001'])
})

test('方案目录名以 id 为身份、中文标题只做标签', () => {
  assert.equal(planDirectoryName({ planId: 'plan-001', title: '同小区住宅' }), 'plan-001-同小区住宅')
  assert.equal(planDirectoryName({ planId: 'plan-001', title: '' }), 'plan-001')
})

// ── 方法判定 ───────────────────────────────────────────────────────────────

test('用户指定 market 而知识判定不适用：记冲突、请确认，不改用别的已实现方法', () => {
  const outcome = validateMethodAssessment(planOf({ methodRequest: 'market' }), [
    { method: 'market', applicable: false, reason: '缺少可比实例，市场法不宜作为主方法' },
    { method: 'cost', applicable: true },
  ])
  assert.equal(outcome.ok, false)
  assert.equal(outcome.assessment.requestedMethodHonored, false)
  assert.deepEqual(outcome.assessment.selectedMethods, [])
  assert.equal(outcome.methodConflict.requested, 'market')
  assert.equal(outcome.methodConflict.adopted, null)
  assert.equal(outcome.blockers[0].kind, 'method-unsupported')
  assert.match(outcome.blockers[0].remediation, /不得.*改用市场法|不要.*改用/)
})

test('业务适用但未实现：能力缺口 ≠ 业务不适用', () => {
  const outcome = validateMethodAssessment(planOf({ methodRequest: 'income' }), [
    { method: 'income', applicable: true, reason: '有稳定租赁关系，适宜用收益法' },
  ])
  assert.equal(outcome.ok, false)
  const assessment = outcome.assessment.assessments[0]
  assert.equal(assessment.applicable, true)
  assert.equal(assessment.implemented, false)
  assert.equal(outcome.blockers[0].code, 'valuation.method.requested-unavailable')
  assert.match(outcome.blockers[0].reason, /尚无该方法可执行的正文/)
  // 不得把"未实现"写成"业务不适用"：原因里说的是"没有可执行正文"，不是"方法不适用"。
  assert.equal(/业务不适用/.test(outcome.blockers[0].reason), false)
})

test('知识要求两种方法而只实现一种：跑得了的照跑，跑不了的记能力缺口（不误伤、不称业务不适用）', () => {
  const outcome = validateMethodAssessment(planOf({ methodRequest: 'auto' }), [
    { method: 'market', applicable: true },
    { method: 'income', applicable: true, reason: '知识要求收益法作为必要校核方法' },
  ])
  assert.equal(outcome.assessment.primaryMethod, 'market')
  const income = outcome.assessment.assessments.find((row) => row.method === 'income')
  assert.equal(income.applicable, true)
  assert.equal(income.implemented, false)
  // 协议 39：业务适用但跑不了 = **能力缺口**，只影响该方法；不得把整个方案拖死。
  assert.equal(outcome.ok, true, '市场法照常执行')
  assert.deepEqual(outcome.capabilityGaps.map((item) => item.method), ['income'])
  assert.match(outcome.capabilityGaps[0].reason, /能力缺口|没有完整的可执行链路/)
  assert.equal(outcome.blockers.some((row) => row.reason.includes('知识选择方案判定不适用于本方案')), false)
  assert.equal(outcome.assessment.notes.some((note) => note.includes('income')), true, '缺口要能读出来')
})

test('自动判断可采用**组合**方法：适用且能跑的方法全部被采纳，不再只取第一个', () => {
  const outcome = validateMethodAssessment(
    planOf({ methodRequest: 'auto' }),
    [
      { method: 'market', applicable: true },
      { method: 'income', applicable: true, reason: '知识要求收益法与市场法互相校核' },
      { method: 'cost', applicable: false, reason: '知识判定不适用' },
    ],
    { implementedOf: (method) => method === 'market' || method === 'income' },
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.assessment.selectedMethods, ['market', 'income'])
  assert.equal(outcome.assessment.primaryMethod, 'market', '第一个采用方法即 primary（列表顺序）')
  assert.equal(outcome.capabilityGaps.length, 0)
  // 业务不适用的那一个仍然只是"不适用"，不进采用列表也不做能力缺口。
  const cost = outcome.assessment.assessments.find((row) => row.method === 'cost')
  assert.equal(cost.selected, false)
  assert.equal(cost.implemented, false)
})

test('自动判断一个方法都跑不了：整体阻断并说清"一个都跑不了"', () => {
  const outcome = validateMethodAssessment(
    planOf({ methodRequest: 'auto' }),
    [{ method: 'market', applicable: true }, { method: 'income', applicable: true }],
    { implementedOf: () => false },
  )
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.assessment.selectedMethods, [])
  assert.equal(outcome.blockers.some((row) => row.code === 'valuation.method.none-executable'), true)
})

test('用户指定方法时**不静默增补**其它方法（即使它们也能跑）', () => {
  const outcome = validateMethodAssessment(
    planOf({ methodRequest: 'market' }),
    [{ method: 'market', applicable: true }, { method: 'income', applicable: true }],
    { implementedOf: () => true },
  )
  assert.deepEqual(outcome.assessment.selectedMethods, ['market'])
  assert.equal(outcome.assessment.requestedMethodHonored, true)
})

test('组合方法各建一个任务（不再只按 primaryMethod 建）', () => {
  const plan = planOf({ methodRequest: 'auto' })
  const assessment = {
    planId: 'plan-001', methodRequest: 'auto', primaryMethod: 'market',
    selectedMethods: ['market', 'income'], assessments: [], requestedMethodHonored: true, notes: [], decidedAt: 'x',
  }
  const graph = buildTaskGraph(plan, assessment)
  assert.deepEqual(graph.nodes.map((node) => node.taskId), ['plan-001-market', 'plan-001-income'])
  assert.deepEqual(graph.nodes.map((node) => node.requestedCapability),
    ['valuation.market.calculate', 'valuation.income.calculate'])
  assert.equal(graph.ok, true)
})

test('用户指定 market 且适用可执行：采纳它并记 requestedMethodHonored', () => {
  const outcome = validateMethodAssessment(planOf({ methodRequest: 'market' }), [
    { method: 'market', applicable: true, ruleRefs: [{ routeId: 'realestate.method-selection', snapshotDigest: 'sha256:abc' }] },
  ])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.assessment.primaryMethod, 'market')
  assert.equal(outcome.assessment.requestedMethodHonored, true)
  assert.deepEqual(outcome.assessment.selectedMethods, ['market'])
  assert.equal(outcome.assessment.assessments[0].ruleRefs.length, 1)
})

// ── 任务图与价值范围 ───────────────────────────────────────────────────────

test('separate 生成土地/建筑物/汇总任务与依赖，土地能力不存在 → 阻断该方案', () => {
  const plan = planOf({ valuationPath: 'separate' })
  const assessment = { planId: 'plan-001', methodRequest: 'auto', primaryMethod: 'market', selectedMethods: ['market'], assessments: [], requestedMethodHonored: true, notes: [], decidedAt: 'x' }
  const graph = buildTaskGraph(plan, assessment)
  assert.equal(graph.nodes.some((node) => node.assetClass === 'land'), true)
  assert.equal(graph.nodes.some((node) => node.assetClass === 'building'), true)
  const join = graph.nodes.find((node) => node.valueScope === 'land-and-building')
  assert.equal(join.dependsOn.length, 2)
  assert.equal(graph.edges.length, 2)
  assert.equal(graph.ok, false)
  assert.equal(graph.blockers.some((row) => row.capabilityId === LAND_EXECUTION_CAPABILITY.id), true)
  assert.equal(LAND_EXECUTION_CAPABILITY.available, false)
  assert.equal(BUILDING_ONLY_CAPABILITY.available, false)
  // 任务图里的对象归属必须仍在方案里（防跨方案写）。
  assert.equal(taskGraphOwnsObjects(graph, plan), true)
})

test('combined 只有一个房地合一任务，价值范围是 land-and-building', () => {
  const graph = buildTaskGraph(planOf(), null)
  assert.equal(graph.ok, true)
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].assetClass, 'realestate')
  assert.equal(graph.nodes[0].valueScope, 'land-and-building')
  assert.deepEqual(graph.edges, [])
})

test('unresolved 不造任务，请员工确认权益边界', () => {
  const graph = buildTaskGraph(planOf({ valuationPath: 'unresolved' }), null)
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.blockers[0].kind, 'valuation-path-unresolved')
  assert.equal(graph.ok, false)
})

test('land-and-building 与 land-only 相加必须被拒绝（重复计价）', () => {
  assert.equal(validateValueScopes([{ valueScope: 'land-and-building' }, { valueScope: 'land-only' }]).ok, false)
  assert.equal(validateValueScopes([{ valueScope: 'land-and-building' }, { valueScope: 'building-only' }]).ok, false)
  assert.equal(validateValueScopes([{ valueScope: 'land-and-building' }]).ok, true)
  assert.equal(validateValueScopes([{ valueScope: 'land-only' }, { valueScope: 'building-only' }]).ok, true)
  assert.equal(validateValueScopes([{ valueScope: 'land-only' }, { valueScope: 'land-only' }]).ok, false)
})

test('任务依赖图拒绝环，且只在前置完成后 ready', () => {
  const cyclic = [
    { taskId: 'a', dependsOn: ['b'] },
    { taskId: 'b', dependsOn: ['a'] },
  ]
  assert.notEqual(detectCycle(cyclic), null)
  assert.equal(detectCycle([{ taskId: 'a', dependsOn: [] }, { taskId: 'b', dependsOn: ['a'] }]), null)

  const nodes = [
    { taskId: 'land', dependsOn: [], status: 'ready' },
    { taskId: 'building', dependsOn: [], status: 'ready' },
    { taskId: 'join', dependsOn: ['land', 'building'], status: 'pending' },
  ]
  assert.deepEqual(readyTaskIds(nodes, []), ['land', 'building'])
  assert.deepEqual(readyTaskIds(nodes, ['land']), ['building'])
  assert.deepEqual(readyTaskIds(nodes, ['land', 'building']), ['join'])
})

test('任务图带环时报错而不是给出一张能跑的图', () => {
  const plan = planOf({ valuationPath: 'separate' })
  const graph = buildTaskGraph(plan, null)
  // 正常构造的图无环；人为制造环来确认检测生效。
  const broken = { ...graph, nodes: graph.nodes.map((node) => node.valueScope === 'land-and-building' ? { ...node, dependsOn: [node.taskId] } : node) }
  assert.notEqual(detectCycle(broken.nodes), null)
})
