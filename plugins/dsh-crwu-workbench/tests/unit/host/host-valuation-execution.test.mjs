/**
 * 动态调度与单执行租约（设计稿 §9.1 / §9.2，计划 Task 7）。
 *
 * 这一层只回答两个问题，但两个都错得很贵：
 *
 * 1. **该不该起子 Agent**：状态读不出来、上一轮刚被拒、启动已经超过技术 SLA 时继续扩张，
 *    会让同一份资料被两个执行者同时算，而两边结论看起来都正常；
 * 2. **同一个任务是不是已经有人在跑**：子 Agent 启动**可能超时且结果未知**，
 *    此时父会话"因为没收到确认"就自己再算一遍，会把两份结论写进同一个方案目录。
 *
 * 顺序执行是**完整有效**的主路径，不是功能缺失 —— 所以"未知/繁忙 → sequential"是断言，不是兜底。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { decideExecution, DEFAULT_MAX_CONCURRENCY, DEFAULT_START_SLA_MS } = await import(
  new URL('src/host/domains/report-evaluation/execution/decision.ts', ROOT).href)
const { createTaskLeaseStore } = await import(
  new URL('src/host/domains/report-evaluation/execution/leases.ts', ROOT).href)

/** 一份"资源充足、状态明确"的事实，逐条覆盖它来构造降级场景。 */
function healthy(overrides = {}) {
  return {
    statusKnown: true,
    externalRunningCount: 0,
    providerUsable: true,
    filterSupported: true,
    activeOwnedTaskIds: [],
    lastStartDurationMs: 500,
    lastStartFailure: false,
    readyTaskIds: ['plan-001', 'plan-002', 'plan-003'],
    ...overrides,
  }
}

// ── 调度决策 ───────────────────────────────────────────────────────────────

test('状态未知 → sequential（资源是不是真的空闲无从确认）', () => {
  const decision = decideExecution(healthy({ statusKnown: false }))
  assert.equal(decision.mode, 'sequential')
  assert.deepEqual(decision.delegatedTaskIds, [])
  assert.deepEqual(decision.parentTaskIds, ['plan-001', 'plan-002', 'plan-003'])
  assert.equal(decision.degradation.some((row) => row.includes('运行状态')), true)
})

test('无 provider / filter 不可验证 / 存在其他繁忙任务 → sequential', () => {
  assert.equal(decideExecution(healthy({ providerUsable: false })).mode, 'sequential')
  assert.equal(decideExecution(healthy({ filterSupported: false })).mode, 'sequential')
  assert.equal(decideExecution(healthy({ externalRunningCount: 2 })).mode, 'sequential')
  assert.equal(decideExecution(healthy({ lastStartFailure: true })).mode, 'sequential')
})

test('启动耗时超过技术 SLA 就停止扩张（10001ms > 10000ms）', () => {
  assert.equal(decideExecution(healthy({ lastStartDurationMs: DEFAULT_START_SLA_MS })).mode, 'parallel')
  const slow = decideExecution(healthy({ lastStartDurationMs: DEFAULT_START_SLA_MS + 1 }))
  assert.equal(slow.mode, 'sequential')
  assert.equal(slow.degradation.some((row) => row.includes('超过')), true)
  assert.equal(slow.degradation.some((row) => row.includes('10001ms')), true)
})

test('单方案直接父会话执行，不为此单开子 Agent', () => {
  const decision = decideExecution(healthy({ readyTaskIds: ['plan-001'] }))
  assert.equal(decision.mode, 'sequential')
  assert.deepEqual(decision.parentTaskIds, ['plan-001'])
  assert.deepEqual(decision.delegatedTaskIds, [])
})

test('状态健康时可以有界并行，并发上限是 2 且不是"必须并行 2 个"', () => {
  const decision = decideExecution(healthy())
  assert.equal(decision.mode, 'parallel')
  assert.deepEqual(decision.delegatedTaskIds, ['plan-001', 'plan-002'])
  assert.deepEqual(decision.parentTaskIds, ['plan-003'], '未启动的方案转顺序队列')
  assert.equal(decision.concurrencyCap, DEFAULT_MAX_CONCURRENCY)

  // 调用方想把上限放大：安全上限是硬顶，不是建议。
  const wider = decideExecution(healthy({ maxConcurrency: 8 }))
  assert.equal(wider.concurrencyCap, DEFAULT_MAX_CONCURRENCY)
  assert.equal(wider.delegatedTaskIds.length, DEFAULT_MAX_CONCURRENCY)
})

test('已经有执行者的任务不再排给父会话（防"名义顺序、实际重复"）', () => {
  const decision = decideExecution(healthy({ activeOwnedTaskIds: ['plan-001'], readyTaskIds: ['plan-001', 'plan-002', 'plan-003'] }))
  assert.equal(decision.delegatedTaskIds.includes('plan-001'), false)
  assert.equal(decision.parentTaskIds.includes('plan-001'), false)
})

test('没有依赖已满足的任务时顺序模式也不报错', () => {
  const decision = decideExecution(healthy({ readyTaskIds: [] }))
  assert.equal(decision.mode, 'sequential')
  assert.deepEqual(decision.parentTaskIds, [])
})

// ── 单执行租约 ─────────────────────────────────────────────────────────────

test('同一任务的另一个 attempt 拿不到租约（计划指定的原话断言）', () => {
  const lease = createTaskLeaseStore()
  assert.equal(lease.acquire({ taskId: 'task-1', planId: 'plan-001', attemptId: 'attempt-A', executor: 'child' }), true)
  assert.equal(lease.acquire({ taskId: 'task-1', planId: 'plan-001', attemptId: 'attempt-B', executor: 'parent' }), false)
  // 同一个 attempt 重复取得是幂等的：重试同一件事不该被判成冲突。
  assert.equal(lease.acquire({ taskId: 'task-1', planId: 'plan-001', attemptId: 'attempt-A', executor: 'child' }), true)
})

test('启动状态未知时保留租约：父会话不能接手去重算', () => {
  const lease = createTaskLeaseStore()
  lease.acquire({ taskId: 'task-2', planId: 'plan-001', attemptId: 'attempt-A', executor: 'child' })
  assert.equal(lease.markStartUnknown('task-2', 'attempt-A').ok, true)
  assert.equal(lease.leaseOf('task-2').state, 'start-unknown')
  assert.equal(lease.acquire({ taskId: 'task-2', planId: 'plan-001', attemptId: 'attempt-B', executor: 'parent' }), false)
  assert.equal(lease.isQuiescent('task-2'), false)
  assert.deepEqual(lease.activeTaskIds(), ['task-2'])
  // 未确认静止就不许释放。
  assert.equal(lease.release('task-2').ok, false)
})

test('晚到的子身份可以绑定到同一个租约，但换一个身份不行', () => {
  const lease = createTaskLeaseStore()
  lease.acquire({ taskId: 'task-3', planId: 'plan-001', attemptId: 'attempt-A', executor: 'child' })
  lease.markStartUnknown('task-3', 'attempt-A')
  assert.equal(lease.bindChild('task-3', 'attempt-A', 'session-child-1', 12_500).ok, true)
  assert.equal(lease.leaseOf('task-3').state, 'running')
  assert.equal(lease.leaseOf('task-3').startDurationMs, 12_500)
  // 已经有真实子身份之后再绑另一个：拒绝。
  assert.equal(lease.bindChild('task-3', 'attempt-A', 'session-child-2').ok, false)
  // 别人的 attempt 不许改动。
  assert.equal(lease.settle('task-3', 'attempt-B').ok, false)
  assert.equal(lease.bindChild('task-3', 'attempt-B', 'session-child-3').ok, false)
  assert.equal(lease.settle('task-3', 'attempt-A').ok, true)
  assert.equal(lease.isQuiescent('task-3'), true)
  // 确认静止之后才允许换执行者。
  assert.equal(lease.release('task-3').ok, true)
  assert.equal(lease.acquire({ taskId: 'task-3', planId: 'plan-001', attemptId: 'attempt-C', executor: 'parent' }), true)
})

test('租约归属按 planId 判定：跨方案写拒绝', () => {
  const lease = createTaskLeaseStore()
  lease.acquire({ taskId: 'task-4', planId: 'plan-001', attemptId: 'attempt-A', executor: 'child' })
  assert.equal(lease.belongsToPlan('task-4', 'plan-001'), true)
  assert.equal(lease.belongsToPlan('task-4', 'plan-002'), false)
  assert.equal(lease.belongsToPlan('task-unknown', 'plan-001'), false)
})

test('空身份一律拒绝（不能把任务记给一个不知道是谁的执行者）', () => {
  const lease = createTaskLeaseStore()
  assert.equal(lease.acquire({ taskId: '', planId: 'plan-001', attemptId: 'a', executor: 'child' }), false)
  assert.equal(lease.acquire({ taskId: 't', planId: '', attemptId: 'a', executor: 'child' }), false)
  assert.equal(lease.acquire({ taskId: 't', planId: 'p', attemptId: '', executor: 'child' }), false)
  lease.acquire({ taskId: 't', planId: 'p', attemptId: 'a', executor: 'child' })
  assert.equal(lease.bindChild('t', 'a', '').ok, false)
})

test('结算后的租约不再算活动任务，也不挡住别的方案', () => {
  const lease = createTaskLeaseStore()
  lease.acquire({ taskId: 'task-5', planId: 'plan-001', attemptId: 'a', executor: 'child' })
  lease.acquire({ taskId: 'task-6', planId: 'plan-002', attemptId: 'b', executor: 'child' })
  lease.settle('task-5', 'a')
  assert.deepEqual(lease.activeTaskIds(), ['task-6'])
  assert.equal(lease.isQuiescent('task-5'), true)
  assert.equal(lease.isQuiescent('task-6'), false)
})

test('租约表有界：只淘汰已结算的，绝不挤掉在跑的', () => {
  const lease = createTaskLeaseStore({ maxEntries: 2, now: () => 1 })
  lease.acquire({ taskId: 'a', planId: 'p', attemptId: 'x', executor: 'parent' }, 1)
  lease.acquire({ taskId: 'b', planId: 'p', attemptId: 'x', executor: 'parent' }, 2)
  lease.settle('a', 'x')
  lease.acquire({ taskId: 'c', planId: 'p', attemptId: 'x', executor: 'parent' }, 3)
  assert.equal(lease.leaseOf('a'), undefined, '已结算的最旧租约被淘汰')
  assert.notEqual(lease.leaseOf('b'), undefined, '在跑的租约不许被挤掉')
  assert.notEqual(lease.leaseOf('c'), undefined)
})

// ── 执行循环：dispatch / join（计划 Task 7） ─────────────────────────────────

const { dispatchReadyTasks, joinTasks } = await import(
  new URL('src/host/domains/report-evaluation/execution/dispatch.ts', ROOT).href)

const TASKS = [
  { taskId: 'task-1', planId: 'plan-001', objectIds: ['object-001'], dependsOn: [], assetClass: 'realestate', valuationPath: 'combined', valueScope: 'land-and-building', status: 'pending' },
  { taskId: 'task-2', planId: 'plan-002', objectIds: ['object-002'], dependsOn: [], assetClass: 'realestate', valuationPath: 'combined', valueScope: 'land-and-building', status: 'pending' },
  { taskId: 'task-3', planId: 'plan-003', objectIds: ['object-003'], dependsOn: ['task-2'], assetClass: 'land', valuationPath: 'separate', valueScope: 'land-only', status: 'pending' },
  { taskId: 'task-4', planId: 'plan-004', objectIds: ['object-004'], dependsOn: [], assetClass: 'realestate', valuationPath: 'combined', valueScope: 'land-and-building', status: 'blocked' },
]

/** 一套依赖替身：默认"状态未知 → 顺序"，也就是生产上最常见的那条路径。 */
function dispatchDeps(overrides = {}) {
  const leases = overrides.leases ?? createTaskLeaseStore()
  const started = []
  const stopped = []
  const deps = {
    tasks: TASKS,
    leases,
    // 默认走"状态未知 → 顺序"这条生产上最常见的路径；readyTaskIds 必须原样透传，
    // 否则决策层看到的是"没有可执行任务"，那会把真实缺陷盖住。
    readFacts: ({ readyTaskIds }) => ({ facts: healthy({ readyTaskIds, statusKnown: false }), notes: [] }),
    startChild: async (input) => { started.push(input); return { ok: true, childId: `child-${input.taskId}`, error: '', durationMs: 10 } },
    missingChildTools: async () => [],
    stopChild: async (childId, reason) => { stopped.push({ childId, reason }) },
    ...overrides,
  }
  return { deps, leases, started, stopped }
}

test('依赖未完成的任务不进本轮：顺序执行也按依赖排', async () => {
  const { deps } = dispatchDeps()
  const outcome = await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a1' }, deps)
  assert.equal(outcome.mode, 'sequential')
  assert.deepEqual(outcome.parentTaskIds, ['task-1', 'task-2'])
  assert.equal(outcome.skipped.some((row) => row.taskId === 'task-3' && /依赖/.test(row.reason)), true)
  assert.equal(outcome.parentTaskIds.includes('task-4'), false, '被阻断的方案不排执行')
})

test('父会话拿到的一批任务**真的**进了租约：重复调度不会排第二遍', async () => {
  const { deps, leases } = dispatchDeps()
  const first = await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a1' }, deps)
  assert.equal(first.parentTaskIds.length, 2)
  for (const taskId of first.parentTaskIds) {
    assert.equal(leases.isQuiescent(taskId), false, `${taskId} 应当有执行者`)
  }
  const second = await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a2' }, deps)
  assert.deepEqual(second.parentTaskIds, [], '同一个任务不能在第二次调度里再排一遍')
  const leasedSkips = second.skipped.filter((row) => ['task-1', 'task-2'].includes(row.taskId))
  assert.equal(leasedSkips.length, 2)
  assert.equal(leasedSkips.every((row) => /执行者/.test(row.reason)), true)
})

test('状态健康 + 多方案 → 有界并行；创建后回读可见性不过就停掉并留在未知状态', async () => {
  const healthyDeps = dispatchDeps({
    readFacts: ({ readyTaskIds }) => ({ facts: healthy({ readyTaskIds }), notes: [] }),
    missingChildTools: async (childId) => (childId === 'child-task-1' ? ['crwu_valuation_market_capture'] : []),
  })
  const outcome = await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a1' }, healthyDeps.deps)
  assert.equal(outcome.mode, 'parallel')
  assert.equal(healthyDeps.started.length, 2, '并发上限 2')
  // task-1 的回读没过：它必须被停掉，且租约留在"未知"——父会话不许接手。
  assert.deepEqual(outcome.delegated.map((row) => row.taskId), ['task-2'])
  assert.match(outcome.failed[0].error, /可见性不足/)
  assert.equal(healthyDeps.stopped.some((row) => row.childId === 'child-task-1'), true)
  assert.equal(healthyDeps.leases.leaseOf('task-1').state, 'start-unknown')
  assert.equal(healthyDeps.leases.leaseOf('task-1').executor, 'child')
})

test('子会话创建失败 → 租约保留未知状态（父会话不许接手重算）', async () => {
  const deps = dispatchDeps({
    readFacts: ({ readyTaskIds }) => ({ facts: healthy({ readyTaskIds }), notes: [] }),
    startChild: async () => ({ ok: false, childId: '', error: '创建超时', durationMs: null }),
  })
  const outcome = await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a1' }, deps.deps)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /创建超时/)
  for (const row of outcome.failed) {
    const lease = deps.leases.leaseOf(row.taskId)
    assert.equal(lease.state, 'start-unknown')
    assert.equal(deps.leases.isQuiescent(row.taskId), false)
  }
})

test('join：子会话还在跑就不结算；结束了才结算', () => {
  const leases = createTaskLeaseStore()
  leases.acquire({ taskId: 'task-1', planId: 'plan-001', attemptId: 'a1', executor: 'child' })
  leases.bindChild('task-1', 'a1', 'child-1', 500)
  const running = joinTasks({ projectId: 'p', taskIds: ['task-1'] }, { leases, childStatusOf: () => 'running' })
  assert.equal(running.tasks[0].settled, false)
  assert.deepEqual(running.runningTaskIds, ['task-1'])
  assert.equal(leases.isQuiescent('task-1'), false)

  const done = joinTasks({ projectId: 'p', taskIds: ['task-1'] }, { leases, childStatusOf: () => 'done' })
  assert.equal(done.tasks[0].settled, true)
  assert.equal(leases.isQuiescent('task-1'), true)
  assert.equal(leases.belongsToPlan('task-1', 'plan-001'), true, '结算不改变归属')
})

test('join：父会话没给结论就不算做完（不许把"没做完"记成"做完了"）', () => {
  const leases = createTaskLeaseStore()
  leases.acquire({ taskId: 'task-1', planId: 'plan-001', attemptId: 'a1', executor: 'parent' })
  const pending = joinTasks({ projectId: 'p', taskIds: ['task-1'] }, { leases, childStatusOf: () => '' })
  assert.equal(pending.tasks[0].settled, false)
  assert.match(pending.tasks[0].note, /还没给出结论/)

  const settled = joinTasks(
    { projectId: 'p', taskIds: ['task-1'], outcomes: { 'task-1': { status: 'completed', note: '父会话算完' } } },
    { leases, childStatusOf: () => '' },
  )
  assert.equal(settled.tasks[0].settled, true)
  assert.equal(leases.isQuiescent('task-1'), true)
})

test('跨方案：租约归属按 planId 判定，结算后别的方案才拿得到', async () => {
  const leases = createTaskLeaseStore()
  const deps = dispatchDeps({ leases })
  await dispatchReadyTasks({ projectId: 'p', parentSessionId: 's', attemptId: 'a1' }, deps.deps)
  assert.equal(leases.belongsToPlan('task-1', 'plan-002'), false)
  assert.equal(leases.belongsToPlan('task-1', 'plan-001'), true)
})

test('执行工具在注册清单里，且不进审核必需集', async () => {
  const { VALUATION_TOOL_NAMES, VALUATION_CHILD_TOOLS } = await import(
    new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
  const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(
    new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
  for (const name of [VALUATION_TOOL_NAMES.executionDispatch, VALUATION_TOOL_NAMES.executionJoin]) {
    assert.equal(name, name.startsWith('crwu_valuation_execution_') ? name : '', '固定工具名')
    assert.equal(CRWU_BUSINESS_TOOLS.includes(name), true, name)
    assert.equal(REQUIRED_AUDIT_TOOLS.includes(name), false, name)
    assert.equal(VALUATION_CHILD_TOOLS.includes(name), true, name)
  }
})
