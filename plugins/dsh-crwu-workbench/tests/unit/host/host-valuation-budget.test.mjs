/**
 * 检索**预算**（`market/budget.ts`）—— 协议 39 / 设计稿 §5.2。
 *
 * 这一份钉的是"换词 / 重试 / 恢复都不能重置预算"这条口径的**纯函数部分**：
 * 预算的键里没有关键字、没有页码、没有尝试次数，只有 项目 / 方案 / 分组 / 来源 / 轮次。
 * 工具侧的读写与"触顶即停"在 `host-valuation-market-tool.test.mjs` 里验。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  BUDGET_FILE, MARKET_CANDIDATE_LIMIT, MARKET_PAGE_LIMIT,
  budgetFromJson, budgetMatches, emptyBudget, pageAllowanceOf, recordPage,
} = await import(new URL('src/host/domains/report-evaluation/market/budget.ts', ROOT).href)

const AT = '2026-10-15T03:00:00.000Z'
const base = () => emptyBudget({ projectId: 'p1', planId: 'plan-001', group: 'sale', updatedAt: AT })

test('上限就是已确认的业务口径：10 页 / 20 条', () => {
  assert.equal(MARKET_PAGE_LIMIT, 10)
  assert.equal(MARKET_CANDIDATE_LIMIT, 20)
  assert.equal(BUDGET_FILE, '取数预算.json')
})

test('刚开始时可以翻页，触顶后给出具体是哪一个上限', () => {
  let budget = base()
  for (let page = 1; page <= 10; page += 1) {
    assert.equal(pageAllowanceOf(budget, 'lianjia').allowed, true, `第 ${String(page)} 页应当可以取`)
    budget = recordPage(budget, 'lianjia', [`c-${String(page)}`], AT).budget
  }
  const stopped = pageAllowanceOf(budget, 'lianjia')
  assert.equal(stopped.allowed, false)
  assert.equal(stopped.stoppedBy, 'page-limit')
  assert.match(stopped.reason, /10 页/)
  assert.equal(stopped.pagesUsed, 10)
})

test('候选先满 20 条就在页数没到 10 之前停（任一上限触顶即停）', () => {
  let budget = base()
  // 每页 5 条：第 4 页结束时 20 条，页数才 4。
  for (let page = 1; page <= 4; page += 1) {
    const keys = [0, 1, 2, 3, 4].map((index) => `c-${String(page)}-${String(index)}`)
    budget = recordPage(budget, 'lianjia', keys, AT).budget
  }
  const stopped = pageAllowanceOf(budget, 'lianjia')
  assert.equal(stopped.allowed, false)
  assert.equal(stopped.stoppedBy, 'candidate-limit')
  assert.equal(stopped.pagesUsed, 4)
  assert.equal(stopped.candidatesUsed, 20)
  assert.match(stopped.reason, /20 条/)
})

test('同源重复条目不算新候选（同一身份再出现一次不加计数）', () => {
  const first = recordPage(base(), 'lianjia', ['a', 'b', 'c'], AT)
  assert.equal(first.added, 3)
  const again = recordPage(first.budget, 'lianjia', ['a', 'b', 'd'], AT)
  assert.equal(again.added, 1, '只有 d 是新的')
  assert.equal(again.budget.providers.lianjia.candidates, 4)
  assert.equal(again.budget.providers.lianjia.pages, 2, '页数照记（重复条目不影响"翻过几页"）')
})

test('预算与关键字无关：换词读到的是同一份账', () => {
  const budget = recordPage(base(), 'lianjia', ['a'], AT).budget
  // 关键字根本不在预算里 —— 换词、换筛选、重复调用都拿到同一份账。
  assert.equal(budgetMatches(budget, { projectId: 'p1', planId: 'plan-001', group: 'sale', round: 1 }), true)
  assert.equal(Object.keys(budget).includes('keyword'), false)
})

test('分组 / 轮次 / 方案 / 项目任一不同都不复用旧账', () => {
  const budget = recordPage(base(), 'lianjia', ['a'], AT).budget
  assert.equal(budgetMatches(budget, { projectId: 'p1', planId: 'plan-001', group: 'rent', round: 1 }), false)
  assert.equal(budgetMatches(budget, { projectId: 'p1', planId: 'plan-001', group: 'sale', round: 2 }), false)
  assert.equal(budgetMatches(budget, { projectId: 'p1', planId: 'plan-002', group: 'sale', round: 1 }), false)
  assert.equal(budgetMatches(budget, { projectId: 'p2', planId: 'plan-001', group: 'sale', round: 1 }), false)
})

test('各来源各记各的账（链家触顶不影响安居客）', () => {
  let budget = base()
  for (let page = 1; page <= 10; page += 1) {
    budget = recordPage(budget, 'lianjia', [`l-${String(page)}`], AT).budget
  }
  assert.equal(pageAllowanceOf(budget, 'lianjia').allowed, false)
  assert.equal(pageAllowanceOf(budget, 'anjuke').allowed, true)
  assert.equal(pageAllowanceOf(budget, 'anjuke').pagesUsed, 0)
})

test('落盘 JSON 能读回来；形状不对时返回 null（调用方重建并如实说明）', () => {
  const budget = recordPage(base(), 'lianjia', ['a', 'b'], AT).budget
  const round = budgetFromJson(JSON.parse(JSON.stringify(budget)))
  assert.deepEqual(round, budget)
  assert.equal(budgetFromJson(null), null)
  assert.equal(budgetFromJson({ schemaVersion: '别的' }), null)
  assert.equal(budgetFromJson({ schemaVersion: 'crwu.valuation.retrieval-budget.v1' })?.round, 1)
})

test('空预算的默认分组是 "sale"，轮次是 1', () => {
  const budget = emptyBudget({ projectId: 'p', planId: 'plan', group: '', updatedAt: AT })
  assert.equal(budget.group, 'sale')
  assert.equal(budget.round, 1)
  assert.deepEqual(budget.providers, {})
})
