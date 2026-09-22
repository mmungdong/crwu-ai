/**
 * `oss-result` 摘要（`auditInfoFromResult`）的单元测试。
 *
 * 2026-09-23 起这个摘要多了两组**裁剪字段**，供抽屉的「AI 检出问题」与「已提未改」使用：
 *
 * - `issues[]`：只留 8 个字段，逐字段截断、整体封顶 100 条；
 * - `reviewComparison.reviewItems[]`：只留 6 个字段（含 `linkedIssueIds` / `inFileResolution`
 *   这两个"已提未改"的判据来源）。
 *
 * 这一层必须盯两件**反向**的事：
 * 1. **不泄漏证据链** —— `ruleEvidence` / `materialEvidence` / 知识库路径 / 完整 quote 一律不进这个接口
 *    （它会被整包塞进浏览器状态；完整证据只在交付件里）；
 * 2. **上限与截断真的生效** —— 否则一份异常报告就能把一次同源 RPC 撑爆。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { auditInfoFromResult } = await import(new URL('src/host/audit/summary.ts', ROOT).href)

/** 一份最小但结构完整的审核结果（字段名逐字照 `audit_result.schema.json`）。 */
function resultDoc(patch = {}) {
  return {
    schemaVersion: 'crwu-audit-result/1.0',
    auditTask: { projectId: 'P-1', auditTime: '2026-09-20T17:40:00+0800', engineVersion: 'engine/1', reportVersion: '复核报告', profile: { stage: '复核' } },
    summary: { overallDecision: 'fail', narrative: 'n', counts: { issuesTotal: 2, high: 1, medium: 1, low: 0 } },
    issues: [
      {
        issueId: 'ISS-01',
        title: '标题一',
        severity: 'high',
        decision: 'fail',
        problemDescription: '第一句。第二句。',
        locationSummary: '位置一',
        handlingRequirement: '建议一',
        gapAnalysis: { ruleRequirement: 'R', observedCondition: 'O', difference: '差异一', finalJudgment: 'J' },
        ruleEvidence: [{ ruleId: 'RULE-1', quote: '规则原文' }],
        materialEvidence: [{ file: 'a.xlsx', locator: 'Sheet1!A1', quote: '材料原文' }],
        flowStatus: 'pending_response',
        reviewComparison: { status: 'performed', category: 'A' },
      },
    ],
    reviewComparison: {
      status: 'performed',
      metrics: { evaluable: 3, exactHits: 1, partialHits: 0, aiHitRate: '33.3%' },
      bands: { overlap: 1, aiOnly: 1, reviewerOnly: 0, divergent: 0 },
      reviewFiles: [{ order: 1, level: '一级复核', displayName: '复核报告', version: 'v1' }],
      reviewItems: [
        {
          itemId: 'R-1', title: '人工意见', matchStatus: 'partial', linkedIssueIds: ['ISS-01', ''],
          inFileResolution: 'L-open',
          reviewerEvidence: { file: 'b.docx', locator: 'p1', quote: '未见委托合同' },
          inFileEvidence: { file: 'c.docx', locator: 'p2', quote: '已列示' },
          handling: '内部处置说明',
        },
      ],
      reviewerOnlyItems: [{ itemId: 'L-1', title: '人工独有' }],
    },
    fileTrace: { generatedAt: '2026-09-20 17:41:02', rendererVersion: 'r/2', sourceDigest: 'sha256:abc' },
    ...patch,
  }
}

test('摘要里的 issues 只保留抽屉需要的字段，证据链一律不带出去', () => {
  const info = auditInfoFromResult(resultDoc())
  assert.equal(Array.isArray(info.issues), true)
  assert.deepEqual(Object.keys(info.issues[0]).sort(), [
    'decision', 'difference', 'handlingRequirement', 'issueId', 'locationSummary',
    'problemDescription', 'severity', 'title',
  ])
  assert.equal(info.issues[0].issueId, 'ISS-01')
  assert.equal(info.issues[0].title, '标题一')
  assert.equal(info.issues[0].severity, 'high')
  assert.equal(info.issues[0].difference, '差异一', 'gapAnalysis.difference 要提上来（首屏简述优先用它）')
  // 反向：证据链不进摘要
  for (const leaked of ['ruleEvidence', 'materialEvidence', 'gapAnalysis', 'flowStatus', 'confidence', 'reviewComparison']) {
    assert.equal(leaked in info.issues[0], false, `issues[] 不该带 ${leaked}`)
  }
})

test('摘要里的 reviewItems 只保留判据字段（linkedIssueIds / inFileResolution）', () => {
  const info = auditInfoFromResult(resultDoc())
  const items = info.reviewComparison.reviewItems
  assert.equal(Array.isArray(items), true)
  assert.deepEqual(Object.keys(items[0]).sort(), [
    'inFileResolution', 'itemId', 'linkedIssueIds', 'matchStatus', 'reviewerQuote', 'title',
  ])
  assert.deepEqual(items[0].linkedIssueIds, ['ISS-01'], '空串的关联 id 要滤掉')
  assert.equal(items[0].inFileResolution, 'L-open')
  assert.equal(items[0].reviewerQuote, '未见委托合同', '人工原话要留下来（抽屉直接展示）')
  // 反向：复核项的其它证据 / 处置说明不进摘要
  for (const leaked of ['reviewerEvidence', 'inFileEvidence', 'closureEvidence', 'handling', 'module', 'reviewLevel']) {
    assert.equal(leaked in items[0], false, `reviewItems[] 不该带 ${leaked}`)
  }
})

test('摘要对超长文本逐字段截断，且整体按上限封顶', () => {
  const long = 'x'.repeat(2000)
  const doc = resultDoc({
    issues: Array.from({ length: 130 }, (_, index) => ({
      issueId: `ISS-${String(index)}`, title: long, severity: 'low',
      problemDescription: long, locationSummary: long, handlingRequirement: long,
      gapAnalysis: { difference: long },
    })),
    reviewComparison: {
      ...resultDoc().reviewComparison,
      reviewItems: Array.from({ length: 130 }, (_, index) => ({
        itemId: `R-${String(index)}`, title: long, linkedIssueIds: ['ISS-0'], inFileResolution: 'L-open',
        reviewerEvidence: { quote: long },
      })),
    },
  })
  const info = auditInfoFromResult(doc)
  assert.equal(info.issues.length, 100, 'issues 封顶 100 条')
  assert.equal(info.reviewComparison.reviewItems.length, 100, 'reviewItems 封顶 100 条')
  const issue = info.issues[0]
  assert.equal(issue.title.length, 200)
  assert.equal(issue.problemDescription.length, 400)
  assert.equal(issue.difference.length, 300)
  assert.equal(issue.locationSummary.length, 240)
  assert.equal(issue.handlingRequirement.length, 400)
  assert.equal(info.reviewComparison.reviewItems[0].reviewerQuote.length, 300)
})

test('旧结果 / 畸形结果降级成空数组，不抛错也不编内容', () => {
  // 老审核产物（没有 issues / reviewItems）：两个字段都是空数组，客户端据此降级渲染。
  const legacy = auditInfoFromResult({ auditTask: { projectId: 'P' }, summary: { overallDecision: 'pass', counts: { issuesTotal: 0 } }, reviewComparison: { status: 'not_performed' } })
  assert.deepEqual(legacy.issues, [])
  assert.deepEqual(legacy.reviewComparison.reviewItems, [])
  // 形状不对：不是数组就当空数组；条目不是对象就当空对象。
  const broken = auditInfoFromResult({
    issues: 'not-an-array',
    reviewComparison: { status: 'performed', reviewItems: [null, 42, { itemId: 'R', linkedIssueIds: 'nope' }] },
  })
  assert.deepEqual(broken.issues, [])
  assert.equal(broken.reviewComparison.reviewItems.length, 3)
  assert.deepEqual(broken.reviewComparison.reviewItems[0].linkedIssueIds, [])
  assert.deepEqual(broken.reviewComparison.reviewItems[2].linkedIssueIds, [])
  assert.equal(broken.reviewComparison.reviewItems[2].itemId, 'R')
})
