/**
 * 模块 store 的**统一导航门禁**测试（`features/workbench/module-store.ts`）。
 *
 * 这一份取代了原来的 `client-module-store.test.mjs` 里"选择模块"那几条：门禁从
 * `WorkbenchPanel` 的 audit 特判上提到导航层之后，真正的行为判据是「所有入口都走同一个
 * `navigate()`，且被拦时记 pending、通过后只恢复最近一次、用户改道就取消」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { createModuleStore } = await import(new URL('src/client/features/workbench/module-store.ts', ROOT).href)
const { MODULE_META, MODULE_IDS, requiresEnvironment, requirementOf } = await import(
  new URL('src/client/features/workbench/modules.ts', ROOT).href)

const item = (state, patch = {}) => ({ state, value: '', reason: '', required: true, ...patch })
function state(patch = {}) {
  return {
    status: 'ready',
    proceed: true,
    userSetup: {
      workspace: item('ok'), credentialsConsent: item('ok'), h3yun: item('ok'), dingtalk: item('ok'),
      aliyunOss: item('ok'), ifind: item('unconfigured', { required: false }),
    },
    systemHealth: {
      packageIntegrity: item('ok'), dshRuntime: item('ok'), platform: item('ok'),
      toolRegistry: item('unverified', { required: false }),
    },
    capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    issues: [],
    passed: 8, total: 8, blocked: [], allOk: true, checkError: '',
    ...patch,
  }
}
const blocking = {
  status: 'action-required', proceed: false,
  issues: [{ id: 'workspace', owner: 'user', blocking: true, scope: 'global', action: '选择目录', message: '未找到工作空间' }],
  blocked: ['未找到工作空间'],
  allOk: false,
}

// ── 模块元数据 ──────────────────────────────────────────────────────────────

test('模块元数据里声明了"是否需要环境"：环境页自己永远不需要', () => {
  for (const id of MODULE_IDS) {
    assert.equal(typeof MODULE_META[id].requiresEnvironment, 'boolean', id)
    assert.ok(typeof MODULE_META[id].requirement === 'string', id)
  }
  assert.equal(requiresEnvironment('env'), false, '环境页是修复入口，拦它就没有出路了')
  assert.equal(requiresEnvironment('audit'), true)
  assert.equal(requiresEnvironment('eval'), true)
  assert.equal(requirementOf('audit'), 'audit')
  assert.equal(requirementOf('eval'), 'global')
})

// ── 导航 ────────────────────────────────────────────────────────────────────

test('环境不通过时点报告审核：落到环境页、记 pending、带出目标页名', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  store.envChanged({ state: state(blocking) })
  const verdict = store.navigate('audit', { state: state(blocking) })
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.pending, 'audit')
  assert.match(verdict.reason, /进入【报告审核】前/)
  const snap = store.get()
  assert.equal(snap.active, 'env', '不进入目标页')
  assert.equal(snap.pendingTarget, 'audit', '记下被拦的目标')
  assert.equal(snap.blocked, true)
  assert.match(snap.gateReason, /工作空间/)
})

test('重新检查通过后只恢复最近一次被拦的目标', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigate('audit', { state: state(blocking) })
  assert.equal(store.get().pendingTarget, 'audit')
  // 成员检查：环境事实变好了。
  store.envChanged({ state: state() })
  const snap = store.get()
  assert.equal(snap.active, 'audit', '检查通过后自动继续到刚才被拦的那一页')
  assert.equal(snap.pendingTarget, null)
  assert.equal(snap.blocked, false)
  assert.equal(snap.gateReason, '')
})

test('检查仍然失败：留在环境页，原因更新成最新的一条', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigate('audit', { state: state(blocking) })
  const stillBad = {
    ...blocking,
    issues: [{ id: 'h3yun', owner: 'user', blocking: true, scope: 'audit', action: '扫码', message: '氚云未绑定' }],
    blocked: ['氚云未绑定'],
  }
  store.envChanged({ state: state(stillBad) })
  const snap = store.get()
  assert.equal(snap.active, 'env')
  assert.equal(snap.pendingTarget, 'audit')
  assert.match(snap.gateReason, /氚云未绑定/)
})

test('用户中途主动改去别处：不自动恢复旧目标（绝不把人弹走）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigate('audit', { state: state(blocking) })
  assert.equal(store.get().pendingTarget, 'audit')
  // 用户自己点了「环境信息」（或任何别的页）—— 这就是"我不想去报告审核了"。
  store.navigate('env', { state: state(blocking) })
  assert.equal(store.get().pendingTarget, null, '用户改道之后必须取消自动恢复')
  // 环境变好也不该把他弹走。
  store.envChanged({ state: state() })
  assert.notEqual(store.get().active, 'audit', '不许无条件把用户弹到报告审核')
  assert.equal(store.get().active, 'env')
})

test('成功进入目标页之后清掉 pending（不会过一会儿又跳一次）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  store.navigate('audit', { state: state() })
  assert.equal(store.get().pendingTarget, null)
  store.envChanged({ state: state() })
  assert.equal(store.get().active, 'audit')
})

test('外部数据源（iFinD）未就绪**不拦**任何导航：基础环境已就绪就进报告审核', () => {
  // 2026-09-30 口径（覆盖 2026-09-26 的「必检项」）：iFinD 是**可选数据源**。
  // 它未配置只让 status 落到 degraded + externalData=false，**不阻塞**基础环境与报告审核。
  const degraded = state({
    status: 'degraded', proceed: true,
    capabilities: { global: true, auditCore: true, delivery: true, externalData: false },
    issues: [
      {
        id: 'ifind', owner: 'user', blocking: false, scope: 'external-data',
        action: '配置外部数据源（同花顺 iFinD API-Key）',
        message: '外部数据核查未就绪（同花顺 iFinD）：还没有配置外部数据源。不影响进入报告审核，涉及外部数据的项目会标记为「未检查」。',
      },
    ],
  })
  const store = createModuleStore()
  store.envChanged({ state: degraded })
  assert.equal(store.get().active, 'audit', '基础环境已就绪 → 默认进报告审核')
  const verdict = store.navigate('audit', { state: degraded })
  assert.equal(verdict.blocked, false, '可选数据源未就绪不拦报告审核')
  assert.equal(store.get().active, 'audit')
  // 「外部数据核查」不是独立模块：它是环境信息页里的一个区块（用户口径 2026-09-30），
  // 所以「去看 / 去配」就是进环境页 —— 而环境页永远进得去。
  assert.equal(MODULE_IDS.includes('external'), false, '不许再有 external 这个模块')
  assert.equal(store.navigate('env', { state: degraded }).blocked, false)
  assert.equal(store.get().active, 'env')
})

test('真正的可选能力缺失（非阻塞 issue）仍然是 degraded，不拦导航', () => {
  const degraded = state({
    status: 'degraded',
    issues: [{ id: 'optional-thing', owner: 'user', blocking: false, scope: 'external-data', action: '以后再说', message: '某个可选能力没配' }],
  })
  const store = createModuleStore()
  store.envChanged({ state: degraded })
  const verdict = store.navigate('audit', { state: degraded })
  assert.equal(verdict.blocked, false)
  assert.equal(store.get().active, 'audit')
})

test('环境页始终可进（它就是修复入口）', () => {
  const broken = state({ status: 'system-blocked', proceed: false, blocked: ['插件内置组件：不可用'] })
  const store = createModuleStore('audit')
  const verdict = store.navigate('env', { state: broken })
  assert.equal(verdict.blocked, false)
  assert.equal(store.get().active, 'env')
  assert.equal(store.get().blocked, false)
})

test('第一次拿到结论：通过 → 报告审核；不通过 → 环境页（只自动落位一次）', () => {
  const ok = createModuleStore()
  ok.envChanged({ state: state() })
  assert.equal(ok.get().active, 'audit')

  const bad = createModuleStore()
  bad.envChanged({ state: state(blocking) })
  assert.equal(bad.get().active, 'env')
  // 已经落位过：之后环境变好也不会自动跳走（没有 pendingTarget）。
  bad.envChanged({ state: state() })
  assert.equal(bad.get().active, 'env')
})

test('旧宿主没有 state：一律不放行需要环境的页面（失败关闭）', () => {
  const store = createModuleStore()
  store.envChanged({ state: null })
  assert.equal(store.get().active, 'env', '拿不到结论就先停在环境页')
  const verdict = store.navigate('audit', { state: null })
  assert.equal(verdict.blocked, true)
  assert.equal(store.get().active, 'env')
})

test('订阅在状态不变时不通知（避免无意义重渲染）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.envChanged({ state: state() })
  assert.equal(notifications, 0)
  store.navigate('env', { state: state() })
  assert.equal(notifications, 1)
})

test('selectEpoch 只在用户主动导航时 +1（自动落位不加）', () => {
  const store = createModuleStore()
  const before = store.get().selectEpoch
  store.envChanged({ state: state() })
  assert.equal(store.get().selectEpoch, before, '自动落位不是用户选择')
  store.navigate('audit', { state: state() })
  assert.equal(store.get().selectEpoch, before + 1)
})
