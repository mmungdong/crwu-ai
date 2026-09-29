/**
 * 审核会话的**沙箱 / 审批策略**测试（协议 18 · 子项目 C）。
 *
 * 这一层是"审核到底能碰什么"的判据。每条断言都对着一条不可回退的规则：
 *
 * - C-01：新建的审核根解析出来就是选定工作空间的 `workspace-write`；
 * - C-02：带着 `auto` / `danger-full-access` preset 的根**不可用**（不复用、不创建子代理）；
 * - C-03：子代理将要继承到的沙箱覆盖是 `workspace-write`、审批被钉成 `never`；
 * - 策略漂移（有人手动切过 / 服务不可用）一律 fail closed。
 *
 * 最后一条对照用例把我们的"预测"与 DSH **真实**的委派捕获函数逐字段比一遍 ——
 * 生产代码不依赖 `@deepseek-ai/dsh-subagent`（只在测试里 import），但口径必须一致。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { applyAuditRootPolicy, inspectAuditRootPolicy, delegatedPolicyFacts, AUDIT_SANDBOX_MODE, AUDIT_APPROVAL_POLICY } =
  await import(new URL('src/host/audit/policy.ts', ROOT).href)
const { setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy')
const { setApprovalPolicy } = await import('@deepseek-ai/dsh-user-approval')
const { captureDelegatedPolicyOverrides } = await import('@deepseek-ai/dsh-subagent')

/**
 * 假 session + 假 ctx。
 *
 * session 只实现"事件日志 + 折叠"这一件事（`append` + `sandboxMode`/`approval` 两个覆盖），
 * 因为 `setSandboxMode` / `setApprovalPolicy` 的契约就是各 append 一条事件、消费方折叠取值。
 */
function makeSession() {
  const events = []
  const override = {}
  return {
    events,
    override,
    // 真 session 的写入路径就是 `append`；投影（fold）在消费方读时生效。这里让 append
    // **立即**反映到 `override` 上 —— 对"写完立刻回读"的判据来说是同一件事，且省掉一层时序猜测。
    append(name, payload) {
      events.push({ name, payload })
      if (name === 'sandbox/mode') override.mode = payload.mode
      if (name === 'approval/policy') override.policy = payload.policy
      if (name === 'permission/preset') override.preset = payload.preset
    },
  }
}

/**
 * 假 ctx：只实现我们真的会读的四件事 ——
 * `sandboxPolicy.resolve/overrideOf`、`approval.overrideOf`、`permissionPresets.current`。
 */
function makeCtx({
  session, mode, workspaceRoot = '/cases/ws', preset,
  approvalAvailable = true, denyResolution = false,
} = {}) {
  const services = {
    sandboxPolicy: {
      resolve: (request) => {
        if (denyResolution) throw new Error('no sandbox backend')
        const override = request?.session?.override ?? {}
        return {
          mode: override.mode ?? mode ?? '',
          workspaceRoot: override.cwd ?? workspaceRoot,
        }
      },
      overrideOf: () => session.override.mode,
    },
    ...(approvalAvailable ? { approval: { overrideOf: () => session.override.policy } } : {}),
    ...(preset === undefined ? {} : { permissionPresets: { current: () => preset } }),
  }
  return { get: (name) => services[name] }
}

/** 造一个 agent：真 setter 只需要 `session` 这一项。 */
function makeAgent(session) {
  return { session }
}

/** 执行一次真实写入（用 DSH 的两个 setter），模拟"策略已收敛"。 */
function applyRealSetters(session, { mode = AUDIT_SANDBOX_MODE, policy = AUDIT_APPROVAL_POLICY, cwd } = {}) {
  if (mode !== undefined) setSandboxMode(session, mode)
  if (policy !== undefined) setApprovalPolicy(session, policy)
  if (cwd !== undefined) session.override.cwd = cwd
}

test('C-01 · 写入并回读：沙箱 workspace-write、边界是**已选工作空间**、审批 never', () => {
  const session = makeSession()
  const workspacePath = '/cases/ws'
  const ctx = makeCtx({ session, workspaceRoot: 'C:\\ws' })
  // 真 setter 写一遍，再回读同一批事实。
  applyRealSetters(session, { cwd: workspacePath })
  const agent = makeAgent(session)
  const view = inspectAuditRootPolicy(ctx, agent, workspacePath)
  assert.equal(view.ok, true, view.error)
  assert.equal(view.sandboxMode, 'workspace-write')
  assert.equal(view.workspaceRoot, workspacePath)
  assert.equal(view.approvalPolicy, 'never')
  assert.equal(view.permissionPreset, '')
})

test('apply：写两条覆盖（sandbox/mode + approval/policy），且都用 DSH 的 setter', () => {
  const session = makeSession()
  const ctx = makeCtx({ session, workspaceRoot: '/cases/ws' })
  const view = applyAuditRootPolicy(ctx, makeAgent(session), '/cases/ws')
  assert.equal(view.ok, true, view.error)
  assert.deepEqual(session.events.map((event) => event.name), ['sandbox/mode', 'approval/policy'])
  assert.equal(session.events[0].payload.mode, 'workspace-write')
  assert.equal(session.events[1].payload.policy, 'never')
  // 两次写入都**不带** `source: 'delegation'`：它们属于根自己的策略，不是委派 seed。
  assert.equal(session.events[0].payload.source, undefined)
})

test('C-02 · 不受限的 permission preset → 不可用（不复用、也不创建子代理）', () => {
  for (const preset of ['auto', 'danger-full-access']) {
    const session = makeSession()
    applyRealSetters(session, { cwd: '/cases/ws' })
    const ctx = makeCtx({ session, preset })
    const view = inspectAuditRootPolicy(ctx, makeAgent(session), '/cases/ws')
    assert.equal(view.ok, false, preset)
    assert.equal(view.permissionPreset, preset)
    assert.match(view.error, /permission preset/)

    // apply 同样拒绝（先写后查，但结论一样）。
    assert.equal(applyAuditRootPolicy(ctx, makeAgent(session), '/cases/ws').ok, false, preset)
  }
})

test('模式不是 workspace-write（被降级 / 被改漂）→ 拒绝，并说清实际值', () => {
  const session = makeSession()
  applyRealSetters(session, { cwd: '/cases/ws' })
  session.override.mode = 'danger-full-access'
  const view = inspectAuditRootPolicy(makeCtx({ session }), makeAgent(session), '/cases/ws')
  assert.equal(view.ok, false)
  assert.equal(view.sandboxMode, 'danger-full-access')
  assert.match(view.error, /danger-full-access/)
})

test('沙箱边界不是**已选工作空间** → 拒绝（案例目录、兄弟工作空间都不行）', () => {
  // 协议 24 起判据是"边界 = 已选工作空间"：DSH 的边界就是会话 cwd，而 cwd 必须逐字等于
  // 工作空间路径才挂得上工作空间（`attachSession`）—— 也只有这样审核会话才会出现在
  // 「中瑞世联工作空间」下面，而不是「未分组」。
  // ⚠️ 跨案例的隔离**不靠这个边界**，靠 `requireAuditScope`（按本轮 `casePath` 精确相等，见 host-audit-scope）。
  const caseDirLevel = makeSession()
  applyRealSetters(caseDirLevel, { cwd: '/cases/space/S1' })
  const inner = inspectAuditRootPolicy(makeCtx({ session: caseDirLevel }), makeAgent(caseDirLevel), '/cases/space')
  assert.equal(inner.ok, false)
  assert.match(inner.error, /不是已选工作空间/)

  // 别的路径（兄弟工作空间）同样必须拒绝。
  const sibling = makeSession()
  applyRealSetters(sibling, { cwd: '/cases/other' })
  const other = inspectAuditRootPolicy(makeCtx({ session: sibling }), makeAgent(sibling), '/cases/space')
  assert.equal(other.ok, false)
  assert.match(other.error, /不是已选工作空间/)

  // 注：夹具里"边界"就是会话 cwd（与 DSH 一致）；`auditRootUsability` 另有一条用例从复用路径钉同一件事。
})

test('审批策略不是 never → 拒绝；审批能力没装配同样拒绝（无人值守不能靠部署默认）', () => {
  const drifted = makeSession()
  applyRealSetters(drifted, { cwd: '/cases/ws' })
  drifted.override.policy = 'ask'
  const drift = inspectAuditRootPolicy(makeCtx({ session: drifted }), makeAgent(drifted), '/cases/ws')
  assert.equal(drift.ok, false)
  assert.match(drift.error, /ask/)

  const session = makeSession()
  applyRealSetters(session, { cwd: '/cases/ws' })
  const noService = inspectAuditRootPolicy(makeCtx({ session, approvalAvailable: false }), makeAgent(session), '/cases/ws')
  assert.equal(noService.ok, false)
  assert.match(noService.error, /审批策略/)
})

test('沙箱策略服务不可用 / resolve 抛错 → fail closed', () => {
  const session = makeSession()
  applyRealSetters(session, { cwd: '/cases/ws' })
  const thrown = inspectAuditRootPolicy(makeCtx({ session, denyResolution: true }), makeAgent(session), '/cases/ws')
  assert.equal(thrown.ok, false)

  const missing = {
    get: (name) => (name === 'approval' ? { overrideOf: () => 'never' } : undefined),
  }
  assert.equal(inspectAuditRootPolicy(missing, makeAgent(session), '/cases/ws').ok, false)
})

test('没有 session / 没有工作空间 → 结构化失败，不抛异常', () => {
  const ctx = makeCtx({ session: makeSession() })
  assert.equal(inspectAuditRootPolicy(ctx, {}, '/cases/ws').ok, false)
  assert.equal(inspectAuditRootPolicy(ctx, undefined, '/cases/ws').ok, false)
  assert.equal(inspectAuditRootPolicy(ctx, makeAgent(makeSession()), '').ok, false)
  assert.equal(applyAuditRootPolicy(ctx, {}, '/cases/ws').ok, false)
  assert.equal(applyAuditRootPolicy(ctx, makeAgent(makeSession()), '').ok, false)
})

test('C-03 · 与 DSH **真实**的委派捕获口径逐字段一致（子代理会继承到什么）', () => {
  // 我们对"子会话将要继承到的策略"的预测，必须与 DSH 在 `subagents.start` 里调用的
  // `captureDelegatedPolicyOverrides` 完全一致 —— 否则"创建前验证"就是自说自话。
  const cases = [
    { label: '已收敛', mode: 'workspace-write', preset: undefined },
    { label: '被降级', mode: 'danger-full-access', preset: undefined },
    { label: '不带覆盖', mode: undefined, preset: undefined },
    { label: 'auto preset', mode: 'workspace-write', preset: 'auto' },
    { label: 'full preset', mode: 'danger-full-access', preset: 'danger-full-access' },
    { label: '无关 preset', mode: 'workspace-write', preset: 'read-only' },
  ]
  for (const item of cases) {
    const session = makeSession()
    if (item.mode !== undefined) setSandboxMode(session, item.mode)
    setApprovalPolicy(session, 'never')
    const ctx = makeCtx({ session, preset: item.preset })
    const ours = delegatedPolicyFacts(ctx, session)
    // 真函数读的是 `parent.ctx.get(...)` + `parent.session`。
    const upstream = captureDelegatedPolicyOverrides({ ctx, session })
    assert.equal(ours.sandboxMode, upstream.sandboxMode ?? '', `${item.label} · sandboxMode`)
    assert.equal(ours.approvalPolicy, upstream.approvalPolicy ?? '', `${item.label} · approvalPolicy`)
    assert.equal(ours.permissionPreset, upstream.permissionPreset ?? '', `${item.label} · permissionPreset`)
  }
  // 契约本身也要在（DSH 两条支持线上都必须有这三个导出）。
  assert.equal(typeof setSandboxMode, 'function')
  assert.equal(typeof setApprovalPolicy, 'function')
  assert.equal(typeof captureDelegatedPolicyOverrides, 'function')
})
