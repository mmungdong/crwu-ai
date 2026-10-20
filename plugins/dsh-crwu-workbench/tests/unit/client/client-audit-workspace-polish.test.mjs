/**
 * Audit workface UI-polish regressions (test-first stage).
 *
 * These pin the screenshot feedback that must change in production:
 *
 * 1. the audit module keeps a **single** primary navigation row: the redundant
 *    top-level "审核" parent row is gone and the existing 报告审核 / 本地审核 leaf
 *    row uses the primary underlined tab classes (`crwu-audit-tab` / `-on`);
 * 2. click and ArrowLeft/Right/Home/End keep roving `aria-selected` / `tabIndex`
 *    and the real `tabpanel` `aria-labelledby` pointing at the selected leaf id;
 * 3. the generic two-level navigation of other modules (eval) is untouched.
 *
 * The real `WorkbenchPanel` is mounted with seeded env/build/module stores and the
 * shared environment fixture; every same-origin RPC is answered in memory. Each
 * assertion names the production change that flips it, so the red state is
 * intentional. Visual inset belongs to the browser check, not to a CSS regex here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

const { render, rerender, find, findAll } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)
const { WorkbenchPanel } = await import(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT).href)
const { createModuleStore } = await import(new URL('src/client/shell/module-store.ts', ROOT).href)
const { createEnvStatusStore } = await import(
  new URL('src/client/modules/environment/model/status.ts', ROOT).href)
const { createBuildStore } = await import(new URL('src/client/shell/build-store.ts', ROOT).href)
const { environmentStateOf } = await import(
  new URL('src/client/modules/environment/api.ts', ROOT).href)
const { WORKBENCH_CLASSES: C } = await import(new URL('src/client/shell/consts.ts', ROOT).href)
const { LOCAL_AUDIT_CLASSES: L } = await import(
  new URL('src/client/modules/local-audit/consts.ts', ROOT).href)
const { TAB_PANEL_ID, tabIdOf } = await import(
  new URL('src/client/shell/navigation.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { environmentFixtureFetch, okEnvBody, environmentBoot } = await import(
  new URL('tests/helpers/environment-ui-fixture.mjs', ROOT).href)

// ── Shared fixtures ──────────────────────────────────────────────────────────

const READY_ENV = okEnvBody()
const BOOT = environmentBoot()
const SERVICES = { uiWorkspace: undefined, workspaces: undefined, layout: undefined, sidebarRight: undefined, sessions: undefined }

/** Memory-only response envelope matching the client RPC reader. */
function responseOf(body) {
  return { ok: true, status: 200, async json() { return body } }
}

let pendingCalls = []

/** Fake same-origin RPC: boot/env come from the shared environment fixture, audit ops are local. */
function installAuditFetch() {
  pendingCalls = []
  const fallback = environmentFixtureFetch(READY_ENV, BOOT)
  globalThis.fetch = async (input, init) => {
    let op = ''
    let args = {}
    try {
      const payload = JSON.parse(String(init?.body ?? '{}'))
      op = String(payload.op ?? '')
      args = payload.args ?? {}
    } catch { op = '' }
    if (op === 'pending') {
      pendingCalls.push(args)
      return responseOf({
        ok: true, error: '', rows: [], formName: '报告审核', page: 1, size: 20, total: 0,
        query: String(args.query ?? ''), filterMode: '', escalated: false, escalateAvailable: false,
      })
    }
    if (op === 'audit-status') {
      return responseOf({
        ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 },
        canStartNext: true,
      })
    }
    if (op === 'oss-index') return responseOf({ ok: true, error: '', results: {} })
    return fallback(input, init)
  }
}

async function flushEffects(instance) {
  const pending = instance.effects
  instance.effects = []
  for (const effect of pending) {
    const result = effect.callback()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') await result
  }
  await tick()
}

/**
 * Mount the real shell on a ready fake env with real stores.
 *
 * Real timers are replaced while effects run so the 10s audit poll never keeps the
 * test process alive; the panel needs no timer to render the navigation row.
 */
async function mountShell(page = 'audit') {
  installAuditFetch()
  const envStatus = createEnvStatusStore()
  await envStatus.refresh()
  const build = createBuildStore()
  await build.refresh()
  const modules = createModuleStore()
  const state = environmentStateOf(envStatus.get().env)
  if (page === 'eval') modules.navigateNode('valuation', { state })
  else modules.navigate('audit', { state })
  const props = { services: SERVICES, envStatus, build, modules }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  try {
    const rendered = render(WorkbenchPanel, props)
    await flushEffects(rendered.instance)
    return {
      tree: rerender(WorkbenchPanel, props),
      instance: rendered.instance,
      modules,
      rerenderPanel: () => rerender(WorkbenchPanel, props),
    }
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

const classesOf = (node) => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)
const hasClass = (node, className) => classesOf(node).includes(className)

function labelOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(labelOf).join('')
  return labelOf(node.props?.children)
}

/** Navigation tabs are the only `role=tab` buttons that control the shared tabpanel. */
const NAV_TAB = (node) => node.type === 'button'
  && node.props?.role === 'tab'
  && node.props?.['aria-controls'] === TAB_PANEL_ID
const navTabs = (tree) => findAll(tree, NAV_TAB)
const navTablists = (tree) => findAll(tree, (node) => node.props?.role === 'tablist')
const selectedTab = (tree) => navTabs(tree).find((tab) => tab.props['aria-selected'] === true) ?? null
const tabByLabel = (tree, label) => navTabs(tree).find((tab) => labelOf(tab) === label) ?? null

// ── Audit navigation flattening ──────────────────────────────────────────────

test('audit shell: one primary underlined report/local row and no redundant 审核 row', async () => {
  const { tree } = await mountShell('audit')

  // Production change: when the module is audit, the single parent directory is not
  // painted and the two leaf pages become the primary tab row.
  const tablists = navTablists(tree)
  assert.equal(tablists.length, 1,
    '审核模块只应保留一条导航页签行（冗余的一级「审核」行必须去掉）')
  assert.equal(tablists[0].props['aria-label'], zhCN.navParentsLabel,
    '扁平后的主行沿用一级目录的可访问名')

  const tabs = navTabs(tree)
  assert.deepEqual(tabs.map(labelOf), [zhCN.navChildReportAudit, zhCN.navChildLocalAudit],
    '导航行只剩 报告审核 / 本地审核 两项')
  assert.equal(tabs.some((tab) => labelOf(tab) === zhCN.navParentAudit), false,
    '不再渲染一级「审核」页签')

  // Production change: the old secondary pill row disappears.
  assert.equal(findAll(tree, (node) => hasClass(node, C.navChildren)).length, 0,
    '不再渲染二级胶囊行')

  for (const tab of tabs) {
    assert.equal(hasClass(tab, L.tab), true,
      `页签「${labelOf(tab)}」必须使用现有主行类 ${L.tab}`)
    assert.equal(hasClass(tab, C.navChild), false, '不再使用二级胶囊类')
  }

  const selected = tabs.filter((tab) => tab.props['aria-selected'] === true)
  assert.equal(selected.length, 1, '恰好一个页签被选中')
  assert.equal(labelOf(selected[0]), zhCN.navChildReportAudit, '审核模块默认落在报告审核')
  assert.equal(hasClass(selected[0], L.tabOn), true, '选中项使用现有主行选中类')
  assert.equal(hasClass(selected[0], C.navChildOn), false, '选中项不再是胶囊选中样式')

  for (const tab of tabs) {
    assert.equal(tab.props['aria-controls'], TAB_PANEL_ID)
    assert.equal(tab.props.tabIndex, tab.props['aria-selected'] === true ? 0 : -1,
      'roving tabIndex 只留给选中项')
  }

  const panel = find(tree, (node) => node.props?.id === TAB_PANEL_ID)
  assert.ok(panel, '内容区 tabpanel 必须存在')
  assert.equal(panel.props['aria-labelledby'], tabIdOf('audit.report'),
    'tabpanel 的 aria-labelledby 指向真实选中的页签 id')
})

test('eval shell: business overview replaces the valuation tab', async () => {
  const { tree } = await mountShell('eval')
  assert.equal(navTablists(tree).length, 0)
  assert.equal(navTabs(tree).length, 0)
  assert.ok(find(tree, (node) => node.props?.['data-business-step'] === 'valuation'))
  assert.equal(findAll(tree, (node) => hasClass(node, C.navChildren)).length, 0)
})

test('audit shell: report/local click and Arrow/Home/End rove through the real handlers', async () => {
  const mounted = await mountShell('audit')
  let tree = mounted.tree
  const rerenderPanel = mounted.rerenderPanel

  // The roving row must be the single flattened primary row before its keyboard
  // contract can be judged; this fails on the current two-row markup.
  assert.equal(navTablists(tree).length, 1, '单一主行才能做扁平后的键盘漫游')

  const clickTab = (label) => {
    const tab = tabByLabel(tree, label)
    assert.ok(tab, `找不到页签 ${label}`)
    tab.props.onClick()
    tree = rerenderPanel()
  }

  clickTab(zhCN.navChildLocalAudit)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildLocalAudit, '点击本地审核后它被选中')
  assert.equal(
    find(tree, (node) => node.props?.id === TAB_PANEL_ID).props['aria-labelledby'],
    tabIdOf('audit.local'), '切到本地审核后 tabpanel 指向本地审核页签 id')

  clickTab(zhCN.navChildReportAudit)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildReportAudit, '点击报告审核后它被选中')
  assert.equal(
    find(tree, (node) => node.props?.id === TAB_PANEL_ID).props['aria-labelledby'],
    tabIdOf('audit.report'))

  const press = (key) => {
    const tab = selectedTab(tree)
    assert.ok(tab, '必须有选中的页签来接收键盘事件')
    let prevented = false
    tab.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
    tree = rerenderPanel()
    return prevented
  }

  assert.equal(press('ArrowRight'), true, 'ArrowRight 由真实处理器接管')
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildLocalAudit)
  assert.equal(press('ArrowLeft'), true)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildReportAudit)
  assert.equal(press('ArrowRight'), true)
  assert.equal(press('ArrowRight'), true)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildReportAudit, '在主行内循环')
  assert.equal(press('End'), true)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildLocalAudit)
  assert.equal(press('Home'), true)
  assert.equal(labelOf(selectedTab(tree)), zhCN.navChildReportAudit)

  for (const tab of navTabs(tree)) {
    assert.equal(tab.props.tabIndex, tab.props['aria-selected'] === true ? 0 : -1,
      'roving tabIndex 跟着选中项走')
  }
})
