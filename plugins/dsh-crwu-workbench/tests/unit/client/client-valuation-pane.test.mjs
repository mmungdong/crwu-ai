/**
 * 房地产启动页（协议 35）：状态机 + 输入工作面 + 只读确认抽屉。
 *
 * 这一份钉的是"页面自己"的三条口径（门禁 / 抽屉 / 跳转在 `client-valuation-handoff` 里）：
 *
 * 1. **输入只在草稿阶段可改**：`preparing-confirmation` 之后所有改输入的动作都被拒，
 *    并把原因写进 `error`（不是静默无动作）；
 * 2. **份数以递归去重后的文件数**为准：>30 整批阻止、0 份 / 全不可读不能启动，
 *    每条禁用原因都要**可见**（`aria-describedby` 关联到按钮）；
 * 3. **禁用项在状态机里也拒绝**：收益法 / 成本法只禁用界面是不够的。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const state = await import(new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { VALUATION_CLASSES } = await import(
  new URL('src/client/modules/report-evaluation/model/styles.ts', ROOT).href)
const { createReportEvaluationController, preflightViewOf, previewViewOf, handoffViewOf } = await import(
  new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { ValuationIntakePane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx', ROOT).href)
const { ValuationConfirmationDrawer } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT).href)
const { Select } = await import(
  new URL('src/client/ui/components/Select.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { VALUATION_PROMPT_MAX_LENGTH } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { render, rerender, find, findAll, textOf } = await import(new URL('tests/helpers/render.mjs', ROOT).href)

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

const PREFLIGHT_RELEASED = {
  ok: true,
  error: '',
  sites: [],
  rows: [],
  gate: { released: true, required: [], optional: [], reason: '', unavailable: false, checkedAt: '' },
  loginJobs: [],
}

const FILE_FACTS = {
  fileCount: 2,
  overLimit: false,
  readableCount: 2,
  limit: 30,
}

/** 一份"已经扫完、可以确认"的草稿状态。 */
function draftState(patch = {}) {
  return state.initialValuationState({
    phase: 'draft',
    // 大多数用例关心的是资料 / 方法 / 文本判据；资产类型有它自己的专门用例，
    // 这里先选上房地产，免得每条用例都被"未选资产类型"挡住。
    assetType: 'real-estate',
    // 本轮起**方法没有默认值**（空态 = 还没选）：关心其它行为的用例统一显式选一项，
    // 空态与校验由「必填两项」那组专门用例覆盖。
    method: 'auto',
    selection: ['/Users/someone/资料/估值报告.pdf'],
    files: [{
      path: '/Users/someone/资料/估值报告.pdf', name: '估值报告.pdf', dirHint: '',
      kind: 'pdf', sizeBytes: 2048, status: 'scanned', reason: '', fileCount: 1,
    }],
    scanState: 'ready',
    ...FILE_FACTS,
    ...patch,
  })
}

// ── 状态机：能改 / 不能改 ────────────────────────────────────────────────────

test('只有 draft 能改输入；其余阶段被拒并给出对症的原因', () => {
  const editable = ['draft']
  const locked = ['preparing-confirmation', 'confirmation',
    'creating-session', 'handoff-failed', 'handed-off', 'stale-host']
  for (const phase of editable) assert.equal(state.canEditInputs(phase), true, phase)
  for (const phase of locked) {
    assert.equal(state.canEditInputs(phase), false, phase)
    const base = state.initialValuationState({ phase })
    for (const mutate of [
      () => state.setSelection(base, ['/tmp/x.pdf']),
      () => state.setMethod(base, 'market'),
      () => state.setBaseDate(base, '2026-06-30'),
      () => state.setSupplementalPrompt(base, '改一句'),
    ]) {
      const outcome = mutate()
      assert.equal(outcome.ok, false, `${phase} 阶段不该允许改输入`)
      assert.notEqual(outcome.error, '', '被拒时必须给出原因')
      assert.deepEqual(outcome.state, base, '被拒时状态必须原样返回')
    }
  }
  // 每种"不能改"都有**对症**的一句话（不是一律"已冻结"）。
  const reasons = locked.map((phase) => state.inputLockedReason(phase))
  assert.equal(new Set(reasons).size >= 4, true, `原因文案要分情形给出，实际：${reasons.join(' / ')}`)
})

test('阶段与显示判据：只有输入工作面 / 确认抽屉两段，没有门禁屏', () => {
  // 协议 39：登录是可选用能力，"进页面先等一次门禁检查"这个阶段被删除。
  for (const phase of ['draft', 'preparing-confirmation', 'confirmation', 'creating-session']) {
    assert.equal(state.showsAuthGate(phase), false, phase)
  }
  assert.equal(state.showsIntakeForm('draft'), true)
  assert.equal(state.showsIntakeForm('preparing-confirmation'), true)
  assert.equal(state.showsIntakeForm('confirmation'), false)
  assert.equal(state.showsConfirmationDrawer('confirmation'), true)
  assert.equal(state.showsConfirmationDrawer('preparing-confirmation'), false)
  // 初始状态是**草稿**：进页面不做任何来源探测，资料随时可整理。
  assert.equal(state.initialValuationState().phase, 'draft')
  assert.equal(state.initialValuationState().login.check, 'idle')
})

test('资产类型：初始为空、未选不能确认、只认已登记取值', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  assert.equal(base.assetType, '', '通用入口的资产类型初始必须是空（不替用户默认房地产）')
  const scanned = state.scanReady(
    { ...base, selection: ['/a'] },
    [{ path: '/a', name: 'a', dirHint: '', kind: 'directory', sizeBytes: 0, status: 'scanned', reason: '', fileCount: 1 }],
    [{ path: '/a/a.pdf', name: 'a.pdf', kind: 'pdf', sizeBytes: 1, parentPath: '/a', state: 'included' }],
    { fileCount: 1, readableCount: 1, overLimit: false, limit: 30, truncated: false },
  ).state
  assert.match(state.startDisabledReason(scanned), /资产类型/)
  const picked = state.setAssetType(base, 'real-estate')
  assert.equal(picked.ok, true)
  assert.equal(picked.state.assetType, 'real-estate')
  const unknown = state.setAssetType(base, '机器设备')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /不认识的资产类型/)
  // 清回空串是合法的（"我选错了"），但那时又不能确认了。
  assert.equal(state.setAssetType(picked.state, '').state.assetType, '')
})

test('方法：四项全部可选（适用性由本轮业务规范判断，界面不预先禁用）', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  for (const method of ['auto', 'market', 'income', 'cost']) {
    assert.equal(state.setMethod(base, method).ok, true, method)
  }
  const options = state.valuationMethodOptions()
  assert.deepEqual(options.map((option) => option.value), ['auto', 'market', 'income', 'cost'])
  assert.deepEqual(options.map((option) => option.disabled), [false, false, false, false])
})

test('基准日：空串合法，非 YYYY-MM-DD 一律拒绝（不做"尽量解析"）', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  assert.equal(state.setBaseDate(base, '').ok, true)
  assert.equal(state.setBaseDate(base, '2026-06-30').ok, true)
  for (const bad of ['2026/06/30', '26-06-30', '2026-6-3', '今天', '2026-06-30T00:00:00Z']) {
    const outcome = state.setBaseDate(base, bad)
    assert.equal(outcome.ok, false, bad)
    assert.match(outcome.error, /YYYY-MM-DD/)
  }
})

test('补充要求：上限 4000 与 Host 同步（超限直接拒绝并注明上限）', () => {
  assert.equal(VALUATION_PROMPT_MAX_LENGTH, 4000)
  const base = state.initialValuationState({ phase: 'draft' })
  assert.equal(state.setSupplementalPrompt(base, 'x'.repeat(4000)).ok, true)
  const over = state.setSupplementalPrompt(base, 'x'.repeat(4001))
  assert.equal(over.ok, false)
  assert.match(over.error, /4000/)
})

// ── 启动条件：份数 / 可读 / 上限 ────────────────────────────────────────────

test('启动条件逐条给出可见原因：0 份 / 扫描中 / >30 整批阻止 / 全不可读', () => {
  const empty = state.initialValuationState({ phase: 'draft' })
  assert.equal(state.canStart(empty), false)
  assert.match(state.startDisabledReason(empty), /先添加至少一份/)

  const scanning = state.initialValuationState({ phase: 'draft', selection: ['/a'], scanState: 'scanning' })
  assert.match(state.startDisabledReason(scanning), /正在读取资料清单/)

  const over = state.initialValuationState({
    phase: 'draft', selection: ['/a'], scanState: 'ready', fileCount: 31, readableCount: 31, overLimit: true,
  })
  const overReason = state.startDisabledReason(over)
  assert.match(overReason, /31/)
  assert.match(overReason, /不会悄悄只取前/)

  const unreadable = state.initialValuationState({
    phase: 'draft', selection: ['/a'], scanState: 'ready', fileCount: 2, readableCount: 0,
  })
  assert.match(state.startDisabledReason(unreadable), /读不出来/)

  assert.equal(state.canStart(draftState()), true)
  assert.equal(state.startDisabledReason(draftState()), '')
})

test('「确认」在没有任何资料时被拒，并把原因写进 error（不静默）', () => {
  const controller = createReportEvaluationController(fakePort(), { initial: { phase: 'draft' } })
  controller.preparePreview()
  assert.match(controller.getState().error, /先添加至少一份/)
  assert.equal(controller.getState().phase, 'draft', '状态不动，只把原因写进 error')
})

// ── 门禁：三个落点 ──────────────────────────────────────────────────────────

function fakePort(overrides = {}) {
  const calls = { preflight: [], intake: [], start: [], scan: [] }
  return {
    calls,
    fileInput: async () => [],
    preflight: async (input) => { calls.preflight.push(input ?? {}); return PREFLIGHT_RELEASED },
    intake: async (input) => { calls.intake.push(input); return { ok: false, error: '不该走到这里' } },
    start: async (input) => { calls.start.push(input); return { ok: false, error: '不该走到这里' } },
    scan: async (input) => { calls.scan.push(input); return { ok: true, items: [], fileCount: 0, overLimit: false, readableCount: 0, limit: 30 } },
    openSession: async () => ({ ok: true, error: '' }),
    ...overrides,
  }
}

test('能力落点：未登录 / 查不出来都**不改阶段**（登录是可选用能力，不是门禁）', () => {
  const released = state.authReady(state.initialValuationState({ phase: 'draft' }), preflightViewOf(PREFLIGHT_RELEASED))
  assert.deepEqual([released.ok, released.state.phase], [true, 'draft'])

  const blocked = preflightViewOf({
    ok: true, error: '',
    sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有 Cookie' }],
    rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '没有 Cookie', required: false, stateLabel: '未登录' }],
    gate: { released: false, required: [], optional: ['lianjia'], reason: '链家 未登录', unavailable: false, checkedAt: '2026-10-15T02:00:00.000Z' },
  })
  const blockedState = state.authReady(state.initialValuationState({ phase: 'draft' }), blocked)
  assert.deepEqual([blockedState.ok, blockedState.state.phase], [true, 'draft'], '未登录不把页面挡在草稿之外')
  assert.equal(blockedState.state.login.rows[0].stateLabel, '未登录')
  assert.equal(blockedState.state.login.gate.reason, '链家 未登录')
  assert.equal(blockedState.state.login.gate.checkedAt, '2026-10-15T02:00:00.000Z', '检查时刻跟着结论一起走')

  const unavailable = state.authFailed(state.initialValuationState({ phase: 'draft' }), '站点清单读不出来')
  assert.equal(unavailable.state.phase, 'draft')
  assert.equal(unavailable.state.login.gate.unavailable, true)
  assert.equal(unavailable.state.login.gate.reason, '站点清单读不出来')
})

test('门禁预检应答收窄：缺字段时是"查不出来"，不是"已登录"', () => {
  const view = preflightViewOf({ ok: true })
  assert.deepEqual(view.sites, [])
  assert.equal(view.gate.released, false, '没有结论不许放行')
  assert.equal(preflightViewOf({ ok: false, error: '浏览器不可用' }).gate.unavailable, true)
})

test('登录任务：reused 说明"正在登录"，失败如实报错', () => {
  const base = state.initialValuationState({
    phase: 'auth-blocked',
    login: {
      check: 'ready', gate: null, sites: [], loginJobs: [], error: '',
      rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '', required: true, stateLabel: '未登录' }],
      job: null,
    },
  })
  const reused = state.loginStarted(base, {
    ok: true, error: '', jobId: 'login-1', reused: true,
    job: { jobId: 'login-1', siteId: 'lianjia', state: 'running', startedAt: 1, finishedAt: null, detail: '', sites: [], commandOk: false, recoveryAttempts: 0 },
  })
  assert.equal(reused.state.notice.includes('正在登录'), true)
  assert.equal(reused.state.login.job.jobId, 'login-1')

  const failed = state.loginStarted(base, { ok: false, error: '起不来', jobId: '', reused: false, job: null })
  assert.equal(failed.state.error, '起不来')
  assert.equal(failed.state.login.job, null)
})

// ── 扫描：份数是 Host 报的递归去重结果 ──────────────────────────────────────

test('扫描落地用 Host 的 fileCount / overLimit / readableCount；改选择清掉上一次的扫描事实', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  const ready = state.scanReady(base, [], [], { fileCount: 7, overLimit: false, readableCount: 5, limit: 30 })
  assert.equal(ready.state.fileCount, 7)
  assert.equal(ready.state.readableCount, 5)
  assert.equal(ready.state.scanState, 'ready')

  const next = state.setSelection(ready.state, ['/other'])
  assert.equal(next.state.fileCount, 0, '换了选择，上一次的份数不再是事实')
  assert.equal(next.state.scanState, 'idle')
  assert.deepEqual(next.state.files, [])
  assert.deepEqual(next.state.fileRows, [])
})

test('扫描 items 收成逐份视图：重名的才附目录摘要', () => {
  const rows = state.selectedFilesOf([
    { path: '/a/资料/报告.pdf', name: '报告.pdf', kind: 'pdf', sizeBytes: 10, status: 'scanned', fileCount: 1 },
    { path: '/b/备份/报告.pdf', name: '报告.pdf', kind: 'pdf', sizeBytes: 20, status: 'scanned', fileCount: 1 },
    { path: '/a/资料/独一份.xlsx', name: '独一份.xlsx', kind: 'excel', sizeBytes: 30, status: 'scanned', fileCount: 1 },
  ], [])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].dirHint, '/a/资料')
  assert.equal(rows[1].dirHint, '/b/备份')
  assert.equal(rows[2].dirHint, '', '不重名的行不加目录摘要')
})

test('创建时间为 null → 「创建时间未知」；认得出的字面量原样取（不做时区换算）', () => {
  assert.equal(state.createdAtTextOf(null), zhCN.valuationDrawerCreatedAtUnknown)
  assert.equal(state.createdAtTextOf(''), zhCN.valuationDrawerCreatedAtUnknown)
  assert.equal(state.createdAtTextOf('2026-02-01T02:03:04.000Z'), '2026-02-01 02:03')
  assert.equal(state.createdAtTextOf('2026-02-01'), '2026-02-01')
})

test('字节数：0 / 拿不到时给空串（不编「0 B」当事实）', () => {
  assert.equal(state.formatBytes(0), '')
  assert.equal(state.formatBytes(Number.NaN), '')
  assert.equal(state.formatBytes(512), '512 B')
  assert.equal(state.formatBytes(2048), '2.0 KB')
  assert.equal(state.formatBytes(3 * 1024 * 1024), '3.0 MB')
})

// ── 输入工作面渲染 ──────────────────────────────────────────────────────────

test('P16：评估目的 / 价值类型只在草稿可改；超长被拒并给出可见原因', () => {
  const base = state.initialValuationState({ phase: 'draft' })
  assert.equal(state.setPurpose(base, '司法拍卖处置参考').ok, true)
  assert.equal(state.setValueType(base, '市场价值').ok, true)
  const filled = state.setValueType(state.setPurpose(base, '司法拍卖处置参考').state, '市场价值').state
  assert.equal(filled.purpose, '司法拍卖处置参考')
  assert.equal(filled.valueType, '市场价值')

  for (const phase of ['preparing-confirmation', 'confirmation', 'creating-session']) {
    const locked = state.initialValuationState({ phase })
    for (const outcome of [state.setPurpose(locked, '抵押'), state.setValueType(locked, '投资价值')]) {
      assert.equal(outcome.ok, false, `${phase} 不该允许改评估目的 / 价值类型`)
      assert.notEqual(outcome.error, '')
    }
  }
  const tooLong = state.setPurpose(base, 'x'.repeat(401))
  assert.equal(tooLong.ok, false, '超长必须被拒（不许静默截断）')
  assert.equal(tooLong.state.purpose, '')
})

test('P16：输入页有评估目的与价值类型两个字段；未填不预置任何正式结论', () => {
  const { tree } = intakeTree()
  const purpose = find(tree, (node) => node.props?.['data-valuation-purpose'] === 'true')
  const valueType = find(tree, (node) => node.props?.['data-valuation-value-type'] === 'true')
  assert.ok(purpose, '评估目的必须是**结构化**输入控件（不是塞在补充要求里）')
  assert.ok(valueType, '价值类型必须是**结构化**输入控件')
  assert.equal(purpose.props.value, '', '未填就是空，不许预置"转让/抵押"这类默认目的')
  assert.equal(valueType.props.value, '', '未填就是空，不许预置"市场价值"这类默认价值类型')
  // label 常驻：两个字段各自有一句常驻说明，且不是 placeholder 顶替。
  assert.equal(textOf(tree).includes(zhCN.valuationPurposeTitle), true)
  assert.equal(textOf(tree).includes(zhCN.valuationValueTypeTitle), true)
  assert.equal(textOf(tree).includes(zhCN.valuationPurposeHintEmpty), true)
  assert.equal(textOf(tree).includes(zhCN.valuationValueTypeHintEmpty), true)
  // 唯一 primary 仍然是「确认」。
  const primaries = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))
  assert.equal(primaries.length, 1)
  assert.equal(textOf(primaries[0]), zhCN.valuationConfirm)
})

function intakeProps(patch = {}, handlers = {}) {
  return {
    state: draftState(patch),
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onMethodChange: () => {}, onBaseDateChange: () => {}, onPromptChange: () => {}, onConfirm: () => {},
    onPurposeChange: () => {}, onValueTypeChange: () => {},
    onBackToEdit: () => {},
    ...handlers,
  }
}

function intakeTree(patch = {}, handlers = {}) {
  const props = intakeProps(patch, handlers)
  return { tree: render(ValuationIntakePane, props).tree, props }
}

test('输入页：前 8 条 + 「查看全部 N 份」；主操作逐字「确认」且是唯一 primary', () => {
  // §8.2 的"前 8 条"说的是**入口展开后的文件行**，不是把入口本身截断。
  const fileRows = Array.from({ length: 11 }, (_, index) => ({
    path: `/a/资料/文件-${String(index + 1)}.pdf`, name: `文件-${String(index + 1)}.pdf`,
    kind: 'pdf', sizeBytes: 10, parentPath: '/a/资料', state: 'included',
  }))
  const files = [{
    path: '/a/资料', name: '资料', dirHint: '', kind: 'directory',
    sizeBytes: 0, status: 'scanned', reason: '', fileCount: 11,
  }]
  const { tree, props } = intakeTree({ files, fileRows, fileCount: 11, readableCount: 11, selection: ['/a/资料'] })
  const subRows = (node) => findAll(node, (item) => String(item.props?.className ?? '') === 'crwu-valuation-subfile')
  assert.equal(subRows(tree).length, 8, '默认展开到首批 8 条')
  const more = findAll(tree, (node) =>
    String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-more'))
    .find((node) => textOf(node).includes('11'))
  assert.ok(more, '要有「查看全部 N 份」')
  more.props.onClick()
  const expanded = rerender(ValuationIntakePane, props)
  assert.equal(subRows(expanded).length, 11, '展开后要看得到全部 11 份')

  const primaries = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))
  assert.equal(primaries.length, 1, '一屏一个 primary')
  assert.equal(textOf(primaries[0]), zhCN.valuationConfirm)
})

test('输入页：禁用时原因可见并与按钮关联；准备中也用同一颗按钮说「正在准备…」', () => {
  const empty = intakeTree({ selection: [], files: [], fileCount: 0, readableCount: 0, scanState: 'idle' })
  const primary = findAll(empty.tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(primary.props.disabled, true)
  assert.equal(primary.props['aria-describedby'], VALUATION_CLASSES.actionReason)
  const reason = find(empty.tree, (node) => node.props?.id === VALUATION_CLASSES.actionReason)
  assert.ok(reason, '禁用原因必须可见')
  assert.match(textOf(reason), /先添加至少一份/)

  const preparing = intakeTree({ phase: 'preparing-confirmation' })
  const pending = findAll(preparing.tree, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(textOf(pending), zhCN.valuationPreparePending)
  assert.equal(pending.props.disabled, true)
})

test('输入页：两个必填项紧跟资料区，用同一种单选下拉（四项可选 + 轻量推荐 + 必填标记）', () => {
  // 这条用例专门看**未选**的初始态，所以显式清掉夹具里的填充。
  const { tree } = intakeTree({ assetType: '', method: '' })

  // ① 分区顺序就是任务顺序：资料 → 两个必填项 → 补充条件 → 信息获取辅助。
  const order = findAll(tree, (node) => node.props?.['data-valuation-block'] !== undefined)
    .map((node) => node.props['data-valuation-block'])
  assert.deepEqual(order, ['files', 'required', 'conditions', 'capability'],
    '必填两项必须紧接资料区、排在所有可选条件与辅助能力之前')

  // ② 两个必填项是**同一种**单选下拉（select-only combobox），不是原生 select、不是一排 radio。
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 0, '不再用原生 select')
  assert.equal(findAll(tree, (node) => node.type === 'input' && node.props?.type === 'radio').length, 0,
    '不再用一排 radio')
  const asset = find(tree, (node) => node.props?.['data-valuation-select'] === 'asset-type')
  const method = find(tree, (node) => node.props?.['data-valuation-select'] === 'method')
  assert.ok(asset, '资产类型下拉要在')
  assert.ok(method, '评估方法下拉要在')
  const assetTrigger = findAll(asset, (node) => node.props?.role === 'combobox')[0]
  const methodTrigger = findAll(method, (node) => node.props?.role === 'combobox')[0]
  assert.equal(assetTrigger.props['aria-haspopup'], 'listbox')
  assert.equal(assetTrigger.props['aria-expanded'], false, '初始是收起的')
  assert.equal(assetTrigger.props['aria-controls'], undefined, '收起时不指向不存在的 listbox')
  assert.equal(textOf(asset).includes(zhCN.valuationAssetTypePlaceholder), true)
  assert.equal(textOf(method).includes(zhCN.valuationMethodPlaceholder), true)
  // 两个必填项都声明了必填，并带"必填"读屏文字（星号只是视觉）。
  assert.equal(assetTrigger.props['aria-required'], true)
  assert.equal(methodTrigger.props['aria-required'], true)
  assert.equal(textOf(tree).includes(zhCN.valuationFieldRequired), true)
  // 可见标签与控件**真的关联**（aria-labelledby 指向页面上的标签元素）。
  for (const trigger of [assetTrigger, methodTrigger]) {
    const labelledBy = String(trigger.props['aria-labelledby'] ?? '')
    assert.notEqual(labelledBy, '', '控件要有可访问名称')
    for (const id of labelledBy.split(' ').filter((one) => one !== '')) {
      assert.ok(find(tree, (node) => node.props?.id === id), `aria-labelledby 指向的 #${id} 必须存在`)
    }
  }
  // 方法选项来自状态机的同一份清单（四项全可选 + 自动判定带轻量「推荐」）。
  const methodOptions = state.valuationMethodOptions()
  const opened = render(Select, {
    name: 'method', labelId: 'crwu-valuation-method-label', value: '', placeholder: '请选择评估方法',
    options: methodOptions.map((option) => ({ value: option.value, label: option.label, hint: option.hint })),
    dataAttributes: { 'data-valuation-select': 'method' },
    optionAttributes: (option) => ({ 'data-valuation-option': option.value }),
    onChange: () => {},
  }).tree
  const openedTrigger = findAll(opened, (node) => node.props?.role === 'combobox')[0]
  openedTrigger.props.onClick()
  const openedList = rerender(Select, {
    name: 'method', labelId: 'crwu-valuation-method-label', value: '', placeholder: '请选择评估方法',
    options: methodOptions.map((option) => ({ value: option.value, label: option.label, hint: option.hint })),
    dataAttributes: { 'data-valuation-select': 'method' },
    optionAttributes: (option) => ({ 'data-valuation-option': option.value }),
    onChange: () => {},
  })
  const options = findAll(openedList, (node) => node.props?.role === 'option')
  assert.deepEqual(options.map((node) => node.props['data-valuation-option']),
    ['auto', 'market', 'income', 'cost'])
  for (const option of options) assert.notEqual(option.props['aria-disabled'], true, '四项都不禁用')

  // ③ 辅助区在页面上（不是整页门禁屏），摘要行与检查时刻都在。
  assert.ok(find(tree, (node) => node.props?.['data-valuation-capability'] !== undefined), '页面下方要有辅助区')
  assert.ok(find(tree, (node) => node.props?.['data-valuation-capability-summary'] !== undefined), '辅助区要有摘要行')
  assert.ok(find(tree, (node) => node.props?.['data-valuation-capability-checked-at'] !== undefined), '要带检查时刻')

  // 上限不再靠 `maxLength` 静默截断（那会把粘贴超长当成什么都没发生）：
  // 由状态机拒绝并给出明确说明（见 client-valuation-scope 的 UX-18 用例）。
  const textarea = findAll(tree, (node) =>
    String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-prompt'))[0]
  assert.equal(textarea.props.maxLength, undefined, '不许用 maxLength 静默截断')
})

test('输入页：初次进入不显示字段红字；失焦或清空已填值之后才有短错误', () => {
  const fresh = intakeTree({ assetType: '', method: '' })
  assert.equal(findAll(fresh.tree, (node) => node.props?.['data-valuation-field-error'] !== undefined).length, 0,
    '初次进入不是满屏红字')
  // 失焦之后：只在**空的**那个字段下面出现一句短错误。
  const assetTrigger = findAll(fresh.tree, (node) => node.props?.role === 'combobox'
    && String(node.props?.id ?? '').includes('asset-type'))[0]
  assetTrigger.props.onBlur()
  const blurred = rerender(ValuationIntakePane, fresh.props)
  const errors = findAll(blurred, (node) => node.props?.['data-valuation-field-error'] !== undefined)
  assert.deepEqual(errors.map((node) => node.props['data-valuation-field-error']), ['asset-type'])
  assert.equal(textOf(errors[0]), zhCN.valuationActionDisabledNoAssetType)

  // 清空一个**已经填过**的必填项：同样给出短错误（清空是用户动作，不是初次进入）。
  const filled = intakeTree({ assetType: 'real-estate', method: 'auto' }, {})
  const filledProps = { ...filled.props, state: draftState({ assetType: '', method: 'auto' }) }
  const cleared = rerender(ValuationIntakePane, filledProps)
  const clearedErrors = findAll(cleared, (node) => node.props?.['data-valuation-field-error'] !== undefined)
  assert.deepEqual(clearedErrors.map((node) => node.props['data-valuation-field-error']), ['asset-type'])
})

test('输入页：底栏显示的必填原因与字段顺序一致（先资产类型，再评估方法）', () => {
  const base = draftState({ assetType: 'real-estate', method: 'auto' })
  assert.equal(state.startDisabledReason(base), '')
  assert.equal(state.startDisabledReason({ ...base, method: '' }), zhCN.valuationActionDisabledNoMethod)
  assert.equal(state.startDisabledReason({ ...base, assetType: '' }), zhCN.valuationActionDisabledNoAssetType)
  // 两个都没选时说**先**要做的那个（资产类型）—— 与页面上的顺序一致。
  assert.equal(state.startDisabledReason({ ...base, assetType: '', method: '' }),
    zhCN.valuationActionDisabledNoAssetType)
})

// ── 只读确认抽屉 ────────────────────────────────────────────────────────────

function drawerTree(overrides = {}) {
  const preview = previewViewOf({
    ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'sha256:feed', methodRequest: 'market',
    baseDate: null, supplementalPrompt: '',
    files: [{
      fileId: 'material-001', fileName: '估值报告.pdf', absolutePath: '/Users/someone/资料/估值报告.pdf',
      archiveRelativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 2048, sha256: 'a'.repeat(64),
      createdAt: null, modifiedAt: '2026-03-01T00:00:00.000Z', readable: true, duplicateOf: null,
    }],
    fileCount: 1,
  })
  // 资产类型与方法**只来自 Host 回包**（`preview`）：调用方不再传一份可能漂移的草稿方法。
  return render(ValuationConfirmationDrawer, {
    preview, state: draftState({ phase: 'confirmation', preview }),
    open: true, creating: false, onBack: () => {}, onConfirm: () => {},
    onCheckCapability: () => {}, onLoginSite: () => {}, onVerifySite: () => {}, onCancelLogin: () => {},
    ...overrides,
  }).tree
}

test('抽屉：只读（方法整组 disabled）、基准日未指定、确认按钮变「正在创建会话…」', () => {
  const tree = drawerTree()
  // 只读是**结构性**的：抽屉里没有任何可编辑控件，方法只是一条读数。
  assert.equal(findAll(tree, (node) => node.type === 'input').length, 0)
  assert.equal(findAll(tree, (node) => node.type === 'textarea').length, 0)
  const method = find(tree, (node) => node.props?.['data-valuation-readonly'] === 'method')
  assert.equal(textOf(method), zhCN.valuationMethodMarket)
  assert.equal(textOf(tree).includes(zhCN.valuationDrawerNoBaseDate), true)
  assert.equal(textOf(tree).includes(zhCN.valuationDrawerCreatedAtUnknown), true, 'createdAt=null 要明说未知')

  const creating = drawerTree({ creating: true })
  const primary = findAll(creating, (node) => node.type === 'button'
    && String(node.props?.className ?? '').includes(VALUATION_CLASSES.btnPrimary))[0]
  assert.equal(textOf(primary), zhCN.valuationCreatingSession)
  assert.equal(primary.props.disabled, true, '创建期间不许重复点')
})

test('P16：抽屉只读展示评估目的与价值类型；未填时逐字写明「未指定」', () => {
  const blank = drawerTree()
  // 未指定不是空白一格：必须有一句可读的说明（与基准日同一种做法）。
  assert.equal(textOf(blank).includes(zhCN.valuationDrawerNoPurpose), true)
  assert.equal(textOf(blank).includes(zhCN.valuationDrawerNoValueType), true)
  const purposeCell = find(blank, (node) => node.props?.['data-valuation-readonly'] === 'purpose')
  const valueTypeCell = find(blank, (node) => node.props?.['data-valuation-readonly'] === 'valueType')
  assert.equal(textOf(purposeCell), zhCN.valuationDrawerNoPurpose)
  assert.equal(textOf(valueTypeCell), zhCN.valuationDrawerNoValueType)

  const stated = drawerTree({
    preview: previewViewOf({
      ok: true, previewId: 'p1', projectId: 'p1', inputDigest: 'sha256:feed', methodRequest: 'market',
      baseDate: null, purpose: '司法拍卖处置参考', valueType: '市场价值', supplementalPrompt: '', files: [],
    }),
  })
  assert.equal(textOf(find(stated, (node) => node.props?.['data-valuation-readonly'] === 'purpose')), '司法拍卖处置参考')
  assert.equal(textOf(find(stated, (node) => node.props?.['data-valuation-readonly'] === 'valueType')), '市场价值')
  // 只读仍然是结构性的（新增两行不许带进可编辑控件）。
  assert.equal(findAll(stated, (node) => node.type === 'input').length, 0)
  assert.equal(findAll(stated, (node) => node.type === 'textarea').length, 0)
})

test('确认与交接的应答收窄：缺字段时不给假结论', () => {
  const preview = previewViewOf({ ok: true, files: [{ fileId: 'material-001', createdAt: null }] })
  assert.equal(preview.baseDate, null, '未指定基准日就是 null')
  assert.equal(preview.purpose, null, '未指定评估目的就是 null（不是空串、更不是默认目的）')
  assert.equal(preview.valueType, null, '未指定价值类型就是 null')
  assert.equal(previewViewOf({ ok: true, purpose: '抵押', valueType: '市场价值', files: [] }).purpose, '抵押')
  assert.equal(previewViewOf({ ok: true, purpose: '', valueType: '  ', files: [] }).valueType, null, '空白等于未指定')
  assert.equal(preview.files[0].createdAt, null, 'createdAt 缺字段按未知处理，不拿 mtime 顶')
  assert.equal(preview.files[0].modifiedAt, null)
  assert.equal(previewViewOf({ ok: false, error: '超限' }).error, '超限')

  const receipt = handoffViewOf({ ok: true, parentSessionId: 's1', dispatchAccepted: false })
  assert.equal(receipt.dispatchAccepted, false)
  assert.equal(receipt.parentSessionId, 's1', '会话已经建出来了，id 不能丢')
})

test('协议不匹配：整页进 stale-host 且不再接受任何推进', () => {
  const marked = state.markHostStale(state.initialValuationState({ phase: 'draft' }))
  assert.equal(marked.phase, 'stale-host')
  const later = state.authReady(marked, preflightViewOf(PREFLIGHT_RELEASED))
  assert.equal(later.ok, true, '纯函数本身不拒绝，但界面只画 stale 那一句')
  assert.equal(marked.error, zhCN.valuationPhaseStale)
})

test('preparing-confirmation 里「返回修改」把预览丢掉并回到可编辑草稿', () => {
  const base = state.initialValuationState({ phase: 'confirmation', selection: ['/a'] })
  const back = state.backToEdit(base)
  assert.equal(back.ok, true)
  assert.equal(back.state.phase, 'draft')
  assert.equal(back.state.preview, null)
  assert.equal(back.state.handoffRequestId, '', '返回修改后要重新铸交接号')
  // 不在确认 / 准备阶段时"返回修改"要被拒（而不是静默无动作）。
  assert.equal(state.backToEdit(state.initialValuationState({ phase: 'draft' })).ok, false)
})

// ── 类名常量与组件上的字面量一致 ────────────────────────────────────────────

test('类名常量与组件里用的字面量一致（改名字必须一起改）', async () => {
  const { readFileSync } = await import('node:fs')
  const sources = [
    'src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx',
    'src/client/modules/report-evaluation/ui/ValuationCapabilityArea.tsx',
    'src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx',
    'src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx',
    'src/client/modules/report-evaluation/styles/pane.ts',
    // Deprecated select* constants are aliases of the public classmap now.
    'src/client/ui/components/Select.tsx',
    'src/client/ui/styles/select.ts',
  ].map((relative) => readFileSync(new URL(relative, ROOT), 'utf8')).join('\n')
  for (const [key, className] of Object.entries(VALUATION_CLASSES)) {
    assert.equal(sources.includes(className), true, `${key}（${className}）在组件 / 样式里没出现`)
  }
  const styles = readFileSync(new URL('src/client/modules/report-evaluation/styles/pane.ts', ROOT), 'utf8')
  // 注释里提到某个词不算"用了它"（否则改一句说明就会把用例弄红）。
  const stylesCode = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const className of [VALUATION_CLASSES.btn, VALUATION_CLASSES.pane, VALUATION_CLASSES.intake]) {
    assert.equal(stylesCode.includes(`.${className}`), true, `样式里缺少 .${className}`)
  }
  // 深色不另写选择器（由 tokens.ts 的 body[data-ds-dark-theme] 块负责）。
  assert.equal(stylesCode.includes('prefers-color-scheme'), false, '不许用系统主题覆盖 DSH 设置')
  assert.equal(stylesCode.includes('prefers-reduced-motion'), true, '要支持 reduced-motion')
})

test('线协议的阶段词 / 来源状态与页面认的那一套逐字一致', async () => {
  const wire = await import(new URL('src/shared/wire/report-evaluation.ts', ROOT).href)
  // 每个页面阶段都要能被 `phaseHintOf` 说出一句话（多一个少一个都会在这里露出来）。
  for (const phase of wire.VALUATION_PAGE_PHASES) {
    assert.equal(typeof state.phaseHintOf(phase), 'string', phase)
    assert.notEqual(state.phaseHintOf(phase), '', phase)
  }
  assert.equal(new Set(wire.VALUATION_PAGE_PHASES).size, wire.VALUATION_PAGE_PHASES.length, '阶段词不许重复')
  assert.deepEqual([...wire.VALUATION_SITE_STATES], ['authenticated', 'unauthenticated', 'unknown'])
  // 协议 37：`waiting-user` 必须在这份词表里（旧词表漏了它，于是门禁把"等待验证"报成"正在登录"）。
  assert.deepEqual([...wire.VALUATION_LOGIN_JOB_STATES],
    ['running', 'succeeded', 'failed', 'cancelled', 'waiting-user'])
  // Host 轮次那套词**不在**页面阶段里（协议 35 起页面不再跟轮次走）。
  for (const runtimePhase of ['extracting', 'running', 'completed']) {
    assert.equal(wire.VALUATION_PAGE_PHASES.includes(runtimePhase), false, runtimePhase)
  }
})
