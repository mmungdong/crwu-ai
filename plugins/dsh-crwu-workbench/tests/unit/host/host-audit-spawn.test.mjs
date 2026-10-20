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

const ROOT = new URL('../../../', import.meta.url)

const { startChild, pickProvider } = await import(new URL('src/host/domains/report-audit/spawn.ts', ROOT).href)

/** 记录 `subagents.start` 每次调用的 ctx。 */
function makeCtx({ agents, subagents } = {}) {
  return { get: (name) => (name === 'agents' ? agents : (name === 'subagents' ? subagents : undefined)) }
}

/** 一个会记录调用的 subagents 替身；默认注册 spawn provider。 */
function stubSubagents(overrides = {}) {
  const calls = []
  const subagents = {
    list: () => ['spawn'],
    // 审核启动要求 provider 声明支持 `toolFilter`（真实边界）；用例可用 overrides 覆盖。
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false }, inheritsParentContext: false }),
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

const DENIED = ['crwu_h3yun_record_get', 'crwu_h3yun_files_list', 'crwu_audit_case_bootstrap']
const { REQUIRED_AUDIT_CHILD_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)

function activationFixture({ failure = '', stuck = false, restrictWorks = true } = {}) {
  const listeners = new Set()
  const calls = { activations: [], legacy: 0, disposed: 0, cancelled: 0, restricted: [], firstTurns: 0, firstVisibility: [] }
  const children = new Map()
  const toolsFor = (agent) => ({
    restrict(filter) {
      calls.restricted.push({ id: agent.id, filter })
      if (failure === 'restrict') throw new Error('restriction refused')
      if (restrictWorks) agent.denied = new Set(filter.deny)
      return () => { agent.denied.clear() }
    },
    get(name) { return agent.denied.has(name) ? undefined : { name } },
  })
  const runtime = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentPreset: true }, prepareContinuable() {} }),
    async start() { calls.legacy += 1; throw new Error('legacy must not run') },
    async startActivation(spec) {
      calls.activations.push(spec)
      if (failure === 'start') throw new Error('activation failed')
      const agent = {
        id: spec.childId, status: 'running', denied: new Set(),
        session: { header: { id: spec.childId, parentSession: ARGS.parentSessionId, cwd: '/ws' } },
        cancel() { calls.cancelled += 1; if (!stuck) this.status = 'idle' },
      }
      agent.ctx = { get: (name) => name === 'tools' ? toolsFor(agent) : undefined }
      children.set(agent.id, agent)
      if (failure === 'parent') agent.session.header.parentSession = 'unrelated'
      if (failure !== 'event') {
        try {
          for (const listener of listeners) await listener({ agent })
        } catch (error) {
          children.delete(agent.id)
          throw error
        }
      }
      if (failure === 'after-create') throw new Error('activation failed after creation')
      if (failure === 'receipt') spec = { ...spec, childId: 'wrong-receipt' }
      calls.firstVisibility.push([...agent.denied])
      calls.firstTurns += 1
      return {
        childId: spec.childId, result: new Promise(() => {}),
        dispose: async () => {
          calls.disposed += 1
          assert.equal(spec.signal.aborted, true, 'abort must precede disposal')
          if (stuck) await new Promise(() => {})
          if (failure !== 'receipt') agent.status = 'idle'
        },
      }
    },
  }
  const ctx = {
    on(event, listener, options) {
      assert.equal(event, 'agent/created')
      assert.equal(options.global, true)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get(name) {
      if (name === 'subagents') return runtime
      if (name === 'agents') return { get: (id) => id === PARENT.id ? PARENT : children.get(id) }
      if (name === 'timer') return { timeout: async () => {} }
      return undefined
    },
  }
  return { ctx, runtime, calls, listeners, children }
}

test('activation takes priority and restricts the reserved child before its first turn', async () => {
  const f = activationFixture()
  const result = await startChild(f.ctx, ARGS)
  assert.equal(result.ok, true, result.error)
  assert.equal(f.calls.legacy, 0)
  assert.equal(f.calls.activations.length, 1)
  const spec = f.calls.activations[0]
  assert.equal(result.childId, spec.childId)
  assert.equal(result.localAgent, f.children.get(spec.childId))
  assert.deepEqual(f.calls.restricted, [{ id: spec.childId, filter: { deny: DENIED } }])
  assert.deepEqual(f.calls.firstVisibility, [DENIED])
  assert.equal(spec.request.parent, PARENT)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: ARGS.prompt }])
  assert.equal('toolFilter' in spec.request, false)
  for (const name of DENIED) assert.equal(result.localAgent.ctx.get('tools').get(name), undefined)
  for (const name of REQUIRED_AUDIT_CHILD_TOOLS) assert.ok(result.localAgent.ctx.get('tools').get(name))
  assert.equal(f.listeners.size, 0)
  result.handle.abort()
  await result.handle.run.dispose()
  assert.equal(f.calls.disposed, 1)
})

for (const failure of ['start', 'parent', 'restrict', 'event', 'receipt']) {
  test(`activation ${failure} failure never retries the legacy entry`, async () => {
    const f = activationFixture({ failure })
    const result = await startChild(f.ctx, ARGS)
    assert.equal(result.ok, false)
    assert.equal(f.calls.legacy, 0)
    assert.equal(f.calls.activations.length, 1)
    assert.equal(f.listeners.size, 0)
    if (failure === 'parent' || failure === 'restrict') assert.equal(f.calls.firstTurns, 0)
    if (failure === 'event' || failure === 'receipt') {
      assert.equal(f.calls.activations[0].signal.aborted, true)
      assert.equal(f.calls.disposed, failure === 'receipt' ? 0 : 1)
      if (failure === 'receipt') {
        assert.equal(f.calls.cancelled, 1)
        assert.equal(f.children.get(f.calls.activations[0].childId).status, 'idle')
      }
    }
  })
}

test('activation restriction is read back before the first turn', async () => {
  const f = activationFixture({ restrictWorks: false })
  const result = await startChild(f.ctx, ARGS)
  assert.equal(result.ok, false)
  assert.equal(f.calls.firstTurns, 0)
})

test('activation failure after creation cancels the reserved live agent without a receipt', async () => {
  const f = activationFixture({ failure: 'after-create' })
  const result = await startChild(f.ctx, ARGS)
  assert.equal(result.ok, false)
  assert.equal(f.calls.cancelled, 1)
  assert.equal(f.children.get(f.calls.activations[0].childId).status, 'idle')
  assert.equal(result.childId, '')
})

test('synchronous disposal failure returns a recoverable child instead of throwing', async () => {
  const f = activationFixture({ failure: 'event', stuck: true })
  const start = f.runtime.startActivation
  f.runtime.startActivation = async (spec) => {
    const receipt = await start(spec)
    return { ...receipt, dispose() { throw new Error('dispose sync failure') } }
  }
  const result = await startChild(f.ctx, ARGS)
  assert.equal(result.ok, false)
  assert.equal(result.childId, f.calls.activations[0].childId)
  assert.equal(typeof result.handle.run.dispose, 'function')
})

test('activation refuses before creation when the hook or local provider is absent', async () => {
  for (const missing of ['hook', 'local']) {
    const f = activationFixture()
    if (missing === 'hook') f.ctx.on = undefined
    else f.runtime.getProvider = () => ({ capabilities: { agentPreset: true } })
    assert.equal((await startChild(f.ctx, ARGS)).ok, false)
    assert.equal(f.calls.activations.length, 0)
    assert.equal(f.calls.legacy, 0)
  }
})

test('a failed activation keeps its identity and handle if stopping cannot be confirmed', async () => {
  const f = activationFixture({ failure: 'event', stuck: true })
  const result = await startChild(f.ctx, ARGS)
  assert.equal(result.ok, false)
  assert.equal(result.childId, f.calls.activations[0]?.childId)
  assert.equal(typeof result.handle.abort, 'function')
  assert.equal(typeof result.handle.run?.dispose, 'function')
  assert.match(result.error, /停止|静默/)
})

test('concurrent activations restrict only their own reserved children', async () => {
  const f = activationFixture()
  const results = await Promise.all([startChild(f.ctx, ARGS), startChild(f.ctx, ARGS)])
  assert.ok(results.every((result) => result.ok))
  assert.notEqual(results[0].childId, results[1].childId)
  assert.deepEqual(f.calls.restricted.map((item) => item.id).sort(), results.map((result) => result.childId).sort())
  assert.equal(f.listeners.size, 0)
})

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
  // 只发这几个字段：多塞字段会被 provider 静默忽略，反而掩盖漂移。
  // `toolFilter` 是 2026-09-29 复查后加的**真实工具边界**（见下一条用例）。
  assert.deepEqual(Object.keys(request).sort(), ['label', 'parent', 'prompt', 'signal', 'toolFilter'])
  assert.deepEqual(request.toolFilter, {
    deny: ['crwu_h3yun_record_get', 'crwu_h3yun_files_list', 'crwu_audit_case_bootstrap'],
  }, '子会话必须看不到、也执行不了这三条 Host 专用工具')
})

// ── 协议 32：子会话必须显式挂到工作区下（DSH 的 `subagents.start` 不会替我们挂）────────

/** 一个忠实的工作区替身：`attachSession` 要求 cwd 逐字等于工作区路径。 */
function workspaceFixture({ childCwd = '/ws', attachFails = false } = {}) {
  const attached = []
  const headers = { 'child-1': { cwd: childCwd } }
  const entity = {
    id: 'w1',
    path: '/ws',
    title: '工作区',
    sessionIds: [],
    async attachSession(sessionId) {
      if (attachFails) throw new Error('工作区记录拒绝挂载')
      const cwd = headers[sessionId]?.cwd ?? ''
      if (cwd !== this.path) throw new Error(`cwd resolves to '${cwd}'`)
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
      attached.push(sessionId)
    },
  }
  return {
    attached, entity, headers,
    ctx: {
      get(name) {
        if (name === 'workspaceRegistry') {
          return { get: (id) => (id === 'w1' ? entity : undefined), list: () => [entity] }
        }
        if (name === 'sessions') return { get: (id) => (headers[id] === undefined ? undefined : { header: headers[id] }) }
        return undefined
      },
    },
    workspace: { id: 'w1', path: '/ws', title: '工作区' },
  }
}

test('子会话建完要**显式挂到工作区**并回读成员关系（否则只能落「未分组」）', async () => {
  const { calls, subagents } = stubSubagents()
  const fixture = workspaceFixture()
  const base = makeCtx({ agents: agentsServing(), subagents })
  const ctx = { get: (name) => fixture.ctx.get(name) ?? base.get(name) }
  const result = await startChild(ctx, { ...ARGS, workspace: fixture.workspace })

  assert.equal(result.ok, true, result.error)
  assert.equal(calls.length, 1, '挂载失败之前不该重复创建子会话')
  assert.deepEqual(fixture.entity.sessionIds, ['child-1'], 'child 必须出现在工作区的成员清单里')
  assert.deepEqual(fixture.attached, ['child-1'])
})

test('挂不到工作区时：**不返回成功**，并且把刚建的子会话停掉', async () => {
  const disposed = []
  const { calls, subagents } = stubSubagents({
    async start(name, request) {
      calls.push({ name, request })
      return { id: 'child-1', dispose: async () => { disposed.push('dispose') } }
    },
  })
  const fixture = workspaceFixture({ attachFails: true })
  const base = makeCtx({ agents: agentsServing(), subagents })
  const ctx = { get: (name) => fixture.ctx.get(name) ?? base.get(name) }
  const result = await startChild(ctx, { ...ARGS, workspace: fixture.workspace })

  assert.equal(result.ok, false)
  assert.match(result.error, /挂到选定的工作区|挂载/)
  assert.equal(result.childId, '', '没挂上就不许把 childId 交出去（上层会据此落记录）')
  assert.deepEqual(calls[0].request.signal.aborted, true, 'abort 必须打在交给 DSH 的那个 signal 上')
  assert.deepEqual(disposed, ['dispose'], '还要释放刚建的子会话，不留一条在跑却没人认领的')
})

test('子会话 cwd 与父会话不一致时也拒绝挂载（这次委派没走 cwd 继承）', async () => {
  const { subagents } = stubSubagents()
  const fixture = workspaceFixture()
  fixture.headers['child-1'] = { cwd: '/somewhere/else' }
  const base = makeCtx({ agents: agentsServing({ id: 'session-parent', session: { header: { cwd: '/ws' } } }), subagents })
  const ctx = { get: (name) => fixture.ctx.get(name) ?? base.get(name) }
  const result = await startChild(ctx, { ...ARGS, workspace: fixture.workspace })
  assert.equal(result.ok, false)
  assert.match(result.error, /cwd/)
  assert.deepEqual(fixture.entity.sessionIds, [])
})

test('provider 不支持 toolFilter 时**在创建子会话之前**拒绝（不许有假边界）', async () => {
  const { calls, subagents } = stubSubagents({
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: false, persona: false }, inheritsParentContext: false }),
  })
  const refused = await startChild(makeCtx({ agents: agentsServing(), subagents }), ARGS)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /不支持 toolFilter/)
  assert.deepEqual(calls, [], '不支持过滤就不许创建子会话')

  // 连 getProvider 都没有（老运行时）：同样拒绝。
  const legacy = stubSubagents({ getProvider: undefined })
  const legacyRun = await startChild(makeCtx({ agents: agentsServing(), subagents: legacy.subagents }), ARGS)
  assert.equal(legacyRun.ok, false)
  assert.match(legacyRun.error, /getProvider|toolFilter/)
  assert.deepEqual(legacy.calls, [])
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

test('startChild prefers spawn, then fork；两者都没有就拒绝（不再挑第一个注册的）', async () => {
  const capable = () => ({ name: 'p', capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: true, persona: false }, inheritsParentContext: false })
  const pick = (names) => pickProvider(makeCtx({ subagents: { list: () => names, getProvider: capable } }))
  assert.equal(pick(['fork', 'spawn']).provider, 'spawn')
  assert.equal(pick(['acp', 'fork']).provider, 'fork')
  // 2026-09-29 第三轮复查后：**不再**回退到"第一个注册的"（远程/不可验证的 provider 不许选）
  assert.equal(pick(['acp', 'weird']).ok, false, '没有本地 provider 就拒绝，而不是挑第一个')
  assert.deepEqual(pick([]).ok, false)

  // 不支持 toolFilter 的 provider：**不能**被挑中（否则子会话的工具集收不窄）。
  const uncapable = pickProvider(makeCtx({ subagents: { list: () => ['spawn'], getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, inheritsParentContext: false }) } }))
  assert.equal(uncapable.ok, false)
  assert.match(uncapable.error, /不支持 toolFilter/)

  // 真的走到 start 时用的也是挑出来的那个 provider。
  const forked = stubSubagents({ list: () => ['fork'] })
  const result = await startChild(makeCtx({ agents: agentsServing(), subagents: forked.subagents }), ARGS)
  assert.equal(result.provider, 'fork')
  assert.equal(forked.calls[0].name, 'fork')
})

test('pickProvider 只接受本地可验证的 provider：远程 provider 不再"回退到第一个"', async () => {
  // 用户第三轮复查的 P1：审核要求 toolFilter **且**能拿到本进程子 Agent（回读沙箱/审批/cwd/workspaceRoot）。
  // 远程 provider 满足不了第二条，所以不许被挑中。
  const pick = (names) => pickProvider(makeCtx({
    subagents: {
      list: () => names,
      getProvider: () => ({ name: 'p', capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: true, persona: false }, inheritsParentContext: false }),
    },
  }))
  assert.equal(pick(['acp']).ok, false, '只有远程 provider → 拒绝')
  assert.match(pick(['acp']).error, /本地可验证|spawn \/ fork/)
  assert.equal(pick(['acp', 'spawn']).provider, 'spawn', '有 spawn 就选 spawn')
  assert.equal(pick(['acp', 'fork']).provider, 'fork', '没有 spawn 就选 fork')
  assert.equal(pick(['acp', 'weird']).ok, false, '两个本地 provider 都没有 → 拒绝（不许选第一个注册的）')
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
