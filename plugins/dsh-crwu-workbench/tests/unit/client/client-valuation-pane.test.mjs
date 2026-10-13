/**
 * 报告评估页（房地产估值，协议 32）：状态机 + 只读确认抽屉 + 自动运行。
 *
 * 这一页最要紧的三条在这里逐条钉死：
 *
 * 1. **抽屉只读**：确认阶段所有改输入的动作都被状态机拒绝。方案把它写成"抽屉里不许改"，
 *    如果只靠"按钮没绑 onClick"，改一次渲染就可能悄悄失效；
 * 2. **确认之后输入不可变**：`确认并开始估值` 之后提交的是**冻结**的方法 / 基准日 / 补充要求，
 *    而且基准日未选择时提交的是空串（客户端**不许**拿资料里识别到的日期补一个）；
 * 3. **失败不丢输入**：资料提取失败时选择、方法、基准日、补充要求全都保留。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const state = await import(new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { createReportEvaluationController, intakeViewOf, resultViewOf, isValuationPhase } = await import(
  new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { ReportEvaluationPane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT).href)
const { render: renderToTree, find, findAll, textOf } = await import(new URL('tests/helpers/render.mjs', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

const INTAKE_PAYLOAD = {
  ok: true,
  valuationId: '估值-20261012-201500-aa11',
  casePath: '/cases/space/估值-20261012-201500-aa11',
  method: 'market',
  baseDate: '',
  supplementalPrompt: '请多考虑地铁因素',
  digest: 'sha256:feed',
  files: [
    { fileName: '估值报告.pdf', relativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 2048, status: 'parsed', note: '' },
    { fileName: '扫描件.tif', relativePath: '', kind: 'image', sizeBytes: 512, status: 'unparsed', note: '没有可用的提取器' },
  ],
  extractedFields: { 坐落: '某市某区某路 1 号', 建筑面积: '120.5', 用途: '住宅' },
  missingFields: ['楼层'],
  unparsed: ['扫描件.tif'],
  capabilityGaps: ['未解析的资料：扫描件.tif'],
  warnings: [],
  knowledge: {
    space: '中瑞世联业务知识库',
    ready: true,
    sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', updatedAt: '', digest: 'sha256:k' }],
    gaps: [],
  },
  providers: [
    { id: 'fang', label: '房天下', state: 'authenticated', stateLabel: '可用', detail: '' },
    { id: 'anjuke', label: '安居客', state: 'unauthenticated', stateLabel: '需要登录', detail: '需要登录' },
  ],
}

/** 一个可编排的端口（记录每一次调用，方便断言"提交的到底是什么"）。 */
function makePort(overrides = {}) {
  const calls = { intake: [], start: [], cancel: [], status: [], result: [], openArtifact: [], preflight: [] }
  return {
    calls,
    pickDirectory: async () => '/cases/space/资料',
    fileInput: async () => [],
    intake: async (input) => { calls.intake.push(input); return INTAKE_PAYLOAD },
    start: async (input) => { calls.start.push(input); return { ok: true, sessionId: 's-val', casePath: INTAKE_PAYLOAD.casePath } },
    cancel: async (input) => { calls.cancel.push(input); return { ok: true } },
    status: async (input) => { calls.status.push(input); return { ok: true, phase: 'running', known: true } },
    result: async (input) => { calls.result.push(input); return { ok: true } },
    openArtifact: async (input) => { calls.openArtifact.push(input); return { ok: true } },
    preflight: async (input) => { calls.preflight.push(input); return { ok: true, providers: INTAKE_PAYLOAD.providers } },
    ...overrides,
  }
}

/** 渲染一次估值页，直接拿元素树（`render` 回的是 `{ tree, instance }`）。 */
function renderPane(controller) {
  return renderToTree(ReportEvaluationPane, { controller }).tree
}

/** 等一拍：控制器里的 promise 链要跑完。 */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

async function driveToConfirmation(port, initial = {}) {
  const controller = createReportEvaluationController(port, { initial })
  controller.setSelection?.(undefined)
  // 直接用状态机摆好"已选资料"的形态（真实路径由原生对话框给出）。
  const withFiles = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'], ...initial } })
  withFiles.start()
  await tick()
  return withFiles
}

// ── 状态机：抽屉只读 ────────────────────────────────────────────────────────

test('能改输入的阶段是 draft / failed；提取中与确认之后拒绝（且提取中不说"已冻结"）', () => {
  // 用户 2026-10-13 实测：提取失败后再点任何输入都报「输入已经冻结」、抽屉又不出来 ——
  // 两套判据打架。正确口径是 **draft / failed 能改**（失败后第一反应就是改了再试），
  // `extracting` 与确认之后不能改，但提取中要给"正在提取"的话，不是"已冻结"。
  for (const phase of ['draft', 'failed']) {
    assert.equal(state.canEditInputs(phase), true, phase)
  }
  for (const phase of ['extracting', 'confirmation', 'queued', 'running',
    'browser-login-required', 'completed', 'cancelled', 'stale-host']) {
    assert.equal(state.canEditInputs(phase), false, phase)
    const base = state.initialValuationState({ phase })
    for (const mutate of [
      () => state.setSelection(base, ['/tmp/x.pdf']),
      () => state.setMethod(base, 'income'),
      () => state.setBaseDate(base, '2026-06-30'),
      () => state.setSupplementalPrompt(base, '改一句'),
    ]) {
      const outcome = mutate()
      assert.equal(outcome.ok, false, `${phase} 阶段不该允许改输入`)
      // 提取中说的是"正在按当前输入提取"，其余才是"已冻结"。
      assert.match(outcome.error, phase === 'extracting' ? /取消提取/ : /输入已经冻结/)
      assert.deepEqual(outcome.state, base, '被拒时状态必须原样返回')
    }
  }
})

test('提取失败后表单**真的**能改，而且能再点一次重新提取（不再卡在"已冻结"）', async () => {
  const port = makePort({
    intake: () => Promise.resolve({ ok: false, error: '输入清单落盘失败：file access denied' }),
  })
  // 资料用状态机摆好（真实路径由原生对话框给出），与其它用例同一条做法。
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  await tick()
  assert.equal(controller.getState().phase, 'failed')
  assert.match(controller.getState().error, /落盘失败/)

  // ① 失败后改输入必须成功（这就是被 bug 挡住的那一步）。
  controller.setMethod('income')
  assert.equal(controller.getState().method, 'income')
  controller.setPrompt('改一句再试')
  assert.equal(controller.getState().supplementalPrompt, '改一句再试')

  // ② 再点一次能重新发起提取（不是"已冻结"死路）。
  const before = controller.getState().intakeRequestId
  controller.start()
  await tick()
  assert.notEqual(controller.getState().intakeRequestId, before, '重新提取要发一个新的请求号')
})

test('抽屉只在 confirmation 阶段显示，且「返回修改」丢掉上一次的确认数据', () => {
  assert.equal(state.showsConfirmationDrawer('confirmation'), true)
  for (const phase of ['draft', 'extracting', 'running', 'completed']) {
    assert.equal(state.showsConfirmationDrawer(phase), false, phase)
  }
  const intake = intakeViewOf(INTAKE_PAYLOAD, { valuationId: '', method: 'auto', baseDate: '', supplementalPrompt: '' })
  const ready = state.intakeReady(state.initialValuationState({ phase: 'extracting' }), intake)
  assert.equal(ready.ok, true)
  assert.equal(ready.state.phase, 'confirmation')
  const back = state.backToEdit(ready.state)
  assert.equal(back.ok, true)
  assert.equal(back.state.phase, 'draft')
  assert.equal(back.state.intake, null, '返回修改后要重新生成快照')
  // 不在确认阶段时"返回修改"要被拒（而不是静默无动作）。
  assert.equal(state.backToEdit(state.initialValuationState()).ok, false)
})

test('基准日：空串合法，非 YYYY-MM-DD 一律拒绝（不做"尽量解析"）', () => {
  const base = state.initialValuationState()
  assert.equal(state.setBaseDate(base, '').ok, true)
  assert.equal(state.setBaseDate(base, '2026-06-30').ok, true)
  for (const bad of ['2026/06/30', '26-06-30', '2026-6-3', '今天', '2026-06-30T00:00:00Z']) {
    const outcome = state.setBaseDate(base, bad)
    assert.equal(outcome.ok, false, bad)
    assert.match(outcome.error, /YYYY-MM-DD/)
  }
})

test('没有资料就不能开始；协议不匹配后停在 stale-host 且不接受任何状态推进', () => {
  const empty = state.initialValuationState()
  const begin = state.beginIntake(empty)
  assert.equal(begin.ok, false)
  assert.match(begin.error, /先选择至少一份资料/)

  const stale = state.applyStatus(state.initialValuationState(), { phase: 'running' })
  assert.equal(stale.ok, true)
  const marked = state.markHostStale(stale.state)
  assert.equal(marked.phase, 'stale-host')
  const later = state.applyStatus(marked, { phase: 'completed' })
  assert.equal(later.ok, false, '过期宿主不许把页面推进到完成')
  assert.equal(later.state.phase, 'stale-host')
})

test('结果视图：拿不到的数字是 null（界面显示「—」），不是 0', () => {
  const view = resultViewOf({
    ok: true,
    artifacts: { html: true, xlsx: true, json: false },
    result: {
      method: 'market', methodReason: '案例充分', baseDate: '',
      unitPrice: null, totalValue: 1234567,
      manual_confirmation_items: ['本次未指定评估基准日'],
      capability_gaps: ['安居客：无结构化数据'],
      cases: [{ url: 'https://x/1', title: '某小区', transaction_type: '挂牌', used_as_comparable: false, unit_price: 8000, building_area: 90, drop_reason: '挂牌价需修正' }],
    },
  })
  assert.equal(view.unitPrice, null)
  assert.equal(view.totalValue, 1234567)
  assert.deepEqual(view.artifacts, { html: true, xlsx: true, json: false })
  assert.equal(state.artifactsComplete(view.artifacts), false)
  const buckets = state.caseBuckets(view.cases)
  assert.equal(buckets.comparable.length, 0)
  assert.equal(buckets.listed.length, 1)
  assert.equal(buckets.listed[0].transactionType, '挂牌')
})

// ── 控制器：确认之后提交的是冻结输入 ────────────────────────────────────────

test('确认并开始：提交的基准日是**逐字**的空串，而不是从资料里补一个日期', async () => {
  const port = makePort()
  const controller = await driveToConfirmation(port, {
    method: 'market', baseDate: '', supplementalPrompt: '请多考虑地铁因素',
  })
  assert.equal(controller.getState().phase, 'confirmation', controller.getState().error)
  assert.equal(controller.getState().intake.missingFields.includes('楼层'), true)

  controller.confirm()
  await tick()
  assert.equal(port.calls.start.length, 1)
  const submitted = port.calls.start[0]
  assert.equal(submitted.baseDate, '', '未选基准日必须提交空串')
  assert.equal(submitted.method, 'market')
  assert.equal(submitted.supplementalPrompt, '请多考虑地铁因素')
  assert.equal(submitted.confirmedSnapshotDigest, 'sha256:feed', '要带上确认时的快照指纹')
  assert.equal(controller.getState().phase, 'running')
})

test('确认之后再改方法 / 基准日都不生效（输入已冻结）', async () => {
  const port = makePort()
  const controller = await driveToConfirmation(port, { method: 'market' })
  controller.confirm()
  await tick()
  const frozen = controller.getState()
  controller.setMethod('income')
  controller.setBaseDate('2026-06-30')
  controller.setPrompt('改一句')
  const after = controller.getState()
  assert.equal(after.method, frozen.method)
  assert.equal(after.baseDate, frozen.baseDate)
  assert.equal(after.supplementalPrompt, frozen.supplementalPrompt)
  assert.match(after.error, /输入已经冻结/)
})

test('资料提取失败：选择 / 方法 / 基准日 / 补充要求全都保留', async () => {
  const port = makePort({
    intake: async () => ({ ok: false, error: '这份资料读不出来' }),
  })
  const controller = await driveToConfirmation(port, {
    method: 'income', baseDate: '2026-06-30', supplementalPrompt: '请多考虑租约',
  })
  const after = controller.getState()
  assert.equal(after.phase, 'failed')
  assert.match(after.error, /这份资料读不出来/)
  assert.deepEqual(after.selection, ['/tmp/估值报告.pdf'])
  assert.equal(after.method, 'income')
  assert.equal(after.baseDate, '2026-06-30')
  assert.equal(after.supplementalPrompt, '请多考虑租约')
})

test('开始估值：门禁不过时不起提交流程，并把原因写出来', async () => {
  const port = makePort()
  const controller = createReportEvaluationController({
    ...port,
    ready: () => ({ ok: false, error: '环境信息未就绪' }),
  }, { initial: { selection: ['/tmp/a.pdf'] } })
  controller.start()
  await tick()
  assert.equal(port.calls.intake.length, 0)
  assert.equal(controller.getState().error, '环境信息未就绪')
})

test('取消会同时通知 Host（本轮的轮次要真的停下来）', async () => {
  const port = makePort()
  const controller = await driveToConfirmation(port)
  controller.confirm()
  await tick()
  controller.cancel()
  await tick()
  assert.equal(controller.getState().phase, 'cancelled')
  assert.equal(port.calls.cancel.length, 1)
  assert.equal(port.calls.cancel[0].valuationId, INTAKE_PAYLOAD.valuationId)
})

test('轮询：阶段词认不出来就不推进（不猜），completed 才去取结果', async () => {
  const port = makePort()
  const controller = await driveToConfirmation(port)
  controller.confirm()
  await tick()

  port.status = async (input) => { port.calls.status.push(input); return { ok: true, phase: '莫名其妙的阶段' } }
  controller.poll()
  await tick()
  assert.equal(controller.getState().phase, 'running', '认不出来的阶段不许改页面状态')

  port.status = async (input) => { port.calls.status.push(input); return { ok: true, phase: 'completed', known: true } }
  controller.poll()
  await tick()
  assert.equal(controller.getState().phase, 'completed')
  assert.equal(port.calls.result.length, 1, 'completed 之后要去取结果')
})

test('阶段词收窄：只认 Host 那十个词', () => {
  for (const phase of ['draft', 'extracting', 'confirmation', 'queued', 'running', 'browser-login-required', 'completed', 'failed', 'cancelled', 'stale-host']) {
    assert.equal(isValuationPhase(phase), true, phase)
  }
  for (const bad of ['done', 'RUNNING', '', undefined, 3]) {
    assert.equal(isValuationPhase(bad), false, String(bad))
  }
})

// ── 渲染：抽屉只读、按钮恰好三个 ────────────────────────────────────────────

test('渲染：确认阶段画出只读抽屉，恰好三个按钮，且**没有任何**可编辑控件', () => {
  const intake = intakeViewOf(INTAKE_PAYLOAD, { valuationId: '', method: 'auto', baseDate: '', supplementalPrompt: '' })
  const controller = createReportEvaluationController(makePort(), {
    initial: {
      phase: 'confirmation',
      valuationId: intake.valuationId,
      selection: ['/tmp/估值报告.pdf'],
      method: 'market',
      baseDate: '',
      supplementalPrompt: '请多考虑地铁因素',
      intake,
    },
  })
  const tree = renderPane(controller)

  // 抽屉内容在：文件 / 解析状态 / 已知信息 / 缺失信息 / 知识来源 / 外部来源。
  const text = textOf(tree)
  for (const required of ['估值报告.pdf', '已解析', '扫描件.tif', '未解析', '坐落', '某市某区某路 1 号', '楼层', '房天下', '中瑞世联业务知识库']) {
    assert.ok(text.includes(required), `抽屉里缺少「${required}」`)
  }

  // **只读**：没有任何 input / textarea / select；方法、基准日、提示词都只作为文本出现。
  assert.deepEqual(findAll(tree, (node) => node.type === 'input'), [], '抽屉里不许有输入框')
  assert.deepEqual(findAll(tree, (node) => node.type === 'textarea'), [], '抽屉里不许有文本框')
  assert.deepEqual(findAll(tree, (node) => node.type === 'select'), [], '抽屉里不许有下拉')
  for (const marker of ['method', 'baseDate', 'prompt']) {
    const node = find(tree, (item) => item.props?.['data-valuation-readonly'] === marker)
    assert.ok(node, `${marker} 要以只读文本出现`)
    assert.equal(node.type, 'p')
  }
  // 基准日未指定时显示那句话，而不是空白。
  assert.ok(text.includes('本次未指定评估基准日'), '未指定基准日要写明')

  // 动作区里**恰好三个**按钮，就是 §5 点名的那三个（抽屉自带的关闭「×」不算动作区）：
  // 返回修改 / 重新检查 / 确认并开始。「取消本轮」在进度页与结果页 —— 那时才真的有一轮在跑。
  const actions = find(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-drawer-actions')
  assert.ok(actions, '抽屉要有动作区')
  const buttons = findAll(actions, (node) => node.type === 'button')
  assert.deepEqual(buttons.map((node) => textOf(node)), ['返回修改', '重新检查', '确认并开始估值'])
})

test('渲染：还没确认时不画抽屉；运行中给阶段与进度但**不伪造**进度条', () => {
  const running = createReportEvaluationController(makePort(), {
    initial: {
      phase: 'running', valuationId: '估值-x', selection: ['/tmp/a.pdf'],
      method: 'market', progress: { stage: '检索案例', detail: '房天下', completed: 2, total: 4 },
    },
  })
  const tree = renderPane(running)
  assert.equal(textOf(tree).includes('本轮估值'), false, '非确认阶段不画抽屉')
  const bar = find(tree, (node) => node.props?.role === 'progressbar')
  assert.ok(bar, '有总数时要画进度条')
  assert.equal(bar.props['aria-valuenow'], 2)
  assert.equal(bar.props['aria-valuemax'], 4)

  // 没有总数（宿主没给）时**不画**进度条 —— 宁可只写文字，也不编一个百分比。
  const unknown = createReportEvaluationController(makePort(), {
    initial: { phase: 'running', valuationId: '估值-y', selection: ['/tmp/a.pdf'], method: 'auto', progress: { stage: '进行中', detail: '', completed: 0, total: 0 } },
  })
  const tree2 = renderPane(unknown)
  assert.equal(find(tree2, (node) => node.props?.role === 'progressbar'), null, '没有总数时不许画进度条')
})

test('渲染：完成页显示结论与两桶案例，交付件缺失时说不齐', () => {
  const controller = createReportEvaluationController(makePort(), {
    initial: {
      phase: 'completed', valuationId: '估值-z', selection: ['/tmp/a.pdf'], method: 'market',
      result: resultViewOf({
        ok: true,
        artifacts: { html: true, xlsx: true, json: true },
        result: {
          method: 'market', methodReason: '同区域案例充分', baseDate: '',
          unitPrice: 42000, totalValue: 5061000,
          manual_confirmation_items: ['本次未指定评估基准日'],
          capability_gaps: ['安居客：无结构化数据（需要登录）'],
          cases: [
            { url: 'https://c/1', title: '成交案例', transaction_type: '成交', used_as_comparable: true, unit_price: 43000, building_area: 90, keep_reason: '同小区同户型' },
            { url: 'https://l/1', title: '挂牌案例', transaction_type: '挂牌', used_as_comparable: false, unit_price: 46000, building_area: 91, drop_reason: '挂牌价需修正' },
          ],
        },
      }),
    },
  })
  const tree = renderPane(controller)
  const text = textOf(tree)
  assert.ok(text.includes('42,000'), '单价要显示')
  assert.ok(text.includes('5,061,000'), '总价要显示')
  // 结论区的顺序按用户口径：总价值 → 单价 → 采用方法 → 基准日 → 案例数量。
  assert.ok(
    text.indexOf(zhCN.valuationResultTotalValue) < text.indexOf(zhCN.valuationResultUnitPrice),
    '总价值要排在单价前面',
  )
  assert.ok(text.includes(zhCN.valuationResultCaseCount), '案例数量要显示')
  assert.ok(text.includes('2 条（可比 1 · 需修正 1）'), '案例数量要给出两桶分布')
  assert.ok(text.includes('本次未指定评估基准日'), '无基准日要写明')
  assert.ok(text.includes('可直接作可比实例（成交）') && text.includes('挂牌 / 询价 / 未知（需修正）'), '案例要分两桶')
  assert.ok(text.includes('同小区同户型') && text.includes('挂牌价需修正'), '保留 / 剔除理由都要显示')
  assert.ok(text.includes('安居客：无结构化数据（需要登录）'), '能力缺口要完整显示')
})

// ── 「点检查并确认之后没有反应」那一类回归（§11）────────────────────────────
//
// 用户原话是"点了按钮没反应"。根因不是没有事件，而是 `valuation-intake` 是一条**没有中间
// 反馈的长 RPC**（它当时还在返回之前串行预检三家站点，每家 20 秒）。所以这一组用例钉的是
// **时序**：第一帧有什么、RPC 在飞的时候是什么样、迟到的响应会不会把状态改回去。

const { beginIntake, cancelIntake } = state

/** 一个可以手动决定何时 resolve 的 intake（用来观察"RPC 在飞"的那一段时间）。 */
function deferred() {
  let settle = () => {}
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, resolve: settle }
}

test('点击检查并确认：**同一帧**进入 extracting、按钮变「正在提取资料…」、输入全部禁用', async () => {
  const gate = deferred()
  const port = makePort({
    intake: async (input) => { port.calls.intake.push(input); return gate.promise },
    scan: async () => ({ ok: true, items: [] }),
  })
  const controller = createReportEvaluationController(port, {
    initial: { selection: ['/tmp/估值报告.pdf'], method: 'market' },
  })

  controller.start()
  // 还没 await：这一帧就该是提取态（用户点下去立刻看得到反馈）。
  assert.equal(controller.getState().phase, 'extracting')
  assert.equal(controller.getState().valuationId !== '', true, '提取开始前就要铸好 valuationId（取消时要用）')

  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-intake-status'] === 'extracting').length, 1,
    '要有 role=status 的进度区')
  const buttons = findAll(tree, (node) => node.type === 'button').map((node) => textOf(node))
  assert.ok(buttons.includes(zhCN.valuationIntakeRunning), `按钮要显示"正在提取资料…"：${buttons.join('|')}`)
  const primary = findAll(tree, (node) => String(node.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.equal(primary.props.disabled, true, '提取中主按钮必须禁用，防重复提交')
  // 输入在这段时间不可编辑（状态机判据 + 界面 disabled 一起）。
  assert.equal(state.canEditInputs('extracting'), false, '提取中不许改输入（§11.1）')
  for (const radio of findAll(tree, (node) => node.type === 'input')) {
    assert.equal(radio.props.disabled, true, '提取中方法 / 基准日要禁用')
  }
  gate.resolve(INTAKE_PAYLOAD)
  await tick()
  assert.equal(controller.getState().phase, 'confirmation')
  assert.equal(port.calls.intake.length, 1, '点击只发起一次 intake')
})

test('基准日：从 Client **逐字**传到 Host（未选择就是空串，不拿资料里的日期补）', async () => {
  const port = makePort()
  const picked = createReportEvaluationController(port, {
    initial: { selection: ['/tmp/估值报告.pdf'], method: 'income', baseDate: '2026-06-30', supplementalPrompt: '  保留空格  ' },
  })
  picked.start()
  await tick()
  assert.deepEqual(port.calls.intake[0], {
    valuationId: port.calls.intake[0].valuationId,
    method: 'income',
    baseDate: '2026-06-30',
    supplementalPrompt: '  保留空格  ',
    paths: ['/tmp/估值报告.pdf'],
  })

  const blank = createReportEvaluationController(makePort(), {
    initial: { selection: ['/tmp/估值报告.pdf'], baseDate: '' },
  })
  blank.start()
  await tick()
  assert.equal(blank.getState().baseDate, '', '未选择就是空串')
})

test('Host 回显的 baseDate 就是用户提交的那一份（未指定时显示「本次未指定评估基准日」）', async () => {
  const port = makePort({ intake: async () => ({ ...INTAKE_PAYLOAD, baseDate: '' }) })
  const controller = createReportEvaluationController(port, {
    initial: { selection: ['/tmp/估值报告.pdf'], baseDate: '' },
  })
  controller.start()
  await tick()
  assert.equal(controller.getState().intake?.baseDate, '')
  const tree = renderPane(controller)
  assert.ok(textOf(tree).includes('本次未指定评估基准日'), '未指定基准日要明确写出来')
})

test('intake 成功：抽屉**自动**打开，不需要用户再点一次', async () => {
  const controller = createReportEvaluationController(makePort(), { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  await tick()
  assert.equal(controller.getState().phase, 'confirmation')
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-confirmation-drawer'] === 'true').length, 1)
})

test('intake 失败：role=alert + 「重新提取」，且资料 / 方法 / 基准日 / 补充要求都还在', async () => {
  const port = makePort({ intake: async () => ({ ok: false, error: '案例目录创建失败：磁盘只读' }) })
  const controller = createReportEvaluationController(port, {
    initial: { selection: ['/tmp/估值报告.pdf'], method: 'cost', baseDate: '2026-06-30', supplementalPrompt: '多考虑地铁' },
  })
  controller.start()
  await tick()
  assert.equal(controller.getState().phase, 'failed')
  const tree = renderPane(controller)
  const alert = find(tree, (node) => node.props?.['data-valuation-intake-error'] === 'true')
  assert.ok(alert, '失败要有 data-valuation-intake-error 的可见错误块')
  assert.equal(alert.props.role, 'alert')
  assert.ok(textOf(alert).includes('磁盘只读'), '要写出**具体**原因')
  assert.ok(findAll(alert, (node) => node.type === 'button').map((node) => textOf(node)).includes(zhCN.valuationIntakeRetry))
  // 失败不丢输入。
  const after = controller.getState()
  assert.deepEqual(after.selection, ['/tmp/估值报告.pdf'])
  assert.equal(after.method, 'cost')
  assert.equal(after.baseDate, '2026-06-30')
  assert.equal(after.supplementalPrompt, '多考虑地铁')
})

test('intake 超时：进入可恢复的失败态，并说明"不再等"而不是谎称宿主已停止', async () => {
  let fire = () => {}
  const port = makePort({
    intake: async (input) => { port.calls.intake.push(input); return new Promise(() => {}) },
    scheduleTimeout: (handler) => { fire = handler; return 1 },
    clearScheduledTimeout: () => {},
    intakeTimeoutMs: 1000,
  })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  assert.equal(controller.getState().phase, 'extracting')
  fire()
  assert.equal(controller.getState().phase, 'failed')
  assert.match(controller.getState().error, /等待超时/)
  const tree = renderPane(controller)
  assert.ok(findAll(tree, (node) => node.props?.['data-valuation-intake-error'] === 'true').length === 1)
  assert.ok(textOf(tree).includes(zhCN.valuationIntakeRetry), '超时也要给可执行动作')
})

test('取消提取：回到可编辑态，并按 valuationId 通知 Host 取消', async () => {
  const port = makePort({ intake: async (input) => { port.calls.intake.push(input); return new Promise(() => {}) } })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  const valuationId = controller.getState().valuationId
  assert.equal(controller.getState().phase, 'extracting')
  controller.cancelIntake()
  await tick()
  assert.equal(controller.getState().phase, 'draft', '取消提取回到可编辑的草稿态')
  assert.deepEqual(controller.getState().selection, ['/tmp/估值报告.pdf'], '重新提取不必重选资料')
  assert.deepEqual(port.calls.cancel, [{ valuationId }], '取消要按**已经铸好的** id 通知 Host')
})

test('取消之后迟到的 intake 响应**不许**把抽屉重新弹出来', async () => {
  const gate = deferred()
  const port = makePort({ intake: async () => gate.promise })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  controller.cancelIntake()
  assert.equal(controller.getState().phase, 'draft')
  gate.resolve(INTAKE_PAYLOAD)
  await tick()
  assert.equal(controller.getState().phase, 'draft', '迟到的响应必须被丢掉')
  assert.equal(controller.getState().intake, null, '更不许落进确认数据')
})

test('返回修改后重新提取：作废旧请求，并生成新的一次快照', async () => {
  const port = makePort()
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  await tick()
  assert.equal(controller.getState().phase, 'confirmation')
  const firstRequestId = controller.getState().intakeRequestId
  controller.backToEdit()
  assert.equal(controller.getState().phase, 'draft')
  assert.equal(controller.getState().intake, null)
  controller.start()
  await tick()
  assert.equal(controller.getState().phase, 'confirmation')
  assert.notEqual(controller.getState().intakeRequestId, firstRequestId, '重新提取是**新的一轮**请求')
  assert.equal(port.calls.intake.length, 2)
})

test('提取阶段只认当前请求的阶段文字：旧请求的迟到阶段不许改这一轮', () => {
  // 从 draft 起（真实路径：用户在草稿态点「检查并确认」），不是凭空造一个 extracting。
  const base = state.initialValuationState({ phase: 'draft' })
  const first = beginIntake({ ...base, selection: ['/tmp/a.pdf'] }, 7)
  assert.equal(first.ok, true)
  assert.equal(first.state.phase, 'extracting')
  // 提取中再点一次必须被拒 —— 防重复提交（§4「防止重复点击启动多个任务」）。
  const again = beginIntake(first.state, 8)
  assert.equal(again.ok, false, '提取中不许再起一次')
  assert.match(again.error, /取消提取/)
  const advanced = state.intakeStage(first.state, 7, '正在复制资料')
  assert.equal(advanced.ok, true)
  assert.equal(advanced.state.intakeStage, '正在复制资料')
  // 换了一轮（8 号）之后，7 号的阶段再回来必须被拒。
  const second = beginIntake({ ...first.state, phase: 'draft' }, 8)
  const stale = state.intakeStage(second.state, 7, '正在提取文件内容')
  assert.equal(stale.ok, false)
  assert.match(stale.error, /迟到/)
})

test('进度区显示的是**宿主报的真实阶段**，客户端不自己编', async () => {
  const port = makePort({
    intake: async (input) => { port.calls.intake.push(input); return new Promise(() => {}) },
    status: async () => ({
      ok: true, phase: 'extracting', known: true,
      progress: { stage: '正在复制资料', detail: '', completed: 2, total: 5 },
    }),
  })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  assert.equal(controller.getState().intakeStage, '', '没有宿主结论时阶段是空的（界面退回一句"正在提取资料…"）')
  controller.poll()
  await tick()
  assert.equal(controller.getState().intakeStage, '正在复制资料')
  assert.equal(controller.getState().phase, 'extracting', '提取阶段不按宿主阶段改页面（这一次 RPC 还没回来）')
  const tree = renderPane(controller)
  assert.ok(textOf(tree).includes('正在复制资料'))
})

test('外部来源：抽屉先开、状态初始「尚未检查」，随后逐家独立更新（不被资料提取阻塞）', async () => {
  const gate = deferred()
  const port = makePort({
    // intake 只回"尚未检查"的三行（宿主不再在提取里访问站点）。
    intake: async () => ({
      ...INTAKE_PAYLOAD,
      providers: [
        { id: 'fang', label: '房天下', state: 'unknown', stateLabel: '尚未检查', detail: '' },
        { id: 'anjuke', label: '安居客', state: 'unknown', stateLabel: '尚未检查', detail: '' },
        { id: 'lianjia', label: '链家', state: 'unknown', stateLabel: '尚未检查', detail: '' },
      ],
    }),
    preflight: async (input) => { port.calls.preflight.push(input); return gate.promise },
  })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  await tick()
  // 抽屉**已经打开**（资料确认信息不等来源探测）。
  assert.equal(controller.getState().phase, 'confirmation')
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-confirmation-drawer'] === 'true').length, 1)
  assert.ok(textOf(tree).includes(zhCN.valuationProviderChecking), '探测中显示「检查中」')
  // 三家各自落到自己的结论上：一家需要登录不影响另外两家。
  gate.resolve({
    ok: true,
    providers: [
      { id: 'fang', label: '房天下', state: 'authenticated', stateLabel: '可用', detail: '' },
      { id: 'anjuke', label: '安居客', state: 'unauthenticated', stateLabel: '需要登录', detail: '需要登录' },
      { id: 'lianjia', label: '链家', state: 'unknown', stateLabel: '无法检查', detail: '网络超时' },
    ],
  })
  await tick()
  assert.equal(controller.getState().providerCheck, 'done')
  const after = renderPane(controller)
  const rows = findAll(after, (node) => node.props?.['data-valuation-provider'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-valuation-provider-state']),
    ['authenticated', 'unauthenticated', 'unknown'])
  assert.ok(textOf(after).includes(zhCN.valuationProviderOpenLogin), '需要登录的来源要给登录入口')
  assert.ok(textOf(after).includes(zhCN.valuationProviderRecheck), '登录后要能重新检查')
  assert.equal(port.calls.preflight.length, 1)
})

test('没有预检能力时如实说「无法检查」，不谎称已登录', async () => {
  const port = makePort({
    intake: async () => ({
      ...INTAKE_PAYLOAD,
      providers: [{ id: 'fang', label: '房天下', state: 'unknown', stateLabel: '尚未检查', detail: '' }],
    }),
    preflight: undefined,
  })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/估值报告.pdf'] } })
  controller.start()
  await tick()
  assert.equal(controller.getState().providerCheck, 'done')
  assert.equal(controller.getState().providerStates.fang.state, 'unknown')
  assert.match(controller.getState().providerStates.fang.detail, /没有外部来源预检能力/)
})

test('资料清单：逐份事实来自 valuation-files-scan，同名文件给目录摘要、完整路径不做主标题', async () => {
  const port = makePort({
    scan: async (input) => ({
      ok: true,
      items: input.paths.map((path, index) => ({
        path,
        name: index === 0 ? '报告.pdf' : '报告.pdf',
        kind: 'pdf',
        sizeBytes: 1024 * (index + 1),
        status: 'scanned',
        reason: '',
        fileCount: 1,
      })),
    }),
  })
  const controller = createReportEvaluationController(port, {
    initial: { selection: ['/a/报告.pdf', '/b/报告.pdf'] },
  })
  controller.rescan()
  await tick()
  const files = controller.getState().files
  assert.equal(files.length, 2)
  assert.deepEqual(files.map((file) => file.name), ['报告.pdf', '报告.pdf'])
  assert.equal(files[0].dirHint !== '', true, '同名文件必须有目录摘要')
  assert.equal(files[0].dirHint === files[1].dirHint, false, '两份的目录摘要要能区分开')
  const tree = renderPane(controller)
  assert.equal(textOf(tree).includes('/a/报告.pdf'), false, '完整路径不做主标题')
  assert.equal(findAll(tree, (node) => node.props?.title === '/a/报告.pdf').length, 1, '完整路径要能在详情里看到')
})

test('没有资料时开始按钮禁用，并在旁边写出原因', () => {
  const controller = createReportEvaluationController(makePort(), { initial: { selection: [] } })
  const tree = renderPane(controller)
  const primary = findAll(tree, (node) => String(node.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.equal(primary.props.disabled, true)
  const reason = find(tree, (node) => node.props?.id === 'crwu-valuation-action-reason')
  assert.ok(reason, '禁用原因要画出来')
  assert.match(textOf(reason), /还没有选择资料/)
  assert.equal(primary.props['aria-describedby'], 'crwu-valuation-action-reason', '禁用原因要与按钮关联')
})

test('取消提取的状态机判据：非提取阶段一律拒绝（不静默）', () => {
  for (const phase of ['draft', 'confirmation', 'running', 'completed']) {
    const outcome = cancelIntake(state.initialValuationState({ phase }))
    assert.equal(outcome.ok, false, phase)
  }
})

test('抽屉把「将提交的提示词」和「每项要素的来源」都摆出来（方案 §5.4 第 3 / 第 10 条）', () => {
  const intake = intakeViewOf({
    ...INTAKE_PAYLOAD,
    fieldSources: { 坐落: '估值报告.pdf' },
    prompt: '## 本轮估值\n估值 ID：估值-20261012-201500-aa11\n',
  }, { valuationId: '', method: 'auto', baseDate: '', supplementalPrompt: '' })
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'confirmation', method: 'auto', intake },
  })
  const tree = renderPane(controller)

  // 提示词：可折叠（`details`），且正文在 `<pre>` 里逐字可见。
  const details = find(tree, (node) => node.type === 'details' && String(node.props?.className ?? '') === 'crwu-valuation-drawer-prompt')
  assert.ok(details, '完整业务提示词要能折叠查看')
  const pre = find(tree, (node) => node.props?.['data-valuation-prompt-full'] === 'true')
  assert.ok(pre, '提示词要以原文形态出现')
  assert.match(textOf(pre), /估值 ID：估值-20261012-201500-aa11/)

  // 来源：逐项标出"来自哪一份文件"，并说明粒度限制。
  const source = find(tree, (node) => node.props?.['data-valuation-field-source'] === '坐落')
  assert.ok(source, '已知要素要标出来源')
  assert.match(textOf(source), /估值报告\.pdf/)
  assert.match(textOf(tree), /来源粒度是「哪一份文件」/)

  // 自动判定：要写明"执行时按规则判断"，而不是只显示一个方法名。
  assert.match(textOf(tree), /执行时按规则判断/)

  // 知识来源带版本信息；取证能力如实说明。
  assert.ok(find(tree, (node) => node.props?.['data-valuation-knowledge-route'] !== undefined))
  assert.match(textOf(tree), /取证能力/)
})

test('宿主不回提示词预览时如实说"没有回传"，不编一份出来', () => {
  const intake = intakeViewOf({ ...INTAKE_PAYLOAD, prompt: '' }, {
    valuationId: '', method: 'market', baseDate: '', supplementalPrompt: '',
  })
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'confirmation', method: 'market', intake },
  })
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-prompt-full'] === 'true').length, 0)
  assert.match(textOf(tree), /宿主没有回传提示词预览/)
})

test('结果页：证据不完整时先提示，剔除案例可折叠，证据缺失如实标出', () => {
  const incomplete = {
    method: 'market', methodReason: '同区域成交案例充分', baseDate: '',
    unitPrice: 52000, totalValue: 6240000, pricingArea: 120, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: ['本部署没有页面截图能力'],
    cases: [
      { url: 'https://x/1', title: 'A 小区', community: 'A', transactionType: '成交', usedAsComparable: true,
        unitPrice: 51000, buildingArea: 100, keepReason: '同小区', dropReason: '', capturedAt: '2026-10-13 10:00',
        evidence: '来源证据/fang-1.html', evidenceMissing: false,
        contact: { state: 'public', agency: '示例房产经纪有限公司', person: '王经理', phone: '010-00000000', detail: '' },
        status: 'adopted', ruleChecks: [
          { ruleId: 'R-SINGLE-20', actual: 0.08, threshold: 0.2, verdict: 'pass', reason: '最大单项修正 +8%' },
          { ruleId: 'R-GROUP-1.2', actual: 1.0, threshold: 1.2, verdict: 'pass', reason: '组内比值 1.0' },
        ] },
      { url: 'https://x/2', title: 'B 小区', community: 'B', transactionType: '挂牌', usedAsComparable: false,
        unitPrice: 60000, buildingArea: 90, keepReason: '', dropReason: '挂牌价，需修正', capturedAt: '2026-10-13 10:01',
        evidence: '', evidenceMissing: true,
        contact: { state: 'masked', agency: '', person: '', phone: '138****1234', detail: '' },
        status: 'single-rule-failed', ruleChecks: [
          { ruleId: 'R-SINGLE-20', actual: 0.26, threshold: 0.2, verdict: 'fail', reason: '装修因素 +26% 超过 20%' },
        ] },
    ],
    artifacts: { html: true, xlsx: false, json: true },
  }
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'completed', result: state.resultViewOf ? state.resultViewOf({ result: incomplete }) : incomplete },
  })
  const tree = renderPane(controller)
  // 1) 证据不完整要**先**说一句，而不是拿大号数字装成正式结论。
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-evidence-incomplete'] === 'true').length, 1)
  // 2) 剔除案例可折叠（`details`），内容仍在。
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-dropped-cases'] === 'true').length, 1)
  assert.match(textOf(tree), /挂牌价，需修正/)
  // 3) 证据：有文件的给路径；明确没留存的如实说"没有留存证据"。
  assert.match(textOf(tree), /来源证据\/fang-1\.html/)
  assert.match(textOf(tree), /没有留存证据/)
  // 4) 抓取时刻是可追溯的一部分。
  assert.match(textOf(tree), /抓取于 2026-10-13 10:00/)
})

test('结果页：证据齐备时不显示"不完整"提示（别把正常结论说成有问题）', () => {
  const complete = {
    method: 'market', methodReason: '', baseDate: '2026-06-30',
    unitPrice: 52000, totalValue: 6240000, pricingArea: 120, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: [],
    cases: [{ url: 'https://x/1', title: 'A', community: 'A', transactionType: '成交', usedAsComparable: true,
      unitPrice: 51000, buildingArea: 100, keepReason: '同小区', dropReason: '', capturedAt: '2026-10-13 10:00',
      evidence: '来源证据/a.html', evidenceMissing: false,
      contact: { state: 'not-published', agency: '', person: '', phone: '', detail: '' },
      status: 'adopted', ruleChecks: [
        { ruleId: 'R-SINGLE-20', actual: 0.05, threshold: 0.2, verdict: 'pass', reason: '最大单项修正 +5%' },
        { ruleId: 'R-GROUP-1.2', actual: 1.0, threshold: 1.2, verdict: 'pass', reason: '单案例比值 1.0' },
      ] }],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'completed', result: complete },
  })
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-evidence-incomplete'] === 'true').length, 0)
  assert.match(textOf(tree), /2026-06-30/)
})

test('结果页：公开联系方式按状态呈现，脱敏号码**原样**保留且没有联系入口', () => {
  const result = {
    method: 'market', methodReason: '', baseDate: '', unitPrice: 1, totalValue: 1,
    pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: [],
    cases: [
      { url: 'https://x/1', title: 'A', community: 'A 小区', transactionType: '挂牌', usedAsComparable: false,
        unitPrice: 1, buildingArea: 1, keepReason: '', dropReason: '挂牌价，需修正', capturedAt: '2026-10-13 10:00',
        evidence: 'e.html', evidenceMissing: false,
        contact: { state: 'masked', agency: '示例经纪', person: '', phone: '138****1234', detail: '' },
        status: 'single-rule-failed', ruleChecks: [
          { ruleId: 'R-SINGLE-20', actual: 0.3, threshold: 0.2, verdict: 'fail', reason: '装修 +30%' },
        ] },
      { url: 'https://x/2', title: 'B', community: 'B 小区', transactionType: '成交', usedAsComparable: true,
        unitPrice: 1, buildingArea: 1, keepReason: '同小区', dropReason: '', capturedAt: '2026-10-13 10:00',
        evidence: 'e.html', evidenceMissing: false,
        contact: { state: 'login-required', agency: '', person: '', phone: '', detail: '需要登录查看经纪人信息' },
        status: 'adopted', ruleChecks: [
          { ruleId: 'R-GROUP-1.2', actual: 1.0, threshold: 1.2, verdict: 'pass', reason: '组内比值 1.0' },
        ] },
    ],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)
  // 五态如实呈现：页面脱敏 ≠ 没拿到 ≠ 需要登录。
  assert.match(textOf(tree), /页面脱敏展示/)
  assert.match(textOf(tree), /需要登录/)
  assert.match(textOf(tree), /需要登录查看经纪人信息/)
  // 脱敏号码**原样**：不许被清洗成完整号码，也不许被抹掉。
  const phone = find(tree, (node) => node.props?.['data-valuation-contact-phone'] === 'raw')
  assert.ok(phone, '号码要按页面原样写出来')
  assert.equal(textOf(phone), '138****1234')
  // 不得提供任何**可点的**联系入口：没有 tel: / sms: 链接，也没有"拨号 / 发消息"按钮
  //（说明文字里可以出现"不提供联系入口"这句话 —— 判据是**可交互元素**，不是文案）。
  assert.equal(findAll(tree, (node) => node.type === 'a'
    && /^(tel|sms|mailto):/.test(String(node.props?.href ?? ''))).length, 0)
  const contactButtons = findAll(tree, (node) => node.type === 'button')
    .filter((node) => /拨号|发消息|联系他|打电话|去联系/.test(textOf(node)))
  assert.deepEqual(contactButtons.map((node) => textOf(node)), [], '联系方式只能是展示，不能有联系入口')
  // 状态挂在稳定标识上（真机脚本与后续断言都读它）。
  assert.ok(findAll(tree, (node) => node.props?.['data-valuation-contact-state'] === 'masked').length >= 1)
})

// ── 「部分结果」与失败阶段（§4）──────────────────────────────────────────────

test('失败时给出失败阶段：宿主最后报过的那个阶段，不是客户端猜的', async () => {
  const gate = deferred()
  const port = makePort({
    intake: async (input) => { port.calls.intake.push(input); return gate.promise },
    status: async () => ({ ok: true, phase: 'extracting', known: true, progress: { stage: '正在提取文件内容', detail: '', completed: 0, total: 0 } }),
  })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/a.pdf'] } })
  controller.start()
  // 提取过程中宿主报了阶段：失败时要把它作为"失败阶段"留下来。
  controller.poll()
  await tick()
  assert.equal(controller.getState().intakeStage, '正在提取文件内容')
  // 同一轮失败：失败阶段就是刚才宿主报过的那一个。
  gate.resolve({ ok: false, error: '提取器崩了' })
  await tick()
  assert.equal(controller.getState().failedStage, '正在提取文件内容')
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-failed-stage'] === 'true').length, 1)
  assert.match(textOf(tree), /失败阶段：正在提取文件内容/)
  assert.match(textOf(tree), /提取器崩了/)
})

test('部分结果：轮次失败但已有交付件时，结果看得见且**不**装成正式结论', async () => {
  const partial = {
    method: 'market', methodReason: '', baseDate: '',
    unitPrice: null, totalValue: null, pricingArea: null, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: ['案例数量不足：只找到 1 条可比案例'],
    cases: [], artifacts: { html: false, xlsx: true, json: false },
  }
  const port = makePort({
    status: async () => ({
      ok: true, phase: 'failed', known: true, recordError: '案例数量不足，未给出正式单价',
      progress: { stage: '', detail: '', completed: 0, total: 0 },
      artifacts: { html: false, xlsx: true, json: false },
      providerStates: {},
    }),
    result: async () => ({ ok: true, result: partial }),
  })
  const controller = createReportEvaluationController(port, {
    initial: { phase: 'failed', valuationId: '估值-x', error: '案例数量不足，未给出正式单价' },
  })
  controller.poll()
  await tick()
  // 阶段**保持 failed**：部分结果不是完成。
  assert.equal(controller.getState().phase, 'failed')
  assert.notEqual(controller.getState().result, null, '已经产出的部分要落地')
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-partial'] === 'true').length, 1)
  assert.match(textOf(tree), /这是阶段结果，不是正式结论/)
  // 拿不到的数字是 `—`，不是 0，也不是"看起来像结论"的大数字。
  assert.match(textOf(tree), /—/)
  assert.match(textOf(tree), /案例数量不足/)
  // 交付件只说在的那一件：另外两件写"还没生成"。
  assert.match(textOf(tree), /还没生成/)
})

test('失败且**没有**交付件时不渲染结果页（不给一个空壳结论）', async () => {
  const port = makePort({
    status: async () => ({
      ok: true, phase: 'failed', known: true, recordError: '资料提取未完成：磁盘只读',
      progress: { stage: '', detail: '', completed: 0, total: 0 },
      artifacts: { html: false, xlsx: false, json: false }, providerStates: {},
    }),
    result: async () => { throw new Error('不该被调用') },
  })
  const controller = createReportEvaluationController(port, {
    initial: { phase: 'failed', valuationId: '估值-x', error: '资料提取未完成' },
  })
  controller.poll()
  await tick()
  assert.equal(controller.getState().result, null)
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-partial'] === 'true').length, 0)
  // 失败原因与可执行动作仍然在（那才是用户此刻需要的）。
  assert.match(textOf(tree), /资料提取未完成/)
  assert.match(textOf(tree), /重新提取/)
})

test('部分结果不覆盖正式完成：completed 时结果页不打"阶段结果"标记', async () => {
  const done = {
    method: 'market', methodReason: '', baseDate: '', unitPrice: 52000, totalValue: 6240000,
    pricingArea: 120, priceUnit: '元/㎡', manualConfirmationItems: [], capabilityGaps: [],
    cases: [], artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'completed', result: done },
  })
  const tree = renderPane(controller)
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-partial'] === 'true').length, 0)
  // 计价面积与计价单位就在单价旁边（§9 第 1 条）。
  assert.match(textOf(tree), /计价面积/)
  assert.match(textOf(tree), /120/)
  assert.match(textOf(tree), /元\/㎡/)
})

test('抽屉把资料冲突与「用户提供」的性质都摆出来（§4 / §5 第 7 条）', () => {
  const intake = intakeViewOf({
    ...INTAKE_PAYLOAD,
    fieldSources: { 建筑面积: '报告A.pdf' },
    fieldConflicts: [{ label: '建筑面积', values: [
      { file: '报告A.pdf', value: '120.5' },
      { file: '报告B.pdf', value: '98.0' },
    ] }],
  }, { valuationId: '', method: 'market', baseDate: '', supplementalPrompt: '多考虑地铁' })
  const controller = createReportEvaluationController(makePort(), {
    initial: { phase: 'confirmation', method: 'market', intake },
  })
  const tree = renderPane(controller)
  // 冲突：双方的值都在，且标出当前采用的那一份。
  const conflict = find(tree, (node) => node.props?.['data-valuation-field-conflict'] === '建筑面积')
  assert.ok(conflict, '资料冲突要逐条列出来')
  const text = textOf(conflict)
  assert.match(text, /120\.5/)
  assert.match(text, /98\.0/)
  assert.match(text, /报告A\.pdf/)
  assert.match(text, /报告B\.pdf/)
  assert.match(text, /当前采用/)
  // 用户补充要求的性质要写在明处：它是「用户提供」，不是文件原文。
  assert.match(textOf(tree), /用户提供/)
})

// ── 文件列表：少量 / 大量 / 长名 / 解析失败（§10 布局那条的可断言部分）────────

/** 造一份带 N 个文件的扫描结果。 */
function scanOf(paths) {
  return { ok: true, items: paths.map((path, index) => ({
    path, name: path.split('/').pop(), kind: 'pdf', sizeBytes: 1024 * (index + 1),
    status: 'scanned', reason: '', fileCount: 1,
  })) }
}

test('少量文件：逐份都画出来，不做任何折叠', async () => {
  const paths = ['/a/报告1.pdf', '/a/报告2.pdf', '/a/报告3.pdf']
  const port = makePort({ scan: async () => scanOf(paths) })
  const controller = createReportEvaluationController(port, { initial: { selection: paths } })
  controller.rescan()
  await tick()
  const tree = renderPane(controller)
  for (const path of paths) {
    assert.match(textOf(tree), new RegExp(path.split('/').pop().replace('.', '\\.')))
  }
  assert.equal(findAll(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-more').length, 0,
    '少量文件不该出现「查看全部」')
})

test('大量文件：有界列表 + 「查看全部 N 份」，不把后续设置推到很远', async () => {
  const paths = Array.from({ length: 20 }, (_, index) => `/a/报告${String(index + 1)}.pdf`)
  const port = makePort({ scan: async () => scanOf(paths) })
  const controller = createReportEvaluationController(port, { initial: { selection: paths } })
  controller.rescan()
  await tick()
  const tree = renderPane(controller)
  const rows = findAll(tree, (node) => String(node.props?.className ?? '').split(/\s+/).includes('crwu-valuation-file'))
  assert.equal(rows.length, 8, '前 8 份之外先折叠（列表有界高度，内部滚动）')
  const more = find(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-more')
  assert.ok(more, '要能展开全部')
  assert.match(textOf(more), /查看全部 20 份/)
  // 数量统计照实说 20，不是 8。
  assert.match(textOf(tree), /已添加 20 份资料/)
})

test('长文件名：行内截断，完整名称在 title 里查得到', async () => {
  const long = `/a/${'很长的文件名'.repeat(12)}.pdf`
  const port = makePort({ scan: async () => scanOf([long]) })
  const controller = createReportEvaluationController(port, { initial: { selection: [long] } })
  controller.rescan()
  await tick()
  const tree = renderPane(controller)
  const name = find(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-file-name')
  assert.ok(name, '文件名那一行要在')
  // 截断是 CSS 的事（overflow/text-overflow 见样式），这里钉的是**完整名称可查**。
  assert.equal(name.props.title, long, '完整路径 / 名称要在 title 里')
})

test('解析失败：逐份给出具体原因，而不是只说「未完成」', async () => {
  const paths = ['/a/扫描件.tif']
  const port = makePort({ scan: async () => ({ ok: true, items: [{
    path: paths[0], name: '扫描件.tif', kind: 'image', sizeBytes: 512,
    status: 'skipped', reason: '没有可用的 OCR：图片内容不会被假装读过', fileCount: 1,
  }] }) })
  const controller = createReportEvaluationController(port, { initial: { selection: paths } })
  controller.rescan()
  await tick()
  const tree = renderPane(controller)
  assert.match(textOf(tree), /没有可用的 OCR/)
  // 状态词如实说「未纳入」，不是含糊的"未完成"。
  assert.match(textOf(tree), /未纳入/)
})

test('扫描失败：说清楚是清单读不出来，而不是"你还没选"', async () => {
  const port = makePort({ scan: async () => ({ ok: false, error: '目录不存在' }) })
  const controller = createReportEvaluationController(port, { initial: { selection: ['/a/报告.pdf'] } })
  controller.rescan()
  await tick()
  const tree = renderPane(controller)
  const alert = find(tree, (node) => String(node.props?.className ?? '').includes('crwu-valuation-count-error'))
  assert.ok(alert, '扫描失败要有可见的错误')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /目录不存在/)
})

test('结果页给出规则校验摘要：逐条规则给出通过 / 未通过数与阈值，组内比值可复核', () => {
  const result = {
    method: 'market', methodReason: '', baseDate: '', unitPrice: 51000, totalValue: 5100000,
    pricingArea: 100, priceUnit: '元/㎡', manualConfirmationItems: [], capabilityGaps: [],
    cases: [
      { url: 'https://x/1', title: 'A', community: 'A', transactionType: '成交', usedAsComparable: true,
        unitPrice: 51000, buildingArea: 100, keepReason: '同小区', dropReason: '', capturedAt: '',
        evidence: 'e1.html', evidenceMissing: false, contact: { state: 'public', agency: '甲', person: '', phone: '', detail: '' },
        status: 'adopted', ruleChecks: [
          { ruleId: 'R-SINGLE-20', actual: 0.08, threshold: 0.2, verdict: 'pass', reason: '楼层 +8%' },
          { ruleId: 'R-GROUP-1.2', actual: 1.1, threshold: 1.2, verdict: 'pass', reason: '组内比值 1.1' },
        ] },
      { url: 'https://x/2', title: 'B', community: 'B', transactionType: '挂牌', usedAsComparable: false,
        unitPrice: 60000, buildingArea: 90, keepReason: '', dropReason: '挂牌价需修正', capturedAt: '',
        evidence: 'e2.html', evidenceMissing: false, contact: { state: 'not-published', agency: '', person: '', phone: '', detail: '' },
        status: 'single-rule-failed', ruleChecks: [
          { ruleId: 'R-SINGLE-20', actual: 0.34, threshold: 0.2, verdict: 'fail', reason: '装修 +34% 超过 20%' },
          { ruleId: 'R-GROUP-1.2', actual: 1.1, threshold: 1.2, verdict: 'pass', reason: '组内比值 1.1' },
        ] },
    ],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)

  // ① 最终采用案例数（§9 第 3 条）。
  const adopted = find(tree, (node) => node.props?.['data-valuation-adopted-count'] !== undefined)
  assert.ok(adopted, '要给出最终采用案例数量')
  assert.equal(adopted.props['data-valuation-adopted-count'], '1')

  // ② 组内比值与阈值都要给出，且标明是否超限。
  const ratio = find(tree, (node) => node.props?.['data-valuation-group-ratio'] !== undefined)
  assert.ok(ratio, '要给出组内比值')
  assert.equal(ratio.props['data-valuation-group-ratio'], '1.1')
  assert.equal(ratio.props['data-valuation-group-over'], 'false')
  assert.match(textOf(ratio), /阈值 1\.2/)

  // ③ 逐条规则：通过 / 未通过数 + 阈值。
  const single = find(tree, (node) => node.props?.['data-valuation-rule-check'] === 'R-SINGLE-20')
  assert.ok(single, '每条规则都要有汇总行')
  assert.match(textOf(single), /通过 1 · 未通过 1/)
  assert.match(textOf(single), /阈值 0\.2/)
  const group = find(tree, (node) => node.props?.['data-valuation-rule-check'] === 'R-GROUP-1.2')
  assert.match(textOf(group), /通过 2 · 未通过 0/)

  // ④ 案例表逐行给出状态（§8 的六态），不是只有"是 / 否可比"。
  const statuses = findAll(tree, (node) => node.props?.['data-valuation-case-status'] !== undefined)
  assert.deepEqual(statuses.map((node) => node.props['data-valuation-case-status']), ['adopted', 'single-rule-failed'])
  assert.match(textOf(statuses[0]), /最终采用/)
  assert.match(textOf(statuses[1]), /单项规则未通过/)
})

test('组内比值超过 1.2 时摘要上明说"已超过阈值"，并把处置指向待确认事项', () => {
  const result = {
    method: 'market', methodReason: '', baseDate: '', unitPrice: 1, totalValue: 1,
    pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: ['组内比值 1.5 超过 1.2：已说明处置方式并保留，需复核'],
    capabilityGaps: [],
    cases: [{ url: 'https://x/1', title: 'A', community: 'A', transactionType: '成交', usedAsComparable: true,
      unitPrice: 1, buildingArea: 1, keepReason: '同小区', dropReason: '', capturedAt: '',
      evidence: 'e.html', evidenceMissing: false, contact: { state: 'public', agency: '甲', person: '', phone: '', detail: '' },
      status: 'adopted', ruleChecks: [
        { ruleId: 'R-GROUP-1.2', actual: 1.5, threshold: 1.2, verdict: 'fail', reason: '组内比值 1.5' },
      ] }],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)
  const ratio = find(tree, (node) => node.props?.['data-valuation-group-ratio'] !== undefined)
  assert.equal(ratio.props['data-valuation-group-over'], 'true', '超限要在摘要上标出来')
  assert.match(textOf(ratio), /已超过阈值/)
  assert.match(textOf(tree), /组内比值 1\.5 超过 1\.2/)
})

// ── 方法判断记录与"不许静默切换"（§7.2）────────────────────────────────────

test('结果页给出方法判断记录：采用哪个、其他为什么不采用', () => {
  const result = {
    method: 'market', methodReason: '同片区成交案例充分',
    methodScreening: [
      { method: 'market', verdict: 'adopted', reason: '同小区与同片区有 3 条可核成交案例' },
      { method: 'income', verdict: 'not-adopted', reason: '对象空置、无租赁合同：缺净收益序列' },
      { method: 'cost', verdict: 'not-adopted', reason: '重置成本与土地取得资料不足' },
    ],
    methodConflict: null,
    baseDate: '', unitPrice: 1, totalValue: 1, pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: [],
    cases: [], artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)
  const rows = findAll(tree, (node) => node.props?.['data-valuation-method-screening'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-valuation-method-screening']), ['market', 'income', 'cost'])
  assert.match(textOf(rows[0]), /采用/)
  assert.match(textOf(rows[1]), /不采用/)
  assert.match(textOf(rows[1]), /缺净收益序列/)
  // 没有冲突时不画冲突提示（别把正常结论说成有问题）。
  assert.equal(findAll(tree, (node) => node.props?.['data-valuation-method-conflict'] === 'true').length, 0)
})

test('用户指定的方法被换掉时，结果页把冲突摆在结论之前', () => {
  const result = {
    method: 'market', methodReason: '',
    methodScreening: [
      { method: 'market', verdict: 'adopted', reason: '无租金数据，改按市场法' },
      { method: 'income', verdict: 'not-adopted', reason: '对象空置、无租赁合同' },
    ],
    methodConflict: { userMethod: 'income', adoptedMethod: 'market', reason: '缺租金与空置率数据，收益法无法形成净收益序列' },
    baseDate: '', unitPrice: 1, totalValue: 1, pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: ['用户指定收益法，因缺租金数据改按市场法：请复核'],
    capabilityGaps: [],
    cases: [], artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)
  const conflict = find(tree, (node) => node.props?.['data-valuation-method-conflict'] === 'true')
  assert.ok(conflict, '换了方法必须当场可见')
  assert.equal(conflict.props.role, 'alert', '这不是普通说明，是要人处理的冲突')
  const text = textOf(conflict)
  assert.match(text, /收益法/)
  assert.match(text, /市场法/)
  assert.match(text, /缺租金与空置率数据/)
})

test('结果页给出最终采用案例的**来源分布**与每条的来源（§9 第 3 条）', () => {
  const result = {
    method: 'market', methodReason: '', methodScreening: [], methodConflict: null,
    baseDate: '', unitPrice: 1, totalValue: 1, pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: [],
    cases: [
      { source: 'fang', sourceLabel: '房天下', url: 'https://x/1', title: 'A', community: 'A',
        transactionType: '成交', usedAsComparable: true, unitPrice: 1, buildingArea: 1,
        keepReason: '同小区', dropReason: '', capturedAt: '', evidence: 'e1.html', evidenceMissing: false,
        contact: { state: 'public', agency: '', person: '', phone: '', detail: '' },
        status: 'adopted', ruleChecks: [] },
      { source: 'fang', sourceLabel: '房天下', url: 'https://x/2', title: 'B', community: 'B',
        transactionType: '成交', usedAsComparable: true, unitPrice: 1, buildingArea: 1,
        keepReason: '同片区', dropReason: '', capturedAt: '', evidence: 'e2.html', evidenceMissing: false,
        contact: { state: 'not-published', agency: '', person: '', phone: '', detail: '' },
        status: 'adopted', ruleChecks: [] },
      { source: 'lianjia', sourceLabel: '链家 / 贝壳', url: 'https://x/3', title: 'C', community: 'C',
        transactionType: '挂牌', usedAsComparable: false, unitPrice: 1, buildingArea: 1,
        keepReason: '', dropReason: '挂牌价需修正', capturedAt: '', evidence: 'e3.html', evidenceMissing: false,
        contact: { state: 'masked', agency: '', person: '', phone: '138****1234', detail: '' },
        status: 'single-rule-failed', ruleChecks: [] },
    ],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)

  // ① 按来源汇总：每家多少条、其中采用几条。
  const rows = findAll(tree, (node) => node.props?.['data-valuation-case-source-summary'] !== undefined)
  const byKey = Object.fromEntries(rows.map((node) => [node.props['data-valuation-case-source-summary'], textOf(node)]))
  assert.match(byKey.fang, /共 2 条 · 采用 2 条/)
  assert.match(byKey.lianjia, /共 1 条 · 采用 0 条/)
  assert.match(byKey.fang, /房天下/)

  // ② 每条案例自己也要标出来源（复核时要能追到站点）。
  const sources = findAll(tree, (node) => node.props?.['data-valuation-case-source'] !== undefined)
  assert.deepEqual(sources.map((node) => node.props['data-valuation-case-source']).sort(), ['fang', 'fang', 'lianjia'])
  assert.match(textOf(sources[0]), /房天下|链家/)
})

test('来源拿不到时不当成"有个空来源"（不制造假分组）', async () => {
  const { caseSourceSummary } = await import(
    new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
  const base = { source: '', sourceLabel: '', usedAsComparable: true }
  assert.deepEqual(caseSourceSummary([base]), [], '来源与展示名都空 → 不参与分组，也不显示空一行')
  // 只有 id 没有展示名时用 id 当标签（照实显示，不留空白）。
  assert.deepEqual(caseSourceSummary([{ ...base, source: 'fang' }]).map((row) => row.label), ['fang'])
})

test('结果页把截图与页面证据分成两列：没有截图时如实写"没有截图"，不拿证据顶替（§7.4）', () => {
  const result = {
    method: 'market', methodReason: '', methodScreening: [], methodConflict: null,
    baseDate: '', unitPrice: 1, totalValue: 1, pricingArea: 1, priceUnit: '元/㎡',
    manualConfirmationItems: [], capabilityGaps: [],
    cases: [
      { source: 'fang', sourceLabel: '房天下', url: 'https://x/1', title: 'A', community: 'A',
        transactionType: '成交', usedAsComparable: true, unitPrice: 1, buildingArea: 1,
        keepReason: '同小区', dropReason: '', capturedAt: '',
        evidence: '来源证据/fang-1.html', evidenceMissing: false,
        screenshot: '来源证据/截图-fang-1.png', screenshotDigest: 'sha256:aa', screenshotCapturedAt: '2026-01-01T00:00:00.000Z',
        screenshotMissing: false,
        contact: { state: 'public', agency: '', person: '', phone: '', detail: '' },
        status: 'adopted', ruleChecks: [] },
      { source: 'lianjia', sourceLabel: '链家 / 贝壳', url: 'https://x/2', title: 'B', community: 'B',
        transactionType: '挂牌', usedAsComparable: false, unitPrice: 1, buildingArea: 1,
        keepReason: '', dropReason: '挂牌价需修正', capturedAt: '',
        evidence: '来源证据/lianjia-1.html', evidenceMissing: false,
        screenshot: '', screenshotDigest: '', screenshotCapturedAt: '', screenshotMissing: true,
        contact: { state: 'not-published', agency: '', person: '', phone: '', detail: '' },
        status: 'single-rule-failed', ruleChecks: [] },
    ],
    artifacts: { html: true, xlsx: true, json: true },
  }
  const controller = createReportEvaluationController(makePort(), { initial: { phase: 'completed', result } })
  const tree = renderPane(controller)
  const cells = findAll(tree, (node) => node.props?.['data-valuation-case-screenshot'] !== undefined)
  assert.equal(cells.length, 2)
  assert.equal(cells[0].props['data-valuation-case-screenshot'], '来源证据/截图-fang-1.png')
  assert.match(textOf(cells[0]), /截图-fang-1\.png/)
  // 有截图的那条：指针悬停能看到指纹（取证要能核对文件没被换过）。
  const withTitle = find(cells[0], (node) => node.props?.title === 'sha256:aa')
  assert.ok(withTitle, '截图上要给出指纹')
  // 没截图的那条：如实写"没有截图"，**不是**留空 —— 留空会被读成"有证据就等于有截图"。
  assert.equal(cells[1].props['data-valuation-case-screenshot'], '')
  assert.match(textOf(cells[1]), /没有截图/)
  // 两条都有页面证据：证明截图那一列不是从证据推出来的。
  assert.match(textOf(tree), /来源证据\/lianjia-1\.html/)
})

test('多个订阅者都要收到通知（面板外壳 + 估值页同时订阅时，不许谁覆盖谁）', async () => {
  // 用户 2026-10-13 实测：选中资料后文件列表不刷新、确认抽屉不出来，要切一次页面才看到。
  // 根因是 controller 只有一个 listener 槽位 —— 后订阅的（父级外壳）把先订阅的（估值页）
  // 覆盖掉，页面再也不重渲染。
  const port = makePort()
  const controller = createReportEvaluationController(port, { initial: { selection: ['/tmp/a.pdf'] } })

  const seenByOuter = []
  const seenByPane = []
  const stopOuter = controller.subscribe((next) => { seenByOuter.push(next.method) })
  const stopPane = controller.subscribe((next) => { seenByPane.push(next.method) })

  controller.setMethod('income')
  assert.deepEqual(seenByOuter, ['income'], '先订阅的（估值页）必须收到通知')
  assert.deepEqual(seenByPane, ['income'], '后订阅的（面板外壳）也要收到通知')

  controller.setBaseDate('2026-06-30')
  assert.equal(seenByPane.length, 2)
  assert.equal(seenByOuter.length, 2)

  // 退掉一个之后，另一个照常收（退订不许把别人一起带走）。
  stopOuter()
  controller.setMethod('cost')
  assert.deepEqual(seenByPane, ['income', 'income', 'cost'])
  assert.deepEqual(seenByOuter, ['income', 'income'], '退订之后不再收到')
  stopPane()

  // 取消订阅之后（React 卸载）再写状态不该抛错。
  controller.setMethod('auto')
})

test('空态只说真实提供的能力：不提拖放（宿主没把拖放交过来）', () => {
  const controller = createReportEvaluationController(makePort())
  const tree = renderPane(controller)
  const text = textOf(tree)
  // §4：拖放只在宿主确实支持时提供。宿主不给，文案就不许写"拖进来"。
  assert.equal(text.includes('拖'), false, `空态文案不该提拖拽：${text}`)
  assert.match(text, /还没有添加资料/)
  assert.match(text, /添加文件/)
  // 空态本身也不该挂 onDrop / onDragOver（那会让人以为能扔）。
  const droppable = findAll(tree, (node) => node.props?.onDrop !== undefined || node.props?.onDragOver !== undefined)
  assert.deepEqual(droppable, [], '没有拖放实现就不要挂拖放事件')
  // 读取能力要如实说清楚（扫描件 / 图片需要 OCR）。
  assert.match(text, /OCR/)
})
