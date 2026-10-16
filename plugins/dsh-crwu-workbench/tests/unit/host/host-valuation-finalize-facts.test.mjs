/**
 * finalize 的 I/O 适配层（设计稿 §11.4，计划 Task 11）。
 *
 * 这一层的风险是**翻译错就静默放行**：把"文件不存在"翻成 `verified: true`、
 * 把缺失截图翻成"知识没要求截图"、用"底稿里有公式"推断"已重算"。
 * 所以每条翻译口径都要有断言，而且用内存替身穷举。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../../', import.meta.url)
const { collectPlanFinalizeFacts, FINALIZE_PATHS, planFilePath, knowledgeSourcesOf, recalculationOf, screenshotsOf } = await import(
  new URL('src/host/domains/report-evaluation/delivery/finalize-facts.ts', ROOT).href)

/**
 * 方案级落点**带 `方案/<planId>/` 前缀**（设计稿 §11.1）。
 *
 * 这一层要钉住的正是"两个方案不会串"：plan-002 没有落盘时，绝不能读到 plan-001 的报告数据
 * 然后判成完成 —— 那样两份结论会看起来都正常，而其中一份根本不是这个方案的。
 */
const PATH = {
  frozenInput: FINALIZE_PATHS.frozenInput,
  projectIndex: FINALIZE_PATHS.projectIndex,
  knowledgeIndex: FINALIZE_PATHS.knowledgeIndex,
  reportData: planFilePath('plan-001', FINALIZE_PATHS.reportData),
  reportHtml: planFilePath('plan-001', FINALIZE_PATHS.reportHtml),
  workbook: planFilePath('plan-001', FINALIZE_PATHS.workbook),
  template: planFilePath('plan-001', '模板验真.json'),
  screenshotManifest: planFilePath('plan-001', FINALIZE_PATHS.screenshotManifest),
  artifactManifest: planFilePath('plan-001', FINALIZE_PATHS.artifactManifest),
  recalculation: planFilePath('plan-001', FINALIZE_PATHS.recalculation),
}
const { finalizePlan } = await import(
  new URL('src/host/domains/report-evaluation/delivery/finalize.ts', ROOT).href)

const ROUTE = { routeId: 'realestate.method.market', snapshotDigest: 'sha256:k' }

/** 一套"都在盘上"的内存文件；逐条删掉它来构造缺口。 */
function diskOf(overrides = {}) {
  const files = {
    [PATH.frozenInput]: { schemaVersion: 'crwu.valuation.input.v2', projectId: 'project-001', inputDigest: 'sha256:in' },
    [PATH.projectIndex]: {
      objects: [{ objectId: 'object-001' }, { objectId: 'object-002' }],
      plans: [{ planId: 'plan-001', objectIds: ['object-001', 'object-002'] }, { planId: 'plan-002', objectIds: ['object-003'] }],
    },
    [PATH.knowledgeIndex]: {
      entries: [{
        routeId: 'realestate.method.market', nodeName: '02-市场法', digest: 'sha256:k',
        source: 'dws', spaceName: '中瑞世联业务知识库', snapshotFile: '知识快照/02-市场法.md', bodyNonEmpty: true,
      }],
    },
    [PATH.reportData]: {
      calculationSteps: [{ stepId: 's1' }, { stepId: 's2' }],
      conclusions: [
        { objectId: 'object-001', valueScope: 'land-and-building', method: 'market', unitPrice: '42000', totalValue: '3749760', currency: 'CNY', basisRefs: [ROUTE] },
        { objectId: 'object-002', valueScope: 'land-and-building', method: 'market', unitPrice: '39800', totalValue: '6352120', currency: 'CNY', basisRefs: [ROUTE] },
      ],
      workbooks: [{ workbookId: 'w1', relativePath: '估值底稿.xlsx', templateId: 'T1', templateDigest: 'sha256:t', objectIds: ['object-001', 'object-002'] }],
    },
    [PATH.template]: { templateId: 'T1', digest: 'sha256:t', expectedDigest: 'sha256:t', structureOk: true },
    [PATH.screenshotManifest]: {
      entries: [{ caseId: 'C001', displayName: 'A', provider: 'lianjia', sourceUrl: 'u', capturedAt: 't', relativePath: '图片/C001/a.png', digest: 'sha256:p', validity: 'valid' }],
    },
    [PATH.artifactManifest]: { ok: true, missing: [] },
    [PATH.recalculation]: { state: 'recalculated', verified: true, reason: 'ok', providerId: 'libreoffice.local', observed: [] },
    ...overrides,
  }
  // `{ PATH: undefined }` 的语义是"这个文件不在盘上"，所以要真的**删掉**这个键，
  // 而不是把它设成 undefined（那样 `path in files` 仍然为真）。
  for (const [path, value] of Object.entries(overrides)) {
    if (value === undefined) delete files[path]
  }
  const present = new Set([PATH.reportHtml, PATH.workbook])
  for (const [path, value] of Object.entries(overrides)) {
    if (value === undefined) present.delete(path)
  }
  return {
    files, present,
    readers: {
      readJson: async (path) => (path in files && files[path] !== undefined ? files[path] : null),
      exists: async (path) => present.has(path),
      digestOf: async () => 'sha256:x',
      recomputeInputDigest: async () => 'sha256:in',
    },
  }
}

function request(overrides = {}) {
  return {
    projectId: 'project-001', planId: 'plan-001', taskId: 'plan-001-realestate',
    requestedStatus: 'completed', frozenInputDigest: 'sha256:in',
    screenshotRequired: true, valuationPath: 'combined', verifiedAt: '2026-10-14T00:00:00Z',
    ...overrides,
  }
}

test('盘上齐备 → 收集出的事实能判成 completed（端到端接线）', async () => {
  const { readers } = diskOf()
  const facts = await collectPlanFinalizeFacts(request(), readers)
  assert.deepEqual(facts.objects.objectIds, ['object-001', 'object-002'])
  assert.equal(facts.knowledge.verified, true)
  assert.equal(facts.recalculation.verified, true)
  assert.equal(facts.evidence.entries.length, 1)
  const receipt = finalizePlan(facts)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.validation.workbookRecalculated, true)
})

test('知识索引读不到 → 翻成缺口，不是"没问题"', async () => {
  const { readers } = diskOf({ [PATH.knowledgeIndex]: undefined })
  const facts = await collectPlanFinalizeFacts(request(), readers)
  assert.equal(facts.knowledge.verified, false)
  assert.equal(facts.knowledge.missing.length > 0, true)
  assert.equal(finalizePlan(facts).status, 'blocked')
})

test('知识条目缺 digest 或有空正文 → 逐条进缺口（有记录 ≠ 可核对）', () => {
  const noDigest = knowledgeSourcesOf({ entries: [{ routeId: 'a', nodeName: 'x', digest: '' }] })
  assert.equal(noDigest.sources.length, 0)
  assert.match(noDigest.missing.join('；'), /缺少 routeId 或 digest/)
  const emptyBody = knowledgeSourcesOf({ entries: [{ routeId: 'a', digest: 'sha256:x', bodyNonEmpty: false }] })
  assert.equal(emptyBody.sources.length, 0)
  assert.match(emptyBody.missing.join('；'), /正文为空/)
  // 逐路由文档形态（`sources`）也要认。
  const asSources = knowledgeSourcesOf({ sources: [{ routeId: 'a', digest: 'sha256:x' }] })
  assert.equal(asSources.sources.length, 1)
})

test('没有重算记录 → unavailable（绝不用"底稿里有公式"推断已重算）', () => {
  const outcome = recalculationOf(null)
  assert.equal(outcome.state, 'unavailable')
  assert.equal(outcome.verified, false)
  assert.match(outcome.reason, /partial/)
})

test('模型自写的"重算成功"记录**不能**绕过真实验证：本机没有表格计算程序时判 failed', () => {
  // 这是 acceptance §11 的机器判据：`重算结论.json` 落在方案目录里、模型写得到，
  // 但"本机没有任何表格计算程序"这件事是可以探测的 —— 那种记录必然是编的。
  const forged = { state: 'recalculated', verified: true, providerId: 'libreoffice.local', reason: '重算通过' }
  const noEngine = recalculationOf(forged, { providers: [] })
  assert.equal(noEngine.state, 'failed')
  assert.equal(noEngine.verified, false, '没有引擎就不许 verified')
  assert.match(noEngine.reason, /探测不到任何表格计算程序/)
  assert.match(noEngine.reason, /partial/)
  assert.equal(noEngine.mismatches.some((item) => item.includes('provider 数 = 0')), true)

  // 探测到真实引擎时，记录可以被接受（引擎确实存在，重算这件事本来就可能做到）。
  const withEngine = recalculationOf(forged, { providers: [{ id: 'libreoffice.local', detail: '已配置' }] })
  assert.equal(withEngine.state, 'recalculated')
  assert.equal(withEngine.verified, true)

  // 调用方**不给**探测结果时保持原判据：不假装做过探测。
  assert.equal(recalculationOf(forged).verified, true)
  assert.equal(recalculationOf(forged).state, 'recalculated')
})

test('探测不到引擎时，finalize 把"声称重算成功"的记录降级（模型写文件也过不去）', async () => {
  const { readers } = diskOf({
    [PATH.recalculation]: { state: 'recalculated', verified: true, providerId: 'libreoffice.local', reason: '重算通过' },
  })
  const facts = await collectPlanFinalizeFacts(request(), { ...readers, recalcProviders: async () => [] })
  assert.equal(facts.recalculation.verified, false)
  assert.equal(facts.recalculation.state, 'failed')
  assert.equal(finalizePlan(facts).status, 'partial')
})

test('重算记录存在但 verified 不为 true → 仍然降级 partial', async () => {
  const { readers } = diskOf({ [PATH.recalculation]: { state: 'recalculated', verified: false, reason: '回读不一致', mismatches: ['object-002'] } })
  const facts = await collectPlanFinalizeFacts(request(), readers)
  assert.equal(finalizePlan(facts).status, 'partial')
})

test('报告没渲染 / 报告数据缺失 → 都不算完成', async () => {
  const noHtml = diskOf()
  noHtml.present.delete(PATH.reportHtml)
  const factsA = await collectPlanFinalizeFacts(request(), noHtml.readers)
  assert.equal(factsA.report.rendered, false)
  assert.equal(finalizePlan(factsA).status, 'partial')

  const noData = diskOf({ [PATH.reportData]: undefined })
  const factsB = await collectPlanFinalizeFacts(request(), noData.readers)
  assert.equal(factsB.report.schemaProblems.length > 0, true)
  assert.notEqual(finalizePlan(factsB).status, 'completed')
})

test('磁盘有底稿但报告数据没登记它 → 按未登记处理，不算工作簿齐备', async () => {
  const { readers } = diskOf({ [PATH.reportData]: { calculationSteps: [{ stepId: 's1' }], conclusions: [], workbooks: [] } })
  const facts = await collectPlanFinalizeFacts(request(), readers)
  assert.equal(facts.workbooks.length, 1, '磁盘上的底稿会被登记成一条（并注明未登记原因）')
  assert.match(facts.workbooks[0].recalculationNote, /没有登记/)
  assert.equal(finalizePlan(facts).status, 'partial')
})

test('知识要求截图而清单缺失 → partial；不要求则不影响', async () => {
  const withoutManifest = diskOf({ [PATH.screenshotManifest]: undefined })
  const required = await collectPlanFinalizeFacts(request({ screenshotRequired: true }), withoutManifest.readers)
  assert.equal(finalizePlan(required).status, 'partial')
  const notRequired = await collectPlanFinalizeFacts(request({ screenshotRequired: false }), withoutManifest.readers)
  assert.equal(finalizePlan(notRequired).status, 'completed')
})

test('冻结输入被改过 → finalize 直接 failed（适配层如实转达重算摘要）', async () => {
  const { readers } = diskOf()
  const tampered = { ...readers, recomputeInputDigest: async () => 'sha256:tampered' }
  const facts = await collectPlanFinalizeFacts(request(), tampered)
  const receipt = finalizePlan(facts)
  assert.equal(receipt.status, 'failed')
  assert.match(receipt.problems[0], /输入快照与冻结记录不一致/)
})

test('产物清单缺失或列出缺失件 → artifacts 不通过', async () => {
  const noManifest = diskOf({ [PATH.artifactManifest]: undefined })
  const factsA = await collectPlanFinalizeFacts(request(), noManifest.readers)
  assert.equal(factsA.artifacts.manifestOk, false)
  const withMissing = diskOf({ [PATH.artifactManifest]: { ok: true, missing: ['推理结果/图片/C001/a.png'] } })
  const factsB = await collectPlanFinalizeFacts(request(), withMissing.readers)
  assert.deepEqual(factsB.artifacts.missing, ['推理结果/图片/C001/a.png'])
  assert.equal(finalizePlan(factsB).status, 'partial')
})

test('模板验真记录缺失 → template=null → blocked（不预览模板就填表不算完成）', async () => {
  const { readers } = diskOf({ [PATH.template]: undefined })
  const facts = await collectPlanFinalizeFacts(request(), readers)
  assert.equal(facts.template, null)
  assert.equal(finalizePlan(facts).status, 'blocked')
})

test('两个方案不串：plan-002 没落盘时读不到 plan-001 的报告数据', async () => {
  const { readers } = diskOf()
  // plan-001 的交付件齐备（上一条已断言 completed）；plan-002 什么都没写。
  const other = await collectPlanFinalizeFacts(request({ planId: 'plan-002', taskId: 'plan-002-realestate' }), readers)
  assert.equal(other.report.rendered, false, 'plan-002 的报告不该"借"到 plan-001 的 HTML')
  assert.equal(other.objects.conclusions.length, 0, 'plan-002 的结论不能来自 plan-001 的报告数据')
  assert.equal(other.workbooks.length, 0)
  assert.notEqual(finalizePlan(other).status, 'completed')
})

test('planId 不是单段安全标识时一律当作读不到（不退回项目根）', async () => {
  const { readers } = diskOf()
  const facts = await collectPlanFinalizeFacts(request({ planId: '../plan-001' }), readers)
  assert.equal(facts.report.rendered, false)
  assert.equal(facts.objects.conclusions.length, 0)
  assert.equal(finalizePlan(facts).status !== 'completed', true)
})

test('screenshotsOf：合法 evidenceType 透传，legacy 记录不伪造 detail', () => {
  const base = {
    displayName: '阳光小区', provider: 'lianjia', sourceUrl: 'https://x/1', capturedAt: '2026-10-16T00:00:00Z',
    relativePath: '推理结果/图片/c/1.png', digest: 'sha256:a', validity: 'valid',
  }
  const rows = screenshotsOf({
    entries: [
      { ...base, caseId: 'c1', evidenceType: 'detail-screenshot' },
      { ...base, caseId: 'c2' },
      { ...base, caseId: 'c3', evidenceType: 'bogus' },
    ],
  })
  assert.equal(rows[0].evidenceType, 'detail-screenshot')
  assert.equal('evidenceType' in rows[1], false, 'legacy 记录不得被伪造为 detail')
  assert.equal('evidenceType' in rows[2], false, '非法值不透传')
})
