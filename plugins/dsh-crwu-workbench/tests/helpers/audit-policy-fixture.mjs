/**
 * 审核策略（协议 18 · 子项目 C）的**测试夹具**。
 *
 * 为什么要有这一份：`applyAuditRootPolicy` / `inspectAuditRootPolicy` 读的是
 * **DSH 自己的服务**（`sandboxPolicy.resolve/overrideOf`、`approval.overrideOf`、
 * `permissionPresets.current`），而几乎每个审核用例都要一个"策略已收敛"的会话。
 * 各文件各写一份假 session 的下场是：升一次协议、或 DSH 改一次取值口径，
 * 就有一半文件忘了改 —— 而它们照样绿（断言的是老形状）。
 *
 * 一份 session 只需要实现**写入路径**（`append`）：两个真 setter 就是往它上面加事件，
 * 消费方（resolve / overrideOf）折叠取值。夹具让 `append` 立即反映到 `override`，
 * 与"写完立刻回读"的判据等价。
 */

/** 一个最小可用 session：`append` 折叠 + 初始覆盖 + cwd。 */
export function makeAuditSession({ mode = 'workspace-write', cwd = '/cases/space', policy = 'never', id = '' } = {}) {
  const events = []
  const override = {}
  if (mode !== '') override.mode = mode
  if (policy !== '') override.policy = policy
  return {
    id,
    events,
    override,
    cwd,
    append(name, payload) {
      events.push({ name, payload })
      if (name === 'sandbox/mode') override.mode = payload.mode
      if (name === 'approval/policy') override.policy = payload.policy
      if (name === 'permission/preset') override.preset = payload.preset
    },
  }
}

/**
 * 一个**声明支持 `toolFilter`** 的子代理 provider 替身。
 *
 * 审核启动现在要求 provider 具备 `capabilities.toolFilter`（真实边界：deny 的工具必须既不进
 * 子会话 prompt、也拒绝执行），不支持就在创建子会话**之前**拒绝 —— 所以夹具必须给出这个能力，
 * 否则所有"启动成功"的用例都会（正确地）失败。
 */
export function subagentProviderStub({ name = 'spawn', toolFilter = true } = {}) {
  return {
    name,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter, persona: false },
    inheritsParentContext: false,
  }
}

/** 一个带 session 的假 Agent（审核根 / 子代理都够用）。 */
export function makeAuditAgent(session, extra = {}) {
  return {
    followup() {},
    async whenIdle() {},
    ...extra,
    session,
  }
}

/**
 * 策略服务替身（三项）。
 *
 * `resolve` 按 DSH 的口径取值：模式取会话的 `sandbox/mode` 覆盖，边界取**会话 cwd** ——
 * 不是覆盖里另存一个 cwd（真实实现就是 `session.cwd` 不可变、作为 workspace-write 的边界）。
 */
export function auditPolicyServices({ preset, cwd } = {}) {
  const sessionCwd = (session) => session?.cwd ?? session?.header?.cwd ?? cwd ?? ''
  return {
    sandboxPolicy: {
      resolve: (request) => {
        const session = request?.session
        return { mode: session?.override?.mode ?? '', workspaceRoot: sessionCwd(session) }
      },
      overrideOf: (session) => session?.override?.mode,
    },
    approval: {
      overrideOf: (session) => session?.override?.policy,
    },
    ...(preset === undefined ? {} : { permissionPresets: { current: () => preset } }),
  }
}
