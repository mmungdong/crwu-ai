/**
 * Environment page polish regressions (test-first stage).
 *
 * Pins the screenshot feedback: compact local timestamps, one combined check/verify label when the
 * instants match, a plain workspace output hint (technical cwd/subagent prose only in developer
 * diagnostics), and unchanged state / refresh semantics. Colors and responsive geometry are
 * asserted by the real browser check, not here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const { render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)
const { EnvironmentPane } = await import(
  new URL('src/client/modules/environment/ui/EnvironmentPane.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const {
  okEnvBody, degradedEnvBody, blockedEnvBody, externalOk,
} = await import(new URL('tests/helpers/environment-ui-fixture.mjs', ROOT).href)

// Diagnostics reads are memory-only; the page must never reach a real profile.
globalThis.fetch = async () => ({
  ok: true, status: 200,
  async json() { return { ok: true, error: '', entries: [], dwsDiagnosable: false } },
})

const SERVICES = {
  uiWorkspace: undefined, workspaces: undefined, layout: undefined, sidebarRight: undefined, sessions: undefined,
}

function paneProps(env, patch = {}) {
  return {
    env,
    build: {
      ok: true, error: '', rev: 'pkg-fixture', version: '0.0.0-fixture', buildKind: 'dev',
      builtAt: '', protocol: null, permissionSchemaVersion: null, parentSessionId: 'fixture-parent',
    },
    error: '', busy: false, checkedAt: '2026-10-16T09:33:01.000Z',
    onRefresh: () => {}, onRelogin: () => {}, onDwsLogin: () => {},
    services: SERVICES,
    wsBusy: false, wsMessage: '', onWsBusy: () => {}, onWsMessage: () => {},
    ...patch,
  }
}

function stepButton(tree, id) {
  return findAll(tree, (node) => node.type === 'button' && node.props?.['data-crwu-env-step'] === id)[0]
}

/** Leaf span texts of the status meta line (one per visible timestamp/label). */
function metaLeaves(tree) {
  const meta = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/)
    .includes('crwu-audit-status-meta'))
  assert.ok(meta, 'status meta line must exist')
  return findAll(meta, (node) => node.type === 'span' && textOf(node).trim() !== '')
    .map((node) => textOf(node))
}

const labelLeaves = (leaves, label) => leaves.filter((text) => text.startsWith(`${label} `))

test('status meta uses compact local YYYY-MM-DD HH:mm (no seconds / AM-PM)', () => {
  const tree = render(EnvironmentPane, paneProps(okEnvBody())).tree
  const meta = find(tree, (node) => String(node.props?.className ?? '').split(/\s+/)
    .includes('crwu-audit-status-meta'))
  const text = textOf(meta)
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'compact local YYYY-MM-DD HH:mm')
  assert.equal(/\d{2}:\d{2}:\d{2}/.test(text), false, 'seconds must not be shown')
  assert.equal(/AM|PM/.test(text), false, 'US AM/PM must not be shown')
})

test('identical check and verify instants collapse into one combined label', () => {
  const checkedAt = '2026-10-16T09:33:01.000Z'
  const env = okEnvBody({ external: externalOk({ checkedAt }) })
  const tree = render(EnvironmentPane, paneProps(env, { checkedAt })).tree
  const leaves = metaLeaves(tree)
  assert.equal(labelLeaves(leaves, zhCN.envStatusCheckedVerified).length, 1,
    'exactly one combined check/verify leaf')
  assert.equal(labelLeaves(leaves, zhCN.envStatusCheckedAt).length, 0,
    'the plain check label is merged away (prefix of the combined label must not win)')
  assert.equal(labelLeaves(leaves, zhCN.envStatusVerifiedAt).length, 0,
    'the plain verify label is merged away')
  const hook = find(tree, (node) => node.props?.['data-crwu-env-verified-at'] !== undefined)
  assert.ok(hook, 'the verified data hook is retained')
  assert.equal(hook.props['data-crwu-env-verified-at'], checkedAt, 'hook keeps the real ISO instant')
})

test('different check and verify instants both stay visible', () => {
  const checkedAt = '2026-10-16T10:00:00.000Z'
  const verifiedAt = '2026-10-16T11:00:00.000Z'
  const env = okEnvBody({ external: externalOk({ checkedAt: verifiedAt }) })
  const tree = render(EnvironmentPane, paneProps(env, { checkedAt })).tree
  const leaves = metaLeaves(tree)
  assert.equal(labelLeaves(leaves, zhCN.envStatusCheckedAt).length, 1, 'check leaf stays')
  assert.equal(labelLeaves(leaves, zhCN.envStatusVerifiedAt).length, 1, 'verify leaf stays')
  assert.equal(labelLeaves(leaves, zhCN.envStatusCheckedVerified).length, 0, 'no combined leaf')
  const hook = find(tree, (node) => node.props?.['data-crwu-env-verified-at'] !== undefined)
  assert.equal(hook.props['data-crwu-env-verified-at'], verifiedAt, 'hook keeps the later verified ISO')
})

test('workspace hint keeps the artifact path but no cwd / subagent prose', () => {
  const tree = render(EnvironmentPane, paneProps(okEnvBody())).tree
  const text = textOf(tree)
  assert.ok(text.includes('/fixture/评估工作空间/<报告流水号>/'), 'path + real separator stay')
  for (const forbidden of ['cwd', 'subagent', 'API', 'crwu 按它']) {
    assert.equal(text.includes(forbidden), false, `ordinary page must not show ${forbidden}`)
  }
})

test('developer diagnostics retains the original workspace execution note', () => {
  const props = paneProps(okEnvBody())
  const { tree } = render(EnvironmentPane, props)
  const toggle = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes('crwu-audit-details-head'))[0]
  assert.ok(toggle, 'developer diagnostics disclosure must exist')
  toggle.props.onClick()
  const opened = rerender(EnvironmentPane, props)
  const text = textOf(opened)
  assert.equal(text.includes(zhCN.envDiagWorkspaceExec), true, 'diagnostic row label')
  assert.equal(text.includes(zhCN.wsCwdNote), true, 'original technical note is preserved there')
})

test('recheck button still calls onRefresh', () => {
  let called = 0
  const tree = render(EnvironmentPane, paneProps(okEnvBody(), { onRefresh: () => { called += 1 } })).tree
  const button = findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.envActionRecheck)[0]
  assert.ok(button, 'single recheck action')
  button.props.onClick()
  assert.equal(called, 1)
})

test('a manually picked step survives a changed background refresh', () => {
  const props = paneProps(okEnvBody())
  const { tree } = render(EnvironmentPane, props)
  stepButton(tree, 'ifind').props.onClick()
  // The background env turns blocked: the default candidate changes, but the manual pick must win.
  const after = rerender(EnvironmentPane, { ...props, env: blockedEnvBody() })
  const panel = find(after, (node) => node.props?.['data-crwu-env-step-panel'] !== undefined)
  assert.equal(panel.props['data-crwu-env-step-panel'], 'ifind', 'manual choice is not stolen by refresh')
})

test('optional iFinD being unconfigured does not block the ready summary', () => {
  const tree = render(EnvironmentPane, paneProps(degradedEnvBody())).tree
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.envStatusReady), true, 'degraded (optional missing) still reads ready')
  const recheck = findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.envActionRecheck)[0]
  assert.equal(recheck.props.disabled, false)
})
