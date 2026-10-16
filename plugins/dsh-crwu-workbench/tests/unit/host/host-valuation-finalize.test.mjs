/**
 * finalize：显式完成校验（设计稿 §11.4，计划 Task 11）。
 *
 * 删除面板进度轮询之后，完成判定不能退化成"模型说完成了"。这一层的判据挑的是
 * **错了会静默交付错东西**的几条：
 *
 * 1. 模型 `requestedStatus=completed` 但缺图 / 缺知识 / 未重算 → 必须降级；
 * 2. 被改过的 `估值输入.json`（借改摘要"让校验通过"）→ 直接 `failed`；
 * 3. 多对象只给一条汇总金额 → 不算完成；
 * 4. `land-and-building` 与 `land-only` 并存 → 重复计价，阻断；
 * 5. 项目里一个方案被阻断时 → 项目 `partial`，且**中断方案的中间金额不进总价**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { finalizePlan, finalizeProject, valueScopesOverlap } = await import(
  new URL('src/host/domains/report-evaluation/delivery/finalize.ts', ROOT).href)

const ROUTE = { routeId: 'realestate.method.market', snapshotDigest: 'sha256:k' }

/** 一份"全部通过"的事实，逐条覆盖它构造缺口。 */
function facts(overrides = {}) {
  return {
    projectId: 'project-001',
    planId: 'plan-001',
    taskId: 'plan-001-realestate',
    requestedStatus: 'completed',
    inputDigest: { frozen: 'sha256:in', recomputed: 'sha256:in' },
    knowledge: {
      sources: [{
        routeId: 'realestate.method.market', nodeName: '02-市场法', resolvedPath: 'x',
        source: 'dws', spaceName: '中瑞世联业务知识库', updatedAt: '2026-10-01',
        digest: 'sha256:k', snapshotFile: '知识快照/02-市场法.md', sectionIds: [], ruleIds: [],
      }],
      verified: true, missing: [],
    },
    template: { templateId: 'T1', digest: 'sha256:t', expectedDigest: 'sha256:t', structureOk: true },
    objects: {
      objectIds: ['object-001', 'object-002'],
      conclusions: [
        { objectId: 'object-001', valueScope: 'land-and-building', method: 'market', unitPrice: '42000', totalValue: '3749760', currency: 'CNY', basisRefs: [ROUTE], calculationRef: 'calc-1' },
        { objectId: 'object-002', valueScope: 'land-and-building', method: 'market', unitPrice: '39800', totalValue: '6352120', currency: 'CNY', basisRefs: [ROUTE], calculationRef: 'calc-2' },
      ],
    },
    calculation: { steps: 6, verified: true },
    evidence: {
      required: true,
      entries: [
        { caseId: 'C001', displayName: 'A', provider: 'lianjia', sourceUrl: 'https://bj.lianjia.com/a', capturedAt: 't', relativePath: '图片/C001/a.png', digest: 'sha256:p', validity: 'valid' },
      ],
    },
    workbooks: [{ workbookId: 'w1', relativePath: '估值底稿.xlsx', templateId: 'T1', templateDigest: 'sha256:t', objectIds: ['object-001', 'object-002'], recalculated: true, recalculationNote: '' }],
    recalculation: { state: 'recalculated', reason: 'ok', providerId: 'libreoffice.local', verified: true, observed: [], recalculatedAt: 't', mismatches: [] },
    report: { rendered: true, schemaProblems: [] },
    artifacts: { manifestOk: true, missing: [] },
    blockers: [],
    valuationPath: 'combined',
    valueScopes: ['land-and-building'],
    verifiedAt: '2026-10-14T00:00:00Z',
    ...overrides,
  }
}

test('全部通过 → completed，并带回执', () => {
  const receipt = finalizePlan(facts())
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.downgraded, false)
  assert.deepEqual(receipt.problems, [])
  assert.equal(receipt.validation.knowledgeVerified, true)
  assert.equal(receipt.validation.workbookRecalculated, true)
  assert.equal(receipt.conclusionIncludesBlockedAmount, false)
})

test('房地路径未确认 → blocked，不生成完成回执', () => {
  const receipt = finalizePlan(facts({ valuationPath: 'unresolved' }))
  assert.equal(receipt.status, 'blocked')
  assert.equal(receipt.downgraded, true)
  assert.equal(receipt.validation, null)
  assert.match(receipt.problems.join('；'), /房地.*未确认/)
})

test('缺图 / 未重算 / 缺计算轨迹 → 一律降到 partial（不能 completed）', () => {
  const noEvidence = finalizePlan(facts({ evidence: { required: true, entries: [] } }))
  assert.equal(noEvidence.status, 'partial')
  assert.equal(noEvidence.downgraded, true)
  assert.equal(noEvidence.validation, null)
  assert.match(noEvidence.problems.join('；'), /没有任何有效截图证据/)

  const notRecalculated = finalizePlan(facts({
    recalculation: { state: 'unavailable', reason: '本部署没有本地表格程序', providerId: '', verified: false, observed: [], recalculatedAt: 't', mismatches: [] },
  }))
  assert.equal(notRecalculated.status, 'partial')
  assert.match(notRecalculated.problems.join('；'), /未完成重算核对/)

  const noSteps = finalizePlan(facts({ calculation: { steps: 0, verified: true } }))
  assert.equal(noSteps.status, 'partial')

  // 失效截图与不存在是两件事，但都不能 completed。
  const invalidShot = finalizePlan(facts({
    evidence: { required: true, entries: [{ caseId: 'C001', displayName: 'A', provider: 'lianjia', sourceUrl: 'u', capturedAt: 't', relativePath: 'p', digest: 'd', validity: 'invalid' }] },
  }))
  assert.equal(invalidShot.status, 'partial')
  assert.match(invalidShot.problems.join('；'), /截图证据失效/)
})

test('知识未核对 / 缺必需知识 → blocked（缺规则不给金额）', () => {
  const unverified = finalizePlan(facts({ knowledge: { sources: [], verified: false, missing: [] } }))
  assert.equal(unverified.status, 'blocked')
  assert.equal(unverified.downgraded, true)

  const missing = finalizePlan(facts({ knowledge: { sources: [], verified: false, missing: ['realestate.case-selection'] } }))
  assert.equal(missing.status, 'blocked')
  assert.match(missing.problems.join('；'), /缺少必需知识/)
})

test('缺模板 / 模板指纹不符 / 结构不过 → blocked 或 partial，且绝不 completed', () => {
  const noTemplate = finalizePlan(facts({ template: null }))
  assert.equal(noTemplate.status, 'blocked')
  const wrongDigest = finalizePlan(facts({ template: { templateId: 'T1', digest: 'sha256:x', expectedDigest: 'sha256:t', structureOk: true } }))
  assert.equal(wrongDigest.status, 'blocked')
  assert.match(wrongDigest.problems.join('；'), /模板指纹与索引不一致/)
  const badStructure = finalizePlan(facts({ template: { templateId: 'T1', digest: 'sha256:t', expectedDigest: 'sha256:t', structureOk: false } }))
  assert.equal(badStructure.status, 'blocked')
})

test('多对象只给一条汇总金额 → 不算完成', () => {
  const receipt = finalizePlan(facts({
    objects: { objectIds: ['object-001', 'object-002'], conclusions: [facts().objects.conclusions[0]] },
  }))
  assert.equal(receipt.status, 'partial')
  assert.match(receipt.problems.join('；'), /缺少对象结论：object-002/)
})

test('借改输入摘要"让校验通过" → failed（最危险的一种）', () => {
  const receipt = finalizePlan(facts({ inputDigest: { frozen: 'sha256:in', recomputed: 'sha256:tampered' } }))
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.ok, false)
  assert.match(receipt.problems[0], /输入快照与冻结记录不一致/)
})

test('有阻断 → blocked，并逐条列出原因', () => {
  const receipt = finalizePlan(facts({
    blockers: [{
      kind: 'knowledge-missing', stage: 'retrieval', missing: ['03-案例选取'],
      checked: ['exact-route'], reason: '选例规则缺失', remediation: '补齐后重跑',
    }],
  }))
  assert.equal(receipt.status, 'blocked')
  assert.match(receipt.problems.join('；'), /选例规则缺失/)
})

test('房地分别评估的价值范围并存 → 重复计价，阻断', () => {
  assert.equal(valueScopesOverlap(['land-and-building', 'land-only']).overlap, true)
  assert.equal(valueScopesOverlap(['land-only', 'building-only']).overlap, false)
  const receipt = finalizePlan(facts({ valueScopes: ['land-and-building', 'land-only'] }))
  assert.equal(receipt.status, 'blocked')
  assert.match(receipt.problems.join('；'), /重复计价/)
})

test('项目级：一个方案阻断 → project=partial，且中断方案金额不进总价', () => {
  const okPlan = finalizePlan(facts())
  const blockedPlan = finalizePlan(facts({
    planId: 'plan-002', taskId: 'plan-002-realestate',
    blockers: [{ kind: 'property-unsupported', stage: 'method-selection', missing: ['商业物业规则'], checked: ['coverage'], reason: '当前只覆盖住宅', remediation: '补齐后重跑' }],
  }))
  const project = finalizeProject({
    projectId: 'project-001', plans: [okPlan, blockedPlan], projectBlockers: [], verifiedAt: 't',
  })
  assert.equal(project.status, 'partial')
  assert.deepEqual(project.perPlan, [{ planId: 'plan-001', status: 'completed' }, { planId: 'plan-002', status: 'blocked' }])
  assert.equal(project.conclusionIncludesBlockedAmount, false)
  // 只有 completed 的方案可以合计。
  assert.deepEqual(project.aggregatablePlanIds, ['plan-001'])
})

test('项目级：全部完成 → completed；项目级阻断 → blocked', () => {
  const done = finalizeProject({ projectId: 'p', plans: [finalizePlan(facts())], projectBlockers: [], verifiedAt: 't' })
  assert.equal(done.status, 'completed')
  const projectBlocked = finalizeProject({
    projectId: 'p', plans: [finalizePlan(facts())],
    projectBlockers: [{ kind: 'knowledge-missing', stage: 'knowledge', missing: ['01-房地产估值通用'], checked: ['exact-route'], reason: '通用规则缺失', remediation: '补齐' }],
    verifiedAt: 't',
  })
  assert.equal(projectBlocked.status, 'blocked')
  assert.deepEqual(projectBlocked.aggregatablePlanIds, [], '项目级阻断时不许合计任何方案金额')
})

test('取消 / 失败请求原样返回，不升级也不伪造回执', () => {
  const cancelled = finalizePlan(facts({ requestedStatus: 'cancelled' }))
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.validation, null)
  assert.equal(cancelled.downgraded, false)
  const failed = finalizePlan(facts({ requestedStatus: 'failed' }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.validation, null)
})

test('知识不要求截图时，截图缺席不阻断（按"不适用"处理）', () => {
  const receipt = finalizePlan(facts({ evidence: { required: false, entries: [] } }))
  assert.equal(receipt.status, 'completed')
  assert.match(receipt.validation.notes.join('；'), /未要求页面截图/)
})

// ── Optional listing-reference fact (authorized default) ─────────────────────

const LISTING_REFERENCE = { verified: true, objectIds: ['object-001', 'object-002'], problems: [] }
const NO_RECALC = {
  state: 'unavailable', reason: '本部署没有本地表格程序', providerId: '',
  verified: false, observed: [], recalculatedAt: 't', mismatches: [],
}

test('挂牌参考：已验证 reference + 模板为空 / 无 Excel → partial，绝不 completed', () => {
  const receipt = finalizePlan(facts({
    valuationMode: 'listing-reference',
    reference: LISTING_REFERENCE,
    template: null,
    workbooks: [],
    recalculation: NO_RECALC,
  }))
  assert.equal(receipt.status, 'partial')
  assert.notEqual(receipt.status, 'completed')
  assert.equal(receipt.downgraded, true)
})

test('挂牌参考：reference 未验证或带问题 → blocked', () => {
  const unverified = finalizePlan(facts({
    valuationMode: 'listing-reference',
    reference: { verified: false, objectIds: [], problems: [] },
    template: null,
    workbooks: [],
    recalculation: NO_RECALC,
  }))
  assert.equal(unverified.status, 'blocked')
  const withProblems = finalizePlan(facts({
    valuationMode: 'listing-reference',
    reference: { verified: true, objectIds: ['object-001'], problems: ['缺少来源'] },
    template: null,
    workbooks: [],
    recalculation: NO_RECALC,
  }))
  assert.equal(withProblems.status, 'blocked')
})

test('挂牌参考不得绕过输入不一致 / 缺知识：仍分别是 failed / blocked', () => {
  const mismatched = finalizePlan(facts({
    valuationMode: 'listing-reference',
    reference: LISTING_REFERENCE,
    inputDigest: { frozen: 'sha256:in', recomputed: 'sha256:other' },
  }))
  assert.equal(mismatched.status, 'failed')
  const missingKnowledge = finalizePlan(facts({
    valuationMode: 'listing-reference',
    reference: LISTING_REFERENCE,
    knowledge: { sources: [], verified: false, missing: ['realestate.method.market'] },
  }))
  assert.equal(missingKnowledge.status, 'blocked')
})
