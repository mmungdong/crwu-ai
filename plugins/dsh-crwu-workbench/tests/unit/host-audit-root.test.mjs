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
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { makeAuditAgent, makeAuditSession, auditPolicyServices } = await import(
  new URL('tests/helpers/audit-policy-fixture.mjs', ROOT).href)

const { auditRootTitle, mintSessionId, probeMessage, auditRootProbe, auditRootUsability, ensureAuditRoot, auditRootView, AUDIT_ROOT_TITLE } = await import(
  new URL('src/host/audit/root.ts', ROOT).href
)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
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
  const policyServices = auditPolicyServices({ ...(options.preset === undefined ? {} : { preset: options.preset }) })
  const liveAgents = new Map(Object.entries(options.liveAgents ?? {
    'parent-1': makeAuditAgent(makeAuditSession({ cwd: '/cases/space/S1' }), {
      id: 'parent-1',
      followup(message) { probes.push(message) },
      async whenIdle() {},
    }),
  }))
  // 会话头是**可变**的：真实 DSH 里 `agents.create` 发布会话之后 `sessions.get` 立刻查得到，
  // 改名（sessionTitle.rename 要求会话活着）就靠这一点。
  const headers = { 'parent-1': { cwd: '/cases/space/S1' }, ...(options.headers ?? {}) }
  return {
    created, renamed, probes, attached, presetResolves, presetMounts,
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => liveAgents.get(id),
          async create(request) {
            created.push(request)
            headers[request.sessionId] = { cwd: request.meta?.cwd ?? '' }
            const agent = makeAuditAgent(makeAuditSession({ cwd: request.meta?.cwd ?? '', mode: '', policy: '' }), {
              id: request.sessionId,
              followup(message) { probes.push(message) },
              async whenIdle() {
                if (options.probeFails === true) throw new Error('模型链路不通')
              },
            })
            liveAgents.set(request.sessionId, agent)
            return { agent }
          },
        }
      }
      // 协议 18 · C：审核根的沙箱/审批策略事实由 DSH 的三个服务回答。
      if (name === 'sandboxPolicy') return policyServices.sandboxPolicy
      if (name === 'approval') return policyServices.approval
      if (name === 'permissionPresets') return policyServices.permissionPresets
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
          async execute() {
            return { result: async () => (options.mkdirFails === true ? result(1, 'sandbox unavailable') : result(0, '')) }
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
      if (name === 'tools') {
        // 注册表替身：必需 Tool 全部「可见」（`get` 必须按 scope resolver 的形状回答），
        // `execute` 走一遍真实调用形状并返回零副作用能力自检的结构化值。
        return {
          get: () => ({ name: 'crwu_audit_capabilities' }),
          async execute() {
            return { isError: false, value: { ok: true, platform: 'darwin-arm64', binPlatform: 'darwin-arm64' } }
          },
        }
      }
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
  const message = probeMessage('seed-1', 'darwin-arm64')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(Array.isArray(message.content), true)
  assert.match(String(message.content[0].text), /hello/)
  assert.match(String(message.content[0].text), /pwd/, '预检要顺便证明 shell 能用、cwd 正确')
  // 形状对照已安装的 `@deepseek-ai/dsh-llm` 声明：`UserMessage extends Message`
  // （`id` / `role` / `content: ContentBlock[]` / `source`），`MessageSourceMap.user = { kind: 'user' }`，
  // 文本块是小写 `{ type: 'text', text }`。`followup` 直接吃这个对象，多塞字段没有意义。
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
  assert.deepEqual(Object.keys(message.content[0]).sort(), ['text', 'type'])
})

// ── 可用性判定 ──────────────────────────────────────────────────────────────

/** 插件选定的工作空间。 */
const WS = '/cases/space'
/** 本轮的案例目录（协议 19 起：审核根的 cwd 与沙箱边界都是它）。 */
const CASE = `${WS}/S1`
/** 一条 scope 完整的根记录（新形态）。 */
const rootOf = (patch = {}) => ({
  workspacePath: WS, casePath: CASE, sessionId: 'parent-1', title: '', assignedAt: '', ...patch,
})

test('auditRootUsability：没有根 / 工作空间级旧根 / 别的案例的根 / 死掉 / 子代理 / cwd 不对 —— 一律不可用', () => {
  assert.equal(auditRootUsability(makeCtx(), makeState(), CASE).ok, false, '还没有根')

  // ⚠️ 工作空间级旧根（`casePath: ''`）**绝不复用**：它的边界是整个工作空间，
  // 子会话的通用 shell / fs 能改同工作空间的其他案例（用户复查 P1 的第 4 条）。
  const legacy = makeState({ auditRoot: rootOf({ casePath: '' }) })
  assert.match(auditRootUsability(makeCtx(), legacy, CASE).reason, /工作空间级/)

  const foreign = makeState({ auditRoot: rootOf({ casePath: `${WS}/S2` }) })
  assert.match(auditRootUsability(makeCtx(), foreign, CASE).reason, /另一个案例目录/)

  // 复用判据的锚是**案例目录**，不是工作空间：同一个案例目录的根仍然可用
  //（工作空间换了 → `<工作空间>/<流水号>` 也变了 → 那时 casePath 不同，走上面那条）。
  const otherWorkspace = makeState({ auditRoot: rootOf({ workspacePath: '/cases/other' }) })
  assert.equal(auditRootUsability(makeCtx(), otherWorkspace, CASE).ok, true,
    '工作空间字段只用于侧栏分组与展示；安全边界是案例目录')

  const dead = makeState({ auditRoot: rootOf({ sessionId: 'gone' }) })
  assert.match(auditRootUsability(makeCtx(), dead, CASE).reason, /不在运行中/)

  const asSubagent = makeState({ auditRoot: rootOf() })
  const subCtx = makeCtx({ headers: { 'parent-1': { cwd: CASE, origin: 'subagent' } } })
  assert.match(auditRootUsability(subCtx, asSubagent, CASE).reason, /本身是子代理/)

  // cwd 还是工作空间 → 子会话会继承到工作空间，同样不可用。
  const wrongCwd = makeState({ auditRoot: rootOf() })
  const cwdCtx = makeCtx({ headers: { 'parent-1': { cwd: WS } } })
  assert.match(auditRootUsability(cwdCtx, wrongCwd, CASE).reason, /不是本轮的案例目录/)
})

test('C-02 · 带着不受限 permission preset 的审核根**不可复用**（策略也是可用性的一部分）', () => {
  // `auto` / `danger-full-access` 是会话的**身份**，不是一次可覆盖的开关：子代理会继承它。
  // 所以"先复用再纠正"是不成立的 —— 只能判不可用，让上层新建一个干净的根。
  for (const preset of ['auto', 'danger-full-access']) {
    const ctx = makeCtx({ preset })
    const state = makeState({ auditRoot: rootOf({ title: 'root' }) })
    const usability = auditRootUsability(ctx, state, CASE)
    assert.equal(usability.ok, false, preset)
    assert.match(usability.reason, /permission preset|策略/, preset)
  }
})

test('auditRootUsability 接受"cwd 就是本轮案例目录"的活根', () => {
  const state = makeState({ auditRoot: rootOf({ title: 'x' }) })
  assert.deepEqual(auditRootUsability(makeCtx(), state, CASE), { ok: true, reason: '' })
})

// ── 复用 / 新建 ─────────────────────────────────────────────────────────────

test('ensureAuditRoot 复用属于**本轮案例**的活根，不新建', async () => {
  const ctx = makeCtx()
  const state = makeState({ auditRoot: rootOf({ title: 'x' }) })
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sessionId, 'parent-1')
  assert.equal(result.created, false)
  assert.deepEqual(ctx.created, [], '能用就别新建 —— 稳定优先；本轮案例的根可以一直用')
})

test('ensureAuditRoot 不复用**别的案例**的根，也不复用工作空间级旧根（各自新建）', async () => {
  // 一条根只服务一个案例目录：跨案例复用等于把子会话的写边界留在别的案例上。
  for (const [record, label] of [
    [{ casePath: `${WS}/S2` }, '别的案例的根'],
    [{ casePath: '' }, '工作空间级旧根'],
  ]) {
    const ctx = makeCtx({ headers: { 'parent-1': { cwd: WS } } })
    const state = makeState({ auditRoot: { workspacePath: WS, sessionId: 'parent-1', title: '', assignedAt: '', ...record } })
    const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
    assert.equal(result.ok, true, `${label}：${result.error}`)
    assert.equal(result.created, true, `${label} 必须新建一个根`)
    assert.equal(ctx.created.length, 1, label)
    assert.equal(ctx.created[0].meta.cwd, CASE, `${label}：新根的 cwd 必须是本轮案例目录`)
    assert.equal(state.auditRoot.casePath, CASE, `${label}：钩子要记的是本轮案例目录`)
  }
})

test('ensureAuditRoot creates a top-level session whose cwd and boundary are the case dir', async () => {
  const ctx = makeCtx()
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.created, true)

  assert.equal(ctx.created.length, 1)
  const request = ctx.created[0]
  // 这就是「挂到我的工作空间下面」的全部含义：**cwd 是本轮案例目录**（不是整个工作空间），
  // 而且**不是**子代理；侧栏分组仍靠 `attachSession`（下面断言）。
  assert.equal(request.meta.cwd, CASE, '根的 cwd 必须是本轮的案例目录')
  assert.equal('parentAgent' in request, false, '不带 parentAgent = 顶层会话，不挂在别人下面')
  assert.equal(request.meta.agentPreset, 'default-preset', '没指定就跟部署默认 preset')
  assert.equal(request.agentOptions.model, 'deepseek-flash')

  assert.deepEqual(ctx.attached, [request.sessionId], '要挂到工作空间，侧栏才归到它下面')
  assert.equal(ctx.renamed.length, 1, '根要改名，见名知义')
  assert.match(ctx.renamed[0].title, /审核子代理根节点/)
  assert.equal(ctx.probes.length, 1, '建完必须跑一次 hello 预检')
  assert.equal(state.auditRoot.sessionId, request.sessionId, '钩子要落到 state 上')
  assert.equal(state.auditRoot.workspacePath, WS, '工作空间仍要记：侧栏分组与展示用它')
  assert.equal(state.auditRoot.casePath, CASE, '案例目录才是复用判据的锚')
  // 沙箱边界回读必须是案例目录（上面 `policy` 里的断言从策略层再钉一次）。
  assert.equal(result.policy.ok, true, result.policy.error)
  assert.equal(result.policy.workspaceRoot, CASE, '回读的边界必须是本轮案例目录')
})

test('ensureAuditRoot follows the preset of the session you are working in', async () => {
  const ctx = makeCtx({ headers: { 'parent-1': { cwd: CASE, agentPreset: 'crwu-audit' } } })
  const state = makeState({ parentSessionId: 'parent-1' })
  await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { presetHint: 'crwu-audit', casePath: CASE })
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
  await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { presetHint: 'crwu-audit', casePath: CASE })
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
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /预检未通过/)
  assert.equal(state.auditRoot.sessionId, '', '预检不过就不落钩子：下次会重新建，而不是复用一个跑不动的根')
})

test('ensureAuditRoot creates the directory and registers the workspace when missing', async () => {
  const ctx = makeCtx({ noWorkspace: true, dirs: [] })
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.notes.some((note) => note.includes('登记成工作空间')), true)
})

test('ensureAuditRoot reports a real failure instead of silently proceeding', async () => {
  const ctx = makeCtx({ noWorkspace: true, mkdirFails: true })
  const result = await ensureAuditRoot({ ctx, state: makeState(), world: fakeWorld() }, { casePath: CASE })
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
    auditRoot: rootOf({ title: '审核子代理根节点 · 09-20 21:05', assignedAt: '2026-09-20T13:05:00Z' }),
  }))
  assert.equal(usable.usable, true)
  assert.equal(usable.title, '审核子代理根节点 · 09-20 21:05')
})

// ── 预检指令的平台中立（2026-09-28：Windows 上写死 bash 会让预检必然失败）────────

test('预检指令按平台给出真实可用的取当前目录命令，绝不要求 bash', () => {
  const posix = auditRootProbe('darwin-arm64')
  const win = auditRootProbe('win32-x64')

  for (const [platform, text] of [['darwin-arm64', posix], ['win32-x64', win]]) {
    assert.match(text, /hello/, `${platform}：仍要是一次 hello 预检`)
    assert.match(text, /crwu_audit_capabilities/, `${platform}：仍要顺便验 Tool 链路`)
    assert.match(text, /当前目录/, `${platform}：必须要求回报当前目录（可解析结果）`)
    // 写死 bash 的后果实测过：宿主自检全绿、Agent 预检直接失败，错误还指向不存在的 bash。
    assert.equal(/\bbash\b/.test(text), false, `${platform}：预检不得要求 bash`)
    assert.equal(/```/.test(text), false, `${platform}：预检不得给出 shell 代码块`)
  }
  assert.match(posix, /`pwd`/)
  assert.match(win, /`Get-Location`/)
  assert.equal(win.includes('pwd'), false, 'Windows 上不应出现 pwd')
  assert.equal(posix.includes('Get-Location'), false)
})

test('probeMessage 把平台一路带进预检文本', () => {
  const win = String(probeMessage('seed-1', 'win32-x64').content[0].text)
  assert.match(win, /Get-Location/)
  assert.match(win, /PowerShell/)
})
