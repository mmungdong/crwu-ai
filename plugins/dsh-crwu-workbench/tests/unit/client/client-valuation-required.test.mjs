/**
 * 本轮（2026-10-15 面板重构）的**必填口径与三处旧缺陷**。
 *
 * 这一份钉的是"删掉它，错的东西就能通过"的几处：
 *
 * 1. **两个必填项贯穿状态、预览与交接**：新草稿两项都未选；`''` 与未知枚举都不是有效方法；
 *    Host 回包缺资产类型 / 方法，或回显与本次提交不一致时，**留在草稿**而不是把旧值当结论；
 * 2. **文件夹真的能收起**（旧条件是"有文件的目录一直展开"，箭头点了没用）；
 * 3. **复制路径的短反馈会恢复**（旧实现一旦成功就再也不下来），且卸载时清掉计时器。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const state = await import(new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { createReportEvaluationController, previewViewOf } = await import(
  new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { ValuationIntakePane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx', ROOT).href)
const capabilityModule = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationCapabilityArea.tsx', ROOT).href)
const { CopyPathButton, COPY_FEEDBACK_MS } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })
/**
 * 只推进微任务（不碰宏任务）。
 *
 * 复制反馈那条用例会把 `setTimeout` 换成"只记录不执行"的替身，那时 `tick()` 永远不会 resolve
 * —— 而剪贴板回执本来就在微任务队列里，用微任务推进才是对的。
 */
const flush = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

/** 资料扫完、两个必填项都选好的草稿。 */
function draftState(patch = {}) {
  return state.initialValuationState({
    phase: 'draft',
    assetType: 'real-estate',
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

/** 进入"正在准备核对"的草稿（`prepareReady` 要求 requestId 是本轮那一次）。 */
function preparing(patch = {}) {
  return draftState({ phase: 'preparing-confirmation', prepareRequestId: 7, ...patch })
}

const PREVIEW_OK = {
  ok: true, error: '', errorKind: '', requestId: 'valuation-7', previewId: 'p1', projectId: 'p1',
  casePath: '/cases/p1', inputDigest: 'sha256:feed',
  assetType: 'real-estate', methodRequest: 'market',
  baseDate: null, purpose: null, valueType: null, supplementalPrompt: '',
  files: [], fileCount: 0, overLimit: false, skipped: [], capabilityGaps: [],
  createdAt: '', expiresAt: '',
}

// ── 1. 两个必填项的空态 ────────────────────────────────────────────────────

test('新草稿：资产类型与评估方法**都未选择**（自动判定不是默认值）', () => {
  const fresh = state.initialValuationState()
  assert.equal(fresh.assetType, '', '资产类型初始为空')
  assert.equal(fresh.method, '', '评估方法初始为空（自动判定是一个选项，不是默认值）')
  assert.equal(state.chosenMethod(fresh.method), null, '空串不是有效方法')
  assert.equal(state.valuationMethodLabel(''), '', '空值不许被显示成「自动判定」')
  assert.equal(state.valuationMethodLabel('income-v2'), '', '未知枚举同样不许回退成「自动判定」')
  // 四项都是**有效**方法，其中包括 auto。
  for (const method of ['auto', 'market', 'income', 'cost']) {
    assert.equal(state.chosenMethod(method), method)
  }
})

test('开始新一轮：两个必填项一起清回未选择，保留最近会话入口', () => {
  const done = draftState({ phase: 'handed-off', recentSessionId: 'session-1', parentSessionId: 'session-1' })
  const next = state.resetAfterHandoff(done).state
  assert.equal(next.assetType, '', '新一轮要重新选资产类型')
  assert.equal(next.method, '', '新一轮要重新选评估方法')
  assert.equal(next.recentSessionId, 'session-1', '最近会话入口是唯一留下的东西')
  assert.equal(next.phase, 'draft')
})

test('setMethod：四项通过、空串清回未选、未知枚举与大小写变体被拒', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  for (const method of ['auto', 'market', 'income', 'cost']) {
    const outcome = state.setMethod(base, method)
    assert.equal(outcome.ok, true, method)
    assert.equal(outcome.state.method, method)
  }
  // 清回未选是合法的（"我选错了"）。
  assert.equal(state.setMethod({ ...base, method: 'cost' }, '').state.method, '')
  assert.equal(state.setMethod({ ...base, method: 'cost' }, '   ').state.method, '')
  // 未知枚举 / 大小写变体 / 带空白的枚举都要被拒（空串以外一律要求**逐字**等于已登记取值）。
  // 前后空白会被 trim（与资产类型 / 基准日同一口径），所以这里只列真正的非法取值。
  for (const bad of ['income-v2', 'MARKET', '收益法', '0']) {
    const outcome = state.setMethod(base, bad)
    assert.equal(outcome.ok, false, `${bad} 不该被接受`)
    assert.match(outcome.error, /不认识的评估方法/)
    assert.deepEqual(outcome.state, base, '被拒时状态必须原样返回')
  }
  // 只有草稿能改。
  const locked = state.initialValuationState({ phase: 'confirmation' })
  assert.equal(state.setMethod(locked, 'auto').ok, false)
})

test('底栏原因：两个必填项按页面顺序先报资产类型，再报评估方法', () => {
  const ready = draftState()
  assert.equal(state.startDisabledReason(ready), '')
  assert.equal(state.startDisabledReason({ ...ready, assetType: '' }),
    zhCN.valuationActionDisabledNoAssetType)
  assert.equal(state.startDisabledReason({ ...ready, method: '' }),
    zhCN.valuationActionDisabledNoMethod)
  assert.equal(state.startDisabledReason({ ...ready, assetType: '', method: '' }),
    zhCN.valuationActionDisabledNoAssetType, '两个都没选时先说要做的第一件')
  // 未知枚举也不会被当成"已经选了"。
  assert.equal(state.startDisabledReason({ ...ready, method: 'income-v2' }),
    zhCN.valuationPreviewIncomplete === '' ? '' : zhCN.valuationActionDisabledNoMethod)
})

// ── 2. 预览回包：缺字段 / 不一致必须留在草稿 ─────────────────────────────────

test('prepareReady：完整且与本次提交一致的回包才进确认，方法/资产类型取自 Host 回包', () => {
  const before = preparing({ assetType: 'real-estate', method: 'market' })
  const outcome = state.prepareReady(before, 7, previewViewOf(PREVIEW_OK))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.state.phase, 'confirmation')
  assert.equal(outcome.state.method, 'market', '方法以 Host 回显为准')
  assert.equal(outcome.state.assetType, 'real-estate')
  assert.equal(outcome.state.preview?.previewId, 'p1')
})

test('prepareReady：`ok:true` 但缺资产类型 / 方法 → 可恢复错误 + 留在草稿（输入一字不动）', () => {
  const before = preparing()
  for (const broken of [
    { ...PREVIEW_OK, assetType: '' },
    { ...PREVIEW_OK, methodRequest: '' },
    { ...PREVIEW_OK, methodRequest: 'income-v2' },
    { ...PREVIEW_OK, methodRequest: 'auto' },
  ]) {
    const outcome = state.prepareReady(before, 7, previewViewOf(broken))
    assert.equal(outcome.ok, true, '这是一次**可恢复**的失败，不是状态机拒绝')
    assert.equal(outcome.state.phase, 'draft', '留在可编辑草稿')
    assert.equal(outcome.state.preview, null, '不许把残缺回包当成预览')
    assert.notEqual(outcome.state.error, '', '要说清为什么没进确认')
    assert.equal(outcome.state.selection.length, before.selection.length, '输入必须保留')
    assert.equal(outcome.state.assetType, before.assetType)
    assert.equal(outcome.state.method, before.method, '不许沿用草稿里的旧方法冒充 Host 结论')
  }
  // 缺字段与"回显不一致"是两句话（不是一句泛化的"失败了"）。
  const incomplete = state.prepareReady(preparing(), 7, previewViewOf({ ...PREVIEW_OK, assetType: '' }))
  const mismatch = state.prepareReady(preparing(), 7, previewViewOf({ ...PREVIEW_OK, methodRequest: 'cost' }))
  assert.equal(incomplete.state.error, zhCN.valuationPreviewIncomplete)
  assert.equal(mismatch.state.error, zhCN.valuationPreviewMismatch)
})

test('prepareReady：`ok:false` 与迟到的 requestId 各自沿用原口径', () => {
  const failed = state.prepareReady(preparing(), 7, previewViewOf({ ok: false, error: '文件读不出来' }))
  assert.equal(failed.state.phase, 'draft')
  assert.equal(failed.state.error, '文件读不出来')
  const stale = state.prepareReady(preparing(), 6, previewViewOf(PREVIEW_OK))
  assert.equal(stale.ok, false)
  assert.equal(stale.error, zhCN.valuationStaleIntake)
  assert.equal(stale.state.phase, 'preparing-confirmation', '迟到的响应不许改状态')
})

test('controller：Host 回 `ok:true` 但缺资产类型时，页面留在草稿并给出可恢复错误', async () => {
  const calls = { intake: [] }
  const port = {
    fileInput: async () => [],
    preflight: async () => ({
      ok: true, error: '', sites: [], rows: [],
      gate: { released: true, required: [], optional: [], reason: '', unavailable: false, checkedAt: '' },
      loginJobs: [],
    }),
    scan: async () => ({ ok: true, items: [], files: [], fileCount: 0 }),
    intake: async (input) => {
      calls.intake.push(input)
      return { ...PREVIEW_OK, assetType: '', requestId: input.requestId }
    },
    start: async () => ({ ok: false, error: '不该走到这里' }),
    openSession: async () => ({ ok: true, error: '' }),
  }
  const controller = createReportEvaluationController(port, { initial: draftState() })
  controller.preparePreview()
  await tick()
  const after = controller.getState()
  assert.equal(calls.intake.length, 1, '确实发过一次准备请求')
  assert.equal(after.phase, 'draft', '残缺回包不许把页面推进到确认')
  assert.equal(after.preview, null)
  assert.equal(after.error, zhCN.valuationPreviewIncomplete)
  assert.equal(after.assetType, 'real-estate', '草稿的输入一字不动')
  assert.equal(after.method, 'market')
  // 提交给 Host 的是**收窄后的正式方法**（不是空串）。
  assert.equal(calls.intake[0].method, 'market')
  assert.equal(calls.intake[0].assetType, 'real-estate')
})

test('controller：空方法根本发不出准备请求（禁用判据与提交判据是同一处）', async () => {
  const calls = { intake: [] }
  const port = {
    fileInput: async () => [],
    preflight: async () => ({
      ok: true, error: '', sites: [], rows: [],
      gate: { released: true, required: [], optional: [], reason: '', unavailable: false, checkedAt: '' },
      loginJobs: [],
    }),
    scan: async () => ({ ok: true, items: [], files: [], fileCount: 0 }),
    intake: async (input) => { calls.intake.push(input); return PREVIEW_OK },
    start: async () => ({ ok: false, error: '不该走到这里' }),
    openSession: async () => ({ ok: true, error: '' }),
  }
  const controller = createReportEvaluationController(port, { initial: draftState({ method: '' }) })
  controller.preparePreview()
  await tick()
  assert.deepEqual(calls.intake, [], '没有方法就不该发准备请求')
  assert.equal(controller.getState().phase, 'draft')
  // 即使真的调到了状态机，`beginPrepare` 也会拒绝。
  assert.equal(state.beginPrepare(draftState({ method: '' }), 1).ok, false)
})

// ── 3. 文件夹真的能收起 ─────────────────────────────────────────────────────

function intakeProps(patch = {}) {
  return {
    state: draftState(patch),
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
    onPurposeChange: () => {}, onValueTypeChange: () => {}, onBackToEdit: () => {},
  }
}

test('文件夹展开 / 收起是真的：收起后子列表不渲染，aria-expanded 与实际一致', () => {
  const props = intakeProps()
  let tree = render(ValuationIntakePane, props).tree
  const toggle = () => findAll(tree, (node) => String(node.props?.className ?? '')
    .includes('crwu-valuation-entry-toggle'))[0]
  const sublistCount = () => findAll(tree, (node) => node.props?.['data-valuation-subfile-group'] !== undefined).length
  const subRows = () => findAll(tree, (node) => node.props?.['data-valuation-subfile'] !== undefined).length

  assert.equal(toggle().props['aria-expanded'], true, '默认展开（员工要看得到里面有什么）')
  assert.equal(sublistCount(), 1)
  assert.equal(subRows(), 2)

  // 收起：子列表**从树上消失**（于是被收起的后代也不在键盘顺序里）。
  toggle().props.onClick()
  tree = rerender(ValuationIntakePane, props)
  assert.equal(toggle().props['aria-expanded'], false)
  assert.equal(sublistCount(), 0, '收起后不许还画着子列表')
  assert.equal(subRows(), 0, '收起后里面的文件行一个都不该在')
  // 收起时也不该留着「查看全部」那条入口（它操作的是看不见的列表）。
  // ⚠️ 只数**这个入口里**的：辅助区的「查看详情」用的是同一个类名，它跟折叠无关。
  const entry = () => findAll(tree, (node) => node.props?.['data-valuation-entry'] !== undefined)[0]
  const moreInEntry = () => findAll(entry(), (node) => String(node.props?.className ?? '')
    .includes('crwu-valuation-more')).length
  assert.equal(moreInEntry(), 0)

  // 再展开：回到原样。
  toggle().props.onClick()
  tree = rerender(ValuationIntakePane, props)
  assert.equal(toggle().props['aria-expanded'], true)
  assert.equal(subRows(), 2)
})

test('资料区在两个必填项之前；两个必填项在补充条件与辅助区之前', () => {
  const tree = render(ValuationIntakePane, intakeProps()).tree
  const blocks = findAll(tree, (node) => node.props?.['data-valuation-block'] !== undefined)
    .map((node) => node.props['data-valuation-block'])
  assert.deepEqual(blocks, ['files', 'required', 'conditions', 'capability'])
})

// ── 4. 复制路径的短反馈会恢复，且卸载时清掉计时器 ────────────────────────────

test('复制路径：成功反馈约 1.5 秒后恢复；卸载时清掉计时器', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realNavigator = globalThis.navigator
  const timers = []
  const cleared = []
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length }
  globalThis.clearTimeout = (handle) => { cleared.push(handle) }
  // Node 的 `navigator` 是 getter-only（Node 22+）：只能 defineProperty，不能直接赋值。
  const defineNavigator = (value) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  }
  defineNavigator({ clipboard: { writeText: async () => undefined } })
  try {
    const rendered = render(CopyPathButton, { path: '/Users/someone/资料/估值报告.pdf' })
    const button = findAll(rendered.tree, (node) => node.type === 'button')[0]
    assert.equal(textOf(button), zhCN.valuationDrawerCopyPath)
    button.props.onClick()
    await flush()
    let tree = rerender(CopyPathButton, { path: '/Users/someone/资料/估值报告.pdf' })
    assert.equal(textOf(tree).includes(zhCN.valuationDrawerCopied), true, '成功就地出现短反馈')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, COPY_FEEDBACK_MS)
    assert.equal(COPY_FEEDBACK_MS, 1_500, '约 1.5 秒')
    // 到点之后反馈**恢复**（旧实现一旦置真就再也不下来）。
    timers[0].callback()
    tree = rerender(CopyPathButton, { path: '/Users/someone/资料/估值报告.pdf' })
    assert.equal(textOf(tree).includes(zhCN.valuationDrawerCopied), false)
    // 失败给的是真实可执行的提示。
    defineNavigator({ clipboard: { writeText: async () => { throw new Error('denied') } } })
    button.props.onClick()
    await flush()
    tree = rerender(CopyPathButton, { path: '/Users/someone/资料/估值报告.pdf' })
    assert.equal(textOf(tree).includes(zhCN.valuationDrawerCopyFailed), true)
    // 卸载：effect 的清理函数必须把计时器清掉。
    const dispose = rendered.instance.effects.map((effect) => effect.callback())
      .filter((item) => typeof item === 'function')
    assert.equal(dispose.length, 1, '组件要登记一条"卸载时清计时器"的清理')
    for (const item of dispose) item()
    assert.ok(cleared.length >= 1, '卸载时必须 clearTimeout')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    if (realNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true, writable: true })
  }
})

// ── 5. 抽屉的事实源是 Host 回包，不是草稿 ────────────────────────────────────

test('抽屉的资产类型与方法只认 Host 回包（组件不再接收草稿方法）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT), 'utf8')
  assert.equal(/method: ValuationMethod/.test(source), false, '抽屉不再接收一份会漂移的草稿方法')
  assert.match(source, /valuationMethodLabel\(preview\.methodRequest\)/)
  assert.match(source, /assetTypeLabelOf\(preview\.assetType\)/)
  const pane = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT), 'utf8')
  assert.equal(/method=\{state\.method\}/.test(pane), false, '外层也不再传草稿方法')
  assert.match(pane, /onCheckCapability=\{controller\.recheckAuth\}/, '抽屉里复用同一份辅助动作')
  // 旧的能力限制文案与本轮冲突的那两句必须消失。
  const locale = readFileSync(new URL('src/client/locales/zh-CN.ts', ROOT), 'utf8')
  assert.equal(/收益法、成本法尚未提供/.test(locale), false, '旧的能力限制文案不许回来')
  assert.equal(/当前支持住宅市场法/.test(locale), false)
})

test('创建期间辅助区不再发起登录 / 验证 / 检查（在途任务仍可取消）', () => {
  const { ValuationCapabilityArea } = capabilityModule
  const unauthenticated = {
    check: 'ready', gate: null, loginJobs: [], error: '', job: null,
    sites: [],
    rows: [{
      siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '未检测到登录状态',
      required: false, stateLabel: '未登录',
    }],
  }
  const props = (patch = {}, handlers = {}) => ({
    state: state.initialValuationState({ phase: 'creating-session', login: unauthenticated, ...patch }),
    onRecheck: () => {}, onLogin: () => {}, onCancelLogin: () => {}, onVerify: () => {},
    ...handlers,
  })
  // 草稿里可以就地登录。
  const open = render(ValuationCapabilityArea, props({ phase: 'draft' })).tree
  const loginButton = () => findAll(open, (node) => node.props?.['data-valuation-capability-action'] === 'login')[0]
  assert.equal(loginButton().props.disabled, false, '草稿里登录入口可用')
  // 创建期间：不再发起新的登录 / 检查；"去验证"同理（它是新发起的一次窗口操作）。
  const locked = render(ValuationCapabilityArea, props()).tree
  const lockedActions = findAll(locked, (node) => node.props?.['data-valuation-capability-action'] !== undefined)
  assert.ok(lockedActions.length >= 2, '辅助区要有可识别的动作按钮')
  for (const action of lockedActions) {
    assert.equal(action.props.disabled, true, `${String(action.props['data-valuation-capability-action'])} 在创建期间必须禁用`)
  }
  // 在途任务的"取消/去验证"照旧可用（冻结的是"新发起"，不是把在跑的任务丢掉）。
  let cancelled = 0
  const running = render(ValuationCapabilityArea, props({
    login: { ...unauthenticated, job: { jobId: 'j1', siteId: 'lianjia', state: 'running', startedAt: 1, finishedAt: null, detail: '', sites: [], commandOk: false, recoveryAttempts: 0 } },
  }, { onCancelLogin: () => { cancelled += 1 } })).tree
  const cancel = findAll(running, (node) => node.type === 'button' && textOf(node) === zhCN.valuationAuthLoginCancel)[0]
  assert.ok(cancel, '在途登录任务要保留取消入口')
  assert.notEqual(cancel.props.disabled, true, '取消在途任务不受创建锁定影响（它不是"新发起"）')
  cancel.props.onClick()
  assert.equal(cancelled, 1, '取消按钮要真的接到回调上')
})

test('信息获取辅助：对外名字统一、说明始终可见、辅助区错误不再借用整页 error', async () => {
  const { readFileSync } = await import('node:fs')
  const { zhCN: locale } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
  assert.equal(locale.valuationCapabilityTitle, '信息获取辅助')
  assert.equal(locale.valuationCapabilityOptional, '可选')
  assert.equal(locale.valuationCapabilityDescription, '用于辅助获取公开信息；未登录可继续估值。')
  const source = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ValuationCapabilityArea.tsx', ROOT), 'utf8')
  // 辅助区只说**这次检查**的失败；文件校验 / 交接失败属于别处，不许在这里再出现一次。
  assert.equal(/login\.error !== '' \|\| state\.error !== ''/.test(source), false,
    '辅助区不许把整页 error 当成自己的失败')
  assert.match(source, /data-valuation-capability-summary/, '摘要行始终在')
  assert.match(source, /data-valuation-auth-fallback/, '未登录时说明降级平台')
  // 对外不再叫「案例来源」（业务证据里的"案例"概念不在这里）。
  assert.equal(/valuationCapabilityTitle: '案例来源'/.test(readFileSync(
    new URL('src/client/locales/zh-CN.ts', ROOT), 'utf8')), false)
})
