/**
 * 工作台的**两级目录**：导航元数据 + 落点 store（`src/client/shell/navigation.ts` /
 * `module-store.ts`）。
 *
 * 这一份取代了原来只测"三个模块"的版本。用户口径（2026-10-13）把导航改成
 * 「一级目录 + 二级目录」之后，真正要钉住的判据变成这四条：
 *
 * 1. **元数据是唯一结构来源**：一级 / 二级目录、顺序、可用性、默认页都在 `NAVIGATION` 里，
 *    组件不写 if；
 * 2. **一次状态更新里改完一整组**：点一级目录时"一级 + 二级 + 正文"同时变
 *    （订阅者只收到一次通知 —— 中间态因此不存在）；
 * 3. **默认选中第一个可用页面**，而且**不记忆**上一次的二级页面；
 * 4. **门禁仍然只有一条规则**：所有入口走同一个 `navigate*`，被拦时记 `pendingNode`、
 *    通过后只恢复最近一次、用户改道就取消。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { createModuleStore } = await import(new URL('src/client/shell/module-store.ts', ROOT).href)
const {
  PARENT_IDS, PARENT_IDS_BY_MODULE, childNodes, defaultNodeOfModule, enabledChildIds, firstEnabledChild,
  moduleOfPage, moduleOfParent, nextTabKey, nodeById, pageIdentityOf, parentIdList, parentNodes, parentOf,
  requirementOfNode, requiresEnvironmentOf, tabIdOf,
} = await import(new URL('src/client/shell/navigation.ts', ROOT).href)
const { MODULE_META, MODULE_IDS, isModuleId, moduleLabel, requirementOf, requiresEnvironment } = await import(
  new URL('src/client/shell/modules.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

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

// ── 导航元数据 ──────────────────────────────────────────────────────────────

test('导航按模块分离：评估树只有估值，一级标签不出现审核', () => {
  // 每个一级目录都声明了它属于哪个模块 —— 过滤读的是这个字段，不是页面里的字符串。
  for (const parentId of PARENT_IDS) {
    assert.notEqual(moduleOfParent(parentId), null, parentId)
  }
  assert.deepEqual(moduleOfParent('valuation'), 'eval')
  assert.deepEqual(moduleOfParent('audit'), 'audit')
  assert.equal(moduleOfParent('valuation.real-estate'), null, '二级目录不属于这条判据')
  assert.equal(moduleOfParent('不存在'), null)
  // 报告评估：一级只有「估值」。**不许出现「审核」**。
  assert.deepEqual(parentNodes('eval').map((node) => node.label), ['估值'])
  assert.deepEqual(parentIdList('eval'), ['valuation'])
  // 报告审核：一级只有「审核」。
  assert.deepEqual(parentNodes('audit').map((node) => node.label), ['审核'])
  assert.deepEqual(parentIdList('audit'), ['audit'])
  // 环境信息不在目录树里。
  assert.deepEqual(parentNodes('env'), [])
  assert.deepEqual(PARENT_IDS_BY_MODULE.env, [])
})

test('没有已配置业务项的一级目录不画（不展示空占位入口）', () => {
  // 「其他业务」声明在评估模块里，但底下一个业务项都没有 → 不出现在目录条上。
  assert.deepEqual(childNodes('other'), [])
  assert.equal(PARENT_IDS_BY_MODULE.eval.includes('other'), true, '元数据还在（业务项配好就会自己出现）')
  assert.equal(parentNodes('eval').some((node) => node.id === 'other'), false)
  // 已经配了业务项（含「开发中」）的一级目录照样显示：那是业务目录的全貌。
  assert.equal(parentNodes('eval').some((node) => node.id === 'valuation'), true)
  // 一级目录自己没有页面（它只是业务大类）。
  for (const module of ['eval', 'audit']) {
    for (const parent of parentNodes(module)) {
      assert.equal(parent.parentId, null, parent.id)
      assert.equal(parent.page, null, parent.id)
    }
  }
})

test('二级目录：估值三项（土地 / 机器设备还没做）、审核两项', () => {
  assert.deepEqual(childNodes('valuation').map((node) => node.label), ['房地产', '土地', '机器设备'])
  assert.deepEqual(childNodes('valuation').map((node) => node.enabled), [true, false, false])
  assert.deepEqual(childNodes('audit').map((node) => node.label), ['报告审核', '本地审核'])
  assert.deepEqual(childNodes('audit').map((node) => node.enabled), [true, true])
  assert.equal(zhCN.navParentEmpty, '该业务目录暂未开放')
  // 每个二级目录都声明了它画哪一页、属于哪一个一级目录。
  for (const parentId of ['valuation', 'audit']) {
    for (const child of childNodes(parentId)) {
      assert.equal(child.parentId, parentId, child.id)
      assert.notEqual(child.page, null, child.id)
      assert.equal(parentOf(child.id).id, parentId)
    }
  }
})

test('默认页面 = 该一级目录下第一个**可用**页面；不认识的 id 返回 null', () => {
  assert.equal(firstEnabledChild('valuation').id, 'valuation.real-estate')
  assert.equal(firstEnabledChild('audit').id, 'audit.report')
  assert.equal(firstEnabledChild('other'), null)
  assert.equal(nodeById('valuation.land').enabled, false)
  assert.equal(nodeById('不存在'), null)
  assert.equal(nodeById(null), null)
  // 侧栏那张分组卡的模块入口 → 默认页面（既有习惯不变：报告审核 → 审核 / 报告审核）。
  assert.equal(defaultNodeOfModule('audit').id, 'audit.report')
  assert.equal(defaultNodeOfModule('eval').id, 'valuation.real-estate')
  assert.equal(defaultNodeOfModule('env'), null, '环境信息不在目录树里')
})

test('页面 → 模块；门禁判据从模块元数据派生（不在这张表里再抄一份）', () => {
  assert.equal(moduleOfPage('real-estate-valuation'), 'eval')
  assert.equal(moduleOfPage('report-audit'), 'audit')
  assert.equal(moduleOfPage('local-audit'), 'audit')
  assert.equal(moduleOfPage(null), null)
  for (const id of MODULE_IDS) {
    assert.equal(typeof MODULE_META[id].requiresEnvironment, 'boolean', id)
    assert.equal(typeof MODULE_META[id].requirement, 'string', id)
  }
  assert.equal(requiresEnvironment('env'), false, '环境页是修复入口，拦它就没有出路了')
  assert.equal(isModuleId('eval'), true)
  assert.equal(moduleLabel('audit'), zhCN.moduleAudit)
  // 估值页要基础环境；审核页要 audit 那一档。
  assert.equal(requiresEnvironmentOf(nodeById('valuation.real-estate')), true)
  assert.equal(requirementOfNode(nodeById('valuation.real-estate')), 'global')
  assert.equal(requirementOfNode(nodeById('audit.report')), 'audit')
  assert.equal(requirementOf('audit'), 'audit')
})

test('键盘循环：左右键在给定序列里绕圈，Home / End 直达两端，别的键不动', () => {
  assert.deepEqual(enabledChildIds('valuation'), ['valuation.real-estate'], '「开发中」的子项不参与循环')
  assert.deepEqual(enabledChildIds('audit'), ['audit.report', 'audit.local'])
  assert.deepEqual(enabledChildIds('other'), [])
  // 键盘循环在**当前模块**的目录条里走：评估树只有一项，所以左右键不动。
  const evalIds = parentIdList('eval')
  assert.deepEqual(evalIds, ['valuation'])
  assert.equal(nextTabKey('valuation', 'ArrowRight', evalIds), 'valuation')
  assert.equal(nextTabKey('valuation', 'Home', evalIds), 'valuation')
  const ids = parentIdList('audit')
  assert.deepEqual(ids, ['audit'])
  assert.equal(nextTabKey('audit', 'ArrowRight', ids), 'audit', '只剩一项时绕回自己')
  assert.equal(nextTabKey('audit', 'End', ids), 'audit')
  // 绕圈本身仍然是同一条纯规则（用一条多项目序列验证）。
  const many = ['valuation', 'audit', 'other']
  assert.equal(nextTabKey('valuation', 'ArrowRight', many), 'audit')
  assert.equal(nextTabKey('other', 'ArrowRight', many), 'valuation', '绕回第一个')
  assert.equal(nextTabKey('valuation', 'ArrowLeft', many), 'other', '反向绕圈')
  assert.equal(nextTabKey('other', 'Home', many), 'valuation')
  assert.equal(nextTabKey('valuation', 'End', many), 'other')
  assert.equal(nextTabKey('audit', 'Enter', many), 'audit', '别的键不动页签')
  assert.equal(nextTabKey('audit', 'ArrowRight', []), 'audit', '空序列不动')
})

test('页签 id 稳定且可区分两级（aria-controls / aria-labelledby 都用它）', () => {
  assert.equal(tabIdOf('audit.report'), 'crwu-workbench-tab-audit.report')
  assert.notEqual(tabIdOf('audit.report'), tabIdOf('audit.local'))
})

test('页面身份：二级目录 / 环境页各是一个身份，一级目录不算', () => {
  // 内容区外壳不重建，所以"什么算换了一页"必须是纯函数、可断定（组件那侧只剩归零这一句）。
  assert.equal(pageIdentityOf({ kind: 'node', parent: 'valuation', node: 'valuation.real-estate' }), 'node:valuation.real-estate')
  assert.notEqual(
    pageIdentityOf({ kind: 'node', parent: 'valuation', node: 'valuation.real-estate' }),
    pageIdentityOf({ kind: 'node', parent: 'valuation', node: 'valuation.land' }),
    '换二级目录 = 换身份（要把滚动位置归零）',
  )
  assert.notEqual(
    pageIdentityOf({ kind: 'node', parent: 'valuation', node: 'valuation.real-estate' }),
    pageIdentityOf({ kind: 'node', parent: 'audit', node: 'audit.report' }),
    '跨模块也是换身份',
  )
  // 环境页 / 空目录也是身份：从环境页回到业务页不能被上一页的滚动位置带走。
  assert.notEqual(
    pageIdentityOf({ kind: 'env', parent: 'valuation', node: null }),
    pageIdentityOf({ kind: 'node', parent: 'valuation', node: 'valuation.real-estate' }),
  )
  assert.notEqual(
    pageIdentityOf({ kind: 'empty', parent: 'other', node: null }),
    pageIdentityOf({ kind: 'env', parent: 'other', node: null }),
  )
  // 同一个身份重复取值必须相等（否则每次渲染都会归零，滚动位置就再也留不住）。
  const node = { kind: 'node', parent: 'audit', node: 'audit.local' }
  assert.equal(pageIdentityOf(node), pageIdentityOf({ ...node }))
})

// ── 落点 store ──────────────────────────────────────────────────────────────

test('环境通过：第一次拿到结论自动落到审核 / 报告审核（口径不变）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  const snap = store.get()
  assert.equal(snap.kind, 'node')
  assert.equal(snap.parent, 'audit')
  assert.equal(snap.node, 'audit.report')
  assert.equal(snap.active, 'audit')
  assert.equal(snap.autoEntered, true)
})

test('环境不通过：停在环境信息（不在目录树里，active=env）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  const snap = store.get()
  assert.equal(snap.kind, 'env')
  assert.equal(snap.node, null)
  assert.equal(snap.active, 'env')
  // 已经落位过：之后环境变好也不会自动跳走（没有 pendingNode）。
  store.envChanged({ state: state() })
  assert.equal(store.get().kind, 'env')
})

test('点一级目录：二级目录、正文、一级目录在**同一次通知**里一起变', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  const verdict = store.navigateParent('valuation', { state: state() })
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.node, 'valuation.real-estate')
  const snap = store.get()
  assert.equal(snap.kind, 'node')
  assert.equal(snap.parent, 'valuation')
  assert.equal(snap.node, 'valuation.real-estate')
  assert.equal(snap.active, 'eval')
  assert.equal(notifications, 1, '一次更新改完一整组 —— 不允许先改一级、再改二级')
})

test('每次切一级目录都默认选中第一个可用页面（不记忆上一次的二级页面）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  store.navigateParent('audit', { state: state() })
  store.navigateNode('audit.local', { state: state() })
  assert.equal(store.get().node, 'audit.local')
  // 切走再切回来：回到审核的**第一个可用页面**，不是刚才那个「本地审核」。
  store.navigateParent('valuation', { state: state() })
  assert.equal(store.get().node, 'valuation.real-estate')
  store.navigateParent('audit', { state: state() })
  assert.equal(store.get().node, 'audit.report', '不记忆：默认选第一个可用页面')
})

test('一级目录下一个可用页面都没有：落到 empty（正文说「该业务目录暂未开放」）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  const verdict = store.navigateParent('other', { state: state() })
  assert.equal(verdict.empty, true)
  assert.equal(verdict.blocked, false)
  const snap = store.get()
  assert.equal(snap.kind, 'empty')
  assert.equal(snap.parent, 'other')
  assert.equal(snap.node, null)
  assert.equal(snap.active, null, '空目录没有对应模块，侧栏不假装高亮某一项')
})

test('「开发中」的二级目录不可进入（enabled=false 是硬判据，不是样式）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  store.navigateParent('valuation', { state: state() })
  const before = store.get()
  const verdict = store.navigateNode('valuation.land', { state: state() })
  assert.equal(verdict.empty, false)
  assert.equal(verdict.node, null)
  assert.deepEqual(store.get(), before, '点「土地」不改变落点')
})

test('环境不通过时点二级目录：落到环境页、记 pending、带出目标页名', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  const verdict = store.navigateParent('audit', { state: state(blocking) })
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.pending, 'audit')
  assert.match(verdict.reason, /进入【报告审核】前/)
  const snap = store.get()
  assert.equal(snap.kind, 'env', '不进入目标页')
  assert.equal(snap.node, null)
  assert.equal(snap.pendingNode, 'audit.report', '记下被拦的目标**节点**')
  assert.equal(snap.blocked, true)
  assert.match(snap.gateReason, /工作空间/)
})

test('重新检查通过后只恢复最近一次被拦的目标（回到那一个二级目录）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigateNode('audit.local', { state: state(blocking) })
  assert.equal(store.get().pendingNode, 'audit.local')
  store.envChanged({ state: state() })
  const snap = store.get()
  assert.equal(snap.kind, 'node')
  assert.equal(snap.node, 'audit.local', '恢复的是刚才被拦的那一页')
  assert.equal(snap.parent, 'audit')
  assert.equal(snap.pendingNode, null)
  assert.equal(snap.blocked, false)
  assert.equal(snap.gateReason, '')
})

test('检查仍然失败：留在环境页，原因更新成最新的一条', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigateParent('audit', { state: state(blocking) })
  const stillBad = {
    ...blocking,
    issues: [{ id: 'h3yun', owner: 'user', blocking: true, scope: 'audit', action: '扫码', message: '氚云未绑定' }],
    blocked: ['氚云未绑定'],
  }
  store.envChanged({ state: state(stillBad) })
  const snap = store.get()
  assert.equal(snap.kind, 'env')
  assert.equal(snap.pendingNode, 'audit.report')
  assert.match(snap.gateReason, /氚云未绑定/)
})

test('用户中途主动改去环境信息：不自动恢复旧目标（绝不把人弹走）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state(blocking) })
  store.navigateParent('audit', { state: state(blocking) })
  assert.equal(store.get().pendingNode, 'audit.report')
  store.navigateEnv({ state: state(blocking) })
  assert.equal(store.get().pendingNode, null, '用户改道之后必须取消自动恢复')
  store.envChanged({ state: state() })
  assert.equal(store.get().kind, 'env', '不许无条件把用户弹到报告审核')
})

test('成功进入目标页之后清掉 pending（不会过一会儿又跳一次）', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  store.navigateNode('valuation.real-estate', { state: state() })
  assert.equal(store.get().pendingNode, null)
  store.envChanged({ state: state() })
  assert.equal(store.get().node, 'valuation.real-estate')
})

test('环境信息永远进得去（它就是修复入口）：不判门禁、也不留下 pending', () => {
  const broken = state({ status: 'system-blocked', proceed: false, blocked: ['插件内置组件：不可用'] })
  const store = createModuleStore()
  const verdict = store.navigateEnv({ state: broken })
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.module, 'env')
  const snap = store.get()
  assert.equal(snap.kind, 'env')
  assert.equal(snap.active, 'env')
  assert.equal(snap.blocked, false)
  assert.equal(snap.pendingNode, null)
})

test('侧栏那张分组卡的模块入口仍然可用：eval / audit / env 各去自己的默认页', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  assert.equal(store.navigate('eval', { state: state() }).node, 'valuation.real-estate')
  assert.equal(store.get().active, 'eval')
  assert.equal(store.navigate('audit', { state: state() }).node, 'audit.report')
  assert.equal(store.get().active, 'audit')
  assert.equal(store.navigate('env', { state: state() }).module, 'env')
  assert.equal(store.get().kind, 'env')
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
  assert.equal(store.get().node, 'audit.report', '基础环境已就绪 → 默认进报告审核')
  assert.equal(store.navigateParent('valuation', { state: degraded }).blocked, false)
  assert.equal(store.get().node, 'valuation.real-estate')
  // 「外部数据核查」不是独立模块：它是环境信息页里的一个区块（用户口径 2026-09-30）。
  assert.equal(MODULE_IDS.includes('external'), false, '不许再有 external 这个模块')
  assert.equal(store.navigateEnv({ state: degraded }).blocked, false)
  assert.equal(store.get().kind, 'env')
})

test('真正的可选能力缺失（非阻塞 issue）仍然是 degraded，不拦导航', () => {
  const degraded = state({
    status: 'degraded',
    issues: [{ id: 'optional-thing', owner: 'user', blocking: false, scope: 'external-data', action: '以后再说', message: '某个可选能力没配' }],
  })
  const store = createModuleStore()
  store.envChanged({ state: degraded })
  const verdict = store.navigateParent('audit', { state: degraded })
  assert.equal(verdict.blocked, false)
  assert.equal(store.get().node, 'audit.report')
})

test('旧宿主没有 state：一律不放行需要环境的页面（失败关闭）', () => {
  const store = createModuleStore()
  store.envChanged({ state: null })
  assert.equal(store.get().kind, 'env', '拿不到结论就先停在环境页')
  const verdict = store.navigateParent('audit', { state: null })
  assert.equal(verdict.blocked, true)
  assert.equal(store.get().kind, 'env')
})

test('订阅在状态不变时不通知（避免无意义重渲染）；selectEpoch 只在用户主动导航时 +1', () => {
  const store = createModuleStore()
  store.envChanged({ state: state() })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.envChanged({ state: state() })
  assert.equal(notifications, 0, '自动落位与恢复都不该重复通知')

  const before = store.get().selectEpoch
  store.envChanged({ state: state() })
  assert.equal(store.get().selectEpoch, before, '自动落位不是用户选择')
  store.navigateParent('valuation', { state: state() })
  assert.equal(store.get().selectEpoch, before + 1)
  assert.equal(notifications, 1)
  // 再点一次**当前页** = 「重新进入它」（既有口径，侧栏那张卡也靠它重置拦截态）：
  // 落点没变，但 selectEpoch 推进，面板据此清掉上一次的「自检没过」拦截屏。
  const after = store.get().selectEpoch
  store.navigateNode('valuation.real-estate', { state: state() })
  assert.equal(store.get().selectEpoch, after + 1)
  assert.equal(store.get().node, 'valuation.real-estate')
  assert.equal(notifications, 2)
})
