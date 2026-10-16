/**
 * Valuation workface UI-polish regressions (test-first stage).
 *
 * These pin the screenshot feedback that must change in production:
 *
 * 1. the duplicated large "估值" heading under the navigation tabs is gone
 *    (valuation-only `navPageHead` suppression), while the top "估值" tab stays
 *    and the audit page keeps its current shape;
 * 2. two capability areas on the same page own distinct `aria-controls` / detail
 *    region ids and each disclosure toggles only its own hidden region;
 * 3. the disclosure label is "状态详情" then "收起详情", with a leading
 *    screen-reader-hidden chevron;
 * 4. toggling the capability details never fires recheck / login;
 * 5. the unauthenticated / challenged / unknown callbacks still route to the real
 *    port, and `creating-session` keeps every capability action locked.
 *
 * Every assertion names the production change that flips it, so the red state is
 * intentional and reviewable. Static look-and-feel stays in the browser check.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

const { render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)
const { WorkbenchPanel } = await import(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT).href)
const { createModuleStore } = await import(new URL('src/client/shell/module-store.ts', ROOT).href)
const { WORKBENCH_CLASSES: C } = await import(new URL('src/client/shell/consts.ts', ROOT).href)
const { TAB_PANEL_ID } = await import(new URL('src/client/shell/navigation.ts', ROOT).href)
const { environmentStateOf } = await import(
  new URL('src/client/modules/environment/api.ts', ROOT).href)
const { createReportEvaluationController } = await import(
  new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { ValuationCapabilityArea } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationCapabilityArea.tsx', ROOT).href)
const { initialValuationState } = await import(
  new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { PERMISSION_SCHEMA_VERSION } = await import(
  new URL('src/shared/access/types.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

// ── Shared fixtures ──────────────────────────────────────────────────────────

// Any same-origin RPC is answered in memory; the panel must never reach a profile.
globalThis.fetch = async (_url, init) => {
  let op = ''
  try { op = JSON.parse(init.body).op } catch { op = '' }
  const body = op === 'pending'
    ? {
        ok: true, error: '', rows: [], formName: '', page: 1, size: 20, total: 0,
        query: '', filterMode: '', escalated: false, escalateAvailable: false,
      }
    : op === 'audit-status'
      ? { ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 } }
      : { ok: true, error: '' }
  return { ok: true, status: 200, async json() { return body } }
}

const READY_STATE = {
  status: 'ready', proceed: true,
  userSetup: {}, systemHealth: {},
  capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
  issues: [], passed: 1, total: 1, blocked: [], allOk: true, checkError: '',
}
const READY_ENV = {
  ok: true, allOk: true, blocked: [], services: [],
  state: READY_STATE,
  workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false },
  me: { name: '', org: '', userId: '' },
}
const SERVICES = { uiWorkspace: undefined, workspaces: undefined, layout: undefined, sessions: undefined }

function envStoreOf(env) {
  const snapshot = { env, busy: false, error: '', checkedAt: '' }
  return { get: () => snapshot, subscribe: () => () => {}, refresh: async () => env }
}

function buildStoreOf() {
  const snapshot = {
    ok: true, error: '', rev: 'pkg-fixture', version: '0.0.0-fixture', buildKind: 'dev', builtAt: '',
    protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION, parentSessionId: '',
  }
  return { get: () => snapshot, subscribe: () => () => {}, refresh: async () => snapshot }
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

/** Mount the actual shell on a ready fake env and land on the requested page. */
async function mountShell(page, evaluation) {
  const modules = createModuleStore()
  if (page === 'valuation') modules.navigateNode('valuation', { state: environmentStateOf(READY_ENV) })
  else modules.navigate('audit', { state: environmentStateOf(READY_ENV) })
  const props = {
    services: SERVICES,
    envStatus: envStoreOf(READY_ENV),
    build: buildStoreOf(),
    modules,
    ...(evaluation === undefined ? {} : { evaluation }),
  }
  const rendered = render(WorkbenchPanel, props)
  await flushEffects(rendered.instance)
  return { tree: rerender(WorkbenchPanel, props), instance: rendered.instance, props, modules }
}

const classesOf = (node) => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)
const hasClass = (node, className) => classesOf(node).includes(className)
const hasClassDeep = (tree, className) => findAll(tree, (node) => hasClass(node, className)).length > 0

const RELEASED = {
  ok: true, error: '', sites: [], rows: [],
  gate: { released: true, required: [], optional: [], reason: '', unavailable: false, checkedAt: '' },
  loginJobs: [],
}
const BLOCKED = {
  ok: true, error: '',
  sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有登录凭据' }],
  rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有登录凭据', required: true, stateLabel: '未登录' }],
  gate: { released: false, required: ['lianjia'], optional: [], reason: '链家 尚未登录', unavailable: false, checkedAt: '' },
  loginJobs: [],
}
const CHALLENGED = {
  ok: true, error: '',
  sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '受保护页要求人机验证', verdict: 'captcha' }],
  rows: [{
    siteId: 'lianjia', label: '链家', state: 'unknown', reason: '受保护页要求人机验证',
    verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/', required: true,
    stateLabel: '无法检查',
    challenge: {
      detected: true, attempted: true, state: 'waiting-user', reasonCode: 'challenge-visible',
      verifyUrl: 'https://bj.lianjia.com/ershoufang/',
    },
  }],
  gate: { released: false, required: ['lianjia'], optional: [], reason: '还有必需来源没有通过登录检查', unavailable: false, checkedAt: '' },
  loginJobs: [],
}
const UNKNOWN = {
  ok: true, error: '',
  sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '本次检查没有拿到结论' }],
  rows: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '本次检查没有拿到结论', required: false, stateLabel: '' }],
  gate: { released: false, required: [], optional: ['lianjia'], reason: '', unavailable: false, checkedAt: '' },
  loginJobs: [],
}

function fakePort(overrides = {}) {
  const calls = { preflight: [], login: [], verify: [], cancel: [] }
  return {
    calls,
    fileInput: async () => [],
    pickDirectory: async () => '',
    scan: async () => ({ ok: true, items: [], files: [], fileCount: 0 }),
    intake: async () => ({ ok: false, error: 'unused' }),
    start: async () => ({ ok: false, error: 'unused' }),
    openSession: async () => ({ ok: true, error: '' }),
    preflight: async (input) => { calls.preflight.push(input ?? {}); return RELEASED },
    login: async (input) => { calls.login.push(input); return { ok: true, error: '', jobId: 'login-1', reused: false, job: null } },
    verificationWindow: async (input) => { calls.verify.push(input); return { ok: true, error: '', opened: true, siteId: input.siteId } },
    slowWaitMs: 5_000, authTimeoutMs: 200, intakeTimeoutMs: 200, handoffTimeoutMs: 200,
    ...overrides,
  }
}

function controllerOf(port, initial) {
  return createReportEvaluationController(port, initial === undefined ? {} : { initial })
}

/** Props that wire the real controller methods into the harness (callback-route tests). */
function liveCapabilityProps(controller) {
  return capabilityHarness(controller.getState(), {
    onLogin: controller.login,
    onVerify: controller.openVerification,
    onRecheck: controller.recheckAuth,
  }).props
}

function capabilityHarness(state, overrides = {}) {
  const calls = { recheck: 0, login: 0, verify: 0, cancel: 0 }
  return {
    calls,
    props: {
      state,
      onRecheck: () => { calls.recheck += 1 },
      onLogin: () => { calls.login += 1 },
      onCancelLogin: () => { calls.cancel += 1 },
      onVerify: () => { calls.verify += 1 },
      ...overrides,
    },
  }
}

/** The disclosure button is the only button carrying `aria-expanded` + `aria-controls`. */
function disclosureButtons(tree) {
  return findAll(tree, (node) => node.type === 'button'
    && node.props?.['aria-expanded'] !== undefined
    && node.props?.['aria-controls'] !== undefined)
}

// ── Shell: duplicated valuation heading ──────────────────────────────────────

test('shell: valuation page no longer paints navPageHead / navPageTitle, tab stays', async () => {
  const controller = controllerOf(fakePort())
  const { tree } = await mountShell('valuation', controller)

  // Production change: suppress the metadata page head for the valuation node only.
  // Today the shell renders it from `activeNode.title` -> this assertion is red.
  assert.equal(findAll(tree, (node) => hasClass(node, C.navPageHead)).length, 0,
    'valuation must not repeat a large heading under the navigation tabs')
  assert.equal(findAll(tree, (node) => hasClass(node, C.navPageTitle)).length, 0,
    'the duplicated nav page title must be suppressed for valuation')

  // Guard: the top-level "估值" tab is the remaining page identity.
  const valuationTab = findAll(tree, (node) => node.type === 'button'
    && node.props?.role === 'tab'
    && node.props?.['aria-controls'] === TAB_PANEL_ID
    && textOf(node) === zhCN.navParentValuation)
  assert.equal(valuationTab.length, 1, 'the top "估值" tab must stay visible')
  assert.equal(hasClassDeep(tree, C.pagePaper), true, 'valuation still uses the shared work paper')
  assert.equal(findAll(tree, (node) => hasClass(node, 'crwu-valuation')).length, 1,
    'the real valuation pane must render inside the shell')
})

test('shell: audit page heading behaviour is unchanged (no navPageHead, surface still renders)', async () => {
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  try {
    const { tree } = await mountShell('audit')
    // Existing audit behaviour: identity comes from the tabs, not a repeated heading.
    assert.equal(findAll(tree, (node) => hasClass(node, C.navPageHead)).length, 0,
      'audit page keeps its current no-heading behaviour')
    assert.equal(findAll(tree, (node) => hasClass(node, C.navPageTitle)).length, 0)
    assert.equal(hasClassDeep(tree, C.surface), true, 'the audit surface still renders')
  } finally {
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
  }
})

// ── Capability details: unique ids + independent toggles ─────────────────────

const CAPABILITY_STATE = initialValuationState({
  phase: 'draft',
  login: {
    check: 'ready', gate: BLOCKED.gate, rows: BLOCKED.rows, sites: BLOCKED.sites,
    loginJobs: [], error: '', job: null,
  },
})

test('capability: two mounts get distinct ids and each disclosure toggles its own region', () => {
  const harness = capabilityHarness(CAPABILITY_STATE)
  const first = render(ValuationCapabilityArea, harness.props)
  const firstInstance = first.instance
  const second = render(ValuationCapabilityArea, harness.props)
  const secondInstance = second.instance

  const firstButton = disclosureButtons(first.tree)[0]
  const secondButton = disclosureButtons(second.tree)[0]
  assert.ok(firstButton, 'first mount must have a disclosure button')
  assert.ok(secondButton, 'second mount must have a disclosure button')

  // Production change: derive the details id per instance instead of the fixed
  // `crwu-valuation-capability-details` -> currently both ids are equal.
  assert.notEqual(firstButton.props['aria-controls'], secondButton.props['aria-controls'],
    'two capability mounts must not share one details id')
  assert.ok(find(first.tree, (node) => node.props?.id === firstButton.props['aria-controls']),
    'the first mount must own a real region for its aria-controls')
  assert.ok(find(second.tree, (node) => node.props?.id === secondButton.props['aria-controls']),
    'the second mount must own a real region for its aria-controls')

  // Collapsed by default: the hidden region is not focusable (native `hidden`).
  const firstRegionBefore = find(first.tree, (node) => node.props?.id === firstButton.props['aria-controls'])
  assert.equal(firstRegionBefore.props.hidden, true, 'details start closed (hidden, not focusable)')

  firstButton.props.onClick()
  globalThis.__crwuTestInstance = firstInstance
  const firstAfter = rerender(ValuationCapabilityArea, harness.props)
  globalThis.__crwuTestInstance = secondInstance
  const secondAfter = rerender(ValuationCapabilityArea, harness.props)

  const firstRegionAfter = find(firstAfter, (node) => node.props?.id === firstButton.props['aria-controls'])
  const secondRegionAfter = find(secondAfter, (node) => node.props?.id === secondButton.props['aria-controls'])
  assert.equal(firstRegionAfter.props.hidden, false, 'clicking the first disclosure opens only its own region')
  assert.equal(secondRegionAfter.props.hidden, true, 'the other mount stays closed')
})

test('capability: disclosure reads 状态详情 then 收起详情 with a leading aria-hidden chevron', () => {
  const harness = capabilityHarness(CAPABILITY_STATE)
  const rendered = render(ValuationCapabilityArea, harness.props)
  const button = disclosureButtons(rendered.tree)[0]

  // Production change: locale copy becomes 状态详情 / 收起详情 + a leading chevron.
  assert.equal(textOf(button).includes('状态详情'), true,
    `disclosure label must be 状态详情, got ${JSON.stringify(textOf(button))}`)
  assert.equal(textOf(button).includes('收起详情'), false)

  // The shared Button wraps children in `.crwu-ui-btn-label`; the chevron must lead
  // that content and be hidden from screen readers.
  const label = find(button, (node) => classesOf(node).includes('crwu-ui-btn-label')) ?? button
  const rawChildren = Array.isArray(label.props.children) ? label.props.children : [label.props.children]
  const leading = rawChildren.filter((child) => child !== null && child !== undefined && child !== false)[0]
  assert.ok(leading !== null && typeof leading === 'object'
    && (leading.props?.['aria-hidden'] === 'true' || leading.props?.['aria-hidden'] === true),
  'a leading aria-hidden chevron must lead the disclosure label')

  button.props.onClick()
  const expanded = rerender(ValuationCapabilityArea, harness.props)
  const expandedButton = disclosureButtons(expanded)[0]
  assert.equal(textOf(expandedButton).includes('收起详情'), true,
    'expanded disclosure label must be 收起详情')
  assert.equal(expandedButton.props['aria-expanded'], true)
})

test('capability: toggling details never fires recheck / login / verify', () => {
  const harness = capabilityHarness(CAPABILITY_STATE)
  const rendered = render(ValuationCapabilityArea, harness.props)
  const button = disclosureButtons(rendered.tree)[0]
  button.props.onClick()
  assert.deepEqual(harness.calls, { recheck: 0, login: 0, verify: 0, cancel: 0 },
    'showing details is a presentation change, not a capability action')
})

// ── Capability callbacks: real port routes stay unchanged ────────────────────

test('capability: unauthenticated row routes login to the real port', async () => {
  const port = fakePort({ preflight: async () => BLOCKED })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  const tree = render(ValuationCapabilityArea, liveCapabilityProps(controller)).tree
  const loginButton = findAll(tree, (node) => node.type === 'button'
    && node.props?.['data-valuation-capability-action'] === 'login')[0]
  assert.ok(loginButton, 'unauthenticated row must offer a login action')
  loginButton.props.onClick()
  await tick()
  assert.deepEqual(port.calls.login, [{ siteId: 'lianjia' }])
})

test('capability: challenged row routes verify to the real port and never logs in', async () => {
  const port = fakePort({ preflight: async () => CHALLENGED })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  const tree = render(ValuationCapabilityArea, liveCapabilityProps(controller)).tree
  const verifyButton = findAll(tree, (node) => node.type === 'button'
    && node.props?.['data-valuation-capability-action'] === 'verify')[0]
  assert.ok(verifyButton, 'challenged row must offer a verify action')
  verifyButton.props.onClick()
  await tick()
  assert.deepEqual(port.calls.verify, [{ siteId: 'lianjia' }])
  assert.deepEqual(port.calls.login, [], 'verification is not a login')
})

test('capability: unknown row exposes a direct recheck that routes to the real port', async () => {
  // The override replaces the recording default, so record the call explicitly.
  const port = fakePort({
    preflight: async (input) => { port.calls.preflight.push(input ?? {}); return UNKNOWN },
  })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  const tree = render(ValuationCapabilityArea, liveCapabilityProps(controller)).tree
  const button = disclosureButtons(tree)[0]
  const region = find(tree, (node) => node.props?.id === button.props['aria-controls'])
  const rechecks = findAll(tree, (node) => node.type === 'button'
    && node.props?.['data-valuation-capability-action'] === 'recheck')
  // Production change: row actions are directly visible; recheck must not hide in details.
  const direct = rechecks.find((node) => findAll(region, (item) => item === node).length === 0)
  assert.ok(direct, 'unknown row must offer a directly visible recheck')
  const before = port.calls.preflight.length
  direct.props.onClick()
  await tick()
  assert.equal(port.calls.preflight.length, before + 1)
})

test('capability: creating-session keeps every capability action locked', () => {
  const locked = initialValuationState({
    phase: 'creating-session',
    login: {
      check: 'ready', gate: BLOCKED.gate, rows: BLOCKED.rows, sites: BLOCKED.sites,
      loginJobs: [], error: '', job: null,
    },
  })
  const tree = render(ValuationCapabilityArea, capabilityHarness(locked).props).tree
  const actions = findAll(tree, (node) => node.type === 'button'
    && node.props?.['data-valuation-capability-action'] !== undefined)
  assert.ok(actions.length >= 1)
  for (const action of actions) {
    assert.equal(action.props.disabled, true,
      `creating-session must lock ${String(action.props['data-valuation-capability-action'])}`)
  }
})

// ── Shell wiring: capability actions flow through the real controller ────────

test('shell: capability login inside WorkbenchPanel reaches the real port', async () => {
  const port = fakePort({ preflight: async () => BLOCKED })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  const { tree } = await mountShell('valuation', controller)
  const loginButton = findAll(tree, (node) => node.type === 'button'
    && node.props?.['data-valuation-capability-action'] === 'login')[0]
  assert.ok(loginButton, 'the shell must surface the real login action')
  loginButton.props.onClick()
  await tick()
  assert.deepEqual(port.calls.login, [{ siteId: 'lianjia' }])
})
