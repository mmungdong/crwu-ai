/**
 * 「当前审核」摘要卡与停止阶段（F2/F3，2026-09-29）。
 *
 * 这份测试盯用户点名的六件事：
 * 1. 点静止态：摘要卡必须**一直在**（包括当前审核不在当前分页 / 筛选结果里时）；
 * 2. 「打开审核会话」用的是**被点那一行**的 `childId` / `parentSessionId`，不是全局 activeKey；
 * 3. `childId` 为空时按钮 disabled 且文案是「会话正在建立」，不许发 open；
 * 4. 阶段文案在卡上、用 `aria-live="polite"` 播报；等待期间停止按钮禁用；
 * 5. timeout / failed 不显示「已停止」，且当前审核**不被清掉**；
 * 6. 它与「分析审核结果（audit_analysis）」是两个入口、两个目标会话。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { fakeReact, registerTsxLoader } from '../helpers/tsx-loader.mjs'

// 报告页是 `.tsx`：必须先注册 TSX 加载器，否则 import 会被 Node 直接拒掉。
registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { ReportPane } = await import(new URL('src/client/features/report-audit/ReportPane.tsx', ROOT).href)
const { openSessionTarget } = await import(new URL('src/client/features/report-audit/row.ts', ROOT).href)
const { discussionTitle } = await import(new URL('src/client/features/report-audit/assistant-context.ts', ROOT).href)

const React = fakeReact

/** 渲染（与 client-package.test.mjs 同一套最小渲染器：不引入 react-dom）。 */
function render(component, props = {}) {
  const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
  globalThis.__crwuTestInstance = instance
  return { tree: resolve(component(props)), instance }
}
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
    globalThis.__crwuTestInstance = instance
    try { return resolve(node.type(node.props)) } finally { globalThis.__crwuTestInstance = saved }
  }
  return { ...node, props: { ...node.props, children: resolve(node.props?.children) } }
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  findAll(node.props?.children, predicate, out)
  return out
}
// 与 `client-package.test.mjs` 同一套判据：**button 元素 + 精确文本**。
// （`Button` 是函数组件，展开后 props 里没有 `label`，只能按渲染出的文本找。）
const buttonLike = (tree, label) => findAll(tree, (node) => node.type === 'button' && textOf(node) === label)[0] ?? null
const liveRegions = (tree) => findAll(tree, (node) => node.props?.['aria-live'] !== undefined)

const RECORD = {
  key: '2026-301705-LX10170',
  childId: 'child-abcdef123456',
  seqNo: '2026-301705-LX10170',
  project: '某项目',
  objectId: 'obj-1',
  startedAt: '2026-09-29 10:00:00',
  parentSessionId: 'parent-1',
  status: 'running',
  ended: false,
  stopped: false,
  stopReason: '',
  endReason: '',
  casePath: '/cases/space/2026-301705-LX10170',
  resultFile: '', htmlFile: '', caseName: '', uploadedAt: '', uploadError: '', ossPrefix: '',
  attempt: 2,
}

const paneProps = (overrides = {}) => ({
  state: {
    tasks: [], audits: {}, ossIndex: {}, ossIndexError: '', ossLoading: false, formName: '',
    query: '', page: 1, pageSize: 20, total: 0, filterMode: '', activeKey: RECORD.key,
    escalateAvailable: false, handoff: null, notice: '', childAliveHint: '',
  },
  gating: { canDispatch: true, canStart: true },
  onSearch: () => {}, onGoPage: () => {}, onRefreshPending: () => {}, onRefreshCloud: () => {},
  onStart: () => {}, onStop: () => {}, onRetryUpload: () => {}, onOpenCloud: () => {},
  onOpenLocalHtml: () => {}, onOpenSession: () => {}, onOpenAuditInfo: () => {}, onOpenPath: () => {},
  onEscalateRetry: () => {}, handoffCopied: false, onHandoffCopied: () => {},
  ...overrides,
})

test('摘要卡：显示流水号 / 项目 / attempt / 开始时间 / childId 尾部，且**不在分页里也在**', () => {
  const { tree } = render(ReportPane, paneProps({
    state: { ...paneProps().state, audits: { [RECORD.key]: RECORD } },
  }))
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.currentAuditTitle), true, '有「当前审核」标题')
  assert.equal(text.includes(RECORD.key), true, '流水号')
  assert.equal(text.includes('某项目'), true, '项目名')
  assert.equal(text.includes(`${zhCN.currentAuditAttempt}2${zhCN.currentAuditAttemptSuffix}`), true, 'attempt')
  assert.equal(text.includes('2026-09-29'), true, '开始时间（保留完整年份，不做相对时间）')
  assert.equal(text.includes('child-abcdef123456'.slice(-8)), true, 'childId 脱敏尾部')
  // tasks 是空的（这条不在当前分页/筛选结果里），卡仍然可见 —— 这是用户明确要求的
  assert.equal(paneProps().state.tasks.length, 0)
})

test('「打开审核会话」用被点那一行的精确 childId/parentSessionId，且与 audit_analysis 是两个入口', () => {
  const opened = []
  const { tree } = render(ReportPane, paneProps({
    state: { ...paneProps().state, audits: { [RECORD.key]: RECORD } },
    onOpenSession: (key) => { opened.push(key) },
  }))
  const open = buttonLike(tree, zhCN.openAuditSession)
  assert.notEqual(open, null, '摘要卡上要有「打开审核会话」')
  assert.equal(open.props.disabled, false)
  assert.equal(open.props.title, zhCN.openAuditSessionHint, '说明它与"分析审核结果"不是同一个会话')
  open.props.onClick()
  assert.deepEqual(opened, [RECORD.key], '目标由 Host 的记录决定（被点的那一行）')

  // 目标 id 必须来自记录本身：`openSessionTarget` 是那个唯一的解析点
  const audits = { [RECORD.key]: RECORD }
  const target = openSessionTarget(RECORD.key, audits, 'bound-parent')
  assert.equal(target.childId, RECORD.childId, '必须用记录里的 childId')
  assert.equal(target.parentSessionId, RECORD.parentSessionId, '必须用记录里的 parentSessionId')
  // 传别的 key（全局 activeKey 顶替）会拿到别的目标 → 说明"用错 key 就开错会话"
  const other = { ...RECORD, key: 'other', childId: 'child-OTHER', parentSessionId: 'parent-OTHER' }
  assert.equal(openSessionTarget('other', { ...audits, other }, 'bound-parent').childId, 'child-OTHER')

  // **两个入口、两个目标**：这条卡打开的是"审核子会话"（记录里的 childId），
  // 而「AI 审核结果分析」是另一条 `audit_analysis` 讨论会话（标题由序号生成，与 childId 无关）。
  assert.equal(zhCN.openAuditSession.includes('分析'), false, '「打开审核会话」的文案不许混入"分析"（两个入口语义不同）')
  const analysisTitle = discussionTitle(RECORD.seqNo, 1)
  assert.equal(analysisTitle.includes(RECORD.childId), false, '分析会话的标题由流水号生成，与审核 childId 无关')
  assert.equal(target.childId, RECORD.childId, '打开审核会话只认记录里的 childId')
  assert.notEqual(analysisTitle, RECORD.childId, '两者不是同一个会话标识')
})

test('childId 为空：按钮 disabled、文案是「会话正在建立」，点它不许发 open', () => {
  const opened = []
  const { tree } = render(ReportPane, paneProps({
    state: { ...paneProps().state, audits: { [RECORD.key]: { ...RECORD, childId: '' } } },
    onOpenSession: (key) => { opened.push(key) },
  }))
  const button = buttonLike(tree, zhCN.openAuditSessionPending)
  assert.notEqual(button, null, '文案必须说明"会话正在建立"')
  assert.equal(button.props.disabled, true, 'childId 为空时必须禁用（不能发起 open）')
  if (typeof button.props.onClick === 'function' && button.props.disabled !== true) button.props.onClick()
  assert.deepEqual(opened, [], '禁用的按钮不许发 open')
})

test('阶段文案在卡上、aria-live 播报；等待期间停止按钮禁用', () => {
  const waiting = {
    ...RECORD,
    stop: {
      phase: 'waiting-quiescence', requestedAt: Date.now() - 4_000, elapsedMs: 4_000,
      quiesced: false, aborted: true, disposed: false, error: '', notes: [], canStartNext: false,
    },
  }
  const { tree } = render(ReportPane, paneProps({
    state: { ...paneProps().state, audits: { [RECORD.key]: waiting } },
  }))
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.stopPhaseStillWaiting) || text.includes(zhCN.stopPhaseWaiting), true,
    '等待期间必须有阶段文案（不许笼统"处理中"）')
  assert.equal(text.includes(zhCN.stopNoRestartHint), true, '必须说清"确认停止前不能启动新的审核"')
  const live = liveRegions(tree)
  assert.equal(live.length >= 1, true, '阶段文案必须是 aria-live 区域')
  assert.equal(live[0].props['aria-live'], 'polite')
  const stop = buttonLike(tree, zhCN.stopAudit)
  assert.equal(stop.props.disabled, true, '等待期间停止按钮禁用（Host 幂等，但界面不该鼓励连点）')
})

test('本地刚点过停止（Host 还没回报）：立刻显示「正在请求停止审核…」', () => {
  const { tree } = render(ReportPane, paneProps({
    state: { ...paneProps().state, audits: { [RECORD.key]: RECORD } },
    stopRequestedAt: Date.now(),
  }))
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.stopPhaseRequested), true, '点下去立刻有反馈（F1 的 100ms 要求）')
  assert.equal(textOf(findAll(tree, (node) => node.props?.['aria-live'] !== undefined)[0]).startsWith(zhCN.stopPhaseQuiesced), false,
    '绝不许此刻就说"已停止"')
})

test('timeout / failed：不显示「已停止」、当前审核不清除、给补救动作', () => {
  for (const [phase, expectLabel] of [['timeout', zhCN.stopPhaseTimeout], ['failed', zhCN.stopPhaseFailed]]) {
    const record = {
      ...RECORD,
      stop: {
        phase, requestedAt: 1, elapsedMs: 9_000, quiesced: false, aborted: true, disposed: false,
        error: phase === 'failed' ? 'EACCES: 状态文件写不进去' : '', notes: ['dispose 超时'], canStartNext: false,
      },
    }
    const { tree } = render(ReportPane, paneProps({
      state: { ...paneProps().state, audits: { [RECORD.key]: record } },
      onRefreshStatus: () => {}, onCopyDiagnostics: () => {},
    }))
    const text = textOf(tree)
    assert.equal(text.includes(expectLabel), true, `${phase} 要有对应文案`)
    // 只查**停止状态**那一行：页面别处（行状态徽章）也可能出现"已停止"这个词，
    // 整篇 includes 会把无关的地方算进来（本仓踩过这类假红/假绿）。
    const stopLine = findAll(tree, (node) => node.props?.['aria-live'] !== undefined).map(textOf).join(' ')
    // ⚠️ 只能比**整行开头**：timeout 的文案「暂时无法确认子会话已停止」本身**包含**"已停止"
    // 这三个字（子串匹配会假红 —— 本仓对这类假通过/假红都留了记录）。
    assert.equal(stopLine.startsWith(zhCN.stopPhaseQuiesced), false, `${phase} 不许显示成"已停止"`)
    assert.equal(stopLine.startsWith(expectLabel), true, `${phase} 的状态行必须以对应阶段文案开头`)
    assert.equal(text.includes(RECORD.key), true, `${phase} 时当前审核必须仍然可见（不许被清掉）`)
    assert.equal(text.includes(zhCN.stopKeptHint), true, '要说清占用未释放')
    assert.equal(text.includes(zhCN.stopActionCopyDiagnostics), true, '要有「复制诊断」')
    if (phase === 'timeout') {
      assert.equal(text.includes(zhCN.stopActionKeepWaiting), true, 'timeout 要给「继续等待」')
      assert.equal(text.includes(zhCN.stopActionStopAgain), true, 'timeout 要给「再次停止」')
    }
    if (phase === 'failed') {
      assert.equal(text.includes('EACCES'), true, 'failed 要显示真实错误原因')
      assert.equal(text.includes(zhCN.stopActionOpenSession), true, 'failed 要给「打开当前会话」')
    }
    assert.equal(text.includes('dispose 超时'), true, 'Host 回报的观察也要显示')
  }
})
