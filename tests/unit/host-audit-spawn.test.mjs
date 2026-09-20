/**
 * 审核子会话创建（`audit/spawn.ts` 的 `startChild` / `pickProvider`）的单元测试。
 *
 * 这是**唯一一条不能拿真实 DSH 实测的调用**：真发一次就是在一个真实案例上跑一次真实审核，
 * 会往真实工作空间写产物、可能自动传真实 OSS。所以它的请求形状必须由测试盯死，
 * 不能靠「我在真机上点过」。下面断言的字段逐个对照已安装的 `@deepseek-ai/dsh-subagent`
 * 与 `@deepseek-ai/dsh-llm` 的类型声明：
 *
 *   start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
 *   SubagentStartRequest = { label?: string; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal }
 *   TextBlock = { type: 'text'; text: string }
 *
 * 还有一条**行为**要求来自 DSH 契约：`signal` 是「启动前后都算数的取消通道」，而停止一条 one-shot
 * 审核必须「先 abort 再 dispose」（`run.dispose()` 会先摘掉 abort 监听再等结果）。
 * 所以 `handle.abort` 必须真的打在交给 DSH 的那个 signal 上 —— 拿别的控制器去 abort 等于没取消。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { startChild, pickProvider } = await import(new URL('src/host/audit/spawn.ts', ROOT).href)

/** 记录 `subagents.start` 每次调用的 ctx。 */
function makeCtx({ agents, subagents } = {}) {
  return { get: (name) => (name === 'agents' ? agents : (name === 'subagents' ? subagents : undefined)) }
}

/** 一个会记录调用的 subagents 替身；默认注册 spawn provider。 */
function stubSubagents(overrides = {}) {
  const calls = []
  const subagents = {
    list: () => ['spawn'],
    async start(name, request) {
      calls.push({ name, request })
      return { id: 'child-1' }
    },
    ...overrides,
  }
  return { calls, subagents }
}

const PARENT = { id: 'session-parent' }

function agentsServing(parent = PARENT) {
  return { get: (id) => (id === parent.id ? parent : undefined) }
}

const ARGS = { label: '审核 S1 · 10:00:00', prompt: '请审核这份报告。', parentSessionId: 'session-parent' }

test('startChild sends the request shape DSH declares', async () => {
  const { calls, subagents } = stubSubagents()
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)

  assert.equal(result.ok, true, result.error)
  assert.equal(result.error, '')
  assert.equal(result.provider, 'spawn')
  assert.equal(result.childId, 'child-1', 'childId 必须取自 run.id —— 占用锁与状态聚合都靠它')
  assert.equal(calls.length, 1)

  const { name, request } = calls[0]
  assert.equal(name, 'spawn', '第一个参数是 provider 名')
  assert.equal(request.label, ARGS.label)
  assert.deepEqual(request.prompt, [{ type: 'text', text: ARGS.prompt }], '必须是小写 text 块，不是 value/字符串')
  assert.equal(request.parent, PARENT, 'parent 必须是 agents 服务给的那个 Agent 本体，不能是复制品')
  assert.equal(typeof request.signal?.aborted, 'boolean', 'signal 必须是 AbortSignal')
  assert.equal(request.signal.aborted, false, '刚创建时不能已经处于 aborted')
  // 只发这四个字段：多塞字段会被 provider 静默忽略，反而掩盖漂移。
  assert.deepEqual(Object.keys(request).sort(), ['label', 'parent', 'prompt', 'signal'])
})

test('startChild returns a handle whose abort hits the very signal it handed DSH', async () => {
  // 停止一条 one-shot 审核靠的就是这个：abort 必须打在 DSH 持有的 signal 上。
  const { calls, subagents } = stubSubagents()
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)

  const handed = calls[0].request.signal
  assert.equal(handed.aborted, false)
  assert.equal(typeof result.handle.abort, 'function')
  result.handle.abort()
  assert.equal(handed.aborted, true, 'abort 没有打在交给 DSH 的 signal 上 → 停止审核会变成干等')
  assert.equal(result.handle.run.id, 'child-1', '句柄要留着 run，停止时才能 dispose')
})

test('startChild refuses when the agents or subagents service is missing', async () => {
  const noAgents = await startChild(makeCtx({ subagents: stubSubagents().subagents }), ARGS)
  assert.equal(noAgents.ok, false)
  assert.match(noAgents.error, /agents 服务不可用/)

  // 说明：`startChild` 里那句 `subagents === undefined` 的守卫**运行时是冗余的**
  // （`pickProvider` 会给出同一句错误），删掉它这个用例仍然通过。它删不得的原因是
  // **类型收窄**：下面 `subagents.start(...)` 需要它，删掉会 `tsc` 报
  // `'subagents' is possibly 'undefined'`。所以这里断言的是**可观察的消息**，
  // 不要误以为它证明了那句守卫存在。
  const noSubagents = await startChild(makeCtx({ agents: agentsServing() }), ARGS)
  assert.equal(noSubagents.ok, false)
  assert.match(noSubagents.error, /subagents 服务不可用/)
})

test('startChild refuses a parent that is not running and starts nothing', async () => {
  const { calls, subagents } = stubSubagents()
  const result = await startChild(makeCtx({ agents: agentsServing({ id: 'other' }), subagents }), ARGS)
  assert.equal(result.ok, false)
  assert.match(result.error, /session-parent/, '错误里要带父会话 id，否则用户无从下手')
  assert.equal(calls.length, 0, '父会话不在运行中就不该创建子会话')
})

test('startChild refuses when the deployment registered no provider', async () => {
  const { calls, subagents } = stubSubagents({ list: () => [] })
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)
  assert.equal(result.ok, false)
  assert.match(result.error, /没有注册任何子代理 provider/)
  assert.equal(calls.length, 0)
})

test('startChild prefers spawn, then fork, then whatever is first', async () => {
  const pick = (names) => pickProvider(makeCtx({ subagents: { list: () => names } }))
  assert.equal(pick(['fork', 'spawn']).provider, 'spawn')
  assert.equal(pick(['acp', 'fork']).provider, 'fork')
  assert.equal(pick(['acp', 'weird']).provider, 'acp', '都不认识就用第一个注册的')
  assert.deepEqual(pick([]).ok, false)

  // 真的走到 start 时用的也是挑出来的那个 provider。
  const forked = stubSubagents({ list: () => ['fork'] })
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents: forked.subagents }), ARGS)
  assert.equal(result.provider, 'fork')
  assert.equal(forked.calls[0].name, 'fork')
})

test('startChild reports a start failure instead of throwing', async () => {
  const { subagents } = stubSubagents({ start: async () => { throw new Error('provider exploded') } })
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)
  assert.equal(result.ok, false)
  assert.match(result.error, /provider exploded/)
  assert.equal(result.childId, '')
  assert.equal(result.handle.run, undefined)
})

test('startChild does not blow up when list() itself throws', async () => {
  // `list()` 抛错在真实部署里等于「拿不到 provider 清单」，要给准确提示而不是整个操作崩掉。
  const subagents = { list: () => { throw new Error('registry down') }, async start() { throw new Error('不应被调用') } }
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)
  assert.equal(result.ok, false)
  assert.match(result.error, /没有注册任何子代理 provider/)
})
