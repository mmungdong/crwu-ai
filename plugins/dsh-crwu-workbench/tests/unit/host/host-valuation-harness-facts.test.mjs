/**
 * Harness 事实读取（设计稿 §9.3，计划 Task 7）。
 *
 * 这一层唯一会犯的错是**美化事实**：读不到就当成"没人占用"、provider 解析不出来就当成可用、
 * Tool 可见性没验证就当成没问题 —— 三种都会让并发在没有任何依据的情况下开起来。
 * 所以每条口径都要有断言，而且断言的是"**不知道**怎么写"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { readHarnessFacts } = await import(
  new URL('src/host/domains/report-evaluation/execution/harness-facts.ts', ROOT).href)
const { decideExecution } = await import(
  new URL('src/host/domains/report-evaluation/execution/decision.ts', ROOT).href)
const { createTaskLeaseStore } = await import(
  new URL('src/host/domains/report-evaluation/execution/leases.ts', ROOT).href)

/** 最小 ctx：`get(service)` 返回注入的服务。 */
function ctxOf(services) {
  return { get: (name) => services[name] }
}

test('服务都读不到 → statusKnown=false（不是"没人跑"），并退化为顺序', () => {
  const { facts, notes } = readHarnessFacts({ ctx: ctxOf({}), readyTaskIds: ['task-1'] })
  assert.equal(facts.statusKnown, false, '读不到服务必须是"不知道"')
  assert.equal(facts.providerUsable, false)
  assert.equal(facts.filterSupported, false)
  assert.equal(facts.lastStartDurationMs, null, '没有过启动就是 null，不是 0')
  assert.equal(notes.length > 0, true, '降级原因要能说出来')
  const decision = decideExecution(facts)
  assert.equal(decision.mode, 'sequential')
  assert.match(decision.reason, /状态未知/)
})

test('子 Agent 数量读不到 → 仍然是"不知道"，不当 0', () => {
  const { facts } = readHarnessFacts({
    ctx: ctxOf({ agents: { get: () => undefined }, subagents: { list: () => undefined } }),
    readyTaskIds: ['task-1'],
  })
  assert.equal(facts.statusKnown, false)
})

test('没有可用 provider → 一律顺序（可见性保证不了就不放子 Agent）', () => {
  const { facts, notes } = readHarnessFacts({
    ctx: ctxOf({ agents: { get: () => undefined }, subagents: { list: () => [] } }),
    readyTaskIds: ['task-1'],
  })
  assert.equal(facts.filterSupported, false)
  assert.match(notes.join('；'), /toolFilter/)
  assert.equal(decideExecution(facts).mode, 'sequential')
})

test('provider 声明支持 toolFilter → filterSupported=true，但仍要求创建后回读可见性', () => {
  const { facts, notes } = readHarnessFacts({
    ctx: ctxOf({
      agents: { get: () => undefined },
      subagents: {
        list: () => ['spawn'],
        listChildren: () => [],
        getProvider: (name) => (name === 'spawn' ? { capabilities: { toolFilter: true } } : undefined),
      },
    }),
    readyTaskIds: ['task-1'],
  })
  // 没有运行中的子会话 + provider 可用 + 支持过滤 → 事实层面允许并行（有界）。
  assert.equal(facts.providerUsable, true, notes.join('；'))
  assert.equal(facts.filterSupported, true)
  assert.equal(facts.statusKnown, true)
  assert.match(notes.join('；'), /回读子会话实际可见的工具/)
})

test('抛错也是"不知道"：读状态出错不许被当成空状态', () => {
  const { facts, notes } = readHarnessFacts({
    ctx: { get: () => { throw new Error('service exploded') } },
    readyTaskIds: ['task-1'],
  })
  assert.equal(facts.statusKnown, false)
  assert.match(notes.join('；'), /读 Agent 运行状态时出错/)
})

test('租约给出"本项目已占用的任务"，start-unknown 记为上一次启动失败', () => {
  const leases = createTaskLeaseStore()
  leases.acquire({ taskId: 'task-9', planId: 'plan-1', attemptId: 'a1', executor: 'parent' })
  leases.markStartUnknown('task-9', 'a1')
  const { facts } = readHarnessFacts({
    ctx: ctxOf({ agents: { get: () => undefined }, subagents: { list: () => [] } }),
    leases,
    readyTaskIds: ['task-1', 'task-9'],
  })
  assert.deepEqual(facts.activeOwnedTaskIds, ['task-9'])
  assert.equal(facts.lastStartFailure, true, 'start-unknown 就是"上一次启动结果不明"')
  // 已占用的任务不进父会话队列：否则就是"名义顺序、实际重复"。
  const decision = decideExecution(facts)
  assert.deepEqual(decision.parentTaskIds, ['task-1'])
})
