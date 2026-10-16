/**
 * v2 估值项目合同（设计稿 §7 / §10 / §11，计划 Task 1）。
 *
 * 这一层钉两件**跨层**的事，都不是"新实现自己产生的期望值"：
 *
 * 1. **结构性阻断与逐方法能力事实**（`assessCoverage`）：协议 39 起它**不再**按物业类型或
 *    方法白名单拦人 —— 物业类型是业务分类（知识判定），方法能不能跑是能力事实（逐方法给出）。
 *    只有**结构性**问题会阻断：房地权益边界未解、房地分别评估缺组件能力。
 *    方法级缺口不误伤其他方法：一个能跑就没有整体阻断。
 * 2. **报告数据判别联合**：`blocked` 的报告**没有金额、也没有工作簿**，`completed` 则必须
 *    同时有对象结论、计算表、知识引用与 finalize 校验回执。这两条是"模型不许一句话把
 *    blocked 升级成 completed"的机器判据（设计稿 §11.4）。
 *
 * 本任务不调用 renderer / finalize（Task 10、11 才实现），只钉数据形状。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { assessCoverage } = await import(
  new URL('src/host/domains/report-evaluation/project/coverage.ts', ROOT).href)
const contracts = await import(
  new URL('src/shared/contracts/valuation-project.ts', ROOT).href)

const reportSchema = JSON.parse(readFileSync(
  new URL('skills/biz/crwu-biz-valuation-realestate/schemas/valuation-report-data.schema.json', ROOT), 'utf8'))
const projectSchema = JSON.parse(readFileSync(
  new URL('skills/biz/crwu-biz-valuation-realestate/schemas/valuation-project.schema.json', ROOT), 'utf8'))

/** 报告 Schema 里 `status.const === x` 的那一支（判别联合必须**恰好一支**）。 */
function branchOf(status) {
  const matches = (reportSchema.oneOf ?? []).filter((branch) =>
    branch?.properties?.status?.const === status)
  assert.equal(matches.length, 1, `报告 Schema 里 status=${status} 必须恰好有一支，实际 ${matches.length}`)
  return matches[0]
}

// ---------------------------------------------------------------------------
// 能力覆盖
// ---------------------------------------------------------------------------

test('住宅 + 市场法 + 房地合一：首期唯一可完整执行的范围', () => {
  const coverage = assessCoverage({ propertyType: 'residential', method: 'market', valuationPath: 'combined' })
  assert.equal(coverage.supported, true)
  assert.deepEqual(coverage.blockers, [])
  // 必需能力是 Host 的技术合同 ID，不是"提示词里点名"。
  for (const id of [
    'browser.auth.status',
    'market.residential.search',
    'market.residential.detail',
    'browser.page.screenshot',
    'template.xlsx.materialize',
    'valuation.market.calculate',
  ]) {
    assert.equal(coverage.requiredCapabilities.includes(id), true, `必需能力缺 ${id}`)
  }
})

test('物业类型不再是代码白名单：商业 / 办公不当场判"不支持"，分类归知识判定', () => {
  // 协议 39 改判：物业类型是不是住宅是**业务分类**（原始登记用途 + 业务规则 + 资料依据），
  // 由本轮知识正文判定；代码里的白名单会把"公寓式住宅 / 商业"这类分类问题变成一句假结论。
  for (const propertyType of ['commercial', 'office', 'industrial', 'other']) {
    const coverage = assessCoverage({ propertyType, method: 'market', valuationPath: 'combined' })
    assert.equal(coverage.supported, true, propertyType)
    assert.equal(coverage.blockers.length, 0, propertyType)
  }
})

test('房地分别评估：土地能力未实现 → 阻断该方案，不重复计算土地价值', () => {
  const coverage = assessCoverage({ propertyType: 'residential', method: 'market', valuationPath: 'separate' })
  assert.equal(coverage.supported, false)
  const kinds = coverage.blockers.map((row) => row.kind)
  assert.equal(kinds.includes('valuation-path-unsupported'), true)
  // 阻断的是**土地/建筑物组件任务**，必须点名候选 Skill 而不是含糊说"暂不支持"。
  const land = coverage.blockers.find((row) => row.kind === 'valuation-path-unsupported')
  assert.equal(land.checked.some((row) => row.includes('crwu-biz-valuation-land')), true)
})

test('收益法 / 成本法：能力事实如实报"跑不了"，但**不当场阻断整方案**', () => {
  const coverage = assessCoverage({ propertyType: 'residential', method: 'auto', valuationPath: 'combined' })
  assert.equal(coverage.supported, true, '结构性上没有问题')
  const facts = new Map(coverage.methodCapabilities.map((item) => [item.method, item]))
  assert.equal(facts.get('market').executable, true)
  for (const method of ['income', 'cost']) {
    const fact = facts.get(method)
    assert.equal(fact.executable, false, `${method} 当前跑不了`)
    assert.match(fact.gap, /能力缺口/, '是能力缺口，不是"业务不适用"')
    // 它与"业务不适用"那句判据**不是同一句话**（后者只在 applicable === false 时出现）。
    assert.equal(fact.gap.includes('知识选择方案判定不适用于本方案'), false, method)
    assert.equal(fact.capabilities.length > 0, true, '要给出具体能力 ID，好让补齐清单是具体的')
  }
  // 逐一请求一个跑不了的方法时，也要能在方法判定层拿到缺口（不是覆盖层的硬拒绝）。
  const single = assessCoverage({ propertyType: 'residential', method: 'income', valuationPath: 'combined' })
  assert.equal(single.supported, true)
  assert.equal(single.methodCapabilities.find((item) => item.method === 'income').executable, false)
})

test('实测的能力清单可以覆盖部署默认（知识补齐后不必改业务口径代码）', () => {
  const coverage = assessCoverage({
    propertyType: 'residential', method: 'auto', valuationPath: 'combined',
    implementedMethods: ['market', 'income'],
  })
  const facts = new Map(coverage.methodCapabilities.map((item) => [item.method, item]))
  assert.equal(facts.get('income').executable, true)
  assert.equal(facts.get('income').gap, '')
  assert.equal(coverage.requiredCapabilities.includes('valuation.income.calculate'), true)
})

test('自动判定是输入而非方法：本身可执行，方法冲突留到方法判定阶段', () => {
  const coverage = assessCoverage({ propertyType: 'residential', method: 'auto', valuationPath: 'combined' })
  assert.equal(coverage.supported, true)
  assert.equal(coverage.requiredCapabilities.includes('knowledge.realestate.method-selection'), true)
})

test('房地权益边界未解 → 请在会话内确认，不自行选路径', () => {
  const coverage = assessCoverage({ propertyType: 'residential', method: 'market', valuationPath: 'unresolved' })
  assert.equal(coverage.supported, false)
  assert.equal(coverage.blockers[0].kind, 'valuation-path-unresolved')
})

test('重复计价的能力门禁：土地与建筑物价值范围由合同列出，不得相加', () => {
  assert.deepEqual([...contracts.VALUE_SCOPES], ['land-only', 'building-only', 'land-and-building'])
  assert.deepEqual([...contracts.VALUATION_PATHS], ['combined', 'separate', 'unresolved'])
  assert.deepEqual([...contracts.REPORT_STATUSES], ['completed', 'blocked', 'partial', 'failed', 'cancelled'])
})

// ---------------------------------------------------------------------------
// 报告数据判别联合
// ---------------------------------------------------------------------------

test('blocked 分支：必填 stage/blockers/lookupAttempts，conclusion 恒为 null，不要金额也不要工作簿', () => {
  const blocked = branchOf('blocked')
  for (const key of ['stage', 'blockers', 'lookupAttempts', 'conclusion']) {
    assert.equal(blocked.required.includes(key), true, `blocked 必须要求 ${key}`)
  }
  assert.equal(blocked.properties.conclusion.const, null)
  assert.equal(blocked.required.includes('objects'), false)
  assert.equal(blocked.required.includes('workbooks'), false)
  assert.equal(blocked.required.includes('conclusions'), false)
  assert.equal(blocked.properties.blockers.minItems, 1)
})

test('completed 分支：对象结论、计算表、知识引用与 finalize 校验回执都必填', () => {
  const completed = branchOf('completed')
  for (const key of ['objects', 'conclusions', 'workbooks', 'knowledgeSources', 'validation']) {
    assert.equal(completed.required.includes(key), true, `completed 必须要求 ${key}`)
  }
  assert.equal(completed.properties.objects.minItems, 1)
  assert.equal(completed.properties.workbooks.minItems, 1)
  assert.equal(completed.properties.conclusions.minItems, 1)
  assert.equal(completed.properties.status.const, 'completed')
})

test('partial / failed / cancelled 分支存在且都不允许冒充最终结论', () => {
  for (const status of ['partial', 'failed', 'cancelled']) {
    const branch = branchOf(status)
    assert.equal(branch.required.includes('conclusion'), true, `${status} 必须显式声明 conclusion`)
    assert.equal(branch.properties.conclusion.const, null)
    assert.equal(branch.required.includes('stage'), true)
  }
})

test('项目索引 Schema 只认 v2，并要求对象/方案/任务三层', () => {
  assert.equal(projectSchema.properties.schemaVersion.const, 'crwu.valuation.project.v2')
  for (const key of ['projectId', 'inputDigest', 'plans', 'objects']) {
    assert.equal(projectSchema.required.includes(key), true, `项目索引必须要求 ${key}`)
  }
  const plan = projectSchema.definitions.plan
  for (const key of ['planId', 'objectIds', 'propertyType', 'methodRequest', 'status']) {
    assert.equal(plan.required.includes(key), true, `方案必须要求 ${key}`)
  }
  const task = projectSchema.definitions.task
  for (const key of ['taskId', 'parentPlanId', 'assetClass', 'valueScope', 'dependsOn', 'valuationPath']) {
    assert.equal(task.required.includes(key), true, `任务必须要求 ${key}`)
  }
})

test('Schema 版本常量集中在合同里（不在各处硬编码字符串）', () => {
  // 协议 39：资产类型进冻结输入 → v3（旧 v2 记录按版本不兼容拒绝，不静默按旧形状读）。
  assert.equal(contracts.VALUATION_INPUT_SCHEMA_VERSION, 'crwu.valuation.input.v3')
  assert.equal(contracts.VALUATION_PROJECT_SCHEMA_VERSION, 'crwu.valuation.project.v2')
  assert.equal(contracts.VALUATION_REPORT_DATA_SCHEMA_VERSION, 'crwu.valuation.report-data.v2')
})

// ---------------------------------------------------------------------------
// P14 / P16：业务输入在**合同**里就得有位置
// ---------------------------------------------------------------------------

test('P16：评估目的与价值类型是冻结输入与报告数据的结构化字段，不是补充要求里的自由文本', () => {
  // 冻结输入：两个字段必须存在，且允许 `null`（未指定）—— 未指定不许被折叠成空串或默认结论。
  const frozen = readFileSync(
    new URL('src/shared/contracts/valuation-project.ts', ROOT), 'utf8')
  const frozenBlock = frozen.slice(frozen.indexOf('export interface FrozenInput'))
  for (const key of ['purpose', 'valueType']) {
    assert.match(frozenBlock, new RegExp(`\\b${key}: string \\| null`),
      `FrozenInput 必须有 \`${key}: string | null\`（P16）`)
  }
  // 报告数据：值 + 是否由员工指定（未指定时报告必须写明，不许静默）。
  const reportBlock = frozen.slice(frozen.indexOf('interface ReportDataBase'))
  for (const key of ['purpose: string | null', 'purposeSpecified: boolean',
    'valueType: string | null', 'valueTypeSpecified: boolean']) {
    assert.equal(reportBlock.includes(key), true, `ReportDataBase 必须有 \`${key}\``)
  }
  // 声明文本是共享常量：提示词、报告数据与 HTML 必须逐字同一句。
  assert.equal(contracts.UNSPECIFIED_PURPOSE_NOTICE, '本次未指定评估目的')
  assert.equal(contracts.UNSPECIFIED_VALUE_TYPE_NOTICE, '本次未指定价值类型')
  assert.equal(contracts.UNSPECIFIED_BASE_DATE_NOTICE, '本次未指定评估基准日')
})

test('P16：未指定评估目的时**不得**据此声称正式完成 —— 合同里有一条与 baseDateSpecified 平行的判据', () => {
  const applied = `${contracts.UNSPECIFIED_PURPOSE_NOTICE} / ${contracts.UNSPECIFIED_VALUE_TYPE_NOTICE}`
  assert.equal(applied.includes('未指定'), true)
  // 报告数据的参数记录必须能分辨"字段缺失（可继续）"与"方法所需关键参数缺失（挂起计算）"。
  const source = readFileSync(new URL('src/shared/contracts/valuation-project.ts', ROOT), 'utf8')
  const parameterBlock = source.slice(source.indexOf('export interface ReportParameterRecord'))
  assert.equal(parameterBlock.includes("'registration-gap'"), true,
    'ReportParameterRecord 必须有 registration-gap（P17：字段缺失可继续）')
  assert.equal(parameterBlock.includes("'calculation-suspended'"), true,
    'ReportParameterRecord 必须有 calculation-suspended（P17：关键参数缺失挂起计算）')
})

test('P15：对象归一化不再把缺失的物业类型默认成住宅', () => {
  // 这一条是**回归哨兵**：`propertyType` 缺失时如果落到"默认 residential"，
  // 整个方案会按住宅口径算下去，而报告上看起来一切正常。
  const source = readFileSync(
    new URL('src/host/tools/report-evaluation/project.ts', ROOT), 'utf8')
  assert.equal(source.includes("|| 'residential'"), false,
    'crwu_valuation_project_prepare 不许把缺失的物业类型默认成住宅')
  assert.equal(source.includes('registeredUse'), true, '对象归一化要搬运 registeredUse')
  assert.equal(source.includes('classificationBasis'), true, '对象归一化要搬运 classificationBasis')
})

test('P15：原始权证登记用途与业务分类是两个字段，分类必须有依据', () => {
  const source = readFileSync(new URL('src/shared/contracts/valuation-project.ts', ROOT), 'utf8')
  const objectBlock = source.slice(source.indexOf('export interface ValuationObject'))
  assert.equal(objectBlock.includes('registeredUse: string'), true,
    'ValuationObject 必须有 registeredUse（原始权证/登记用途）')
  assert.equal(objectBlock.includes('classificationBasis: string'), true,
    'ValuationObject 必须有 classificationBasis（业务分类依据）')
  // 对象 schema 也是同一套字段（会话内对象契约）。
  const objectSchema = JSON.parse(readFileSync(
    new URL('skills/biz/crwu-biz-valuation-realestate/schemas/valuation-object.schema.json', ROOT), 'utf8'))
  for (const key of ['registeredUse', 'classificationBasis']) {
    assert.equal(key in (objectSchema.properties ?? {}), true, `对象 schema 必须有 ${key}`)
  }
})
