/**
 * 审核根会话（子代理的挂载点）的单元测试。
 *
 * 用户报的「创建新会话时还是挂错了地方」：子会话的 cwd 与「子代理树挂在谁下面」都由**父会话**
 * 决定，而父会话原来是「哪个会话头最后挂载」。这一层要钉住的是：
 *
 * 1. 父级一律是**审核根会话** —— 一个建在插件选定工作空间里的**顶层**会话（没有 parentAgent）；
 * 2. 根可用就一直复用（稳定优先，所有审核子代理整齐挂在同一棵树下）；
 * 3. 根不可用（进程重启 / 换工作空间 / 会话没了）→ 新建一个（用户已确认接受分叉）；
 * 4. 建完必须跑 hello 预检：跑不起来就**不落钩子、不起审核**，把问题拦在第一条真审核之前。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { auditRootTitle, mintSessionId, probeMessage, auditRootUsability, ensureAuditRoot, auditRootView, AUDIT_ROOT_TITLE } = await import(
  new URL('src/host/audit/root.ts', ROOT).href
)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', installDocUrl: '', manifestUrl: '', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  singleAuditOnly: true, requireTopLevelParent: true,
}

function fakeWorld() {
  return {
    platform: async () => 'darwin-arm64',
    home: async () => '/Users/x',
    workdir: async () => '/cases/session',
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
}

/** 一棵「活着的会话」：默认 parent-1 是活的、cwd 就是工作空间。 */
function makeCtx(options = {}) {
  const created = []
  const renamed = []
  const probes = []
  const attached = []
  const presetResolves = []
  const presetMounts = []
  const dirs = new Set(options.dirs ?? ['/cases/space'])
  const liveAgents = new Map(Object.entries(options.liveAgents ?? {
    'parent-1': {
      id: 'parent-1',
      followup(message) { probes.push(message) },
      async whenIdle() {},
    },
  }))
  // 会话头是**可变**的：真实 DSH 里 `agents.create` 发布会话之后 `sessions.get` 立刻查得到，
  // 改名（sessionTitle.rename 要求会话活着）就靠这一点。
  const headers = { 'parent-1': { cwd: '/cases/space' }, ...(options.headers ?? {}) }
  return {
    created, renamed, probes, attached, presetResolves, presetMounts,
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => liveAgents.get(id),
          async create(request) {
            created.push(request)
            headers[request.sessionId] = { cwd: request.meta?.cwd ?? '' }
            const agent = {
              id: request.sessionId,
              followup(message) { probes.push(message) },
              async whenIdle() {
                if (options.probeFails === true) throw new Error('模型链路不通')
              },
            }
            liveAgents.set(request.sessionId, agent)
            return { agent }
          },
        }
      }
      if (name === 'sessions') {
        return { get: (id) => (headers[id] === undefined ? undefined : { header: headers[id] }) }
      }
      if (name === 'sessionTitle') {
        return { rename: (session, title) => { renamed.push({ session, title }); return { title } } }
      }
      if (name === 'agentPresets') {
        return {
          resolve: async (id) => {
            presetResolves.push(id)
            return { id: id === undefined || id === '' ? 'default-preset' : id }
          },
          mount: async (agentCtx, id) => { presetMounts.push({ agentCtx, id }); return { id } },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      }
      if (name === 'workspaceRegistry') {
        const entity = {
          id: 'w1', path: '/cases/space', async attachSession(sessionId) { attached.push(sessionId) },
        }
        return {
          async resolveByPath(path) {
            if (options.noWorkspace === true) throw new Error('ENOENT')
            return path === '/cases/space' ? entity : undefined
          },
          async create(path) { return { ...entity, path } },
          list: () => [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
          get: () => entity,
        }
      }
      if (name === 'shell') {
        // 形状照 `ShellRunResult`：`runShell` 看的是 exitCode 与 stdout.text，不是 {ok}。
        const result = (exitCode, stderr) => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: '', truncated: false }, stderr: { text: stderr, truncated: false },
        })
        return {
          resolve: (request) => request,
          async run() {
            return options.mkdirFails === true ? result(1, 'sandbox unavailable') : result(0, '')
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            return dirs.has(String(target.targetKey).replace(/[\\/]+$/, '')) ? { type: 'directory' } : undefined
          },
          async readText() { return '{}' },
          async writeText() { return { operation: 'update', version: 'v' } },
        }
      }
      if (name === 'timer') return { timeout: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) }
      return undefined
    },
  }
}

function makeState(patch = {}) {
  return {
    ...createWorkbenchState(CONFIG),
    workspaceChosen: true,
    workspacePath: '/cases/space',
    workspaceTitle: '中瑞世联工作空间',
    caseRoot: '/cases/space',
    ...patch,
  }
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('auditRootTitle is self-describing and carries a timestamp', () => {
  const title = auditRootTitle(new Date(2026, 8, 20, 21, 5))
  assert.equal(title, `${AUDIT_ROOT_TITLE} · 09-20 21:05`)
  assert.match(title, /审核子代理根节点/)
})

test('mintSessionId produces a fresh session- id every time', () => {
  const first = mintSessionId()
  assert.match(first, /^session-/)
  assert.notEqual(first, mintSessionId())
})

test('probeMessage is a plain user message carrying the probe instruction', () => {
  const message = probeMessage('seed-1')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(Array.isArray(message.content), true)
  assert.match(String(message.content[0].text), /hello/)
  assert.match(String(message.content[0].text), /pwd/, '预检要顺便证明 bash 能用、cwd 正确')
  // 形状对照已安装的 `@deepseek-ai/dsh-llm` 声明：`UserMessage extends Message`
  // （`id` / `role` / `content: ContentBlock[]` / `source`），`MessageSourceMap.user = { kind: 'user' }`，
  // 文本块是小写 `{ type: 'text', text }`。`followup` 直接吃这个对象，多塞字段没有意义。
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
  assert.deepEqual(Object.keys(message.content[0]).sort(), ['text', 'type'])
})

// ── 可用性判定 ──────────────────────────────────────────────────────────────

test('auditRootUsability refuses an empty, stale, foreign or subagent root', () => {
  const state = makeState()
  assert.equal(auditRootUsability(makeCtx(), state, '/cases/space').ok, false, '还没有根')

  const wrongWorkspace = makeState({ auditRoot: { workspacePath: '/cases/other', sessionId: 'parent-1', title: '', assignedAt: '' } })
  assert.match(auditRootUsability(makeCtx(), wrongWorkspace, '/cases/space').reason, /工作空间已换/)

  const dead = makeState({ auditRoot: { workspacePath: '/cases/space', sessionId: 'gone', title: '', assignedAt: '' } })
  assert.match(auditRootUsability(makeCtx(), dead, '/cases/space').reason, /不在运行中/)

  const asSubagent = makeState({ auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: '', assignedAt: '' } })
  const subCtx = makeCtx({ headers: { 'parent-1': { cwd: '/cases/space', origin: 'subagent' } } })
  assert.match(auditRootUsability(subCtx, asSubagent, '/cases/space').reason, /本身是子代理/)

  const wrongCwd = makeState({ auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: '', assignedAt: '' } })
  const cwdCtx = makeCtx({ headers: { 'parent-1': { cwd: '/cases/elsewhere' } } })
  assert.match(auditRootUsability(cwdCtx, wrongCwd, '/cases/space').reason, /不是当前工作空间/)
})

test('auditRootUsability accepts a live root whose cwd is the chosen workspace', () => {
  const state = makeState({ auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: 'x', assignedAt: '' } })
  assert.deepEqual(auditRootUsability(makeCtx(), state, '/cases/space'), { ok: true, reason: '' })
})

// ── 复用 / 新建 ─────────────────────────────────────────────────────────────

test('ensureAuditRoot reuses a usable root and creates nothing', async () => {
  const ctx = makeCtx()
  const state = makeState({ auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: 'x', assignedAt: '' } })
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld() })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'parent-1')
  assert.equal(result.created, false)
  assert.deepEqual(ctx.created, [], '能用就别新建 —— 稳定优先，所有审核挂同一棵树')
})

test('ensureAuditRoot creates a top-level session inside the chosen workspace', async () => {
  const ctx = makeCtx()
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld() })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.created, true)

  assert.equal(ctx.created.length, 1)
  const request = ctx.created[0]
  // 这就是「挂到我的工作空间下面」的全部含义：cwd 是工作空间，而且**不是**子代理。
  assert.equal(request.meta.cwd, '/cases/space', '根的 cwd 必须是插件选定的工作空间')
  assert.equal('parentAgent' in request, false, '不带 parentAgent = 顶层会话，不挂在别人下面')
  assert.equal(request.meta.agentPreset, 'default-preset', '没指定就跟部署默认 preset')
  assert.equal(request.agentOptions.model, 'deepseek-flash')

  assert.deepEqual(ctx.attached, [request.sessionId], '要挂到工作空间，侧栏才归到它下面')
  assert.equal(ctx.renamed.length, 1, '根要改名，见名知义')
  assert.match(ctx.renamed[0].title, /审核子代理根节点/)
  assert.equal(ctx.probes.length, 1, '建完必须跑一次 hello 预检')
  assert.equal(state.auditRoot.sessionId, request.sessionId, '钩子要落到 state 上')
  assert.equal(state.auditRoot.workspacePath, '/cases/space')
})

test('ensureAuditRoot follows the preset of the session you are working in', async () => {
  const ctx = makeCtx({ headers: { 'parent-1': { cwd: '/cases/space', agentPreset: 'crwu-audit' } } })
  const state = makeState({ parentSessionId: 'parent-1' })
  await ensureAuditRoot({ ctx, state, world: fakeWorld() }, { presetHint: 'crwu-audit' })
  assert.equal(ctx.created[0].meta.agentPreset, 'crwu-audit', '审核的工具链要跟你在用的会话一致')
})

test('the root-creation request carries exactly the fields DSH declares', async () => {
  // 与 `host-audit-spawn.test.mjs` 同一条理由：这一条在真机上点一次就是一次真审核，
  // 所以请求形状只能靠测试盯死。字段逐个对照已安装的 `@deepseek-ai/dsh-agent` 声明：
  //
  //   AgentRegistry.create(options: CreateAgentOptions): Promise<AgentHandle>
  //   CreateAgentOptions = { sessionId; parentAgent?; meta?; inheritedEventCount?; seed?;
  //                          agentOptions?; signal?; setup? }
  //   meta = { cwd?; parentSession?; isSeeded?; origin?; delegationDepth?; agentPreset? }
  //   AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<…> | void
  //
  // 多塞的字段会被 DSH 静默忽略 —— 那正是「看起来配了、其实没生效」的来源，所以
  // 「只发这几个」本身就是被断言的行为。
  const ctx = makeCtx()
  const state = makeState({ parentSessionId: 'parent-1' })
  await ensureAuditRoot({ ctx, state, world: fakeWorld() }, { presetHint: 'crwu-audit' })
  const request = ctx.created[0]

  assert.deepEqual(
    Object.keys(request).sort(),
    ['agentOptions', 'meta', 'sessionId', 'setup'],
    '只发这四个；parentAgent 缺席 = 顶层会话，signal/seed 这些我们不用',
  )
  assert.deepEqual(
    Object.keys(request.meta).sort(),
    ['agentPreset', 'cwd'],
    'meta 只给 cwd 与 agentPreset —— 一旦带上 origin/delegationDepth，根就不是干净顶层会话了',
  )
  assert.match(String(request.sessionId), /^session-/)

  // preset 必须在 `setup` 里挂到**这个会话自己的** scope：挂到插件 ctx 上，
  // 根会话就没有审核工具链（表现为「起来了但什么也干不了」）。
  const agentCtx = { marker: 'agent-scope' }
  await request.setup(agentCtx, { id: request.sessionId })
  assert.deepEqual(
    ctx.presetMounts,
    [{ agentCtx, id: 'crwu-audit' }],
    'setup 第一个参数必须原样交给 agentPresets.mount',
  )
})

test('ensureAuditRoot keeps the hook clean when the preflight fails', async () => {
  const ctx = makeCtx({ probeFails: true })
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld() })
  assert.equal(result.ok, false)
  assert.match(result.error, /预检未通过/)
  assert.equal(state.auditRoot.sessionId, '', '预检不过就不落钩子：下次会重新建，而不是复用一个跑不动的根')
})

test('ensureAuditRoot creates the directory and registers the workspace when missing', async () => {
  const ctx = makeCtx({ noWorkspace: true, dirs: [] })
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld() })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.notes.some((note) => note.includes('登记成工作空间')), true)
})

test('ensureAuditRoot reports a real failure instead of silently proceeding', async () => {
  const ctx = makeCtx({ noWorkspace: true, mkdirFails: true })
  const result = await ensureAuditRoot({ ctx, state: makeState(), world: fakeWorld() })
  assert.equal(result.ok, false)
  assert.match(result.error, /创建目录失败/)
  assert.equal(ctx.created.length, 0, '目录都建不出来，就不要建会话')
})

test('auditRootView explains the two states the panel shows', () => {
  const empty = auditRootView(makeCtx(), makeState())
  assert.equal(empty.sessionId, '')
  assert.equal(empty.usable, false)
  assert.match(empty.reason, /发起审核时自动创建/)

  const usable = auditRootView(makeCtx(), makeState({
    auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: '审核子代理根节点 · 09-20 21:05', assignedAt: '2026-09-20T13:05:00Z' },
  }))
  assert.equal(usable.usable, true)
  assert.equal(usable.title, '审核子代理根节点 · 09-20 21:05')
})
