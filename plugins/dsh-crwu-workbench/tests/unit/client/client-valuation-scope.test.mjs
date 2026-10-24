/**
 * 房地产启动页的**流程恢复 + 资料范围闭环**（协议 37 · 设计稿 §7–§12）。
 *
 * 这一份钉的是 2026-10-14 那一轮 UI/UX 优化里"旧行为下会失败"的那些点，逐条对应 UX 编号：
 *
 * - UX-01 创建期间抽屉持续显示（同一颗按钮 pending）；
 * - UX-02 人机验证有**真实入口**（受控 Host 操作，不给登录按钮）；
 * - UX-03 `waiting-user` 不被归一成 `running`；未知值不伪装 running；
 * - UX-04 登录错误与整体检查错误**可见**，且各贴在所属区域；
 * - UX-05 切页恢复：检查中/准备中切走再回来不永久卡住；
 * - UX-06 交接失败按 Host 的权威创建判据分派动作（未知不许回草稿）；
 * - UX-07 登录任务按 jobId 同步，不保留旧 running；
 * - UX-08/09/14 入口与实际文件两层、逐个移除、撤销、重新纳入、重扫；
 * - UX-10/11/12/15/16/18 视觉与可访问性的可断言部分（实心主按钮、命中区、对比度 token、
 *   只读键值摘要、表单展示记忆、补充要求保留换行）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const state = await import(new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { VALUATION_CLASSES } = await import(
  new URL('src/client/modules/report-evaluation/model/styles.ts', ROOT).href)
const {
  createReportEvaluationController, preflightViewOf, previewViewOf, handoffViewOf, verificationViewOf,
} = await import(new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { ValuationIntakePane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx', ROOT).href)
const { ValuationCapabilityArea } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationCapabilityArea.tsx', ROOT).href)
const { ValuationConfirmationDrawer } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT).href)
const { ReportEvaluationPane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT).href)
const { SideDrawer } = await import(new URL('src/client/ui/SideDrawer.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { render, rerender, find, findAll, textOf } = await import(new URL('tests/helpers/render.mjs', ROOT).href)

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

const RELEASED = {
  ok: true, error: '', sites: [], rows: [],
  gate: { released: true, required: [], optional: [], reason: '', unavailable: false, checkedAt: '' },
  loginJobs: [],
}

/** 已经放行、资料扫完的草稿（多数用例从这里开始）。 */
function draftState(patch = {}) {
  return state.initialValuationState({
    phase: 'draft',
    assetType: 'real-estate',
    // 本轮起**方法没有默认值**：关心其它行为的用例显式选一项（空态另有专门用例）。
    method: 'market',
    selection: ['/Users/someone/资料'],
    files: [{
      path: '/Users/someone/资料', name: '资料', dirHint: '', kind: 'directory',
      sizeBytes: 0, status: 'scanned', reason: '', fileCount: 2,
    }],
    fileRows: [
      { path: '/Users/someone/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf', sizeBytes: 2048, parentPath: '/Users/someone/资料', state: 'included' },
      { path: '/Users/someone/资料/现场照片.jpg', name: '现场照片.jpg', kind: 'image', sizeBytes: 1024, parentPath: '/Users/someone/资料', state: 'included' },
    ],
    scanState: 'ready',
    fileCount: 2,
    readableCount: 2,
    ...patch,
  })
}

function fakePort(overrides = {}) {
  const calls = { preflight: [], intake: [], start: [], scan: [], login: [], verify: [], open: [] }
  return {
    calls,
    fileInput: async () => [],
    preflight: async (input) => { calls.preflight.push(input ?? {}); return RELEASED },
    login: async (input) => { calls.login.push(input); return { ok: true, error: '', jobId: 'login-1', reused: false, job: null } },
    verificationWindow: async (input) => { calls.verify.push(input); return { ok: true, error: '', opened: true, siteId: input.siteId } },
    scan: async (input) => { calls.scan.push(input); return { ok: true, items: [], files: [], fileCount: 0 } },
    intake: async (input) => { calls.intake.push(input); return { ok: false, error: '不该走到这里' } },
    start: async (input) => { calls.start.push(input); return { ok: false, error: '不该走到这里' } },
    openSession: async () => ({ ok: true, error: '' }),
    ...overrides,
  }
}

/**
 * 毫秒级的等待上限。
 *
 * 真实默认是 60 / 120 / 180 秒：测试里留下一个在途请求就会让 node --test 的进程
 * 挂到那个定时器结束（实测这一份从 3 秒变成 120 秒）。行为断言与时长无关，
 * 所以这里把它们压到毫秒级，需要"仍在等待"的用例用推迟应答表达。
 */
const FAST_TIMEOUTS = { slowWaitMs: 5_000, authTimeoutMs: 200, intakeTimeoutMs: 200, handoffTimeoutMs: 200 }

function controllerOf(port, options) {
  return createReportEvaluationController({ ...port, ...FAST_TIMEOUTS }, options)
}

/** 只渲染用的哑 controller（页面外壳只读状态、只调方法）。 */
function stubController(pageState) {
  return {
    getState: () => pageState,
    subscribe: () => () => {},
    checkAuth: () => {}, recheckAuth: () => {}, login: () => {}, cancelLogin: () => {},
    openVerification: () => {},
    pickFiles: () => {}, pickFolder: () => {}, removeSelection: () => {}, excludeFile: () => {},
    reincludeFile: () => {}, undoRemoval: () => {}, rescan: () => {},
    setMethod: () => {}, setBaseDate: () => {}, setPrompt: () => {},
    preparePreview: () => {}, backToEdit: () => {}, confirm: () => {},
    openCreatedSession: () => {}, invalidate: () => {}, markStale: () => {},
  }
}

// ══ UX-01：创建期间抽屉必须继续显示 ═════════════════════════════════════════

test('UX-01 创建期间仍渲染同一个只读抽屉，主按钮 pending（原操作界面不许消失）', async () => {
  assert.equal(state.showsConfirmationDrawer('confirmation'), true)
  assert.equal(state.showsConfirmationDrawer('creating-session'), true,
    '点下「开始估值」之后抽屉必须继续存在')

  const preview = previewViewOf({
    ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'sha256:feed', methodRequest: 'market',
    baseDate: null, supplementalPrompt: '',
    files: [{
      fileId: 'material-001', fileName: '权属资料.pdf', absolutePath: '/Users/someone/资料/权属资料.pdf',
      archiveRelativePath: '材料-源/权属资料.pdf', kind: 'pdf', sizeBytes: 2048, sha256: 'a'.repeat(64),
      createdAt: '2026-02-01T02:03:04.000Z', modifiedAt: null, readable: true, duplicateOf: null,
    }],
  })
  const creating = draftState({ phase: 'creating-session', preview, slowWait: 'create' })
  const tree = render(ReportEvaluationPane, { controller: stubController(creating) }).tree
  const drawers = findAll(tree, (node) => node.props?.['data-valuation-confirmation-drawer'] !== undefined)
  assert.equal(drawers.length, 1, 'creating-session 阶段抽屉必须还在（旧行为这里是 0 个）')
  const primary = findAll(drawers[0], (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(textOf(primary), zhCN.valuationCreatingSession)
  assert.equal(primary.props.disabled, true)
  // 创建期间四条关闭路径一起失效：关闭按钮禁用、返回修改禁用、遮罩没有 onClick、
  // 抽屉自己进入了 closeDisabled（Escape 由 SideDrawer 判）。
  assert.match(textOf(drawers[0]), /正在创建会话/)
  assert.equal(findAll(drawers[0], (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationDrawerBack)[0].props.disabled, true, '创建期间不许返回修改')
})

// ══ UX-02：人机验证的**真实**入口 ══════════════════════════════════════════

const CHALLENGED = {
  ok: true, error: '',
  sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '受保护页要求人机验证', verdict: 'captcha' }],
  rows: [{
    siteId: 'lianjia', label: '链家', state: 'unknown', reason: '受保护页要求人机验证',
    verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
    required: true, stateLabel: '无法检查',
    challenge: { detected: true, attempted: true, state: 'waiting-user', reasonCode: 'challenge-visible', verifyUrl: 'https://bj.lianjia.com/ershoufang/' },
  }],
  gate: { released: false, required: ['lianjia'], optional: [], reason: '还有必需来源没有通过登录检查', unavailable: false, checkedAt: '' },
  loginJobs: [],
}

test('UX-02 被人机验证挡住时有「打开验证窗口」，走受控 Host 操作且不调用登录', async () => {
  const port = fakePort({ preflight: async () => CHALLENGED })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  // 协议 39：未登录 / 被挑战都**不改阶段**（页面留在草稿），能力事实由能力区展示。
  assert.equal(controller.getState().phase, 'draft')

  const tree = render(ReportEvaluationPane, { controller: stubController(controller.getState()) }).tree
  // 摘要行直接给出短结论与动作：被挑战不是未登录，唯一的处置是去验证。
  const stateLabel = findAll(tree, (node) => node.props?.['data-valuation-site-state-label'] !== undefined)[0]
  assert.equal(textOf(stateLabel), zhCN.valuationCapabilityShortChallenge)
  const verifyButton = findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationCapabilityGoVerify)[0]
  assert.ok(verifyButton, '必须有一个真实的「去验证」入口（旧行为这里只有文字）')
  assert.equal(findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationAuthLoginGo.replace('{label}', '链家')).length, 0,
  '被挑战时不许出现登录入口（员工本来就已登录）')

  const live = controllerOf(port)
  live.checkAuth()
  await tick()
  live.openVerification('lianjia')
  await tick()
  assert.deepEqual(port.calls.verify, [{ siteId: 'lianjia' }], '只提交 siteId（URL 由 Host 定）')
  assert.deepEqual(port.calls.login, [], '验证不是登录：不许顺带拉起登录')
  assert.equal(live.getState().notice, zhCN.valuationAuthVerifyOpened.replace('{label}', '链家'))
  assert.match(live.getState().notice, /窗口打开不等于验证已经通过/)
  // 文案必须同时暴露"打开≠通过"：`opened` 不是成功。
  assert.equal(verificationViewOf({ ok: true, opened: true, siteId: 'lianjia' }).opened, true)
})

// ══ UX-03：waiting-user 与未知状态 ══════════════════════════════════════════

test('UX-03 waiting-user 原样保留；未知状态不伪装成 running', async () => {
  const view = preflightViewOf({
    ok: true,
    loginJobs: [
      { jobId: 'j1', siteId: 'lianjia', state: 'waiting-user', startedAt: 1, finishedAt: 2 },
      { jobId: 'j2', siteId: 'lianjia', state: '忽然多出来的状态', startedAt: 1 },
    ],
  })
  assert.equal(view.loginJobs[0].state, 'waiting-user', 'waiting-user 不许被解析成 running')
  assert.equal(view.loginJobs[1].state, 'failed', '未知状态不许伪装成 running（会永远等下去）')

  const wire = await import(new URL('src/shared/wire/report-evaluation.ts', ROOT).href)
  assert.deepEqual([...wire.VALUATION_LOGIN_JOB_STATES],
    ['running', 'succeeded', 'failed', 'cancelled', 'waiting-user'])
})

// ══ UX-04：错误可见 ════════════════════════════════════════════════════════

const BLOCKED = {
  ok: true, error: '',
  sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有登录凭据' }],
  rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有登录凭据', required: true, stateLabel: '未登录' }],
  gate: { released: false, required: ['lianjia'], optional: [], reason: '链家 尚未登录', unavailable: false, checkedAt: '' },
  loginJobs: [],
}

const FAILED_JOB = {
  jobId: 'login-1', siteId: 'lianjia', state: 'failed', startedAt: 1, finishedAt: 2,
  detail: '启动浏览器失败', sites: [], commandOk: false, recoveryAttempts: 0,
}

test('UX-04 登录失败与整体检查失败都可见，且各贴在所属区域', () => {
  const login = {
    check: 'ready', gate: BLOCKED.gate, rows: BLOCKED.rows, sites: BLOCKED.sites,
    loginJobs: [FAILED_JOB], job: FAILED_JOB,
    error: '',
  }
  const blocked = state.initialValuationState({ phase: 'draft', login })
  const tree = render(ValuationCapabilityArea, {
    state: blocked,
    onRecheck: () => {}, onLogin: () => {}, onCancelLogin: () => {}, onVerify: () => {},
  }).tree
  const text = textOf(tree)
  // 五种状态各有各的话：失败必须说"未完成"，而不是"已结束"。
  assert.equal(text.includes(zhCN.valuationAuthJobFailed.replace('{label}', '链家')), true)
  assert.equal(text.includes('· 启动浏览器失败'), true, 'Host 给的安全原因要显示出来')
  assert.equal(text.includes(zhCN.valuationAuthLoginDone), false, '旧的"已结束"泛化句不许回来')

  const withError = state.initialValuationState({
    phase: 'draft',
    login: { ...login, job: null, loginJobs: [], error: '打开登录窗口失败：安全原因' },
  })
  const errorTree = render(ValuationCapabilityArea, {
    state: withError,
    onRecheck: () => {}, onLogin: () => {}, onCancelLogin: () => {}, onVerify: () => {},
  }).tree
  const alert = find(errorTree, (node) => node.props?.['data-valuation-auth-error'] === 'true')
  assert.ok(alert, '登录/取消失败时错误必须可见（旧行为这里是 false）')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /安全原因/)
})

// ══ UX-05：切页恢复 ════════════════════════════════════════════════════════

test('UX-05 检查中切走再回来能重新检查（不再永久卡 checking）', async () => {
  let release = null
  const pending = new Promise((resolve) => { release = resolve })
  const base = fakePort()
  const port = fakePort({ preflight: async (input) => { port.calls.preflight.push(input ?? {}); return await pending } })
  const controller = controllerOf(port)
  controller.checkAuth()
  await tick()
  // 协议 39：检查**不动阶段**（页面一直是草稿），只有能力区自己的 check 在变。
  assert.equal(controller.getState().phase, 'draft')
  assert.equal(controller.getState().login.check, 'checking')

  // 切走：在途请求作废，并且**清理瞬时状态**（这是旧行为缺失的那一步）。
  controller.invalidate()
  assert.equal(controller.getState().login.check, 'idle', '离开时要清掉"正在检查"这个瞬时事实')
  release(RELEASED)
  await tick()

  // 回来：必须能真的再查一次（旧行为被 guard 吃掉，页面永远停在 checking）。
  controller.checkAuth()
  await tick()
  assert.equal(port.calls.preflight.length, 2, '回来必须真的重新发一次检查')
  assert.equal(controller.getState().phase, 'draft')
})

test('UX-05 准备确认中切走再回来是可编辑草稿，且能重新确认', async () => {
  const releases = []
  const port = fakePort({
    intake: async (input) => {
      port.calls.intake.push(input)
      return await new Promise((resolve) => { releases.push(resolve) })
    },
  })
  const controller = controllerOf(port, { initial: draftState() })
  controller.preparePreview()
  await tick()
  assert.equal(controller.getState().phase, 'preparing-confirmation')

  controller.invalidate()
  assert.equal(controller.getState().phase, 'draft', '在途准备作废后必须回到可编辑草稿')
  assert.equal(controller.getState().selection.length, 1, '输入必须保留')
  releases[0]({ ok: false, error: '迟到的结果' })
  await tick()
  assert.equal(controller.getState().phase, 'draft', '迟到响应不许把页面推回 pending/confirmation')
  assert.equal(controller.getState().preview, null)

  // 能重新确认（旧行为是一个永远 pending 的按钮）。
  controller.preparePreview()
  await tick()
  assert.equal(controller.getState().phase, 'preparing-confirmation')
  // 收掉在途请求的定时器：别让测试进程等一个 200ms 的超时。
  controller.invalidate()
})

test('UX-05 交接期间切页**不**清理：会话是 Host 的事务', () => {
  const preview = previewViewOf({ ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'd', files: [] })
  const creating = draftState({ phase: 'creating-session', preview, handoffRequestId: 'r1' })
  const pruned = state.pruneTransientState(creating)
  assert.equal(pruned.phase, 'creating-session', '切页不能中断正在创建的交接')
  assert.equal(pruned.handoffRequestId, 'r1')
})

// ══ UX-06 / UX-17：交接失败的三类事实 ══════════════════════════════════════

test('UX-06 Host 明确说未创建时才允许「返回修改」；未知与已创建都不许', () => {
  const base = draftState({ phase: 'handoff-failed' })

  const notCreated = state.handoffFailed(base, { creationDisposition: 'not-created' }, '创建失败').state
  assert.equal(state.canReturnToEdit(notCreated), true)
  assert.equal(state.backToEdit(notCreated).ok, true, 'Host 说没创建 → 状态机真的允许回草稿')
  assert.equal(state.backToEdit(notCreated).state.phase, 'draft')

  const unknown = state.handoffFailed(base, { creationDisposition: 'unknown' }, '超时').state
  assert.equal(state.canReturnToEdit(unknown), false)
  const refused = state.backToEdit(unknown)
  assert.equal(refused.ok, false, '结果未知时不许回草稿（会生成第二个项目目录）')
  assert.match(refused.error, /恢复/)

  const created = state.handoffFailed(base, {
    creationDisposition: 'created', parentSessionId: 's1',
  }, '指令没发出去').state
  assert.equal(state.canReturnToEdit(created), false)
  assert.equal(created.parentSessionId, 's1', '已建出的会话 id 必须留着')
  assert.equal(created.retrySameSession, true)
})

test('UX-06 缺字段（旧宿主）按 unknown 处理：不会误判成"没创建"', () => {
  const view = handoffViewOf({ ok: false, error: '超时', parentSessionId: '' })
  assert.equal(view.creationDisposition, 'unknown')
  const createdButEmpty = state.handoffFailed(draftState({ phase: 'handoff-failed' }),
    { parentSessionId: '' }, '超时').state
  assert.equal(createdButEmpty.creationDisposition, 'unknown')
})

test('UX-17 失败标题来自结构化事实，不再是一句泛化阶段话', () => {
  const base = draftState({ phase: 'handoff-failed' })
  const notCreated = state.handoffFailed(base, { creationDisposition: 'not-created' }, 'x').state
  assert.equal(state.handoffTitleOf(notCreated), zhCN.valuationHandoffNotCreatedTitle)
  assert.equal(state.handoffRetryLabelOf(notCreated), zhCN.valuationHandoffRetryCreate)

  const unknown = state.handoffFailed(base, { creationDisposition: 'unknown' }, 'x').state
  assert.equal(state.handoffTitleOf(unknown), zhCN.valuationHandoffUnknownTitle)
  assert.equal(state.handoffRetryLabelOf(unknown), zhCN.valuationHandoffRecover)

  const created = state.handoffFailed(base, { creationDisposition: 'created', parentSessionId: 's1' }, 'x').state
  assert.equal(state.handoffTitleOf(created), zhCN.valuationHandoffCreatedTitle)
  assert.equal(state.handoffRetryLabelOf(created), zhCN.valuationHandoffRetryDispatch)
})

test('UX-17 页面不再渲染泛化阶段句；未知结果不给「返回修改」', () => {
  const unknown = state.handoffFailed(draftState({ phase: 'handoff-failed' }),
    { creationDisposition: 'unknown' }, '尚未确认').state
  const tree = render(ReportEvaluationPane, { controller: stubController(unknown) }).tree
  const panel = find(tree, (node) => node.props?.['data-valuation-handoff-kind'] === 'unknown')
  assert.ok(panel, '未知结果有独立的失败区')
  assert.equal(textOf(tree).includes(zhCN.valuationPhaseHandoffFailed), false,
    '那句"会话还没有创建成功"的泛化结论不许再出现（它和未知结果自相矛盾）')
  assert.equal(findAll(panel, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationDrawerBack).length, 0, '未知结果不给返回修改')
  assert.equal(findAll(panel, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationHandoffRecover).length, 1)
})

// ══ UX-07：登录任务按 jobId 同步 ═══════════════════════════════════════════

test('UX-07 重新检查后按 jobId 更新任务；Host 不再认它时就丢掉', () => {
  const running = {
    jobId: 'j1', siteId: 'lianjia', state: 'running', startedAt: 1, finishedAt: null,
    detail: '', sites: [], commandOk: false, recoveryAttempts: 0,
  }
  const done = { ...running, state: 'succeeded', finishedAt: 2, detail: '已确认登录状态' }
  assert.equal(state.syncLoginJob(running, [done])?.state, 'succeeded', '同一条任务要用新状态')
  assert.equal(state.syncLoginJob(running, []), null, 'Host 不认这条任务时不许留着一个永远 running')

  const base = state.initialValuationState({
    phase: 'auth-blocked',
    login: { check: 'ready', gate: null, rows: [], sites: [], loginJobs: [], error: '', job: running },
  })
  const next = state.authReady(base, preflightViewOf({ ok: true, loginJobs: [done] }))
  assert.equal(next.state.login.job.state, 'succeeded')
  const gone = state.authReady(base, preflightViewOf({ ok: true, loginJobs: [] }))
  assert.equal(gone.state.login.job, null)
})

// ══ UX-08 / UX-09 / UX-14：资料范围闭环 ════════════════════════════════════

test('UX-08 扫描把真实文件与排除范围都传下去，并把 files/skipped/truncated 收进状态', async () => {
  const port = fakePort({
    scan: async (input) => {
      port.calls.scan.push(input)
      return {
        ok: true, items: [{ path: '/Users/someone/资料', name: '资料', kind: 'directory', status: 'scanned', fileCount: 2 }],
        files: [
          { path: '/Users/someone/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf', sizeBytes: 2048, parentPath: '/Users/someone/资料' },
          { path: '/Users/someone/资料/现场照片.jpg', name: '现场照片.jpg', kind: 'image', sizeBytes: 1024, parentPath: '/Users/someone/资料' },
        ],
        skipped: [{ path: '资料/链接', name: '链接', reason: '符号链接不纳入审核范围' }],
        fileCount: 2, readableCount: 2, skippedCount: 1, overLimit: false, truncated: false, limit: 30,
      }
    },
  })
  const controller = createReportEvaluationController(port, { initial: draftState({ excluded: ['/Users/someone/资料/旧件.pdf'] }) })
  controller.rescan()
  await tick()
  assert.deepEqual(port.calls.scan[0].excluded, ['/Users/someone/资料/旧件.pdf'],
    '扫描必须带上排除范围，否则"移除"只过滤了 UI 列表')
  const next = controller.getState()
  assert.equal(next.fileRows.length, 2)
  assert.equal(next.fileRows[0].parentPath, '/Users/someone/资料')
  assert.equal(next.scanSkipped.length, 1, '跳过项要能看到原因')
  assert.match(next.scanSkipped[0].reason, /符号链接/)
})

const ALL_FILES = [
  { path: '/Users/someone/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf', sizeBytes: 2048, parentPath: '/Users/someone/资料' },
  { path: '/Users/someone/资料/现场照片.jpg', name: '现场照片.jpg', kind: 'image', sizeBytes: 1024, parentPath: '/Users/someone/资料' },
]

/** 一个"真的按排除范围过滤"的扫描替身：用来证明排除写进了 Host 口径，而不只是 UI。 */
function scanningPort() {
  const port = fakePort()
  port.scan = async (input) => {
    port.calls.scan.push(input)
    const excluded = new Set(input.excluded ?? [])
    const files = ALL_FILES.filter((file) => !excluded.has(file.path))
    return {
      ok: true, items: [], files, skipped: [],
      fileCount: files.length, readableCount: files.length,
      overLimit: false, truncated: false, limit: 30,
    }
  }
  return port
}

test('UX-08 逐个移除写进排除范围并重扫；重新纳入也走同一份范围', async () => {
  const port = scanningPort()
  port.calls.scan.length = 0
  const controller = controllerOf(port, { initial: draftState() })
  controller.excludeFile('/Users/someone/资料/现场照片.jpg')
  await tick()
  assert.deepEqual(port.calls.scan[0].excluded, ['/Users/someone/资料/现场照片.jpg'])
  let next = controller.getState()
  assert.equal(next.excluded.length, 1)
  assert.equal(next.fileCount, 1, '份数按排除后的真实文件数算')
  const removedRow = next.fileRows.find((row) => row.path.endsWith('现场照片.jpg'))
  assert.equal(removedRow.state, 'excluded', '被移除的行仍然看得见（否则员工无从核对）')

  controller.reincludeFile('/Users/someone/资料/现场照片.jpg')
  await tick()
  assert.deepEqual(port.calls.scan[1].excluded, [])
  next = controller.getState()
  assert.equal(next.fileCount, 2)
})

test('UX-08 撤销移除：原样还原入口 + 排除范围（本机文件不动）', async () => {
  const port = scanningPort()
  const controller = controllerOf(port, { initial: draftState() })
  controller.removeSelection('/Users/someone/资料')
  await tick()
  assert.equal(controller.getState().selection.length, 0)
  assert.match(controller.getState().lastRemoval.name, /资料/)

  controller.undoRemoval()
  await tick()
  assert.deepEqual(controller.getState().selection, ['/Users/someone/资料'], '撤销要恢复整个入口')
  assert.equal(controller.getState().lastRemoval, null)
  assert.equal(controller.getState().fileRows.length, 2, '子文件行也一起还原')
})

test('UX-08 移除文件夹会清理只属于它的排除项（不留"幽灵排除"）', async () => {
  const port = scanningPort()
  const controller = controllerOf(port, {
    initial: draftState({ excluded: ['/Users/someone/资料/现场照片.jpg'] }),
  })
  const next = controller.getState()
  assert.equal(next.excluded.length, 1)
  controller.removeSelection('/Users/someone/资料')
  await tick()
  assert.deepEqual(controller.getState().excluded, [], '入口都不在范围里了，它的排除记录不该留着')
  // 入口被移除后选择为空：没有可扫的东西，所以这里**不该**再发一次扫描。
  assert.equal(port.calls.scan.length, 0)
  // 纯函数口径再确认一次：清干净之后下一次重扫带的就是空排除范围（不会有"幽灵排除"）。
  const after = state.removeSelection(
    draftState({ excluded: ['/Users/someone/资料/现场照片.jpg'] }), '/Users/someone/资料')
  assert.deepEqual(after.state.excluded, [])
  assert.deepEqual(after.state.selection, [])
})

test('UX-14 清单不完整（truncated）时禁止确认，并给「重新读取清单」', () => {
  const truncated = draftState({ truncated: true })
  assert.match(state.startDisabledReason(truncated), /未完整读取/)
  const tree = render(ValuationIntakePane, {
    state: truncated, onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
  }).tree
  assert.ok(find(tree, (node) => node.props?.['data-valuation-truncated'] === 'true'))
  const primary = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(primary.props.disabled, true)

  const failed = draftState({ scanState: 'failed', scanError: '读不出来' })
  const failedTree = render(ValuationIntakePane, {
    state: failed, onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
  }).tree
  assert.ok(find(failedTree, (node) => node.props?.['data-valuation-scan-error'] === 'true'), '扫描失败要保留原因')
  assert.equal(findAll(failedTree, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationScanRetry).length, 1, '要有真实的重新读取入口')
})

test('UX-09 文件行状态：移除态可见、文件夹与文件图标不同、大小未知不编 0 B', () => {
  const s = draftState({
    fileRows: [
      { path: '/Users/someone/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf', sizeBytes: 0, parentPath: '/Users/someone/资料', state: 'included' },
      { path: '/Users/someone/资料/现场照片.jpg', name: '现场照片.jpg', kind: 'image', sizeBytes: 1024, parentPath: '/Users/someone/资料', state: 'excluded' },
    ],
  })
  const tree = render(ValuationIntakePane, {
    state: s, onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
  }).tree
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.valuationFileSizeUnknown), true, '大小未知要说"待确认"，不写 0 B')
  assert.equal(text.includes(zhCN.valuationFileStatusScanned), true)
  assert.equal(findAll(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-subfile').length, 2)
  const removed = find(tree, (node) => node.props?.['data-valuation-subfile-state'] === 'removed')
  assert.ok(removed, '被移除的文件仍然显示（状态是"已从本次范围移除"）')
  assert.equal(findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationReinclude).length, 1, '要有「重新纳入」')
})

test('入口行有 aria-expanded 与实际文件组关联；移除入口是独立按钮', () => {
  const s = draftState()
  const tree = render(ValuationIntakePane, {
    state: s, onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
  }).tree
  const toggle = findAll(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-entry-toggle'
    && node.type === 'button')[0]
  assert.ok(toggle, '文件夹标题区是一个按钮')
  assert.equal(toggle.props['aria-expanded'], true, '默认展开')
  const groupId = toggle.props['aria-controls']
  const group = find(tree, (node) => node.props?.id === groupId)
  assert.ok(group, 'aria-controls 必须指向真实存在的文件组')
  const removeButtons = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-entry-remove'))
  assert.equal(removeButtons.length, 1)
  assert.match(String(removeButtons[0].props['aria-label']), /资料/, '图标/按钮名称要说出对象')
})

test('UX-13 准备确认期间底栏有**真实**的「返回修改」与准备说明', async () => {
  const calls = { back: 0, confirm: 0 }
  const preparing = draftState({ phase: 'preparing-confirmation', slowWait: 'prepare' })
  const tree = render(ValuationIntakePane, {
    state: preparing,
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {},
    onConfirm: () => { calls.confirm += 1 }, onBackToEdit: () => { calls.back += 1 },
  }).tree
  // 旧行为：底栏只说"要改请先点返回修改"，而页面上并没有那颗按钮。
  const back = findAll(tree, (node) => node.type === 'button'
    && textOf(node) === zhCN.valuationDrawerBack)[0]
  assert.ok(back, '准备期间必须有真的「返回修改」')
  back.props.onClick()
  assert.equal(calls.back, 1)
  assert.equal(calls.confirm, 0, '返回修改不许顺带提交')
  assert.ok(find(tree, (node) => node.props?.['data-valuation-prepare-note'] === 'true'),
    '要说明正在归档所选资料、原输入已保留')
  assert.ok(find(tree, (node) => node.props?.['data-valuation-slow-wait'] === 'prepare'),
    '≥15 秒要有长等待说明')
  const primary = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(primary.props.disabled, true)
  assert.equal(primary.props['aria-busy'] === true || primary.props['aria-busy'] === 'true', true,
    'pending 要能被读屏读到')
})

test('UX-11 移除按钮登记 ref，移除后焦点交给下一份（不掉到 body）', () => {
  const s = draftState()
  const tree = render(ValuationIntakePane, {
    state: s,
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {},
    onConfirm: () => {}, onBackToEdit: () => {},
  }).tree
  const removeButtons = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-file-remove'))
  assert.equal(removeButtons.length, 2)
  for (const button of removeButtons) {
    assert.equal(typeof button.props.ref, 'function', '每个移除按钮都要登记 ref（焦点交接的落点）')
  }
})

test('UX-18 中文输入法合成期间不应用上限（不把半个合成串报错）', () => {
  const seen = []
  const s = draftState()
  const tree = render(ValuationIntakePane, {
    state: s,
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: (value) => { seen.push(value) },
    onConfirm: () => {}, onBackToEdit: () => {},
  }).tree
  const textarea = findAll(tree, (node) =>
    String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-prompt'))[0]
  assert.equal(typeof textarea.props.onCompositionStart, 'function')
  textarea.props.onCompositionStart()
  textarea.props.onChange({ target: { value: 'x'.repeat(4001) } })
  assert.deepEqual(seen, [], '合成期间的中间态不许触发上限判断')
  textarea.props.onCompositionEnd({ target: { value: 'x'.repeat(4001) } })
  assert.deepEqual(seen, ['x'.repeat(4001)], '合成结束才把最终值交给状态机')
})

// ══ UX-10 / UX-11 / UX-12 / UX-15 / UX-16 / UX-18（可断言部分）═════════════

test('UX-10 主按钮走实心 token（不再是只有描边的假 primary）', () => {
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /\.crwu-valuation-btn\.crwu-valuation-btn-primary\s*\{[^}]*\}/.exec(code)
  assert.ok(rule, '主按钮变体必须有一条双类规则')
  assert.match(rule[0], /background:\s*var\(--crwu-primary-bg\)/, '主按钮必须是实心底')
  assert.match(rule[0], /color:\s*var\(--crwu-primary-text\)/)
  assert.match(code, /--crwu-primary-bg-hover/, 'hover 也要走主题 token')
})

test('UX-13 底栏是**真正的 footer**：确定高度 flex 列 + flex:none，不用 sticky 压住内容', () => {
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  // 工作面是确定高度的 flex 列；正文自己滚；操作栏 flex:none。
  assert.match(code, /\.crwu-valuation\s*\{[^}]*height:\s*100%/)
  assert.match(code, /\.crwu-valuation-intake\s*\{[^}]*flex:\s*1 1 auto;\s*min-height:\s*0/)
  assert.match(code, /\.crwu-valuation-intake-body\s*\{[^}]*flex:\s*1 1 auto;\s*min-height:\s*0;\s*overflow:\s*auto/)
  assert.match(code, /\.crwu-valuation-actionbar\s*\{[^}]*flex:\s*none/)
  // 挂载容器必须把高度接下去，否则操作栏会掉回正文末尾（真机实测 600px 高时跑到 y=915）。
  assert.match(code, /\.crwu-valuation-intake-host\s*\{[^}]*flex:\s*1 1 auto;\s*min-height:\s*0/)
  // sticky 底栏会盖住"它流入位置之前"的内容：不许再出现。
  assert.equal(/position:\s*sticky/.test(code), false, '底栏不许再用 sticky 覆盖正文')
  // 底栏是**可见的一条固定带**：自己的表面底 + 通栏顶发丝线，让人一眼看出它不跟着正文滚
  //（2026-10-16 用户口径：底下那块固定区域要有底色）。
  const barRule = /\.crwu-valuation-actionbar\s*\{([^}]*)\}/.exec(code)
  assert.ok(barRule, '底栏要有自己的规则')
  assert.match(barRule[1], /background:\s*var\(--crwu-surface-subtle\)/,
    '底栏要有自己的表面色，不能用 transparent')
  assert.equal(/background:\s*transparent/.test(barRule[1]), false, '透明底不许回来')
  assert.match(barRule[1], /border-top:\s*1px solid var\(--crwu-border\)/, '底栏要靠通栏发丝线与正文分开')
  assert.equal(/\.crwu-valuation-actionbar::before/.test(code), false,
    '底栏有了自己的表面色，内缩 ::before 发丝线就该删掉（否则一条界线画两遍）')
  // 文字与按钮**离底栏边框有距离**：内容按同一个量内缩（2026-10-16 紧凑底栏：上下 12/4px）。
  assert.match(barRule[1], /margin:\s*0;/, '底栏不许用外边距做位移（通栏靠工作纸不收内距，不靠负外边距）')
  assert.match(barRule[1], /padding:\s*12px var\(--crwu-valuation-inset\) 4px/, '底栏内容要内缩同一个量')
  assert.equal(/padding:\s*10px var\(--crwu-valuation-inset\)/.test(barRule[1]), false,
    '旧的 10px 底栏 padding 不许回来（会与 12px 那条重复）')
  assert.match(code, /\.crwu-valuation-intake-body,[\s\S]{0,400}margin-inline:\s*var\(--crwu-valuation-inset\)/,
    '正文内容要内缩同一个量，否则底栏内容与上方正文错位')
  assert.equal(/\.crwu-valuation-actionbar[^{]*\{[^}]*calc\(var\(--crwu-valuation-inset\) \* -1\)/.test(code), false,
    '底栏不许再用负外边距（工作纸横向内距本来就是 0，负向会撑出纸外）')
  // 禁用的主按钮退回中性底，而不是把实心主按钮整体降透明度
  //（深色下 --crwu-primary-bg 是浅色，乘 .45 仍是最抢眼的一块）。
  const disabledPrimary = /\.crwu-valuation-btn\.crwu-valuation-btn-primary:disabled\s*\{([^}]*)\}/.exec(code)
  assert.ok(disabledPrimary, '禁用主按钮要有独立规则')
  assert.match(disabledPrimary[1], /background:\s*var\(--crwu-control\)/)
  assert.match(disabledPrimary[1], /opacity:\s*1/)
})

test('底栏底色要铺到工作纸上：估值页的工作纸不许自己留内距，否则灰带下面留一条白线', () => {
  const pane = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const layout = readFileSync(new URL('src/client/shell/styles/layout.ts', ROOT), 'utf8')
  const bar = /\.crwu-valuation-actionbar\s*\{([^}]*)\}/.exec(pane.replace(/\/\*[\s\S]*?\*\//g, ''))
  assert.ok(bar, '底栏要有自己的规则')
  // 通栏靠的是「工作面自己占满纸」+「底栏自己内缩」，不是负外边距：
  // 工作纸横向内距本来就是 0，负向外扩会把底栏撑到纸外（真机实测 24px 溢出 + 12px 纵向溢出）。
  assert.match(bar[1], /margin:\s*0;/)
  assert.equal(/margin:[^;]*-1\)/.test(bar[1]), false, '底栏不许再用负外边距')
  // 纸在估值页**不收内距**：收一点，底栏下面就露一点白线
  //（2026-10-16 用户反馈："下面为啥还有一条白线没收住"）。
  const paper = /\.crwu-audit-page-paper\[data-workbench-page="valuation"\]\s*\{([^}]*)\}/.exec(layout)
  assert.ok(paper, '估值页的工作纸要有一条自己的规则')
  assert.match(paper[1], /padding:\s*0;/, '估值页工作纸不许自己留内距')
  assert.equal(/padding-block/.test(paper[1]), false, '旧的 16/12px 纸内距不许回来')
  // 纸不收内距之后，**正文自己**必须把上内距接过来，否则首块内容会顶到纸边上（视觉上比改前更挤）。
  const paneCode = pane.replace(/\/\*[\s\S]*?\*\//g, '')
  const bodyRule = /\.crwu-valuation-intake-body\s*\{([^}]*)\}/.exec(paneCode)
  assert.ok(bodyRule, '正文滚动区要有自己的规则')
  assert.match(bodyRule[1], /padding:\s*12px var\(--crwu-valuation-inset\) 24px/,
    '正文要自己内缩（上 12 / 下 24 / 横向同底栏），不能再指望工作纸')
})

test('UX-13 底栏左侧只有一行：可用时是行动摘要，禁用时是原因（不重复同一句话）', () => {
  const s = draftState({ assetType: '', method: '', selection: [], files: [], fileRows: [], fileCount: 0, readableCount: 0, scanState: 'idle' })
  const tree = render(ValuationIntakePane, {
    state: s, onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {},
    onConfirm: () => {}, onBackToEdit: () => {},
  }).tree
  const bar = find(tree, (node) => String(node.props?.className ?? '') === VALUATION_CLASSES.actionbar)
  const lines = findAll(bar, (node) => String(node.props?.className ?? '') === 'crwu-valuation-action-line')
  assert.equal(lines.length, 1, '底栏左侧只有一行文字')
  assert.match(textOf(lines[0]), /请选择资产类型/)
  assert.equal(findAll(bar, (node) => String(node.props?.className ?? '').includes('crwu-valuation-hint')).length, 0,
    '禁用原因不再另起一行重复同一件事')
  const primary = findAll(bar, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(primary.props.disabled, true)
  assert.equal(primary.props['aria-describedby'], VALUATION_CLASSES.actionReason, '原因仍要能被读屏关联到')
  assert.equal(find(bar, (node) => node.props?.id === VALUATION_CLASSES.actionReason) !== null, true)
})

test('估值底栏用**固定区域的实底色**，而不是融进正文的透明底', () => {
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  const bar = /\.crwu-valuation-actionbar\s*\{([^}]*)\}/.exec(code)
  assert.ok(bar, '底栏要有自己的规则')
  assert.match(bar[1], /background:\s*var\(--crwu-surface-subtle\)/)
  // 底色必须来自 token（明暗两套由 tokens.ts 负责），不许写死十六进制。
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(bar[1]), false, '底栏不许出现硬编码色值')
  assert.match(bar[1], /border-top:\s*1px solid var\(--crwu-border\)/)
  // 底栏是工作面的 footer：它自己排在正文滚动区之外，底色只是把这件事画出来。
  assert.match(code, /\.crwu-valuation-actionbar\s*\{[^}]*position:\s*relative/)
  assert.equal(/position:\s*(fixed|sticky)/.test(code), false, '底栏仍然不许 fixed / sticky')

  // 底栏与正文滚动区是**两个不同的表面**：正文保持透明（工作纸的底），底栏才有自己的一块色。
  const body = /\.crwu-valuation-intake-body\s*\{([^}]*)\}/.exec(code)
  assert.ok(body, '正文滚动区要有自己的规则')
  assert.equal(/background:\s*var\(--crwu-surface-subtle\)/.test(body[1]), false,
    '正文不许跟着底栏一起变灰，否则固定带就看不出是一条带')
})

test('UX-11 命中区：文件移除 44px 按钮槽、文件夹标题区 44px、按钮组纵向外扩到 44px', () => {
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  // 移除按钮是 **44×44 的独立按钮槽**（里面才是 28px 的视觉盒）。为什么不用负向 ::after 外扩：
  // 外扩会真的增加滚动容器的 scrollWidth —— 375px 窄面板实测正文多出 8px 横向滚动（真机复现）。
  assert.match(code, /\.crwu-valuation-file-remove\s*\{[^}]*width:\s*44px;\s*height:\s*44px/)
  assert.match(code, /\.crwu-valuation-file-remove::after\s*\{[^}]*width:\s*28px;\s*height:\s*28px/)
  assert.match(code, /\.crwu-valuation-entry-toggle\s*\{[^}]*min-height:\s*44px/)
  // 普通按钮靠**纵向**外扩把命中高度做到 ≥44px，横向不外扩（同样是为了不撑破窄面板）。
  const btnAfter = /\.crwu-valuation-btn::after\s*\{([^}]*)\}/.exec(code)
  assert.ok(btnAfter, '普通按钮要有命中区外扩规则')
  assert.match(btnAfter[1], /top:\s*-4px;\s*bottom:\s*-4px/)
  assert.equal(/inset:\s*-4px 0/.test(btnAfter[1]), false, '横向外扩会让窄面板出现横向溢出')
  assert.match(code, /:focus-visible/, '焦点态必须明确')
  assert.match(code, /:disabled:hover/, '禁用态不保留看似可用的悬停高亮')
})

test('UX-12 必要说明与输入边界用可读的语义 token（不再拿 tertiary 承载操作信息）', async () => {
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(code, /\.crwu-valuation-hint\s*\{[^}]*var\(--crwu-valuation-hint-text\)/)
  // 输入边界现在归共享 field / date-picker / select 所有者；估值侧只保留提示文案与布局。
  for (const owner of ['field.ts', 'date-picker.ts', 'select.ts']) {
    const shared = readFileSync(new URL(`src/client/ui/styles/${owner}`, ROOT), 'utf8')
    assert.match(shared, /var\(--crwu-field-border\)/, `${owner} 要提供可识别的控件边界 token`)
  }
  const tokens = await import(new URL('src/client/styles/tokens.ts', ROOT).href)
  assert.equal(tokens.CRWU_TOKEN_STYLE_TEXT.includes('--crwu-valuation-field-border: #85858B'), true)
  assert.equal(tokens.CRWU_TOKEN_STYLE_TEXT.includes('--crwu-valuation-field-border: #6F717A'), true,
    '深浅两套都要有，否则深色会退回旧值')
})

test('UX-15 抽屉用只读键值摘要，不再画一排 disabled radio；方法说明与本次选择相符', () => {
  const preview = previewViewOf({
    ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'd', methodRequest: 'market',
    assetType: 'real-estate', baseDate: null, supplementalPrompt: '第一行\n第二行',
    files: [], fileCount: 0,
  })
  const tree = render(ValuationConfirmationDrawer, {
    preview, state: draftState({ phase: 'confirmation', preview }),
    open: true, creating: false, onBack: () => {}, onConfirm: () => {},
    onCheckCapability: () => {}, onLoginSite: () => {}, onVerifySite: () => {}, onCancelLogin: () => {},
  }).tree
  assert.equal(findAll(tree, (node) => node.type === 'input' && node.props?.type === 'radio').length, 0,
    '抽屉里不许再出现 disabled radio')
  const method = find(tree, (node) => node.props?.['data-valuation-readonly'] === 'method')
  assert.ok(method, '方法要用只读摘要')
  assert.equal(textOf(method), zhCN.valuationMethodMarket)
  // 资产类型从 Host 回包取（调用方不再传草稿方法 / 资产类型）。
  const asset = find(tree, (node) => node.props?.['data-valuation-readonly'] === 'assetType')
  assert.equal(textOf(asset), zhCN.valuationAssetTypeRealEstate)
  // 方法说明**与本次选择相符**（旧文案「当前支持住宅市场法 / 收益法成本法尚未提供」已删除）。
  const hint = findAll(tree, (node) => node.props?.['data-valuation-drawer-method-hint'] !== undefined)[0]
  assert.ok(hint, '方法要有一句与本次选择相符的说明')
  assert.equal(textOf(hint), zhCN.valuationMethodHintOnce
    .replace('{label}', zhCN.valuationMethodMarket).replace('{hint}', zhCN.valuationMethodMarketHint))
  assert.equal(textOf(hint).includes('尚未提供'), false, '旧的能力限制文案不许回来')
  const prompt = find(tree, (node) => node.props?.['data-valuation-readonly'] === 'prompt')
  assert.equal(textOf(prompt), '第一行\n第二行', '用户原文的换行必须保留')
  // 创建时间标注 UTC（ISO 字面量不许被读成本地时间）。
  const utc = readFileSync(new URL('src/client/locales/zh-CN.ts', ROOT), 'utf8')
  assert.match(utc, /valuationDrawerCreatedAt: '创建于 \{at\}（UTC）'/)
})

test('UX-16 抽屉打开时输入工作面隐藏但**保留在 DOM 里**（表单展示记忆）', () => {
  assert.equal(state.keepsIntakeMounted('confirmation'), true)
  assert.equal(state.keepsIntakeMounted('creating-session'), true)
  assert.equal(state.showsIntakeForm('confirmation'), false, '确认阶段不再显示输入表单')
  const preview = previewViewOf({ ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'd', files: [] })
  const confirming = draftState({ phase: 'confirmation', preview })
  const tree = render(ReportEvaluationPane, { controller: stubController(confirming) }).tree
  const host = find(tree, (node) => node.props?.['data-valuation-intake-host'] === 'true')
  assert.ok(host, '输入工作面必须仍然挂载（否则展开状态/滚动位置/焦点锚点都会丢）')
  assert.equal(host.props.hidden, true, '确认阶段它是隐藏的')
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  assert.match(styles, /\.crwu-valuation \[hidden\] \{ display: none/,
    'hidden 只靠 UA 样式会被作者样式盖掉，必须自己兜一条')
})

test('UX-18 方法说明只出现一次且不再带"当前选项"前缀；补充要求超限保留原文并明确说明', () => {
  const methods = readFileSync(new URL('src/client/locales/zh-CN.ts', ROOT), 'utf8')
  assert.equal(methods.includes('当前选项：'), false, '旧前缀不许回来')
  assert.match(methods, /valuationMethodHintOnce: '\{label\}：\{hint\}'/)

  const base = draftState()
  const over = state.setSupplementalPrompt(base, 'x'.repeat(4001))
  assert.equal(over.ok, false, '超限不许静默接受')
  assert.equal(over.state.supplementalPrompt, '', '原有有效内容保留，不被超长粘贴顶掉')
  assert.equal(over.state.promptOverLimit, true)
  assert.match(over.error, /4000/)
  assert.match(state.startDisabledReason(over.state), /4000/)
  const recovered = state.setSupplementalPrompt(over.state, '短一点')
  assert.equal(recovered.state.promptOverLimit, false)
})

test('基准日：形状对但日期不存在的（2026-02-30）必须被拒绝，不做溢出归一', () => {
  const base = draftState()
  for (const bad of ['2026-02-30', '2026-13-01', '2025-02-29', '2026-04-31', '2026-00-10']) {
    const outcome = state.setBaseDate(base, bad)
    assert.equal(outcome.ok, false, bad)
    assert.match(outcome.error, /有效日期/)
  }
  assert.equal(state.setBaseDate(base, '2024-02-29').ok, true, '闰年 2 月 29 日合法')
  assert.equal(state.setBaseDate(base, '2026-01-31').ok, true)
})

test('能力区检查中：等待文案 + 主按钮 disabled/aria-busy；长等待给说明但不假报失败', () => {
  const checking = state.initialValuationState({
    phase: 'draft',
    slowWait: 'auth',
    login: { check: 'checking', gate: null, rows: [], sites: [], loginJobs: [], error: '', job: null },
  })
  const tree = render(ValuationCapabilityArea, {
    state: checking,
    onRecheck: () => {}, onLogin: () => {}, onCancelLogin: () => {}, onVerify: () => {},
  }).tree
  assert.equal(textOf(tree).includes(zhCN.valuationAuthChecking), true)
  // 能力区里那颗按钮**不是全页唯一 primary**：它只是"这次检查还在跑"的落点，
  // 页面唯一的实心按钮永远是「确认」（登录不再是门禁，不该跟主操作抢视觉主位）。
  const busy = findAll(tree, (node) => node.type === 'button'
    && (node.props?.['aria-busy'] === true || node.props?.['aria-busy'] === 'true'))[0]
  assert.ok(busy, '检查中要有一颗 aria-busy 的按钮')
  assert.equal(busy.props.disabled, true)
  assert.ok(find(tree, (node) => node.props?.['data-valuation-slow-wait'] === 'auth'), '15 秒后给长等待说明')
  // 检查中不许出现**状态结论**"未登录"（说明句里的"未登录可继续估值"是另一回事）。
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-site-state-label'] !== undefined).length, 0,
    '检查中不许出现逐站状态结论')
  assert.equal(textOf(tree).includes(zhCN.valuationAuthFallbackHint), false,
    '检查中不许提前说"未登录时会降级"')
})

// ══ 共享抽屉：新参数默认不改变旧调用方 ═════════════════════════════════════

test('SideDrawer：closeDisabled 真的挡住 Escape 与遮罩；initialFocus 默认仍是第一个可聚焦元素', async () => {
  const { WORKBENCH_CLASSES } = await import(new URL('src/client/shell/consts.ts', ROOT).href)
  const listeners = {}
  const previous = globalThis.document
  globalThis.document = {
    activeElement: null,
    addEventListener: (type, listener) => { listeners[type] = listener },
    removeEventListener: () => {},
  }
  try {
    // ① 报告审核那张（不传新参数）：Esc 照旧关闭。
    let closed = 0
    const plain = render(SideDrawer, { title: '审核信息', onClose: () => { closed += 1 } })
    for (const effect of plain.instance.effects) effect.callback()
    listeners.keydown({ key: 'Escape' })
    assert.equal(closed, 1, '旧调用方的 Esc 行为不许变')

    // ② 估值创建期间：closeDisabled 让 Esc 与遮罩都失效。
    let blocked = 0
    const locked = render(SideDrawer, {
      title: '确认本轮估值输入', closeDisabled: true, onClose: () => { blocked += 1 },
    })
    for (const effect of locked.instance.effects) effect.callback()
    listeners.keydown({ key: 'Escape' })
    assert.equal(blocked, 0, '创建期间 Escape 不许关闭')
    const backdrop = findAll(locked.tree, (node) => String(node.props?.className ?? '')
      .includes(WORKBENCH_CLASSES.sideDrawerBackdrop))[0]
    assert.equal(backdrop.props.onClick, undefined, '创建期间点遮罩也不许关闭')
    const close = findAll(locked.tree, (node) => String(node.props?.className ?? '')
      .includes(WORKBENCH_CLASSES.sideDrawerClose))[0]
    assert.equal(close.props.disabled, true)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('UX-16 抽屉退出先播 150ms 动画再卸载（切回草稿那一刻不会立刻消失）', async () => {
  const pane = readFileSync(new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT), 'utf8')
  assert.match(pane, /const \[presented, setPresented\] = React\.useState/, '父层要自己管呈现生命周期')
  assert.match(pane, /setClosing\(true\)/, '要进入 closing 让 SideDrawer 播退出动画')
  assert.match(pane, /prefers-reduced-motion: reduce/, '减少动画时必须立即卸载（不能变成多等 150ms）')
  const drawer = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT), 'utf8')
  assert.match(drawer, /closing=\{props\.closing === true\}/, 'closing 要真的传给共享抽屉')
})

test('SideDrawer：报告审核那张抽屉的渲染路径没有任何新参数', () => {
  const panel = readFileSync(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT), 'utf8')
  assert.equal(/closeDisabled/.test(panel), false)
  assert.equal(/initialFocus/.test(panel), false)
  assert.equal(/description=/.test(panel), false)
})

// ══ 交付形状：操作清单与协议号同步 ═════════════════════════════════════════

test('协议 49 与冻结清单同步：验证窗口、Graph 与清理操作均有登记', async () => {
  const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
  assert.equal(WORKBENCH_PROTOCOL, 52)
  const { FROZEN_OPERATIONS } = await import(new URL('tests/helpers/frozen-inventory.mjs', ROOT).href)
  assert.equal(FROZEN_OPERATIONS.includes('workspace-cleanup-plan'), true)
  assert.equal(FROZEN_OPERATIONS.includes('valuation-browser-open-verification'), true)
  const api = readFileSync(new URL('src/client/modules/report-evaluation/api.ts', ROOT), 'utf8')
  assert.match(api, /valuation-browser-open-verification/)
  // Client 不许自己拼 URL / profile / 命令：只提交 siteId。
  assert.equal(/verifyUrl/.test(api), false)
})
