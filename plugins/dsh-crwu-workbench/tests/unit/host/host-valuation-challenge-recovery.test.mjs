/**
 * 挑战恢复协调器（设计稿 §8.4，计划 Task 3）。
 *
 * 这里钉的是"预算与冷却由**程序**管理"这条要求，以及三条错了会静默放行的边界：
 *
 * 1. 同一取数任务的自动尝试**最多 2 次**，总窗口 120 秒 —— 调用方放宽不了；
 * 2. 冷却在**队列之外**等待（不占 profile），且冷却期间新取数请求要看到 `cooldownUntil`；
 * 3. 显式继续（员工完成验证后）只接受**登记过**的取数任务与原 URL，不能凭空导航到别的页面；
 * 4. 恢复未通过时保留 `waiting-user` 断点并给出 `nextEligibleAt`，不重试到把站点打爆。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  createChallengeRecoveryCoordinator,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_WINDOW_MS,
} = await import(new URL('src/host/domains/report-evaluation/browser/challenge-recovery.ts', ROOT).href)
const { createProfileQueue } = await import(
  new URL('src/host/domains/report-evaluation/browser/profile-queue.ts', ROOT).href)

const TASK = 'task-2026-10-14-001'
const URL_A = 'https://bj.lianjia.com/ershoufang/101139646125.html'

/** 假的 BrowserClient：按脚本依次返回恢复结论，并记录每次调用。 */
function makeClient(outcomes) {
  const calls = []
  return {
    calls,
    async recover(request) {
      calls.push({ ...request })
      const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0]
      return {
        recoveryId: request.recoveryId,
        retrievalTaskId: request.retrievalTaskId,
        providerId: request.providerId,
        strategyId: 'auto',
        strategyVersion: '1',
        attempts: next.attempts ?? 1,
        beforeKind: 'geetest-v3-canvas',
        afterKind: next.state === 'recovered' ? 'none' : 'geetest-v3-canvas',
        state: next.state,
        reasonCode: next.reasonCode ?? '',
        nextEligibleAt: '',
        strategies: ['geetest-v3-canvas'],
        notes: [],
        pageValidation: {
          finalUrl: request.url, title: '', hostMatches: true, readable: true,
          challengeVisible: next.state !== 'recovered', loginWall: false, blocked: false,
          overlaySelectors: ['.geetest_panel'], reason: '',
        },
      }
    },
    async status() { return { ok: true, error: '', sites: [], unavailable: false } },
    async login() { return { ok: true, error: '', sites: [], aborted: false } },
    async fetch() { throw new Error('unused') },
    async shot() { throw new Error('unused') },
    sites() { return '/pkg/sites.json' },
  }
}

test('一次调用内部最多做 2 次自动尝试，并在两次之间于队列之外冷却', async () => {
  let clock = 1_000
  const slept = []
  const client = makeClient([
    { state: 'waiting-user', attempts: 1, reasonCode: 'visible-challenge' },
    { state: 'recovered', attempts: 1, reasonCode: 'no-visible-challenge' },
  ])
  const coordinator = createChallengeRecoveryCoordinator({
    client,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
    cooldownMs: 1_000,
  })

  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: TASK, url: URL_A })
  assert.equal(outcome.state, 'recovered')
  assert.equal(client.calls.length, 2)
  assert.deepEqual(slept, [1_000])
  // 第二次调用拿到的预算必须已经扣掉第一次用掉的那一次。
  assert.equal(client.calls[1].attempts, 1)
  // 窗口是"剩余窗口"，不是重新开始的 120 秒。
  assert.equal(client.calls[1].windowMs <= RECOVERY_WINDOW_MS, true)
  // 冷却由协调器传 0 给 CLI：命令行进程里不许睡。
  assert.equal(client.calls[0].cooldownMs, 0)
  assert.equal(coordinator.cooldownUntilOf('lianjia'), 0, '恢复成功后不该留冷却')
})

test('预算用尽后返回 waiting-user 与 nextEligibleAt，不再调用 CLI', async () => {
  let clock = 5_000
  const client = makeClient([{ state: 'waiting-user', attempts: 2, reasonCode: 'visible-challenge' }])
  const coordinator = createChallengeRecoveryCoordinator({
    client, now: () => clock, sleep: async () => {}, cooldownMs: 2_000,
  })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: TASK, url: URL_A })
  assert.equal(outcome.state, 'waiting-user')
  assert.equal(client.calls.length, 1)
  const budget = coordinator.budgetOf(TASK)
  assert.equal(budget.attempts, RECOVERY_MAX_ATTEMPTS)
  assert.equal(budget.remainingAttempts, 0)
  assert.equal(coordinator.cooldownUntilOf('lianjia') > clock, true)

  clock += 10
  const again = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: TASK, url: URL_A })
  assert.equal(again.state, 'waiting-user')
  assert.equal(again.reasonCode, 'budget-exhausted')
  assert.notEqual(again.nextEligibleAt, '')
  assert.equal(client.calls.length, 1, '预算用尽后不该再起一次浏览器')
})

test('窗口用尽即停止自动尝试，并记录下次可尝试时间', async () => {
  let clock = 0
  const client = makeClient([{ state: 'waiting-user', attempts: 1, reasonCode: 'visible-challenge' }])
  const coordinator = createChallengeRecoveryCoordinator({
    client,
    now: () => clock,
    // 冷却被夹到剩余窗口之内：醒来时窗口已经用完，预算却还剩一次。
    sleep: async (ms) => { clock += ms },
    cooldownMs: RECOVERY_WINDOW_MS,
  })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-b', url: URL_A })
  assert.equal(outcome.state, 'waiting-user')
  assert.equal(outcome.reasonCode, 'window-exhausted')
  assert.notEqual(outcome.nextEligibleAt, '')
  assert.equal(coordinator.budgetOf('task-b').remainingAttempts, 1, '窗口用尽时预算可能还有剩')
  assert.equal(client.calls.length, 1)
})

test('不认识的挑战形态直接返回 unsupported，不反复重试', async () => {
  const client = makeClient([{ state: 'unsupported', attempts: 1, reasonCode: 'challenge-family-unsupported' }])
  const coordinator = createChallengeRecoveryCoordinator({
    client, now: () => 0, sleep: async () => {}, cooldownMs: 1_000,
  })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-c', url: URL_A })
  assert.equal(outcome.state, 'unsupported')
  assert.equal(client.calls.length, 1)
})

test('同一取数任务不能中途换来源', async () => {
  const client = makeClient([{ state: 'recovered' }])
  const coordinator = createChallengeRecoveryCoordinator({ client, now: () => 0, sleep: async () => {} })
  await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-d', url: URL_A })
  await assert.rejects(
    () => coordinator.attempt({ providerId: 'fang', retrievalTaskId: 'task-d', url: URL_A }),
    /已经绑定在来源 lianjia/,
  )
})

test('显式继续只能从登记过的取数任务继续，且用受保护的原 URL', async () => {
  const client = makeClient([{ state: 'waiting-user', attempts: 2, reasonCode: 'visible-challenge' }, { state: 'recovered' }])
  const coordinator = createChallengeRecoveryCoordinator({
    client, now: () => 0, sleep: async () => {}, cooldownMs: 1_000,
  })
  await assert.rejects(
    () => coordinator.resume({ providerId: 'lianjia', retrievalTaskId: 'never-seen' }),
    /没有登记过的取数任务/,
  )
  await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-e', url: URL_A })
  const callsBefore = client.calls.length
  const outcome = await coordinator.resume({ providerId: 'lianjia', retrievalTaskId: 'task-e' })
  assert.equal(outcome.state, 'recovered')
  assert.equal(client.calls.length, callsBefore + 1)
  const last = client.calls[client.calls.length - 1]
  assert.equal(last.url, URL_A, '继续必须回到原页面')
  assert.equal(last.attempts, 1, '员工继续只做一次页面核验')
  assert.equal(last.cooldownMs, 0)
  await assert.rejects(() => coordinator.resume({ providerId: 'fang', retrievalTaskId: 'task-e' }), /属于来源 lianjia/)
})

test('冷却期间的自动尝试不占用 profile 队列', async () => {
  const queue = createProfileQueue()
  let clock = 0
  const client = makeClient([{ state: 'waiting-user', attempts: 1 }, { state: 'recovered' }])
  // 让"浏览器调用"真的走队列，好观察冷却期间队列是空的。
  const queuedClient = {
    ...client,
    calls: client.calls,
    async recover(request) {
      return await queue.run('profile', undefined, async () => await client.recover(request))
    },
  }
  const observed = []
  const coordinator = createChallengeRecoveryCoordinator({
    client: queuedClient,
    now: () => clock,
    sleep: async (ms) => {
      observed.push(queue.activeCount('profile'))
      clock += ms
    },
    cooldownMs: 1_000,
  })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-f', url: URL_A })
  assert.equal(outcome.state, 'recovered')
  assert.deepEqual(observed, [0], '冷却等待期间队列必须是空的')
})

test('取消会让协调器返回 cancelled，而不是继续尝试', async () => {
  const client = makeClient([{ state: 'waiting-user', attempts: 1 }])
  const coordinator = createChallengeRecoveryCoordinator({ client, now: () => 0, sleep: async () => {} })
  const controller = new AbortController()
  controller.abort()
  const outcome = await coordinator.attempt(
    { providerId: 'lianjia', retrievalTaskId: 'task-g', url: URL_A },
    controller.signal,
  )
  assert.equal(outcome.state, 'cancelled')
  assert.equal(client.calls.length, 0)
})

// ── 恢复核验：`recovered` 必须真的回到原页面（P10） ────────────────────────
//
// 站点把自己的人机验证页当成受保护页的回答时（实测 2026-10-15：`bj.lianjia.com/…`
// → `hip.lianjia.com/captcha`），CLI 回的是 `waiting-user/challenge-page-waiting-user`：
// 等人过验证、可用同一任务继续 —— **不是** unsupported（没有策略），更不是 recovered。
// 而任何 `recovered` 都要过"最终 URL 回到该来源 + 页面可读 + 无可见挑战"这一道核验。

const { recoveryVerified } = await import(
  new URL('src/host/domains/report-evaluation/browser/challenge-recovery.ts', ROOT).href)

function outcomeWith(overrides) {
  return {
    recoveryId: 'rec-x', retrievalTaskId: TASK, providerId: 'lianjia',
    strategyId: 'auto', strategyVersion: '1', attempts: 1,
    beforeKind: 'geetest-v3-canvas', afterKind: 'none',
    state: 'recovered', reasonCode: 'no-visible-challenge', nextEligibleAt: '',
    strategies: ['geetest-v3-canvas'], notes: [],
    pageValidation: {
      finalUrl: URL_A, title: '', hostMatches: true, readable: true,
      challengeVisible: false, loginWall: false, blocked: false, overlaySelectors: [], reason: '',
    },
    ...overrides,
  }
}

test('recoveryVerified 要求三件事同时成立：同站、可读、无可见挑战', () => {
  assert.equal(recoveryVerified(outcomeWith({})), true)
  assert.equal(recoveryVerified(outcomeWith({ state: 'waiting-user' })), false)
  assert.equal(recoveryVerified(outcomeWith({
    pageValidation: { ...outcomeWith({}).pageValidation, hostMatches: false },
  })), false, '最终 URL 不在原站点就不是恢复')
  assert.equal(recoveryVerified(outcomeWith({
    pageValidation: { ...outcomeWith({}).pageValidation, readable: false },
  })), false, '页面不可读就不是恢复')
  assert.equal(recoveryVerified(outcomeWith({
    pageValidation: { ...outcomeWith({}).pageValidation, challengeVisible: true },
  })), false, '还有可见挑战就不是恢复')
})

test('协调器不替 CLI 宣布恢复：没核过的 recovered 降级为 waiting-user', async () => {
  const client = makeClient([{ state: 'recovered' }])
  client.recover = async (request) => ({
    ...outcomeWith({ retrievalTaskId: request.retrievalTaskId, providerId: request.providerId }),
    pageValidation: { ...outcomeWith({}).pageValidation, hostMatches: false },
  })
  // 冷却 0：这一条测的是核验，不是冷却（时钟不动时冷却会让用例自锁）。
  const coordinator = createChallengeRecoveryCoordinator({ client, now: () => 0, sleep: async () => {}, cooldownMs: 0 })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-unverified', url: URL_A })
  assert.equal(outcome.state, 'waiting-user')
  assert.equal(outcome.reasonCode, 'recovery-unverified')
  assert.match(outcome.pageValidation.reason, /没有通过页面核验/)
})

test('挑战页族：一次就交回人工，**不做**冷却重试（不吃预算也不敲第二次）', async () => {
  // 2026-10-13 成功那一轮的节奏是"每 URL 只导航一次 + 列表 9s / 详情 8.5s"，
  // 而归档里站点随后开始回 captcha —— 对同一个挑战页再敲一次只会让风控更紧，
  // 而那一页本来就没有可驱动的控件（人工必须介入）。
  const client = makeClient([{ state: 'waiting-user', attempts: 1, reasonCode: 'challenge-page-waiting-user' }])
  const coordinator = createChallengeRecoveryCoordinator({
    client, now: () => 0, sleep: async () => {}, cooldownMs: 0,
  })
  const outcome = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-hip', url: URL_A })
  assert.equal(outcome.state, 'waiting-user', 'unsupported 才是死路；这一族等人')
  assert.equal(outcome.reasonCode, 'challenge-page-waiting-user')
  assert.equal(client.calls.length, 1, '挑战页族不再自动重试（一次即交回人工）')
  assert.equal(coordinator.cooldownUntilOf('lianjia'), 0, '不留下会挡住后续取数的冷却')
})

test('人工完成后继续：resume 回原页面核验，没核过的一样降级', async () => {
  // 站点把受保护页换成人机验证页 → 自动这一次就交回人工（挑战页族不冷却重试）；
  // 员工在可见窗口过完验证后再用**同一取数任务**继续 —— 必须回到原 URL 并核验。
  const calls = []
  const verifiedClient = {
    calls,
    async recover(request) {
      calls.push({ ...request })
      return calls.length <= 1
        ? {
          ...outcomeWith({ retrievalTaskId: request.retrievalTaskId }),
          state: 'waiting-user', reasonCode: 'challenge-page-waiting-user',
        }
        : outcomeWith({ retrievalTaskId: request.retrievalTaskId })
    },
    async status() { return { ok: true, error: '', sites: [], unavailable: false } },
    async login() { return { ok: true, error: '', sites: [], aborted: false } },
    async fetch() { throw new Error('unused') },
    async shot() { throw new Error('unused') },
    sites() { return '/pkg/sites.json' },
  }
  const coordinator = createChallengeRecoveryCoordinator({
    client: verifiedClient, now: () => 0, sleep: async () => {}, cooldownMs: 0,
  })
  const first = await coordinator.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-resume', url: URL_A })
  assert.equal(first.state, 'waiting-user')
  assert.equal(calls.length, 1, '挑战页族一次即交回人工（不再自动重试）')
  const resumed = await coordinator.resume({ providerId: 'lianjia', retrievalTaskId: 'task-resume' })
  assert.equal(resumed.state, 'recovered')
  const last = calls[calls.length - 1]
  assert.equal(last.url, URL_A, '继续必须回到原页面（URL 只能从受保护的预算记录里取）')
  assert.equal(last.attempts, 1, '员工继续只做一次页面核验')

  // 同一入口上，没通过核验的 recovered 一样不许放行。
  const unverifiedCalls = []
  const unverifiedClient = {
    calls: unverifiedCalls,
    async recover(request) {
      unverifiedCalls.push({ ...request })
      return unverifiedCalls.length <= 1
        ? {
          ...outcomeWith({ retrievalTaskId: request.retrievalTaskId }),
          state: 'waiting-user', reasonCode: 'challenge-page-waiting-user',
        }
        : {
          ...outcomeWith({ retrievalTaskId: request.retrievalTaskId }),
          pageValidation: { ...outcomeWith({}).pageValidation, challengeVisible: true },
        }
    },
    async status() { return { ok: true, error: '', sites: [], unavailable: false } },
    async login() { return { ok: true, error: '', sites: [], aborted: false } },
    async fetch() { throw new Error('unused') },
    async shot() { throw new Error('unused') },
    sites() { return '/pkg/sites.json' },
  }
  const strict = createChallengeRecoveryCoordinator({
    client: unverifiedClient, now: () => 0, sleep: async () => {}, cooldownMs: 0,
  })
  await strict.attempt({ providerId: 'lianjia', retrievalTaskId: 'task-resume-2', url: URL_A })
  const unverified = await strict.resume({ providerId: 'lianjia', retrievalTaskId: 'task-resume-2' })
  assert.equal(unverified.state, 'waiting-user')
  assert.equal(unverified.reasonCode, 'recovery-unverified')
})

//
// 恢复能力必须**真的**以结构化 Tool 的形式注册：写在提示词里的能力不算实现。
// 这里钉三件事：名字只写一份、估值链路必需工具集包含它、注册面与审核必需集分开。

const { VALUATION_TOOL_NAMES, VALUATION_CHILD_TOOLS } = await import(
  new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(
  new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { valuationBrowserRecoverTools } = await import(
  new URL('src/host/tools/report-evaluation/browser-recover.ts', ROOT).href)

test('恢复能力以结构化 Tool 注册，且名字只有一份', () => {
  assert.equal(VALUATION_TOOL_NAMES.browserRecover, 'crwu_valuation_browser_recover')
  assert.equal(VALUATION_CHILD_TOOLS.includes('crwu_valuation_browser_recover'), true,
    '估值链路必需工具集必须包含它（否则会话跑到一半才发现工具调不到）')
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_browser_recover'), true,
    '注册面清单必须包含它（"装出来的包注册几个 Tool"按它核对）')
  // 它与审核必需集**分开**：审核链路不该因为估值工具缺失而拒绝启动。
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_browser_recover'), false)
})

test('没有装配浏览器能力时如实回 capability-gap（不装库、不拼命令、不换通道）', async () => {
  const [tool] = valuationBrowserRecoverTools({
    // 只给这份用例需要的最小 deps；缺 `browserRuntime` 正是被测场景。
    ctx: {}, config: {}, state: {}, world: {},
    form: {}, access: {}, discussionScopes: {},
  })
  const result = await tool.execute(
    { caseDir: '/cases/x', providerId: 'lianjia', retrievalTaskId: 'task-1' },
    { agent: undefined, signal: undefined },
  )
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /没有装配浏览器恢复能力/)
})

test('工具签名只接业务 ID，不接 URL / 策略 / 脚本 / 输出目录', () => {
  const [tool] = valuationBrowserRecoverTools({ ctx: {}, config: {}, state: {}, world: {}, form: {}, access: {}, discussionScopes: {} })
  // `defineTool` 把简写收成 JSON Schema，所以真正的参数名在 `parameters.properties`。
  const names = Object.keys(tool.parameters.properties ?? tool.parameters)
  assert.deepEqual(names.sort(), ['caseDir', 'providerId', 'retrievalTaskId'])
  for (const forbidden of ['url', 'strategy', 'script', 'out', 'command', 'caseRoot']) {
    assert.equal(names.includes(forbidden), false, `工具不该接受 ${forbidden}`)
  }
  // 描述里要写明"自动恢复不需要调用本工具发起"，否则模型会把它当重试按钮反复调用。
  assert.match(tool.description, /最多 2 次|120 秒/)
  assert.match(tool.description, /不接受 URL/)
})

// ── finalize Tool 的接线（设计稿 §11.4） ────────────────────────────────────

const { valuationFinalizeTools } = await import(
  new URL('src/host/tools/report-evaluation/finalize.ts', ROOT).href)

test('finalize 以结构化 Tool 注册：名字只有一份，且与审核必需集分开', () => {
  assert.equal(VALUATION_TOOL_NAMES.finalize, 'crwu_valuation_finalize')
  assert.equal(VALUATION_CHILD_TOOLS.includes('crwu_valuation_finalize'), true)
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_finalize'), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_finalize'), false)
  const [tool] = valuationFinalizeTools({ ctx: {}, config: {}, state: {}, world: {}, form: {}, access: {}, discussionScopes: {} })
  assert.equal(tool.name, 'crwu_valuation_finalize')
})

test('finalize 的入参只接业务参数：没有路径拼接、没有状态覆盖开关', () => {
  const [tool] = valuationFinalizeTools({ ctx: {}, config: {}, state: {}, world: {}, form: {}, access: {}, discussionScopes: {} })
  const names = Object.keys(tool.parameters.properties ?? tool.parameters)
  // 协议 40：多一个 `target`（`plan` 缺省 / `project` 由父会话收口）—— 仍是业务参数，
  // 不是路径拼接、也不是状态覆盖开关。
  assert.deepEqual(names.sort(),
    ['caseDir', 'planId', 'requestedStatus', 'revision', 'screenshotRequired', 'target', 'taskId', 'valuationPath'])
  // `screenshotRequired` 必须由调用方从**知识正文**传进来，工具不许自己猜。
  assert.equal(names.includes('screenshotRequired'), true)
  // 描述里要写明"请求的状态只是提示"，否则模型会以为它能自己宣布完成。
  assert.match(tool.description, /只是提示/)
  assert.match(tool.description, /partial/)
})

// ── project prepare Tool 的接线（设计稿 §7） ────────────────────────────────

const { valuationProjectPrepareTools } = await import(
  new URL('src/host/tools/report-evaluation/project.ts', ROOT).href)

test('project prepare 以结构化 Tool 注册，入参只接业务结构', () => {
  assert.equal(VALUATION_TOOL_NAMES.projectPrepare, 'crwu_valuation_project_prepare')
  assert.equal(VALUATION_CHILD_TOOLS.includes('crwu_valuation_project_prepare'), true)
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_project_prepare'), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_project_prepare'), false)
  const [tool] = valuationProjectPrepareTools({ ctx: {}, config: {}, state: {}, world: {}, form: {}, access: {}, discussionScopes: {} })
  assert.equal(tool.name, 'crwu_valuation_project_prepare')
  const names = Object.keys(tool.parameters.properties ?? tool.parameters)
  assert.deepEqual(names.sort(), ['caseDir', 'implementedMethods', 'methodFacts', 'objects', 'proposals', 'write'])
  // 描述里要写明"本工具不做业务判断"，否则模型会指望它替知识回答适用性。
  assert.match(tool.description, /不做业务判断/)
  assert.match(tool.description, /阻断/)
})
