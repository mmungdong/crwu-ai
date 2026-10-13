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

const ROOT = new URL('../../../', import.meta.url)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { makeAuditAgent, makeAuditSession, auditPolicyServices } = await import(
  new URL('tests/helpers/audit-policy-fixture.mjs', ROOT).href)

const { auditRootTitle, mintSessionId, probeMessage, auditRootProbe, auditRootUsability, ensureAuditRoot, auditRootView, AUDIT_ROOT_TITLE } = await import(
  new URL('src/host/domains/report-audit/root.ts', ROOT).href
)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

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

/**
 * 一棵「活着的会话」：默认 parent-1 是活的、cwd 就是工作空间。
 *
 * 协议 32 起，审核根不再自己 `agents.create`，而是走**统一的工作区会话服务**
 * （`sessionController.create({ workspaceId })`）。所以这个替身必须同时faithful地提供：
 *   - `sessionController.create` —— DSH 的正规入口（解析工作区 → 建 Agent → 挂载）；
 *   - `workspaceRegistry` 记录的 `sessionIds` —— 归属判据（侧栏分组靠它，不靠 cwd）；
 *   - 预置 `parent-1` 的成员关系 —— 复用旧根时要能回读到。
 */
function makeCtx(options = {}) {
  const created = []
  const renamed = []
  const probes = []
  const attached = []
  const presetResolves = []
  const presetMounts = []
  const controllerRequests = []
  const cancelled = []
  /** 每一次 shell 调用都记下来：口径要求「插件不建工作空间目录」，判据就是这里为空。 */
  const shellRuns = []
  const dirs = new Set(options.dirs ?? ['/cases/space'])
  /** 「存在但不是目录」的路径（工作空间选成了一个文件）：`fs.stat` 回 `type: 'file'`。 */
  const files = new Set(options.files ?? [])
  const policyServices = auditPolicyServices({ ...(options.preset === undefined ? {} : { preset: options.preset }) })
  const liveAgents = new Map(Object.entries(options.liveAgents ?? {
    'parent-1': makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), {
      id: 'parent-1',
      followup(message) { probes.push(message) },
      async whenIdle() {},
      cancel(reason) { cancelled.push({ id: 'parent-1', reason }) },
    }),
  }))
  // 会话头是**可变**的：真实 DSH 里 `agents.create` 发布会话之后 `sessions.get` 立刻查得到，
  // 改名（sessionTitle.rename 要求会话活着）就靠这一点。
  const headers = { 'parent-1': { cwd: '/cases/space' }, ...(options.headers ?? {}) }
  let minted = 0

  const entity = {
    id: 'w1',
    path: '/cases/space',
    title: '中瑞世联工作空间',
    /**
     * 归属真相（DSH 的 `Workspace.sessionIds`）。默认预置 `parent-1`：它就是"上一次建的根"，
     * 复用用例要能回读到它。要测"成员关系丢了"就传 `sessionIds: []`。
     */
    sessionIds: options.sessionIds ?? ['parent-1'],
    /**
     * ⚠️ **照 DSH 的判据来**（`@deepseek-ai/dsh-workspace` 的 `attachSession`）：
     * `if (cwd !== this.record.path) throw …` —— 会话的 cwd 必须**逐字等于**工作空间路径。
     * 替身不加这一条，2026-09-30 那个 bug（根建在案例目录 → 挂不上 → 只能落「未分组」）
     * 在单测里就永远看不见：`attached` 照样有记录、用例全绿。
     */
    async attachSession(sessionId) {
      const cwd = headers[sessionId]?.cwd ?? ''
      if (cwd !== this.path) {
        throw new Error(`cannot attach session '${sessionId}' to workspace '${this.path}': its cwd resolves to '${cwd}'`)
      }
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
      attached.push(sessionId)
    },
  }

  const agentsService = {
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
        cancel(reason) { cancelled.push({ id: request.sessionId, reason }) },
      })
      liveAgents.set(request.sessionId, agent)
      // DSH 的 `agents.create` 会在这个会话自己的 scope 上跑 `setup`（preset 就挂在这里）。
      if (typeof request.setup === 'function') await request.setup({ marker: 'agent-scope' }, agent)
      return { agent }
    },
  }

  return {
    created, renamed, probes, attached, presetResolves, presetMounts, controllerRequests, cancelled,
    shellRuns, entity, headers, liveAgents,
    get(name) {
      if (name === 'agents') return agentsService
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
      // 协议 32：统一会话创建入口。照 DSH 的 `SessionController.create` 忠实实现 ——
      // 解析工作区 → `cwd = workspace.path` 建 Agent → `attachSession`（失败即抛）。
      if (name === 'sessionController') {
        return {
          async create(request) {
            controllerRequests.push(request)
            if (request.workspaceId === undefined) throw new Error('workspaceId 缺失')
            if (request.cwd !== undefined) throw new Error('session.create 不接受 cwd')
            if (options.noWorkspace === true) throw new Error(`workspace "${request.workspaceId}" not found`)
            const sessionId = request.sessionId ?? `session-${minted += 1}`
            await agentsService.create({
              sessionId,
              meta: { cwd: entity.path, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) },
              agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
              setup: async (agentCtx, id) => {
                if (request.agentPreset !== undefined) presetMounts.push({ agentCtx, id: request.agentPreset })
                void id
              },
            })
            await entity.attachSession(sessionId)
            return { sessionId }
          },
          async rename(request) {
            renamed.push({ sessionId: request.sessionId, title: request.title })
          },
        }
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
        // `unregistered`：id 查不到、也列不出（工作区没登记进注册表）。
        const known = options.unregistered !== true
        return {
          async resolveByPath(path) {
            if (options.noWorkspace === true || !known) throw new Error('ENOENT')
            return path === '/cases/space' ? entity : undefined
          },
          async create(path) { return { ...entity, path } },
          list: () => (known ? [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }] : []),
          get: (id) => (known && id === 'w1' ? entity : undefined),
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
          async execute(request) {
            shellRuns.push(request)
            return { result: async () => (options.mkdirFails === true ? result(1, 'sandbox unavailable') : result(0, '')) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
            if (dirs.has(key)) return { type: 'directory' }
            if (files.has(key)) return { type: 'file' }
            return undefined
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
    workspaceMissing: false,
    // 协议 32：`workspaceId` 是工作区的**身份**，没有它一律拒绝启动。
    workspaceId: 'w1',
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
/** 本轮的案例目录（协议 24 起：它是**案例 scope** 的锚，不再是会话 cwd/沙箱边界）。 */
const CASE = `${WS}/S1`
/**
 * 一条 scope 完整的根记录（协议 32 形态：**多了 `workspaceId`**）。
 *
 * `workspaceId` 是复用前那道"还是不是同一个工作区"的判据 —— 老记录没有它时退回按路径比较。
 */
const rootOf = (patch = {}) => ({
  workspaceId: 'w1', workspacePath: WS, casePath: CASE, sessionId: 'parent-1',
  title: '', assignedAt: '', ...patch,
})

test('auditRootUsability：没有根 / 工作空间级旧根 / 别的案例的根 / 换过工作区 / 死掉 / 子代理 / cwd 不对 —— 一律不可用', async () => {
  assert.equal((await auditRootUsability(makeCtx(), makeState(), CASE)).ok, false, '还没有根')

  // ⚠️ 工作空间级旧根（`casePath: ''`）**绝不复用**：它的边界是整个工作空间，
  // 子会话的通用 shell / fs 能改同工作空间的其他案例（用户复查 P1 的第 4 条）。
  const legacy = makeState({ auditRoot: rootOf({ casePath: '' }) })
  assert.match((await auditRootUsability(makeCtx(), legacy, CASE)).reason, /工作空间级/)

  const foreign = makeState({ auditRoot: rootOf({ casePath: `${WS}/S2` }) })
  assert.match((await auditRootUsability(makeCtx(), foreign, CASE)).reason, /另一个案例目录/)

  // 协议 32：记录属于**另一个工作区**时不再复用 —— 会话 id 跨重启活下来、工作区选择不会，
  // 两者不同步时复用等于把内容写进用户以为早已换掉的目录。（旧口径只比 `casePath`，这条会漏。）
  const switched = makeState({ auditRoot: rootOf({ workspaceId: 'w-old', workspacePath: '/cases/other' }) })
  assert.match((await auditRootUsability(makeCtx(), switched, CASE)).reason, /另一个工作区|不一致/)

  const dead = makeState({ auditRoot: rootOf({ sessionId: 'gone' }) })
  assert.match((await auditRootUsability(makeCtx(), dead, CASE)).reason, /不在运行中/)

  const asSubagent = makeState({ auditRoot: rootOf() })
  const subCtx = makeCtx({ headers: { 'parent-1': { cwd: WS, origin: 'subagent' } } })
  assert.match((await auditRootUsability(subCtx, asSubagent, CASE)).reason, /本身是子代理/)

  // cwd 不是已选工作区（这里是案例目录）→ 挂不到工作区下、边界也不对，不可用。
  const wrongCwd = makeState({ auditRoot: rootOf() })
  const cwdCtx = makeCtx({ headers: { 'parent-1': { cwd: CASE } } })
  assert.match((await auditRootUsability(cwdCtx, wrongCwd, CASE)).reason, /不是选定工作区/)

  // 协议 32 **新增**的一条：成员关系回读不到就不复用。
  // 旧实现根本不查它 —— 挂载丢了的根会被复用来跑审核，子会话落「未分组」。
  const detached = makeState({ auditRoot: rootOf() })
  const detachedCtx = makeCtx({ sessionIds: [] })
  assert.match((await auditRootUsability(detachedCtx, detached, CASE)).reason, /成员清单/)
})

test('C-02 · 带着不受限 permission preset 的审核根**不可复用**（策略也是可用性的一部分）', async () => {
  // `auto` / `danger-full-access` 是会话的**身份**，不是一次可覆盖的开关：子代理会继承它。
  // 所以"先复用再纠正"是不成立的 —— 只能判不可用，让上层新建一个干净的根。
  for (const preset of ['auto', 'danger-full-access']) {
    const ctx = makeCtx({ preset })
    const state = makeState({ auditRoot: rootOf({ title: 'root' }) })
    const usability = await auditRootUsability(ctx, state, CASE)
    assert.equal(usability.ok, false, preset)
    assert.match(usability.reason, /permission preset|策略/, preset)
  }
})

test('auditRootUsability 接受"cwd 就是已选工作区、且成员关系在位"的活根', async () => {
  const state = makeState({ auditRoot: rootOf({ title: 'x' }) })
  assert.deepEqual(await auditRootUsability(makeCtx(), state, CASE), { ok: true, reason: '' })
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
    assert.equal(ctx.created[0].meta.cwd, WS, `${label}：新根的 cwd 必须是**已选工作空间**（协议 24）`)
    assert.equal(state.auditRoot.casePath, CASE, `${label}：钩子要记的是本轮案例目录`)
  }
})

test('ensureAuditRoot 建的顶层会话：cwd = 已选工作空间（协议 24，会话才挂得上工作空间）', async () => {
  const ctx = makeCtx()
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.created, true)

  assert.equal(ctx.created.length, 1)
  const request = ctx.created[0]
  // 这就是「挂到我的工作空间下面」的全部含义：**cwd = 已选工作空间**
  //（DSH 的沙箱边界就是会话 cwd，而 `attachSession` 要求 cwd 逐字等于工作空间路径），
  // 而且**不是**子代理；侧栏分组靠 `attachSession`（下面断言）。
  assert.equal(request.meta.cwd, WS, '根的 cwd 必须是**已选工作空间**')
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
  // 沙箱边界回读必须是**已选工作空间**（协议 24：边界 = 会话 cwd = 工作空间路径）。
  // 案例目录仍是复用判据与案例 scope 的锚（上一行），两件事不要混。
  assert.equal(result.policy.ok, true, result.policy.error)
  assert.equal(result.policy.workspaceRoot, WS, '回读的边界必须是已选工作空间')
})

test('ensureAuditRoot follows the preset of the session you are working in', async () => {
  const ctx = makeCtx({ headers: { 'parent-1': { cwd: CASE, agentPreset: 'crwu-audit' } } })
  const state = makeState({ parentSessionId: 'parent-1' })
  await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { presetHint: 'crwu-audit', casePath: CASE })
  assert.equal(ctx.controllerRequests[0].agentPreset, 'crwu-audit', '审核的工具链要跟你在用的会话一致')
  assert.equal(ctx.presetMounts[0].id, 'crwu-audit', 'preset 要真的挂到这个会话自己的 scope 上')
})

test('审核根只通过统一会话入口创建：只发 workspaceId + agentPreset，绝不自己发 cwd', async () => {
  // 协议 32：审核根不再自己 `agents.create({ meta: { cwd } })`，而是走
  // `sessionController.create`。这条断言钉的正是"**只有一条建会话的路**"：
  // `cwd` 一旦出现在请求里，就说明有人又开了一条能决定落点的旁路。
  //
  // 字段逐个对照已安装的 `@deepseek-ai/dsh-api-session-controller` 声明：
  //   SessionCreateRequest = { workspaceId?; cwd?; sessionId?; agentPreset? }
  //   `workspaceId` 与 `cwd` 互斥（两个都给会抛 `gateway/bad-request`）。
  const ctx = makeCtx()
  const state = makeState({ parentSessionId: 'parent-1' })
  await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { presetHint: 'crwu-audit', casePath: CASE })
  const request = ctx.controllerRequests[0]

  assert.deepEqual(
    Object.keys(request).sort(),
    ['agentPreset', 'workspaceId'],
    '只发这两个：落点由 workspaceId 决定，preset 决定工具链',
  )
  assert.equal(request.workspaceId, 'w1')
  assert.equal('cwd' in request, false, 'cwd 一律不许出现（它会让会话挂不到工作区下）')

  // Agent 侧的请求由 DSH 的 controller 组装（cwd = 工作区路径、顶层会话、带 preset）。
  const agentRequest = ctx.created[0]
  assert.equal(agentRequest.meta.cwd, WS, '根会话的 cwd 必须是工作区路径')
  assert.equal('parentAgent' in agentRequest, false, '不带 parentAgent = 顶层会话')
  assert.match(String(agentRequest.sessionId), /^session-/)
})

test('ensureAuditRoot keeps the hook clean when the preflight fails', async () => {
  const ctx = makeCtx({ probeFails: true })
  const state = makeState()
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /预检未通过/)
  assert.equal(state.auditRoot.sessionId, '', '预检不过就不落钩子：下次会重新建，而不是复用一个跑不动的根')
  // 协议 32：建完才发现跑不动时必须**释放**这条会话，否则左侧会留下一条空对话，
  // 用户会以为审核已经跑过一轮。
  assert.equal(ctx.cancelled.length, 1, '预检不过要释放刚建的会话')
  assert.equal(ctx.cancelled[0].id, ctx.created[0].sessionId)
  assert.equal(result.notes.some((note) => note.includes('已释放')), true)
})

test('工作区没登记进注册表 → 拒绝启动（审核根**不再**替用户登记工作区）', async () => {
  // 协议 32：工作区必须已经在【环境信息】里选好并登记。
  // 以前这里会 `workspaceRegistry.create(path)` 顺手登记一个 —— 那条路让"没选工作区"变成
  // "插件自己挑了一个"，而用户以为审核会写到他选的地方。
  const ctx = makeCtx({ unregistered: true, dirs: ['/cases/space'] })
  const result = await ensureAuditRoot({ ctx, state: makeState(), world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /注册表|环境信息/)
  assert.equal(ctx.controllerRequests.length, 0, '工作区不成立就不要建会话')
  // 口径：插件绝不建文件系统目录，也绝不自己登记工作区 —— 一次 shell 都不许跑。
  assert.deepEqual(ctx.shellRuns, [], '不得用 mkdir / New-Item 补建工作区')
})

test('ensureAuditRoot refuses to start when the chosen workspace directory is gone', async () => {
  // 「工作区目录不存在 → 直接失败」：以前会 mkdir 补建，那会让写错的路径悄悄变成一个新目录。
  const ctx = makeCtx({ dirs: [] })
  const result = await ensureAuditRoot({ ctx, state: makeState(), world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是一个目录/)
  assert.match(result.error, /重新选择/)
  assert.equal(ctx.controllerRequests.length, 0, '工作区不成立就不要建会话')
  assert.deepEqual(ctx.shellRuns, [], '不得用 mkdir / New-Item 补建工作区')
})

test('ensureAuditRoot refuses to start when the chosen workspace path is a file, not a directory', async () => {
  // §8-5：路径存在但**不是目录**同样阻塞（不静默当成工作区、更不建目录）。
  const ctx = makeCtx({ dirs: [], files: ['/cases/space'] })
  const result = await ensureAuditRoot({ ctx, state: makeState(), world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是一个目录/)
  assert.equal(ctx.controllerRequests.length, 0)
  assert.deepEqual(ctx.shellRuns, [])
})

test('ensureAuditRoot refuses to start when no workspace was chosen at all', async () => {
  const ctx = makeCtx()
  const state = makeState()
  state.workspaceId = ''
  state.workspacePath = ''
  state.caseRoot = ''
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /尚未选定工作区/)
  assert.match(result.error, /已有目录/)
  assert.equal(ctx.controllerRequests.length, 0)
  assert.deepEqual(ctx.shellRuns, [])
})

test('caseRoot 不再是工作区降级：只配了部署案例根时审核仍然拒绝启动', async () => {
  // 协议 32 之前这里是 `workspacePath || caseRoot`：忘了选工作区就退到部署配置里的案例根。
  // 那条降级的后果是"审核跑起来了，产物写到部署默认目录"。
  const ctx = makeCtx()
  const state = makeState({ workspaceId: '', workspacePath: '' })
  assert.equal(state.caseRoot, '/cases/space', '前提：部署案例根是有值的')
  const result = await ensureAuditRoot({ ctx, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, { casePath: CASE })
  assert.equal(result.ok, false)
  assert.match(result.error, /尚未选定工作区/)
  assert.equal(ctx.controllerRequests.length, 0)
})

test('审核根与工作空间解析里**没有**任何建目录的代码（静态判据）', async () => {
  // §8-8 / §8-10 的静态一半：运行时轨迹证明"这一次没建"，静态判据证明"以后也建不了"。
  // 允许自动创建的只有 `<工作空间>/<流水号>` 案例目录，而它由 `audit/ops.ts` 用
  // `tools/common/case-files.ts` 的 `ensureDirectory` 建 —— 审核根与工作空间解析这两个模块
  // **不许**出现 mkdir / New-Item / ensureDirectory。
  const { readFile } = await import('node:fs/promises')
  for (const file of [
    'src/host/domains/report-audit/root.ts',
    'src/host/core/workspace/resolve.ts',
    'src/host/core/workspace/ops.ts',
  ]) {
    const source = await readFile(new URL(file, ROOT), 'utf8')
    for (const banned of ['mkdirCommand', 'mkdir -p', 'New-Item', 'ensureDirectory']) {
      assert.equal(source.includes(banned), false, `${file} 不许出现「${banned}」`)
    }
  }
})

test('auditRootView explains the two states the panel shows', async () => {
  const empty = await auditRootView(makeCtx(), makeState())
  assert.equal(empty.sessionId, '')
  assert.equal(empty.usable, false)
  assert.match(empty.reason, /发起审核时自动创建/)

  const usable = await auditRootView(makeCtx(), makeState({
    auditRoot: rootOf({ title: '审核子代理根节点 · 09-20 21:05', assignedAt: '2026-09-20T13:05:00Z' }),
  }))
  assert.equal(usable.usable, true)
  assert.equal(usable.title, '审核子代理根节点 · 09-20 21:05')

  // 协议 32：面板说的是「这条已记录的根**此刻**还能不能用」，所以成员关系丢了就要显示不可用 ——
  // 旧实现只比字符串，挂载丢了的根在面板上照样显示"可用"。
  const detached = await auditRootView(makeCtx({ sessionIds: [] }), makeState({
    auditRoot: rootOf({ title: 'x' }),
  }))
  assert.equal(detached.usable, false)
  assert.match(detached.reason, /成员清单/)
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
