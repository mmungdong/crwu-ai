/**
 * 环境领域模型的客户端侧测试（`shared/environment/model.ts` + `features/environment/*`）。
 *
 * 这一份取代了旧的「五层分层规则」测试（`layers.ts` 已随 2026-09-26 环境页重构删除）：
 * 旧版盯的是"界面把检查项摆在哪一层"，新版盯的是**结论本身** —— 因为结论已经上提到 Host
 * 的统一环境模型，界面只负责画。所以要断言的是：
 *
 * 1. **状态推导**：iFinD（必需项）/ 氚云 / 钉钉 / OSS / 工作空间缺失都是**阻塞**；
 *    包 / 运行时 / 平台故障归 system；`degraded` 只留给将来真正的可选能力；
 * 2. **通过率只统计必需项**（所以「环境就绪」与「N/N 通过」永远同时成立，iFinD 在分母里）；
 * 3. **门禁**：unknown / check-failed / 未就绪一律不放行（含 `external-data`）；
 *    就绪才放行；iFinD 未通过时提示指名 API-Key；
 * 4. **导航纯函数**：被拦时落到 env 并带上目标页名；
 * 5. **iFinD 卡片**：状态词 / 色调映射，以及"没取到数据不说已认证"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  overallStatusOf, capabilitiesOf, requiredTallyOf, blockerMessages, degradedMessages,
  primaryUserIssue, environmentGate, navigateModuleIn, statusProceedable, proceedableOf,
} = await import(new URL('src/shared/environment/model.ts', ROOT).href)

// ── 测试夹具：直接构造模型（Host 侧的事实 → 模型的那一步由 host-environment-env.test.mjs 覆盖）─

const item = (state, patch = {}) => ({ state, value: '', reason: '', required: true, ...patch })

function view(patch = {}) {
  return {
    status: 'ready',
    proceed: true,
    userSetup: {
      workspace: item('ok'),
      credentialsConsent: item('ok'),
      h3yun: item('ok'),
      dingtalk: item('ok'),
      aliyunOss: item('ok'),
      // iFinD 自 2026-09-26 起是必需项（旧口径"恒为可选 → degraded"已被产品要求覆盖）。
      ifind: item('authenticated'),
    },
    systemHealth: {
      packageIntegrity: item('ok'),
      dshRuntime: item('ok'),
      platform: item('ok'),
      toolRegistry: item('unverified', { required: false }),
    },
    capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    issues: [],
    passed: 9,
    total: 9,
    blocked: [],
    allOk: true,
    checkError: '',
    ...patch,
  }
}

const issue = (id, patch = {}) => ({
  id, owner: 'user', blocking: true, scope: 'global', action: '做点什么', message: `${id} 不行`, ...patch,
})

test('只有 iFinD 缺失 → degraded（不是阻塞），也不拦任何能力', () => {
  const issues = [issue('ifind', { owner: 'user', blocking: false, scope: 'external-data' })]
  const status = overallStatusOf(issues, true)
  assert.equal(status, 'degraded')
  assert.equal(statusProceedable(status), true)
  const caps = capabilitiesOf(issues)
  assert.deepEqual(caps, { global: true, auditCore: true, delivery: true, externalData: true })
})

test('氚云 / 钉钉 / OSS / 工作空间缺失 = 阻塞（action-required）', () => {
  for (const id of ['h3yun', 'dingtalk', 'oss-cred', 'workspace']) {
    const status = overallStatusOf([issue(id)], true)
    assert.equal(status, 'action-required', id)
    assert.equal(statusProceedable(status), false, id)
    assert.equal(capabilitiesOf([issue(id)]).global, false, id)
    assert.equal(capabilitiesOf([issue(id)]).auditCore, false, id)
  }
})

test('包 / 运行时 / 平台故障归 system，不是员工的活', () => {
  for (const id of ['package', 'runtime', 'platform']) {
    const issues = [issue(id, { owner: 'system' })]
    assert.equal(overallStatusOf(issues, true), 'system-blocked', id)
    assert.equal(primaryUserIssue(view({ issues })), null, `${id}：系统故障不该给员工派活`)
  }
  // 混合时 system 优先：员工修完自己那几项也进不去，所以先说系统故障。
  const mixed = [issue('h3yun'), issue('package', { owner: 'system' })]
  assert.equal(overallStatusOf(mixed, true), 'system-blocked')
})

test('管理员事项 → admin-required；员工事项优先级更低', () => {
  assert.equal(overallStatusOf([issue('oss-config', { owner: 'admin' })], true), 'admin-required')
  assert.equal(overallStatusOf([issue('oss-config', { owner: 'admin' }), issue('h3yun')], true), 'admin-required')
})

test('还没检查 = unknown；自检没跑完 = check-failed（不是"某一项没配好"）', () => {
  assert.equal(overallStatusOf([], false), 'unknown')
  assert.equal(overallStatusOf([], true), 'ready')
  const failed = view({ status: 'check-failed', proceed: false, checkError: '主目录探测失败' })
  assert.equal(proceedableOf(failed), false)
  const gate = environmentGate(failed, 'global', { runCheck: '先检查', target: '报告审核' })
  assert.equal(gate.allowed, false)
  assert.match(gate.reason, /主目录探测失败/)
})

test('通过率只统计必需项：就绪时 passed === total，「8/9」那种矛盾不会出现', () => {
  const ready = view()
  const tally = requiredTallyOf({ systemHealth: ready.systemHealth, userSetup: ready.userSetup })
  assert.equal(tally.total, 9, '包 / 运行时 / 平台 / 工作空间 / 授权 / 氚云 / 钉钉 / OSS / iFinD')
  assert.equal(tally.passed, tally.total)
  assert.equal(tally.ratio, 1)

  // iFinD **在分母里**：它没过时通过率必须跟着掉（不能再出现"环境就绪 + 8/9"的自相矛盾）。
  const missingIfind = view({
    userSetup: { ...ready.userSetup, ifind: item('unconfigured', { required: true }) },
    systemHealth: { ...ready.systemHealth, toolRegistry: item('unverified', { required: false }) },
  })
  const tally2 = requiredTallyOf({ systemHealth: missingIfind.systemHealth, userSetup: missingIfind.userSetup })
  assert.equal(tally2.total, 9)
  assert.equal(tally2.passed, 8, 'iFinD 未通过 → 少一项')
  // 未验证的 Tool 注册表仍然不进分母。
  assert.equal(tally2.total, 9)
})

test('阻塞项 / 降级项分得开，且阻塞项顺序稳定', () => {
  // iFinD 现在是**阻塞**项（双 scope）；degraded 只留给将来真正的可选能力。
  const issues = [
    issue('workspace'),
    issue('ifind', { scope: 'global' }),
    issue('optional-thing', { blocking: false, scope: 'external-data' }),
    issue('h3yun'),
  ]
  assert.deepEqual(blockerMessages(view({ issues })), ['workspace 不行', 'ifind 不行', 'h3yun 不行'])
  assert.deepEqual(degradedMessages(view({ issues })), ['optional-thing 不行'])
})

// ── 门禁 ────────────────────────────────────────────────────────────────────

const LABELS = { runCheck: '进入前请先检查', target: '报告审核' }

test('environmentGate：unknown / checking 不放行（也别说成"配错了"）', () => {
  for (const status of ['unknown', 'checking']) {
    const gate = environmentGate(view({ status, proceed: false }), 'global', LABELS)
    assert.equal(gate.allowed, false, status)
    assert.equal(gate.status, status)
    assert.match(gate.reason, /请先检查|完成环境检查/)
  }
})

test('environmentGate：ready / degraded 放行；其余一律拦住并带上原因', () => {
  assert.equal(environmentGate(view(), 'global', LABELS).allowed, true)
  assert.equal(environmentGate(view({ status: 'degraded' }), 'audit', LABELS).allowed, true)
  for (const status of ['action-required', 'admin-required', 'system-blocked']) {
    const gate = environmentGate(view({ status, issues: [issue('workspace')] }), 'global', LABELS)
    assert.equal(gate.allowed, false, status)
    assert.match(gate.reason, /workspace 不行/)
  }
})

test('environmentGate：旧宿主没有 state（null）时**全部**失败关闭（含外部数据）', () => {
  // iFinD 自 2026-09-26 起是必检项，所以 external-data 也必须在拿不到结论时失败关闭
  // （旧口径「条件能力永不拦」已经作废）。
  for (const requirement of ['global', 'audit', 'delivery', 'external-data']) {
    assert.equal(environmentGate(null, requirement, LABELS).allowed, false, requirement)
  }
})

test('environmentGate：iFinD 未通过时 external-data 也拦，而且提示指名 API-Key', () => {
  const blocked = view({
    status: 'action-required', proceed: false,
    capabilities: { global: false, auditCore: false, delivery: false, externalData: false },
    issues: [issue('ifind', { owner: 'user', scope: 'global', message: 'iFinD API-Key 未通过验证：还没有填写 iFinD API-Key' })],
  })
  const verdict = environmentGate(blocked, 'external-data', LABELS)
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason, /iFinD API-Key 验证/)
  // 必需项全过时照旧放行。
  const free = environmentGate(view(), 'external-data', LABELS)
  assert.equal(free.allowed, true)
})

test('environmentGate：iFinD 未通过时 audit 的提示指名 iFinD API-Key', () => {
  const blocked = view({
    status: 'action-required', proceed: false,
    capabilities: { global: false, auditCore: false, delivery: false, externalData: false },
    issues: [issue('ifind', { owner: 'user', scope: 'global', message: 'iFinD API-Key 未通过验证：还没有填写 iFinD API-Key' })],
  })
  assert.match(environmentGate(blocked, 'audit', LABELS).reason, /进入【报告审核】前，请先完成同花顺 iFinD API-Key 验证/)
})

test('navigateModuleIn：被拦时落到 env，并带上目标页名', () => {
  const state = view({ status: 'action-required', proceed: false, issues: [issue('workspace')] })
  const label = (id) => (id === 'audit' ? '报告审核' : '报告评估')
  const blocked = navigateModuleIn(state, { target: 'audit', requires: true, requirement: 'audit' }, label)
  assert.equal(blocked.module, 'env')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.pending, 'audit')
  assert.match(blocked.reason, /进入【报告审核】前/)
  // 通过之后直接进。
  const free = navigateModuleIn(view(), { target: 'audit', requires: true, requirement: 'audit' }, label)
  assert.equal(free.module, 'audit')
  assert.equal(free.blocked, false)
})

test('navigateModuleIn：环境页永远进得去；不需要环境的页面也不判', () => {
  const broken = view({ status: 'system-blocked', proceed: false, issues: [issue('package', { owner: 'system' })] })
  assert.deepEqual(navigateModuleIn(broken, { target: 'env' }, () => '环境信息'),
    { module: 'env', blocked: false, pending: null, reason: '' })
  assert.equal(navigateModuleIn(broken, { target: 'eval', requires: false }, () => '报告评估').blocked, false)
})

test('navigateModuleIn：真正的可选能力缺失（非阻塞）仍然放行', () => {
  const degraded = view({
    status: 'degraded',
    issues: [issue('ifind', { blocking: false, scope: 'external-data' })],
  })
  const verdict = navigateModuleIn(degraded, { target: 'audit', requires: true, requirement: 'audit' }, () => '报告审核')
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.module, 'audit')
})
