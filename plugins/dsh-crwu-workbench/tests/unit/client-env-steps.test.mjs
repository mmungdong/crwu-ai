/**
 * 环境页**步骤模型**的纯逻辑测试（`features/environment/steps.ts`）。
 *
 * 这一层是「有哪几步、每步什么状态、默认停在哪一步」的**唯一**判据。两条不许退回去的交互规则
 * 都在它里面（见源文件注释），所以每条规则各有一条断言钉住：
 * 1. 步骤顺序固定，**不按状态重排**（导航位置一变，用户就要重新找）；
 * 2. 「默认停在第一项未完成」与「用户选过之后，后台刷新不得抢焦点」。
 *
 * 只 import `.ts`（无 JSX），所以**不需要** tsx-loader：Node 原生剥离类型即可。
 * `setupStepInput` / `lastVerifiedAt` 只读 `EnvResult` 的几个字段，TS 在运行时已被剥离，
 * 所以夹具用最小对象字面量（不 import 任何类型）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { grantedConsent, missingConsent } = await import(new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)
const { SETUP_STEP_IDS, setupSteps, pickStep, allStepsDone, setupStepInput, lastVerifiedAt } = await import(
  new URL('src/client/features/environment/steps.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一条配置项（`SetupItemView` 的最小形状）。 */
const item = (state, patch = {}) => ({ state, value: '', reason: '', required: true, ...patch })

/** 四项必需项全通过。`ok` 与 `authenticated` 都是完成态（两种都要覆盖到）。 */
function setupInput(patch = {}) {
  return {
    authorized: true,
    h3yun: item('ok'),
    dingtalk: item('authenticated'),
    oss: item('ok'),
    ifind: item('authenticated'),
    workspace: item('ok'),
    ...patch,
  }
}

/** 最小 `EnvResult` 假体：只给被测函数真的会读的字段。 */
function fakeEnv(patch = {}) {
  // 协议 18：授权判据是整条收据（`localAccess`），不再是 `trust.credentials` 布尔。
  return { localAccess: grantedConsent(), external: { checkedAt: '' }, state: undefined, ...patch }
}

/** 只取「步骤 id → state」的投影，断言比整棵树短。 */
const statesOf = (steps) => Object.fromEntries(steps.map((step) => [step.id, step.state]))
const stepOf = (steps, id) => steps.find((step) => step.id === id)

// ── 顺序与完成判据 ───────────────────────────────────────────────────────────

test('步骤顺序固定为 accounts → oss → ifind → workspace，不按状态重排', () => {
  assert.deepEqual([...SETUP_STEP_IDS], ['accounts', 'oss', 'ifind', 'workspace'])
  // 后面几步已完成、第一步还没做：顺序也不许变（重排会让用户每次都重新找位置）。
  const steps = setupSteps(setupInput({ authorized: false }))
  assert.deepEqual(steps.map((step) => step.id), ['accounts', 'oss', 'ifind', 'workspace'])
  // 序号是 1 起的位置号，跟顺序一起固定。
  assert.deepEqual(steps.map((step) => step.index), [1, 2, 3, 4])
})

test('完成判据只看**自己那一步的项**：ok / authenticated 才算完成；accounts 要授权 + 氚云 + 钉钉', () => {
  assert.deepEqual(statesOf(setupSteps(setupInput())),
    { accounts: 'done', oss: 'done', ifind: 'done', workspace: 'done' })

  // accounts 是「授权 + 氚云 + 钉钉」的**合取**：缺任何一个都不算完成。
  assert.equal(statesOf(setupSteps(setupInput({ authorized: false }))).accounts, 'todo')
  assert.equal(statesOf(setupSteps(setupInput({ h3yun: item('unconfigured') }))).accounts, 'todo')
  assert.equal(statesOf(setupSteps(setupInput({ dingtalk: item('unverified') }))).accounts, 'todo')
  // 只缺氚云不影响别的步骤（判据按步骤各自算，不互相牵连）。
  assert.deepEqual(statesOf(setupSteps(setupInput({ h3yun: item('unconfigured') }))),
    { accounts: 'todo', oss: 'done', ifind: 'done', workspace: 'done' })

  // 五个状态词都要判对：只有 ok / authenticated 是完成态。
  assert.equal(statesOf(setupSteps(setupInput({ oss: item('authenticated') }))).oss, 'done')
  for (const notDone of ['unconfigured', 'unverified', 'invalid', 'unreachable', 'unknown']) {
    assert.equal(statesOf(setupSteps(setupInput({ oss: item(notDone) }))).oss, 'todo', notDone)
  }
  assert.equal(statesOf(setupSteps(setupInput({ ifind: item('ok') }))).ifind, 'done')
  assert.equal(statesOf(setupSteps(setupInput({ workspace: item('ok') }))).workspace, 'done')
})

// ── 默认停在哪一步 ───────────────────────────────────────────────────────────

test('默认停在**第一项未完成**；全部完成时停在最后一步', () => {
  assert.equal(pickStep(setupSteps(setupInput()), null), 'workspace', '全完成 → 最后一步')
  assert.equal(pickStep(setupSteps(setupInput({ authorized: false })), null), 'accounts')
  assert.equal(pickStep(setupSteps(setupInput({ h3yun: item('unconfigured') })), null), 'accounts')
  // accounts 做完之后轮到 oss（不是一路"停在最后一步"）。
  assert.equal(pickStep(setupSteps(setupInput({ oss: item('unconfigured') })), null), 'oss')
  assert.equal(pickStep(setupSteps(setupInput({ ifind: item('unreachable') })), null), 'ifind')
  // 空清单是退化输入：也要给出一个具体步骤，页面拿它当"当前步骤"。
  assert.equal(pickStep([], null), 'accounts')
})

test('用户手动选过的步骤，后台刷新不许把他抢走（哪怕那一步刚变成已完成）', () => {
  // 同一条规则的两个时刻：先有别的步骤未完成，之后该步骤完成了。
  const before = setupSteps(setupInput({ authorized: false }))
  assert.equal(pickStep(before, 'workspace'), 'workspace', '别的步骤还没做完也不许把焦点抢回去')
  const after = setupSteps(setupInput())
  assert.equal(pickStep(after, 'workspace'), 'workspace', '这一步刚变成完成也不许换页')

  // 认不出的 manual（旧版本存下来的值 / 类型外输入）回退到第一项未完成，而不是卡死。
  assert.equal(pickStep(before, 'bogus'), 'accounts')
  assert.equal(pickStep(after, 'bogus'), 'workspace')
})

// ── 状态词 ──────────────────────────────────────────────────────────────────

test('当前步骤未完成时是「进行中」；完成了就是「已完成」，不走 doing 分支', () => {
  const doing = setupSteps(setupInput({ oss: item('unconfigured') }), 'oss')
  assert.equal(stepOf(doing, 'oss').state, 'doing')
  assert.equal(stepOf(doing, 'oss').stateText, zhCN.envStepDoing)
  // 没被选中的项照样按自己的完成态说话（左侧导航与右侧详情说的是同一件事）。
  assert.equal(stepOf(doing, 'accounts').stateText, zhCN.envStepDone)
  assert.equal(stepOf(doing, 'ifind').stateText, zhCN.envStepDone)

  // 同一个 active 值：那一步完成后必须是 done，不是 doing。
  const finished = setupSteps(setupInput(), 'oss')
  assert.equal(stepOf(finished, 'oss').state, 'done')
  assert.equal(stepOf(finished, 'oss').stateText, zhCN.envStepDone)

  // 未选中的未完成项是「待处理」，三项文案互不相同。
  const todo = setupSteps(setupInput({ authorized: false, oss: item('unconfigured') }), 'accounts')
  assert.equal(stepOf(todo, 'accounts').state, 'doing')
  assert.equal(stepOf(todo, 'accounts').stateText, zhCN.envStepDoing)
  assert.equal(stepOf(todo, 'oss').state, 'todo')
  assert.equal(stepOf(todo, 'oss').stateText, zhCN.envStepTodo)
  assert.equal(new Set([zhCN.envStepDone, zhCN.envStepTodo, zhCN.envStepDoing]).size, 3)
})

test('allStepsDone：全部完成才为真；空清单不算"全部完成"', () => {
  assert.equal(allStepsDone(setupSteps(setupInput())), true)
  assert.equal(allStepsDone(setupSteps(setupInput({ authorized: false }))), false)
  assert.equal(allStepsDone(setupSteps(setupInput({ ifind: item('unverified') }))), false)
  // 空清单一律为假：否则页面会对着一份空清单说"四项都已完成"。
  assert.equal(allStepsDone([]), false)
})

// ── 从 EnvResult 取输入 ──────────────────────────────────────────────────────

test('setupStepInput：授权缺省值取自 localAccess 收据；旧宿主（没有 state）给 unknown 空视图', () => {
  // 调用方没给 authorized 时，回落到 Host 回的本机访问收据（协议 18 取代了布尔值）。
  assert.equal(setupStepInput(fakeEnv(), undefined).authorized, true)
  assert.equal(setupStepInput(fakeEnv({ localAccess: missingConsent() }), undefined).authorized, false)
  // `outdated` / `revoked` 都不是授权：范围变过或员工撤销过，都要重新允许。
  assert.equal(setupStepInput(fakeEnv({ localAccess: { ...grantedConsent(), state: 'outdated' } }), undefined).authorized, false)
  assert.equal(setupStepInput(fakeEnv({ localAccess: { ...grantedConsent(), state: 'revoked' } }), undefined).authorized, false)
  // 显式给的值（包括 false）优先，不被回落覆盖。
  assert.equal(setupStepInput(fakeEnv({ localAccess: missingConsent() }), true).authorized, true)
  assert.equal(setupStepInput(fakeEnv(), false).authorized, false)

  // 旧宿主没有统一环境模型：五项都给 unknown 空视图，页面据此走"旧构建"提示而不是假装通过。
  const old = setupStepInput(fakeEnv(), true)
  for (const key of ['h3yun', 'dingtalk', 'oss', 'ifind', 'workspace']) {
    assert.equal(old[key].state, 'unknown', key)
    assert.equal(old[key].reason, '')
    assert.equal(old[key].value, '')
  }
  // state 在但 userSetup 不在（半新宿主）走同一条空视图路径。
  assert.equal(setupStepInput(fakeEnv({ state: {} }), true).ifind.state, 'unknown')
})

test('setupStepInput 从统一环境模型取四项：OSS 取的是 aliyunOss，少一项不影响其它项', () => {
  const env = fakeEnv({
    state: {
      userSetup: {
        h3yun: item('unconfigured', { reason: '未登录' }),
        dingtalk: item('ok'),
        aliyunOss: item('authenticated'),
        ifind: item('unverified'),
        workspace: item('ok', { value: '/cases/a' }),
      },
    },
  })
  const input = setupStepInput(env, true)
  assert.equal(input.h3yun.state, 'unconfigured')
  assert.equal(input.h3yun.reason, '未登录')
  assert.equal(input.dingtalk.state, 'ok')
  assert.equal(input.oss.state, 'authenticated', 'OSS 取的是 userSetup.aliyunOss')
  assert.equal(input.ifind.state, 'unverified')
  assert.equal(input.workspace.value, '/cases/a')

  // userSetup 少一项时那一项退回 unknown 空视图（不是 undefined 崩在渲染里）。
  const partial = setupStepInput(fakeEnv({ state: { userSetup: { workspace: item('ok') } } }), true)
  assert.equal(partial.h3yun.state, 'unknown')
  assert.equal(partial.workspace.state, 'ok')
})

// ── 最近真实验证时间 ────────────────────────────────────────────────────────

test('lastVerifiedAt：只认真实探测时刻；空串与解析不出来的值一律不给假时间', () => {
  assert.equal(lastVerifiedAt(fakeEnv({ external: { checkedAt: '2026-09-26T10:00:00.000Z' } })),
    '2026-09-26T10:00:00.000Z')
  // 归一成 ISO：带时区偏移的串按同一时刻回。
  assert.equal(lastVerifiedAt(fakeEnv({ external: { checkedAt: '2026-09-26T18:00:00+08:00' } })),
    '2026-09-26T10:00:00.000Z')
  assert.equal(lastVerifiedAt(fakeEnv({ external: { checkedAt: '' } })), '')
  assert.equal(lastVerifiedAt(fakeEnv({ external: { checkedAt: '不是时间' } })), '')
  // 旧宿主缺 `delivery` 时不能抛，也不能编时间。
  assert.equal(lastVerifiedAt({ external: { checkedAt: '2026-09-26T10:00:00.000Z' } }), '2026-09-26T10:00:00.000Z')
})

test('lastVerifiedAt：OSS 这次真的验过时取两者较晚的那个（缓存命中不算）', () => {
  const env = fakeEnv({
    external: { checkedAt: '2026-09-26T10:00:00.000Z' },
    delivery: { probe: { ok: true } },
  })
  // OSS 通过 + 本次自检更晚 → 取本次自检（probeOss 每次自检都真跑，没有缓存）。
  assert.equal(lastVerifiedAt(env, '2026-09-26T11:00:00.000Z'), '2026-09-26T11:00:00.000Z')
  // OSS 没通过 → 自检时刻**不算**验证时刻，只认 iFinD 那次。
  const failed = fakeEnv({ external: { checkedAt: '2026-09-26T10:00:00.000Z' }, delivery: { probe: { ok: false } } })
  assert.equal(lastVerifiedAt(failed, '2026-09-26T11:00:00.000Z'), '2026-09-26T10:00:00.000Z')
})
