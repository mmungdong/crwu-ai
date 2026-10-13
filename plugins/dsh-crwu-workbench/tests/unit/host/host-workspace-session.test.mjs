/**
 * 工作区会话统一服务（协议 32）的单元测试。
 *
 * 这一层是"会话到底建在哪儿"的**唯一**判据来源。它要钉死的不变量：
 *
 * 1. 唯一来源是【环境信息】里的选中工作区 —— `caseRoot`、部署默认目录、父会话 cwd 都不是来源；
 * 2. `workspaceId` 空 / 路径空 / 目录丢了 / 自检没完成 / 注册表查不到 / 路径不一致 / 不是目录
 *    一律**在发请求之前**失败（fail closed），一个会话都不建；
 * 3. 建会话只发 `workspaceId`，**绝不**发 `cwd`（`cwd` 就是那条把会话建到错误目录的降级）；
 * 4. 建完必须回读到"会话在 `workspace.sessionIds` 里"才算成功；
 * 5. 挂载/成员关系回读失败时**不得**返回成功；
 * 6. 复用旧会话之前必须重新核工作区一致性与 Agent 存活。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  workspaceSessionService,
  resolveSelectedWorkspace,
  verifyReusableSession,
  workspaceFailureReasonText,
} = await import(new URL('src/host/core/workspace-session/index.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/fallback-case-root', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

const WS = '/ws'

/**
 * 一棵最小但**判据忠实**的宿主替身。
 *
 * 忠实点：`attachSession` 照 DSH 的判据要求 `cwd` **逐字等于**工作区路径；
 * `sessionController.create({ workspaceId })` 自己也会建 Agent + attach 一次（与 DSH 一致），
 * 所以"插件漏了显式 attach"在这里不会被误判成通过。
 */
function makeCtx(options = {}) {
  const createRequests = []
  const attached = []
  const renames = []
  const headers = { ...(options.headers ?? {}) }
  const agents = new Map(Object.entries(options.liveAgents ?? {}))
  const dirs = new Set(options.dirs ?? [WS])

  const entity = {
    id: 'w1',
    path: options.entityPath ?? WS,
    title: '中瑞世联工作区',
    sessionIds: [],
    async attachSession(sessionId) {
      const cwd = headers[sessionId]?.cwd ?? ''
      if (cwd !== this.path) {
        throw new Error(`cannot attach session '${sessionId}': cwd resolves to '${cwd}'`)
      }
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
      attached.push(sessionId)
    },
  }

  const ctx = {
    createRequests, attached, renames, headers, agents, entity,
    get(name) {
      if (name === 'workspaceRegistry') {
        if (options.noRegistry === true) return undefined
        const known = options.unregistered !== true && !options.pathMismatchList
        return {
          get: (id) => (options.unregistered === true || id !== 'w1' ? undefined : entity),
          // `list` 必须与 `get` 一致：真实注册表不会列出自己 `get` 不到的记录。
          list: () => (known ? [{ id: 'w1', path: entity.path, title: entity.title }] : []),
        }
      }
      if (name === 'sessionController') {
        if (options.noController === true) return undefined
        return {
          async create(request) {
            createRequests.push(request)
            if (options.createFails === true) throw new Error('模型链路不可用')
            const sessionId = request.sessionId ?? `session-${createRequests.length}`
            headers[sessionId] = { cwd: options.sessionCwd ?? WS }
            agents.set(sessionId, { id: sessionId })
            if (options.skipAutoAttach !== true) {
              // DSH 的行为：create({ workspaceId }) 自己会 attach，失败时**抛错**。
              if (options.autoAttachFails === true) throw new Error('attach 失败')
              await entity.attachSession(sessionId)
            }
            return { sessionId }
          },
          async rename(request) {
            renames.push(request)
            if (options.renameFails === true) throw new Error('改名服务不可用')
          },
        }
      }
      if (name === 'sessions') {
        return { get: (id) => (headers[id] === undefined ? undefined : { header: headers[id] }) }
      }
      if (name === 'agents') {
        return { get: (id) => agents.get(id) }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: String(path).replace(/[\\/]+$/, ''), displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
            return dirs.has(key) ? { type: 'directory' } : undefined
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

function makeState(patch = {}) {
  return {
    ...createWorkbenchState(CONFIG),
    workspaceChosen: true,
    workspaceMissing: false,
    workspaceId: 'w1',
    workspacePath: WS,
    workspaceTitle: '中瑞世联工作区',
    caseRoot: WS,
    ...patch,
  }
}

// ── 解析：不成立的工作区一律在发请求之前失败 ────────────────────────────────

test('没有选中工作区 / 目录丢了 / 自检没完成 —— 都不算"有工作区"', async () => {
  const ctx = makeCtx()
  for (const [patch, reason] of [
    [{ workspaceId: '' }, 'no-workspace'],
    [{ workspacePath: '' }, 'no-workspace'],
    [{ workspaceMissing: true }, 'workspace-missing'],
    [{ workspaceChosen: false }, 'workspace-unchecked'],
  ]) {
    const resolved = await resolveSelectedWorkspace(ctx, makeState(patch))
    assert.equal(resolved.ok, false, JSON.stringify(patch))
    assert.equal(resolved.reason, reason, JSON.stringify(patch))
    assert.ok(resolved.error.length > 0, '失败必须带一句人话')
  }
})

test('caseRoot 与部署默认目录**不是**工作区来源（唯一的来源是 workspaceId/Path）', async () => {
  const ctx = makeCtx()
  const resolved = await resolveSelectedWorkspace(ctx, makeState({
    workspaceId: '', workspacePath: '', caseRoot: '/fallback-case-root',
  }))
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'no-workspace', 'caseRoot 有值也不能当工作区用')
})

test('注册表服务缺失 / id 查不到 / 路径不一致 / 不是目录 —— 一律指名道姓地失败', async () => {
  for (const [options, patch, reason] of [
    [{ noRegistry: true }, {}, 'services-unavailable'],
    [{ unregistered: true }, {}, 'workspace-unregistered'],
    [{ entityPath: '/somewhere/else' }, {}, 'workspace-path-mismatch'],
    [{ dirs: [] }, {}, 'workspace-not-a-directory'],
  ]) {
    const ctx = makeCtx(options)
    const resolved = await resolveSelectedWorkspace(ctx, makeState(patch))
    assert.equal(resolved.ok, false, reason)
    assert.equal(resolved.reason, reason)
  }
})

test('每条失败原因都有一句给人看的话，且不带路径/凭据', () => {
  for (const reason of [
    'no-workspace', 'workspace-missing', 'workspace-unchecked', 'workspace-unregistered',
    'workspace-path-mismatch', 'workspace-not-a-directory', 'services-unavailable',
    'session-create-failed', 'session-attach-failed', 'session-membership-missing',
    'session-cwd-mismatch', 'session-agent-missing',
  ]) {
    const message = workspaceFailureReasonText(reason)
    assert.ok(message.length > 0, reason)
    assert.equal(/\/ws|session-|undefined/.test(message), false, `${reason} 的文案不该带路径或 id`)
  }
})

// ── 创建：只发 workspaceId，回读成员关系 ────────────────────────────────────

test('创建会话只发 workspaceId，绝不发 cwd（cwd 就是那条把会话建错地方的降级）', async () => {
  const ctx = makeCtx()
  const service = workspaceSessionService(ctx, makeState())
  const created = await service.createSession({ title: '审核子代理根节点 · 09-20 21:05', source: 'audit-root' })

  assert.equal(created.ok, true, created.ok ? '' : created.error)
  assert.equal(ctx.createRequests.length, 1)
  const request = ctx.createRequests[0]
  assert.equal(request.workspaceId, 'w1')
  assert.equal('cwd' in request, false, 'cwd 一律不许出现（空串、案例目录、工作区路径都不行）')
  assert.deepEqual(Object.keys(request).sort(), ['workspaceId'], '只发工作区身份')

  // 回读：会话必须出现在工作区记录的成员清单里 —— 这就是侧栏分组的唯一凭据。
  assert.deepEqual(ctx.entity.sessionIds, [created.sessionId])
  assert.equal(created.workspace.path, WS)
  assert.deepEqual(ctx.renames, [{ sessionId: created.sessionId, title: '审核子代理根节点 · 09-20 21:05' }])
})

test('工作区不成立时**一个会话都不建**', async () => {
  for (const patch of [
    { workspaceId: '' }, { workspacePath: '' }, { workspaceMissing: true },
    { workspaceChosen: false },
  ]) {
    const ctx = makeCtx()
    const created = await workspaceSessionService(ctx, makeState(patch))
      .createSession({ title: 't', source: 'audit-root' })
    assert.equal(created.ok, false, JSON.stringify(patch))
    assert.deepEqual(ctx.createRequests, [], `${JSON.stringify(patch)}：不许发出建会话请求`)
  }
})

test('create 抛错 / 返回空 id —— 都算创建失败，且不谎报成员关系', async () => {
  const failing = makeCtx({ createFails: true })
  const first = await workspaceSessionService(failing, makeState()).createSession({ title: 't', source: 'x' })
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'session-create-failed')
  assert.deepEqual(failing.entity.sessionIds, [])

  // 简化宿主可能回一个没有 id 的应答。
  const silent = makeCtx()
  const controller = silent.get('sessionController')
  silent.get = ((original) => (name) => {
    if (name !== 'sessionController') return original(name)
    return { ...controller, create: async () => ({}) }
  })(silent.get.bind(silent))
  const second = await workspaceSessionService(silent, makeState()).createSession({ title: 't', source: 'x' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'session-create-failed')
})

test('成员关系回读失败时**不许**返回成功（挂载失败必须显形）', async () => {
  // ① 所有挂载尝试都失败：拿不到成员关系，直接失败。
  const ctx = makeCtx({ autoAttachFails: true, skipAutoAttach: true })
  ctx.entity.attachSession = async () => { throw new Error('工作区记录拒绝挂载') }
  const created = await workspaceSessionService(ctx, makeState()).createSession({ title: 't', source: 'x' })
  assert.equal(created.ok, false)
  assert.equal(created.reason, 'session-attach-failed')
  assert.match(created.error, /挂到选定的工作区|挂载失败/, '要说明是"挂载"这一步出了问题')
})

test('会话 cwd 不是工作区路径时不通过（cwd 不一致 = 落点不对）', async () => {
  // `create` 把 Agent 建在别的目录：显式 attach 与回读都必须拦下它。
  const ctx = makeCtx({ sessionCwd: '/somewhere/else', skipAutoAttach: true })
  const created = await workspaceSessionService(ctx, makeState()).createSession({ title: 't', source: 'x' })
  assert.equal(created.ok, false)
  assert.equal(created.reason, 'session-cwd-mismatch')
})

test('改名失败不算失败，但要如实记进 notes', async () => {
  const ctx = makeCtx({ renameFails: true })
  const created = await workspaceSessionService(ctx, makeState()).createSession({ title: '根节点', source: 'x' })
  assert.equal(created.ok, true)
  assert.equal(created.notes.some((note) => note.includes('改名失败')), true)
})

test('Agent 不在注册表里时创建失败（复用一条没有 Agent 的会话没有意义）', async () => {
  const ctx = makeCtx()
  const controller = ctx.get('sessionController')
  ctx.get = ((original) => (name) => {
    if (name !== 'sessionController') return original(name)
    return { ...controller, create: async (request) => {
      ctx.createRequests.push(request)
      // 建了会话头、挂了工作区，但**没有** Agent（模拟进程重启后的残留）。
      ctx.headers['session-orphan'] = { cwd: WS }
      await ctx.entity.attachSession('session-orphan')
      return { sessionId: 'session-orphan' }
    } }
  })(ctx.get.bind(ctx))
  const created = await workspaceSessionService(ctx, makeState()).createSession({ title: 't', source: 'x' })
  assert.equal(created.ok, false)
  assert.equal(created.reason, 'session-agent-missing')
})

// ── 复用旧会话之前的重新验证 ────────────────────────────────────────────────

test('复用旧会话：工作区换了 / Agent 没了 / 成员关系丢了 —— 都不复用', async () => {
  const placement = { workspaceId: 'w1', workspacePath: WS, sessionId: 'session-1' }

  // ① 记录属于另一个工作区。
  const switched = makeCtx({ headers: { 'session-1': { cwd: WS } }, liveAgents: { 'session-1': {} } })
  const other = await verifyReusableSession(switched, makeState({ workspaceId: 'w1' }), { ...placement, workspaceId: 'w-other' })
  assert.equal(other.ok, false)
  assert.match(other.reason, /另一个工作区/)

  // ② Agent 已经不在了（进程重启）。
  const dead = makeCtx({ headers: { 'session-1': { cwd: WS } } })
  const gone = await verifyReusableSession(dead, makeState(), placement)
  assert.equal(gone.ok, false)
  assert.match(gone.reason, /不在运行中/)

  // ③ Agent 在，但成员关系回读不到（挂载丢了）。
  const drifted = makeCtx({ headers: { 'session-1': { cwd: WS } }, liveAgents: { 'session-1': {} } })
  const missing = await verifyReusableSession(drifted, makeState(), placement)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /成员清单/)

  // ④ 都成立 → 可复用。
  const good = makeCtx({ headers: { 'session-1': { cwd: WS } }, liveAgents: { 'session-1': {} } })
  good.entity.sessionIds.push('session-1')
  const ok = await verifyReusableSession(good, makeState(), placement)
  assert.deepEqual(ok, { ok: true, reason: '' })
})

test('复用旧会话时，工作区本身不成立也要拦住（不能让旧会话绕过环境门禁）', async () => {
  const ctx = makeCtx({ headers: { 'session-1': { cwd: WS } }, liveAgents: { 'session-1': {} } })
  ctx.entity.sessionIds.push('session-1')
  const verdict = await verifyReusableSession(ctx, makeState({ workspaceMissing: true }), {
    workspaceId: 'w1', workspacePath: WS, sessionId: 'session-1',
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /不存在|移动/)
})

// ── 静态判据：源码里不许再出现 cwd 降级 ─────────────────────────────────────

test('工作区会话层里没有任何 cwd 降级（静态判据）', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('src/host/core/workspace-session/', ROOT)
  /** 去注释：这些文件必须**解释**为什么不能用 cwd 降级，注释里的反例不算违规。 */
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue
    const code = stripComments(await readFile(new URL(name, dir), 'utf8'))
    for (const banned of [/cwd:\s*''/, /cwd:\s*caseRoot/, /cwd:\s*workspacePath/, /cwd:\s*state\./, /cwd:\s*[a-zA-Z]+\s*[,}]/]) {
      assert.equal(banned.test(code), false, `${name} 不许出现 ${banned}`)
    }
  }
})
