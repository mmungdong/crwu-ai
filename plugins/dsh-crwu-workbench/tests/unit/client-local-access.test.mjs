/**
 * 本机访问授权的**客户端纯逻辑与授权卡**测试（协议 18 · 子项目 A3）。
 *
 * 界面这一侧只有两件事要守：
 * 1. 判据**只能来自 Host** 的收据（`env.localAccess`）—— 不许从"有没有凭据 / 是不是登录过"
 *    倒推授权状态，那正是"未授权时报未登录"的来源；
 * 2. **逐条列出**这次允许覆盖的固定功能，按钮说的是动作（允许并继续 / 暂不允许），
 *    已允许时必须给撤销入口（同意必须可撤销）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { fakeReact, registerTsxLoader } from '../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)

const { grantedConsent, missingConsent } = await import(new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)
const { LOCAL_ACCESS_CAPABILITIES, PERMISSION_SCHEMA_VERSION } =
  await import(new URL('src/shared/access/types.ts', ROOT).href)
const {
  consentGranted, consentNeedsDecision, consentOf, consentRequestCapabilities,
  permissionSchemaMismatch, MISSING_LOCAL_ACCESS,
} = await import(new URL('src/client/features/environment/local-access.ts', ROOT).href)
const { LocalAccessConsentCard, capabilityLabel, consentChipText } =
  await import(new URL('src/client/features/environment/LocalAccessConsentCard.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

const React = fakeReact

/** 展开函数组件（与 client-package.test.mjs 同一套注入式渲染器口径）。 */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
    try {
      return resolve(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

function render(component, props = {}) {
  globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
  return resolve(component(props))
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function findButtonLike(node, label) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonLike(child, label)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'button' && textOf(node) === label) return node
  return findButtonLike(node.props?.children, label)
}

/** 渲染授权卡并返回元素树 + 文本。 */
function cardTree(consent, patch = {}) {
  const tree = render(LocalAccessConsentCard, {
    consent, busy: false, error: '', declined: false,
    onGrant: () => {}, onDecline: () => {}, onRevoke: () => {}, ...patch,
  })
  return { tree, text: textOf(tree) }
}

// ── 纯逻辑：唯一判据是 Host 的收据 ────────────────────────────────────────────

test('consentOf：环境没回来 / 旧宿主没有 localAccess 一律按 missing（fail closed）', () => {
  for (const env of [null, undefined, {}, { localAccess: null }]) {
    assert.equal(consentOf(env).state, 'missing')
    assert.equal(consentGranted(env), false)
  }
  assert.equal(consentOf({ localAccess: grantedConsent() }).state, 'granted')
  assert.equal(consentGranted({ localAccess: grantedConsent() }), true)
  assert.equal(MISSING_LOCAL_ACCESS.schemaVersion, 0)
})

test('只有 granted 放行；outdated / revoked / persist-failed 都不放行', () => {
  const granted = grantedConsent()
  for (const state of ['missing', 'outdated', 'revoked', 'persist-failed']) {
    const view = { ...granted, state }
    assert.equal(consentGranted({ localAccess: view }), false, state)
  }
  assert.equal(consentGranted({ localAccess: granted }), true)
})

test('consentNeedsDecision：只有 missing 与 outdated 自动把员工带到授权卡上', () => {
  // `revoked` 是员工**主动撤销**过：再自动弹一次就是不听他的；
  // `persist-failed` 说明他刚点过撤销，界面该显示"撤销没能写盘"。
  assert.equal(consentNeedsDecision(missingConsent()), true)
  assert.equal(consentNeedsDecision({ ...missingConsent(), state: 'outdated' }), true)
  assert.equal(consentNeedsDecision({ ...missingConsent(), state: 'revoked' }), false)
  assert.equal(consentNeedsDecision({ ...missingConsent(), state: 'persist-failed' }), false)
  assert.equal(consentNeedsDecision(grantedConsent()), false)
})

test('A-06：权限说明版本不一致（含旧宿主读不到这个字段）一律判为不一致', () => {
  assert.equal(permissionSchemaMismatch(PERMISSION_SCHEMA_VERSION), false)
  assert.equal(permissionSchemaMismatch(undefined), true, '旧宿主没给字段 = 执行的是旧范围')
  assert.equal(permissionSchemaMismatch(null), true)
  assert.equal(permissionSchemaMismatch(PERMISSION_SCHEMA_VERSION + 1), true)
  assert.equal(permissionSchemaMismatch('1'), true)
})

test('提交的能力清单逐字来自共享常量（界面显示什么就提交什么）', () => {
  assert.deepEqual(consentRequestCapabilities(), [...LOCAL_ACCESS_CAPABILITIES])
  // 每次都要新的数组：调用方改它不许影响下一次提交。
  consentRequestCapabilities().push('evil')
  assert.deepEqual(consentRequestCapabilities(), [...LOCAL_ACCESS_CAPABILITIES])
})

// ── 授权卡 ──────────────────────────────────────────────────────────────────

test('未允许：逐条列出五项固定功能，并说明边界（不给 Agent 凭据、不给任意命令）', () => {
  const { text } = cardTree(missingConsent())
  assert.equal(text.includes(zhCN.envConsentTitle), true)
  assert.equal(text.includes(zhCN.envConsentIntro), true)
  // 五项逐条可读，且每一项的文案互不相同（漏映射会退化成同一句）。
  const labels = LOCAL_ACCESS_CAPABILITIES.map((capability) => capabilityLabel(capability))
  assert.equal(new Set(labels).size, LOCAL_ACCESS_CAPABILITIES.length, '五项能力必须各有各的文案')
  for (const label of labels) {
    assert.equal(label.length > 0, true)
    assert.equal(text.includes(label), true, label)
  }
  assert.equal(text.includes(zhCN.envConsentBoundary), true)
  // 按钮说的是动作，不是「确定 / 取消」。
  assert.ok(findButtonLike(render(LocalAccessConsentCard, {
    consent: missingConsent(), busy: false, error: '', declined: false,
    onGrant: () => {}, onDecline: () => {}, onRevoke: () => {},
  }), zhCN.envConsentAgree))
  assert.equal(text.includes(zhCN.envConsentDecline), true)
})

test('已允许：显示允许时间 + 撤销入口，且不再列出范围（已经同意过）', () => {
  const { text } = cardTree(grantedConsent())
  assert.equal(text.includes(zhCN.envConsentDone), true)
  assert.equal(text.includes(grantedConsent().grantedAt), true)
  assert.equal(text.includes(zhCN.envConsentRevoke), true, '同意必须可撤销')
  assert.equal(text.includes(zhCN.envConsentAgree), false)
  assert.equal(text.includes(zhCN.envConsentScopeTitle), false)
})

test('「暂不允许」之后：按钮换成「重新允许一次」，并如实说明功能保持禁用', () => {
  const { text } = cardTree(missingConsent(), { declined: true })
  assert.equal(text.includes(zhCN.envConsentDeclined), true)
  assert.ok(findButtonLike(render(LocalAccessConsentCard, {
    consent: missingConsent(), busy: false, error: '', declined: true,
    onGrant: () => {}, onDecline: () => {}, onRevoke: () => {},
  }), zhCN.envConsentRegrant), '拒绝之后再点应当是「重新允许一次」')
})

test('撤销态：说清访问已关闭，并给「重新允许一次」', () => {
  const { text } = cardTree({ ...missingConsent(), state: 'revoked' })
  assert.equal(text.includes(zhCN.envConsentRevoked), true)
  assert.ok(findButtonLike(render(LocalAccessConsentCard, {
    consent: { ...missingConsent(), state: 'revoked' }, busy: false, error: '', declined: false,
    onGrant: () => {}, onDecline: () => {}, onRevoke: () => {},
  }), zhCN.envConsentAgree))
})

test('撤销失败（persist-failed）：如实报告，且**不**显示成已允许', () => {
  const { text } = cardTree({ ...missingConsent(), state: 'persist-failed' })
  assert.equal(text.includes(zhCN.envConsentPersistFailed), true)
  assert.equal(consentChipText({ ...missingConsent(), state: 'persist-failed' }) !== zhCN.envItemOk, true)
})

test('A-06 界面侧：权限说明版本不一致时整张卡禁用并给出重启指引', () => {
  const grantedOnClick = []
  const { text } = cardTree(grantedConsent(), {
    schemaMismatch: true,
    onRevoke: () => { grantedOnClick.push('revoke') },
  })
  assert.equal(text.includes(zhCN.envConsentSchemaMismatch), true, '要说清是版本不一致、要完全重启')
  // 已允许时按钮是「撤销授权」；不一致时它必须禁用（不能让旧宿主继续按旧范围干活）。
  const button = findButtonLike(render(LocalAccessConsentCard, {
    consent: grantedConsent(), busy: false, error: '', declined: false, schemaMismatch: true,
    onGrant: () => {}, onDecline: () => {}, onRevoke: () => {},
  }), zhCN.envConsentRevoke)
  assert.ok(button)
  assert.equal(button.props.disabled, true)
  assert.deepEqual(grantedOnClick, [])
})

test('Host 回的失败原因原样展示（写盘失败不许被吞掉）', () => {
  const { text } = cardTree(missingConsent(), { error: zhCN.envConsentPersistFailedGrant })
  assert.equal(text.includes(zhCN.envConsentPersistFailedGrant), true)
})
