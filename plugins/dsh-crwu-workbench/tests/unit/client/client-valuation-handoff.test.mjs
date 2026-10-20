/**
 * 房地产启动页的**门禁 / 抽屉 / 交接跳转**（计划 Task 4）。
 *
 * 这一份钉的是"页面到会话"那一段，逐条对应设计稿 §4 与 §5：
 *
 * 1. **门禁只拦房地产正文**：未登录时正文被拦，但目录切换、报告评估、报告审核、环境信息照常；
 * 2. **抽屉只展示文件元信息与三个用户输入**：知识库状态、已知/缺失字段、完整提示词、
 *    取证能力、digest、运行看板一律不许出现；
 * 3. **一次只建一个父会话**：双击「开始估值」、超时重试都复用同一个 requestId，
 *    导航失败只重新导航；
 * 4. **交接成功后不再有任何 valuation-status / valuation-result 请求**；
 * 5. **迟到的响应不许覆盖新页面**（generation + AbortSignal）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { WORKBENCH_PROTOCOL, VALUATION_PROMPT_MAX_LENGTH } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { FROZEN_OPERATIONS } = await import(new URL('tests/helpers/frozen-inventory.mjs', ROOT).href)
const { ReportEvaluationPane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT).href)
const { createReportEvaluationController } = await import(
  new URL('src/client/modules/report-evaluation/controller.ts', ROOT).href)
const { createModuleStore } = await import(new URL('src/client/shell/module-store.ts', ROOT).href)
const { childNodes, nodeById } = await import(new URL('src/client/shell/navigation.ts', ROOT).href)
const { render: renderToTree, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 一次挂载 + 跑完 effect + 冲刷微任务，再重渲染（替身不会按依赖自动重跑 effect）。 */
async function mountPane(controller) {
  const rendered = renderToTree(ReportEvaluationPane, { controller })
  const pending = rendered.instance.effects
  rendered.instance.effects = []
  for (const effect of pending) await effect.callback()
  await tick()
  return { tree: rerender(ReportEvaluationPane, { controller }), instance: rendered.instance }
}

/**
 * 走到**确认抽屉**：先把 effect 跑起来，再准备预览、冲刷微任务、重跑新增的 effect，最后重渲染。
 *
 * 协议 39 起"挂载即探测来源"被删掉：能力检查由**抽屉打开**触发。所以这里必须
 * 挂载 → 准备预览 → 重跑 effect，顺序反了就永远等不到那次检查。
 */
async function confirmationTree(port, patch = {}) {
  const controller = draftController(port, patch)
  const rendered = renderToTree(ReportEvaluationPane, { controller })
  /** 把当前这一帧登记的 effect 全部跑掉（替身不会按依赖自动重跑）。 */
  const drain = async () => {
    const pending = rendered.instance.effects
    rendered.instance.effects = []
    for (const effect of pending) await effect.callback()
    await tick()
  }
  await drain()
  controller.preparePreview()
  await tick()
  // 先重渲染一次：抽屉的"呈现生命周期" effect 是在 `wantsDrawer` 变真那一帧才登记的。
  rerender(ReportEvaluationPane, { controller })
  await drain()
  return { tree: rerender(ReportEvaluationPane, { controller }), controller, instance: rendered.instance }
}

const PREVIEW_FILE = {
  fileId: 'material-001',
  fileName: '估值报告.pdf',
  absolutePath: '/Users/someone/资料/估值报告.pdf',
  archiveRelativePath: '材料-源/估值报告.pdf',
  kind: 'pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  createdAt: '2026-02-01T02:03:04.000Z',
  modifiedAt: '2026-03-01T02:03:04.000Z',
  readable: true,
  duplicateOf: null,
}

const PREVIEW_PAYLOAD = {
  ok: true,
  errorKind: '',
  error: '',
  requestId: 'req-1',
  previewId: '估值-20261014-101010-aa11',
  projectId: '估值-20261014-101010-aa11',
  casePath: '/cases/space/估值-20261014-101010-aa11',
  inputDigest: 'sha256:feed',
  assetType: 'real-estate',
  methodRequest: 'market',
  baseDate: null,
  supplementalPrompt: '请多考虑地铁因素',
  files: [PREVIEW_FILE],
  fileCount: 1,
  overLimit: false,
  skipped: [],
  capabilityGaps: [],
  createdAt: '2026-10-14T02:03:04.000Z',
  expiresAt: '2026-10-14T03:03:04.000Z',
}

const HANDOFF_RECEIPT = {
  ok: true,
  errorKind: '',
  error: '',
  projectId: '估值-20261014-101010-aa11',
  parentSessionId: 'session-parent-1',
  dispatchAccepted: true,
  reused: false,
}

const SCAN_PAYLOAD = {
  ok: true,
  error: '',
  errorKind: '',
  fileCount: 2,
  limit: 30,
  overLimit: false,
  readableCount: 2,
  skippedCount: 0,
  items: [
    { path: '/Users/someone/资料/估值报告.pdf', name: '估值报告.pdf', kind: 'pdf', sizeBytes: 2048, status: 'scanned', reason: '', fileCount: 1 },
    { path: '/Users/someone/资料/可比案例.xlsx', name: '可比案例.xlsx', kind: 'excel', sizeBytes: 4096, status: 'scanned', reason: '', fileCount: 1 },
  ],
}

const PREFLIGHT_BLOCKED = {
  ok: true,
  error: '',
  sites: [
    { siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '未检测到登录状态' },
    { siteId: 'fang', label: '房天下', state: 'unknown', reason: '网络超时，未能确认' },
  ],
  rows: [
    { siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '未检测到登录状态', required: true, stateLabel: '未登录' },
    { siteId: 'fang', label: '房天下', state: 'unknown', reason: '网络超时，未能确认', required: false, stateLabel: '无法检查' },
  ],
  gate: {
    released: false, required: ['lianjia'], optional: ['fang'],
    reason: '链家 尚未登录：请在打开的那个浏览器窗口里完成登录', unavailable: false, checkedAt: '2026-10-15T02:00:00.000Z',
  },
  loginJobs: [],
  opened: false,
  openError: '',
}

const PREFLIGHT_RELEASED = {
  ...PREFLIGHT_BLOCKED,
  sites: [
    { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '' },
    { siteId: 'fang', label: '房天下', state: 'authenticated', reason: '' },
  ],
  rows: [
    { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '', required: true, stateLabel: '已登录' },
    { siteId: 'fang', label: '房天下', state: 'authenticated', reason: '', required: false, stateLabel: '已登录' },
  ],
  gate: { released: true, required: ['lianjia'], optional: ['fang'], reason: '', unavailable: false, checkedAt: '' },
}

const RUNNING_JOB = {
  jobId: 'login-1', siteId: 'lianjia', state: 'running', startedAt: 1, finishedAt: null,
  detail: '', sites: [], commandOk: false, recoveryAttempts: 0,
}

/** 一个可编排的端口；`status` / `result` / `openArtifact` / `cancel` 只是**呼叫记录器**。 */
function makePort(overrides = {}) {
  const calls = {
    scan: [], preflight: [], login: [], loginCancel: [], intake: [], start: [], open: [],
    // 旧运行期契约的四个操作：Task 4 之后一次都不该被调用。
    status: [], result: [], openArtifact: [], cancel: [],
  }
  const openedSessions = []
  return {
    calls,
    openedSessions,
    pickDirectory: async () => '/Users/someone/资料',
    fileInput: async () => [],
    scan: async (input) => { calls.scan.push(input); return SCAN_PAYLOAD },
    preflight: async (input) => { calls.preflight.push(input ?? {}); return PREFLIGHT_RELEASED },
    login: async (input) => { calls.login.push(input); return { ok: true, error: '', jobId: 'login-1', reused: false, job: RUNNING_JOB } },
    loginCancel: async (input) => { calls.loginCancel.push(input); return { ok: true, error: '' } },
    intake: async (input) => { calls.intake.push(input); return PREVIEW_PAYLOAD },
    start: async (input) => { calls.start.push(input); return HANDOFF_RECEIPT },
    openSession: async (sessionId) => { calls.open.push(sessionId); openedSessions.push(sessionId); return { ok: true, error: '' } },
    status: async (input) => { calls.status.push(input); return { ok: true } },
    result: async (input) => { calls.result.push(input); return { ok: true } },
    openArtifact: async (input) => { calls.openArtifact.push(input); return { ok: true } },
    cancel: async (input) => { calls.cancel.push(input); return { ok: true } },
    ...overrides,
  }
}

/** 已经通过门禁、资料扫完的草稿（大多数用例从这里开始）。 */
const DRAFT_PATCH = {
  phase: 'draft',
  // 协议 39：资产类型是通用入口的第一个选择，未选不能确认 —— 这一份草稿是"已经选好了"的状态。
  assetType: 'real-estate',
  // 本轮起**方法也没有默认值**：草稿必须显式选一项才算"可以核对"。
  // 这里选「市场法」，与 `PREVIEW_PAYLOAD.methodRequest` 一致 —— 回显与本次提交必须相同。
  method: 'market',
  selection: ['/Users/someone/资料/估值报告.pdf', '/Users/someone/资料/可比案例.xlsx'],
  files: SCAN_PAYLOAD.items.map((item) => ({
    path: item.path, name: item.name, dirHint: '', kind: item.kind,
    sizeBytes: item.sizeBytes, status: item.status, reason: item.reason, fileCount: item.fileCount,
  })),
  scanState: 'ready',
  fileCount: 2,
  readableCount: 2,
  overLimit: false,
  login: { check: 'ready', gate: PREFLIGHT_RELEASED.gate, rows: PREFLIGHT_RELEASED.rows, sites: PREFLIGHT_RELEASED.sites, loginJobs: [], error: '', job: null },
}

function draftController(port, patch = {}) {
  return createReportEvaluationController(port, { initial: { ...DRAFT_PATCH, ...patch } })
}

// ── 1. 页面身份与能力范围 ───────────────────────────────────────────────────

test('估值是一级页：没有房地产二级导航，资产类型改在页面里选', async () => {
  // 2026-10-15 口径：估值直接打开通用页面，取消房地产二级导航。
  assert.deepEqual(childNodes('valuation'), [], '「估值」下面不再挂二级目录')
  assert.equal(nodeById('valuation').page, 'valuation')
  assert.equal(nodeById('valuation.real-estate'), null, '旧的「房地产」二级目录整体删除')
  // 资产类型由页面里的下拉承载（不是导航），未选不能确认。
  const port = makePort()
  const { tree } = await mountPane(draftController(port))
  const field = find(tree, (node) => node.props?.['data-valuation-asset-type'] === 'true')
  assert.ok(field, '通用估值页必须有资产类型字段')
  const trigger = findAll(field, (node) => node.props?.role === 'combobox')[0]
  assert.equal(trigger.props['aria-expanded'], false, '初始是收起的单选下拉')
  assert.equal(textOf(field).includes(zhCN.valuationAssetTypeRealEstate), true, '这一份草稿已经选好房地产')
})

// ── 2. 登录是可选用能力，不再是门禁 ─────────────────────────────────────────

test('未登录也能填完并启动；来源状态只在能力区如实展示', async () => {
  const port = makePort({ preflight: async () => PREFLIGHT_BLOCKED })
  const controller = draftController(port)
  const { tree } = await mountPane(controller)

  // 页面留在草稿：未登录不把它挡在正文之外。
  assert.equal(controller.getState().phase, 'draft')
  assert.notEqual(find(tree, (node) => String(n1Class(node)) === 'crwu-valuation-intake'), null,
    '未登录时资料表单照常可画')
  assert.equal(textOf(tree).includes(zhCN.valuationAuthChecking), false, '没有在途检查')
  // 能力区在页面上，并如实说"未登录"。
  assert.ok(find(tree, (node) => node.props?.['data-valuation-site'] === 'lianjia'), '能力区要列出链家')

  // 目录与能力是两件事：切换模块照常。
  const modules = createModuleStore()
  const env = { state: { status: 'ready', blocked: [], issues: [], capabilities: {} } }
  assert.equal(modules.navigate('eval', env).blocked, false, '报告评估模块本身照常可进')
  assert.equal(modules.get().node, 'valuation')
  assert.equal(modules.navigate('audit', env).blocked, false, '报告审核照常可进')
  assert.equal(modules.get().node, 'audit.report')
  assert.equal(modules.navigate('env', env).blocked, false, '环境信息照常可进')
  // 能力判定不在导航层：它不该认识登录 / 预检这些词。
  for (const file of ['src/client/shell/module-store.ts', 'src/client/shell/navigation.ts']) {
    const code = readFileSync(new URL(file, ROOT), 'utf8')
    assert.equal(/valuation-browser-preflight|valuation-browser-login/.test(code), false,
      `${file} 不该出现估值来源能力操作`)
  }
})

function n1Class(node) { return String(node.props?.className ?? '') }

test('进页面不做任何来源探测；打开确认抽屉时才独立查一次', async () => {
  const port = makePort()
  const controller = draftController(port)
  // 挂载并跑完首帧 effect。
  const rendered = renderToTree(ReportEvaluationPane, { controller })
  const first = rendered.instance.effects
  rendered.instance.effects = []
  for (const effect of first) await effect.callback()
  await tick()
  assert.equal(port.calls.preflight.length, 0, '进页面不自动探测案例来源')

  // 打开确认抽屉（准备确认 → 确认）时才查一次。
  controller.preparePreview()
  await tick()
  rerender(ReportEvaluationPane, { controller })
  const rest = rendered.instance.effects
  rendered.instance.effects = []
  for (const effect of rest) await effect.callback()
  await tick()
  assert.equal(port.calls.preflight.length, 1, '抽屉打开时查一次来源状态')
  assert.equal(controller.getState().phase, 'confirmation')
})

test('能力区的三种状态各有各的话：未登录给登录入口、unknown 只给重新检查', async () => {
  const blockedPort = makePort({ preflight: async () => PREFLIGHT_BLOCKED })
  const blockedController = draftController(blockedPort)
  // 显式触发一次检查（进页面不自动查 —— 这正是上一条用例钉住的）。
  blockedController.recheckAuth()
  await tick()
  const blockedTree = (await mountPane(blockedController)).tree
  assert.equal(textOf(blockedTree).includes(zhCN.valuationAuthLogin.replace('{label}', '链家')), true,
    '未登录的站点要给登录入口')

  const unknownPort = makePort({
    preflight: async () => ({
      ok: true, error: '',
      sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '网络不可达',
        verdict: '', protectedUrl: '', expiresAt: '', sessionCookie: false }],
      rows: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '网络不可达',
        verdict: '', protectedUrl: '', expiresAt: '', sessionCookie: false, required: false, stateLabel: '无法检查' }],
      gate: { released: false, required: [], optional: ['lianjia'], reason: '链家 的登录状态查不出来', unavailable: false, checkedAt: '2026-10-15T02:00:00.000Z' },
      loginJobs: [], opened: false, openError: '',
    }),
  })
  const unknownController = draftController(unknownPort)
  unknownController.recheckAuth()
  await tick()
  const unknownTree = (await mountPane(unknownController)).tree
  const unknownText = textOf(unknownTree)
  assert.equal(unknownText.includes(zhCN.valuationAuthLogin.replace('{label}', '链家')), false,
    'unknown **不给**登录入口（查不出来不是没登录）')
  assert.equal(unknownText.includes(zhCN.valuationAuthRecheck), true, 'unknown 的处置是重新检查')
  assert.equal(unknownText.includes('2026-10-15'), true, '检查时刻要显示出来')
})

test('主页面唯一 primary 是核对资料；抽屉主操作是开始估值、次操作是返回修改', async () => {
  const port = makePort()
  const controller = draftController(port)
  const draftTree = (await mountPane(controller)).tree
  const primaries = findAll(draftTree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))
  assert.equal(primaries.length, 1, '一屏一个 primary')
  assert.equal(textOf(primaries[0]), zhCN.valuationConfirm, '主操作文案逐字是「核对资料」')
  assert.equal(textOf(primaries[0]).includes('检查并确认'), false, '旧的「检查并确认」不许回来')

  const { tree } = await confirmationTree(makePort())
  const drawer = findAll(tree, (n) => n.props?.['data-valuation-confirmation-drawer'] !== undefined)
  assert.equal(drawer.length, 1, '确认抽屉恰好一个')
  const drawerPrimaries = findAll(drawer[0], (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))
  assert.equal(drawerPrimaries.length, 1, '抽屉里也只允许一个 primary')
  assert.equal(textOf(drawerPrimaries[0]), '开始估值', '抽屉主操作逐字是「开始估值」')
  assert.equal(
    findAll(drawer[0], (n) => n.type === 'button' && textOf(n) === '返回修改').length, 1,
    '中性次操作逐字是「返回修改」')
})

test('确认抽屉只展示文件元信息与三个用户输入：没有知识库状态 / 字段 / 冲突 / 完整提示词 / 取证 / digest', async () => {
  const port = makePort()
  const { tree } = await confirmationTree(port)
  const drawer = findAll(tree, (n) => n.props?.['data-valuation-confirmation-drawer'] !== undefined)[0]
  const text = textOf(drawer)

  assert.equal(text.includes('知识库状态'), false, '抽屉里不许出现知识库状态')
  assert.equal(text.includes('资料中读到的信息'), false, '抽屉里不许出现"已知字段"')
  assert.equal(text.includes('缺失信息'), false, '抽屉里不许出现"缺失字段"')
  assert.equal(text.includes('资料冲突'), false, '抽屉里不许出现冲突表')
  assert.equal(text.includes('将提交给 Agent'), false, '抽屉里不许出现完整 Prompt')
  assert.equal(text.includes('取证能力'), false, '抽屉里不许出现取证能力')
  assert.equal(text.includes('运行看板'), false)
  // 辅助能力**是允许的环境操作**：抽屉里明确给出链家状态与「重新检查」
  //（旧约束"抽屉里一个能力都不许出现"已作废）；但它仍然不是启动门禁。
  assert.equal(text.includes(zhCN.valuationCapabilityTitle), true, '抽屉里要有信息获取辅助')
  assert.equal(text.includes(zhCN.valuationCapabilityOptional), true)
  assert.equal(text.includes('知识库'), false)
  assert.equal(text.includes('digest'), false)
  assert.equal(text.includes(PREVIEW_PAYLOAD.inputDigest), false, '指纹不许出现在抽屉里')
  assert.equal(findAll(drawer, (n) => n.props?.['data-valuation-prompt-full'] !== undefined).length, 0)

  // 该有的：文件名 / 类型 / 大小 / 创建日期 / 原始绝对路径 / 方法 / 基准日 / 补充要求。
  assert.equal(text.includes('估值报告.pdf'), true)
  assert.equal(text.includes('pdf'), true)
  assert.equal(text.includes('2.0 KB'), true)
  assert.equal(text.includes('2026-02-01'), true)
  assert.equal(text.includes('/Users/someone/资料/估值报告.pdf'), true, '要回显原始绝对路径')
  assert.equal(findAll(drawer, (n) => n.props?.['data-valuation-drawer-path'] !== undefined).length, 1)
  assert.equal(text.includes(zhCN.valuationDrawerConfirm), true)
  assert.equal(text.includes('请多考虑地铁因素'), true)
})

test('创建时间为 null 时显示「创建时间未知」，绝不拿 mtime 冒充', async () => {
  const port = makePort({
    intake: async (input) => {
      port.calls.intake.push(input)
      return {
        ...PREVIEW_PAYLOAD,
        files: [{ ...PREVIEW_FILE, createdAt: null, modifiedAt: '2026-03-01T02:03:04.000Z' }],
      }
    },
  })
  const { tree } = await confirmationTree(port)
  const drawer = findAll(tree, (n) => n.props?.['data-valuation-confirmation-drawer'] !== undefined)[0]
  const text = textOf(drawer)
  assert.equal(text.includes(zhCN.valuationDrawerCreatedAtUnknown), true)
  assert.equal(text.includes('2026-03-01'), false, '不许把 mtime 当创建时间显示')
})

test('重名与重复内容都能分辨：同名附 fileId + 目录，重复内容指出来源', async () => {
  const second = {
    ...PREVIEW_FILE,
    fileId: 'material-002',
    absolutePath: '/Users/someone/另一批/估值报告.pdf',
    archiveRelativePath: '材料-源/估值报告-2.pdf',
    sha256: 'b'.repeat(64),
  }
  const duplicate = {
    ...PREVIEW_FILE,
    fileId: 'material-003',
    fileName: '估值报告副本.pdf',
    absolutePath: '/Users/someone/资料/估值报告副本.pdf',
    duplicateOf: 'material-001',
  }
  const port = makePort({
    intake: async (input) => {
      port.calls.intake.push(input)
      return { ...PREVIEW_PAYLOAD, files: [PREVIEW_FILE, second, duplicate], fileCount: 3 }
    },
  })
  const { tree } = await confirmationTree(port)
  const drawer = findAll(tree, (n) => n.props?.['data-valuation-confirmation-drawer'] !== undefined)[0]
  const text = textOf(drawer)
  assert.equal(text.includes('material-001'), true, '重名要用短 fileId 区分')
  assert.equal(text.includes('另一批'), true, '重名要能看到所在目录')
  // 重复内容优先给出**可识别的文件名**（fileId 只作辅助）—— 比"与 material-001 重复"更容易核对。
  assert.equal(
    text.includes(zhCN.valuationDrawerDuplicateContentNamed
      .replace('{name}', '估值报告.pdf').replace('{fileId}', 'material-001')),
    true,
    '内容重复要指出与谁重复（用可识别的文件名）')
})

test('抽屉里的方法改成只读键值摘要（UX-15）：范围说明仍在、基准日未指定要写明、补充要求 4000 上限', async () => {
  const port = makePort()
  const { tree } = await confirmationTree(port)
  const drawer = findAll(tree, (n) => n.props?.['data-valuation-confirmation-drawer'] !== undefined)[0]
  const text = textOf(drawer)
  // 一排 disabled radio 看起来像一个"不能用的表单"；现在方法只是**读数**。
  assert.equal(findAll(drawer, (n) => n.type === 'input' && n.props?.type === 'radio').length, 0,
    '抽屉里不再有 disabled radio')
  const method = find(drawer, (n) => n.props?.['data-valuation-readonly'] === 'method')
  assert.ok(method, '方法要用只读摘要')
  // 方法说明**与本次选择相符**（旧文案「收益法、成本法尚未提供完整知识与模板」已删除）。
  assert.equal(text.includes(zhCN.valuationMethodHintOnce
    .replace('{label}', zhCN.valuationMethodMarket).replace('{hint}', zhCN.valuationMethodMarketHint)), true,
  '方法说明要写在明处，且与本次选择相符')
  assert.equal(/尚未提供|当前支持住宅市场法/.test(text), false, '旧的能力限制文案不许回来')
  assert.equal(text.includes(zhCN.valuationDrawerNoBaseDate), true, '未指定基准日要明确写出来')
  assert.equal(VALUATION_PROMPT_MAX_LENGTH, 4000, '补充要求上限与 Host 同步（4000）')

  // 输入页：超过上限时按钮禁用并说明原因。
  const over = draftController(makePort(), { supplementalPrompt: 'x'.repeat(VALUATION_PROMPT_MAX_LENGTH + 1) })
  const overTree = (await mountPane(over)).tree
  const primary = findAll(overTree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.equal(primary.props.disabled, true, '超长补充要求不能启动')
  assert.equal(String(primary.props['aria-describedby']).includes('crwu-valuation-action-reason'), true)
  assert.ok(find(overTree, (n) => n.props?.id === 'crwu-valuation-action-reason'))
})

// ── 4. 资料数量：1–30、整数批阻止、重叠不重复计数 ────────────────────────────

test('递归整理后的文件数才是依据（不是选中的目录数）；>30 整批阻止；未选资料可启动', async () => {
  const port = makePort()
  const controller = draftController(port, {
    // 用户选了两个目录：里面一共 2 份文件（目录数不作数）。
    selection: ['/Users/someone/资料', '/Users/someone/资料/子目录'],
    files: [
      { path: '/Users/someone/资料', name: '资料', dirHint: '', kind: '', sizeBytes: 0, status: 'scanned', reason: '', fileCount: 2 },
    ],
    fileCount: 2,
  })
  const tree = (await mountPane(controller)).tree
  // 底栏只放**当前可行动摘要**；数量明细留在资料区（设计稿 §9.1）。
  assert.equal(textOf(tree).includes(zhCN.valuationActionSummaryReady.replace('{count}', '2')), true,
    '数量用递归去重后的文件数')
  const primary = findAll(tree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.notEqual(primary.props.disabled, true)

  const over = draftController(makePort(), { overLimit: true, fileCount: 31 })
  const overTree = (await mountPane(over)).tree
  const overPrimary = findAll(overTree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.equal(overPrimary.props.disabled, true, '超过 30 整批阻止（不悄悄截取）')
  assert.equal(textOf(overTree).includes('31'), true)
  assert.equal(textOf(overTree).includes('不会悄悄只取前'), true)

  const empty = draftController(makePort(), { selection: [], files: [], fileCount: 0, scanState: 'idle' })
  const emptyTree = (await mountPane(empty)).tree
  const emptyPrimary = findAll(emptyTree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.notEqual(emptyPrimary.props.disabled, true, '材料选填，两项必选完成即可启动')
  assert.equal(textOf(emptyTree).includes(zhCN.valuationActionSummaryOptional), true)

  const unreadable = draftController(makePort(), { fileCount: 2, readableCount: 0 })
  const unreadableTree = (await mountPane(unreadable)).tree
  const unreadablePrimary = findAll(unreadableTree, (n) => n.type === 'button'
    && String(n.props?.className ?? '').includes('crwu-valuation-btn-primary'))[0]
  assert.equal(unreadablePrimary.props.disabled, true, '全部不可读不能启动')
})

test('Host 拒绝全部空文件 / 超限时，页面回到可编辑草稿并显示原因', async () => {
  const port = makePort({
    intake: async (input) => {
      port.calls.intake.push(input)
      return {
        ok: false, errorKind: 'input-invalid',
        error: '选中的资料全是空文件（0 字节）：没有可估值的内容，本轮不能启动。',
        requestId: input.requestId,
      }
    },
  })
  const controller = draftController(port)
  controller.preparePreview()
  await tick()
  assert.equal(controller.getState().phase, 'draft', '准备失败要回到草稿，不能留在 pending')
  assert.match(controller.getState().error, /空文件/)
  const tree = (await mountPane(controller)).tree
  assert.equal(textOf(tree).includes('空文件'), true)
})

// ── 5. 一次只建一个父会话 + 立即跳转 ────────────────────────────────────────

test('交接成功：提示后立即打开父会话（顶层 openSession，不是 openSubagent），且不再有 status/result 请求', async () => {
  const port = makePort()
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  const state = controller.getState()
  // 跳转已经发生（面板切到会话）：这一页**不留成功页**，直接回到新草稿。
  assert.equal(state.phase, 'draft', '交接成功之后不许停在"已创建/正在打开"那一页')
  assert.equal(state.notice, '', '不再挂"正在打开…"的整页提示')
  assert.equal(port.openedSessions[0], HANDOFF_RECEIPT.parentSessionId, '打开的是父会话 id')
  assert.equal(port.calls.status.length, 0, '交接成功后不许再轮询 valuation-status')
  assert.equal(port.calls.result.length, 0)
  assert.equal(port.calls.openArtifact.length, 0)
  assert.equal(port.calls.cancel.length, 0)
})

test('交接成功后这一页是新草稿：成功页被删掉，只剩一条最近会话入口（入口用 recentSessionId）', async () => {
  const port = makePort()
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  const state = controller.getState()
  assert.equal(state.recentSessionId, HANDOFF_RECEIPT.parentSessionId, '最近会话入口要留着')
  assert.equal(state.parentSessionId, '', '新一轮草稿不再持有上一轮的会话身份')

  const tree = (await mountPane(controller)).tree
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.valuationSessionCreated), false, '「估值会话已创建，正在打开…」这一页必须消失')
  assert.ok(find(tree, (node) => String(node.props?.className ?? '') === 'crwu-valuation-intake'),
    '回到的是可用的输入工作面，不是一张死页')
  assert.equal(text.includes(zhCN.valuationRecentSession), true, '保留中性的最近会话入口')

  // 入口只能用 `recentSessionId`（`parentSessionId` 已经清掉），否则点了只会报"没有子会话 id"。
  const open = findAll(tree, (n) => n.type === 'button' && textOf(n) === zhCN.valuationSessionOpenRetry)[0]
  assert.ok(open, '最近会话入口要能点')
  open.props.onClick()
  await tick()
  assert.equal(controller.getState().error, '', '最近会话入口不许报错')
  assert.deepEqual(port.openedSessions, [HANDOFF_RECEIPT.parentSessionId, HANDOFF_RECEIPT.parentSessionId])
})

test('双击「开始估值」只建一个父会话', async () => {
  const port = makePort()
  const { controller } = await confirmationTree(port)
  controller.confirm()
  controller.confirm()
  controller.confirm()
  await tick()
  assert.equal(port.calls.start.length, 1, '重复点击不许建第二个父会话')
  assert.equal(port.openedSessions.length, 1)
})

test('请求超时后重试：复用同一个 requestId / previewId，不新建父会话', async () => {
  let failFirst = true
  const port = makePort({
    start: async (input) => {
      port.calls.start.push(input)
      if (failFirst) {
        failFirst = false
        return { ok: false, errorKind: 'infrastructure', error: '交接超时', projectId: input.previewId, parentSessionId: '', dispatchAccepted: false, reused: false }
      }
      return { ...HANDOFF_RECEIPT, reused: true }
    },
  })
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  assert.equal(controller.getState().phase, 'handoff-failed')
  assert.match(controller.getState().error, /超时/)

  controller.confirm()
  await tick()
  assert.equal(port.calls.start.length, 2)
  assert.equal(port.calls.start[0].requestId, port.calls.start[1].requestId, '重试必须复用同一个 requestId')
  assert.equal(port.calls.start[0].previewId, port.calls.start[1].previewId)
  assert.equal(controller.getState().phase, 'draft', '恢复成功并跳转之后同样不留成功页')
})

test('指令发送失败：保留已创建的 sessionId，重试发到同一个会话', async () => {
  let first = true
  const port = makePort({
    start: async (input) => {
      port.calls.start.push(input)
      if (first) {
        first = false
        return {
          ok: true, errorKind: '', error: '', projectId: input.previewId,
          parentSessionId: 'session-parent-1', dispatchAccepted: false, reused: false,
        }
      }
      return { ...HANDOFF_RECEIPT, reused: true }
    },
  })
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  const failed = controller.getState()
  assert.equal(failed.phase, 'handoff-failed')
  assert.equal(failed.parentSessionId, 'session-parent-1', '会话已经建出来了，id 必须留着')
  assert.equal(failed.retrySameSession, true)
  // 标题与解释来自 Host 的权威创建判据（会话已建 → "交接尚未完成"），
  // 不再是那句与事实矛盾的"会话还没有创建成功"（UX-17）。
  assert.equal(failed.creationDisposition, 'created')
  const tree = (await mountPane(controller)).tree
  assert.equal(textOf(tree).includes(zhCN.valuationHandoffCreatedTitle), true)
  assert.equal(textOf(tree).includes(zhCN.valuationHandoffCreatedNote), true)

  controller.confirm()
  await tick()
  assert.equal(port.calls.start.length, 2)
  assert.equal(port.calls.start[0].requestId, port.calls.start[1].requestId)
  assert.equal(controller.getState().phase, 'draft', '续发成功并跳转之后同样不留成功页')
})

test('an expired preview offers fresh confirmation and never resubmits the expired handoff', async () => {
  const port = makePort({
    intake: async (input) => { port.calls.intake.push(input); return { ...PREVIEW_PAYLOAD,
      previewId: `fresh-preview-${port.calls.intake.length}`, projectId: `fresh-preview-${port.calls.intake.length}` } },
    start: async (input) => { port.calls.start.push(input); return { ok: false, errorKind: 'not-found',
      error: '这次预览已经过期', projectId: input.previewId, parentSessionId: '', dispatchAccepted: false,
      creationDisposition: 'not-created', recoveryAction: 'refresh-preview' } },
  })
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  const tree = (await mountPane(controller)).tree
  assert.doesNotMatch(textOf(tree), /可以直接重试创建|重试创建/)
  assert.match(textOf(tree), /重新准备确认/)
  controller.confirm()
  await tick()
  assert.equal(port.calls.start.length, 1)
  assert.equal(port.calls.intake.length, 2)
  assert.equal(controller.getState().phase, 'confirmation')
  assert.equal(controller.getState().preview.previewId, 'fresh-preview-2')
  assert.deepEqual(port.calls.intake[1].paths, DRAFT_PATCH.selection)
  assert.equal(port.calls.open.length, 0)
})

test('the workflow handoff callback stays on the graph page and retains the actual parent identity', async () => {
  const port = makePort()
  const receipts = []
  const controller = createReportEvaluationController(port, { initial: DRAFT_PATCH,
    onHandoff: async (receipt) => { receipts.push(receipt) } })
  controller.preparePreview()
  await tick()
  controller.confirm()
  await tick()
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].parentSessionId, HANDOFF_RECEIPT.parentSessionId)
  assert.equal(port.calls.open.length, 0, 'native sessions are available by explicit action, without leaving the workflow')
  assert.equal(controller.getState().parentSessionId, HANDOFF_RECEIPT.parentSessionId)
  assert.notEqual(controller.getState().phase, 'draft')
})

test('导航失败：显示「会话已创建，自动打开失败」+「打开估值会话」；重试只重新导航', async () => {
  let openAttempts = 0
  const port = makePort({
    openSession: async (sessionId) => {
      port.calls.open.push(sessionId)
      openAttempts += 1
      if (openAttempts === 1) return { ok: false, error: 'layout 服务不可用' }
      port.openedSessions.push(sessionId)
      return { ok: true, error: '' }
    },
  })
  const { controller } = await confirmationTree(port)
  controller.confirm()
  await tick()
  assert.equal(controller.getState().openFailed, true)
  const tree = (await mountPane(controller)).tree
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.valuationSessionOpenFailed), true)
  assert.equal(text.includes(zhCN.valuationSessionOpenRetry), true)

  const retry = findAll(tree, (n) => n.type === 'button' && textOf(n) === zhCN.valuationSessionOpenRetry)[0]
  retry.props.onClick()
  await tick()
  assert.equal(port.calls.start.length, 1, '重试只重新导航，不再创建')
  assert.equal(port.openedSessions[0], HANDOFF_RECEIPT.parentSessionId)
  assert.equal(controller.getState().openFailed, false)
})

test('openValuationSession：优先 uiWorkspace.openSession + 切到会话面板，绝不调用 openSubagent', async () => {
  const { openValuationSession } = await import(
    new URL('src/client/modules/report-evaluation/session/open-session.ts', ROOT).href)
  const opened = []
  const panels = []
  let subagentCalls = 0
  const result = await openValuationSession({
    uiWorkspace: { openSession: (id) => { opened.push(id) } },
    layout: { selectPanel: (panel) => { panels.push(panel) } },
    sessions: { openSubagent: () => { subagentCalls += 1 } },
  }, 'session-parent-1')
  assert.deepEqual(result, { ok: true, error: '' })
  assert.deepEqual(opened, ['session-parent-1'])
  assert.deepEqual(panels, ['conversation'])
  assert.equal(subagentCalls, 0, '顶层父会话不许走 openSubagent')

  const missing = await openValuationSession({}, 'session-parent-1')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.includes('不可用'), true)

  const empty = await openValuationSession({ uiWorkspace: { openSession: () => {} } }, '')
  assert.equal(empty.ok, false)
})

// ── 6. 迟到的响应不许覆盖新页面 ─────────────────────────────────────────────

test('迟到的准备预览响应不许把页面推进到确认（generation + AbortSignal）', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let seenSignal
  const port = makePort({
    intake: async (input, options) => {
      port.calls.intake.push(input)
      seenSignal = options?.signal
      return await pending
    },
  })
  const controller = draftController(port)
  controller.preparePreview()
  await tick()
  assert.equal(controller.getState().phase, 'preparing-confirmation')
  assert.ok(seenSignal, '在途请求要带 AbortSignal')

  // 用户离开这一页 / 换了输入：在途请求作废，**并且**清理这一次页面请求的瞬时状态。
  // 旧行为只中止请求、把 phase 留在 `preparing-confirmation`，于是切回来是一个永远
  // pending 的按钮（UX-05）。现在回到可编辑草稿：输入仍在、下次「确认」是全新一轮。
  controller.invalidate()
  assert.equal(seenSignal.aborted, true, 'invalidate 要真的中止在途请求')
  assert.equal(controller.getState().phase, 'draft', '在途准备作废后回到可编辑草稿')
  assert.deepEqual(controller.getState().selection, DRAFT_PATCH.selection, '输入必须保留')
  release(PREVIEW_PAYLOAD)
  await tick()
  assert.equal(controller.getState().phase, 'draft', '迟到的响应不许改状态')
  assert.equal(controller.getState().preview, null)
})

test('「返回修改」之后迟到的预览响应被丢掉', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const port = makePort({ intake: async () => await pending })
  const controller = draftController(port)
  controller.preparePreview()
  await tick()
  controller.backToEdit()
  assert.equal(controller.getState().phase, 'draft')
  release(PREVIEW_PAYLOAD)
  await tick()
  assert.equal(controller.getState().phase, 'draft')
  assert.equal(controller.getState().preview, null)
  assert.equal(controller.getState().error, '')
})

// ── 7. 旧页与旧运行期契约必须整组消失 ──────────────────────────────────────

test('进度页 / 结果页文件不再存在', async () => {
  for (const file of ['ValuationProgressPane.tsx', 'ValuationResultPane.tsx']) {
    await assert.rejects(
      import(new URL(`src/client/modules/report-evaluation/ui/${file}`, ROOT).href),
      (error) => /Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(error)),
      `${file} 应当已经删除`)
  }
})

test('Client 侧不再引用运行期 status / result / open-artifact / 运行期 cancel', () => {
  const files = [
    'src/client/modules/report-evaluation/api.ts',
    'src/client/modules/report-evaluation/index.ts',
    'src/client/modules/report-evaluation/controller.ts',
    'src/client/modules/report-evaluation/model/valuation-state.ts',
    'src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx',
    'src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx',
    'src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx',
    'src/client/shell/WorkbenchPanel.tsx',
  ]
  for (const file of files) {
    const code = readFileSync(new URL(file, ROOT), 'utf8')
    for (const banned of ["'valuation-status'", "'valuation-result'", "'valuation-open-artifact'", "'valuation-cancel'"]) {
      assert.equal(code.includes(banned), false, `${file} 还在引用 ${banned}`)
    }
  }
})

test('冻结清单与门面同步：删掉 4 条运行期操作，加入门禁 login / login-cancel', () => {
  for (const gone of ['valuation-status', 'valuation-result', 'valuation-open-artifact', 'valuation-cancel']) {
    assert.equal(FROZEN_OPERATIONS.includes(gone), false, `${gone} 应当已经从操作清单里删除`)
  }
  assert.equal(FROZEN_OPERATIONS.includes('valuation-browser-login'), true)
  assert.equal(FROZEN_OPERATIONS.includes('valuation-browser-login-cancel'), true)
  // 输入取消**不**沿用运行期名字：这一代没有需要 Host 取消的运行期轮次。
  assert.equal(FROZEN_OPERATIONS.includes('intake-cancel'), false)
})

test('WorkbenchPanel 不再持有估值轮询；报告审核的轮询不动', () => {
  const code = readFileSync(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT), 'utf8')
  assert.equal(code.includes('VALUATION_POLL_INTERVAL_MS'), false, '估值专用轮询间隔必须删除')
  assert.equal(/evaluationController\.poll\(/.test(code), false, '面板不许再调估值 poll')
  assert.equal(code.includes('useValuationPhase'), false, '估值 phase 订阅必须删除')
  assert.match(code, /POLL_INTERVAL_MS = 10_000/, '报告审核的 10 秒轮询不许动')
})

test('协议号升到 49，且只在 shared/consts.ts 一处声明', () => {
  assert.equal(WORKBENCH_PROTOCOL, 49)
  const source = readFileSync(new URL('src/shared/consts.ts', ROOT), 'utf8')
  assert.equal((source.match(/WORKBENCH_PROTOCOL =/g) ?? []).length, 1)
})

// ── 8. 共享抽屉：footer 可选，报告审核那张不受影响 ──────────────────────────

test('SideDrawer：footer 是可选的（审核抽屉渲染结果不变）；Esc 仍关闭；关闭后焦点回到指定元素', async () => {
  const { SideDrawer } = await import(new URL('src/client/ui/SideDrawer.tsx', ROOT).href)
  const { WORKBENCH_CLASSES } = await import(new URL('src/client/shell/consts.ts', ROOT).href)
  const { React } = await import(new URL('tests/helpers/render.mjs', ROOT).href)

  // 没有 footer：与协议 35 之前逐字相同（报告审核那张抽屉就是这么用的）。
  const plain = renderToTree(SideDrawer, { title: '审核信息', onClose: () => {} }).tree
  assert.equal(findAll(plain, (n) => String(n.props?.className ?? '') === WORKBENCH_CLASSES.sideDrawer).length, 1)
  assert.equal(findAll(plain, (n) => String(n.props?.className ?? '') === WORKBENCH_CLASSES.sideDrawerFoot).length, 0,
    '没有 footer 时不许凭空多一个 footer 元素')

  // 有 footer：固定 footer 与 Esc / 焦点回收都在。
  let closed = 0
  const listeners = {}
  const previous = globalThis.document
  globalThis.document = {
    activeElement: null,
    addEventListener: (type, listener) => { listeners[type] = listener },
    removeEventListener: () => {},
  }
  try {
    const rendered = renderToTree(SideDrawer, {
      title: '确认本轮估值输入',
      footer: React.createElement('span', null, 'footer 内容'),
      returnFocusTo: { current: { focus: () => {} } },
      onClose: () => { closed += 1 },
    })
    const tree = rendered.tree
    assert.equal(findAll(tree, (n) => String(n.props?.className ?? '') === WORKBENCH_CLASSES.sideDrawerFoot).length, 1)
    assert.equal(textOf(tree).includes('footer 内容'), true)
    // 替身不会自动跑 effect：显式跑一次，Esc / 焦点回收才装上（真实 React 里自动跑）。
    for (const effect of rendered.instance.effects) effect.callback()
    // Esc 仍然关闭（键盘用户不该只能去点 ×）。
    assert.equal(typeof listeners.keydown, 'function', 'Esc 监听要装上')
    listeners.keydown({ key: 'Escape' })
    assert.equal(closed, 1)
    // Tab 在"没有真实 DOM / 没有可聚焦元素"时静默跳过，不抛错。
    listeners.keydown({ key: 'Tab' })
    // 卸载清理（真实 React 在自己跑；这里调一次确认它不抛错）。
    for (const effect of rendered.instance.effects) {
      const cleanup = effect.callback()
      if (typeof cleanup === 'function') cleanup()
    }
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('只有估值确认抽屉用 footer：报告审核那张抽屉的渲染路径没被改', () => {
  // 报告审核的抽屉外壳由 WorkbenchPanel 渲染（内容体是 AuditInfoDrawer）：
  // 它没有底部主操作，所以**不该**被顺手加上 footer —— 那会让它多一条横线与一片空白。
  const panel = readFileSync(new URL('src/client/shell/WorkbenchPanel.tsx', ROOT), 'utf8')
  const drawer = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT), 'utf8')
  assert.match(panel, /<SideDrawer/, '报告审核的抽屉仍在 WorkbenchPanel 里')
  assert.equal(/footer=/.test(panel), false, '报告审核抽屉不许突然带 footer')
  assert.match(drawer, /footer=\{/, '估值确认抽屉要用 footer 放主操作')
})

test('抽屉关闭后焦点回到「确认」：表单不卸载，抽屉把焦点还给同一个元素（UX-16）', () => {
  // 新版接线：确认期间输入工作面**隐藏但保留在 DOM 里**，所以「确认」那颗按钮还是
  // 同一个元素；外层把它的 ref 交给抽屉，抽屉在退出动画结束后 focus() 回去。
  // 焦点本身只能由真机验（注入式替身没有 DOM），这里钉住接线与两条关键属性。
  const pane = readFileSync(new URL('src/client/modules/report-evaluation/ui/ReportEvaluationPane.tsx', ROOT), 'utf8')
  const intake = readFileSync(new URL('src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx', ROOT), 'utf8')
  const drawer = readFileSync(
    new URL('src/client/modules/report-evaluation/ui/ValuationConfirmationDrawer.tsx', ROOT), 'utf8')
  assert.match(pane, /confirmButtonRef/, '外层要持有「确认」的 ref')
  assert.match(pane, /primaryRef=\{confirmButtonRef\}/, 'ref 要交给输入页的主操作')
  assert.match(pane, /returnFocusTo=\{confirmButtonRef\}/, '抽屉关闭后要把焦点还给它')
  assert.match(pane, /data-valuation-intake-host/, '输入工作面在抽屉打开期间仍然挂载')
  assert.match(pane, /hidden=\{!showsIntakeForm\(state\.phase\)\}/, '确认阶段它是隐藏的')
  assert.match(intake, /props\.primaryRef/, '输入页要用外层给的 ref')
  // 创建期间抽屉不许关闭（X / Esc / 遮罩 / 返回修改四条路一起失效）。
  assert.match(drawer, /closeDisabled=\{props\.creating\}/)
})

// ── 协议 36：门禁的挑战处置 ────────────────────────────────────────────────
//
// 2026-10-14 现场：员工已登录，但受保护页要人机验证，而门禁只说了一句"无法检查"。
// 现在逐站结论带着 `challenge`：界面必须说清"不是未登录、去那个窗口完成验证"，
// 并且**不给**登录入口（引导登录是错的处置）。

const PREFLIGHT_CHALLENGED = {
  ok: true,
  error: '',
  sites: [{
    siteId: 'lianjia', label: '链家', state: 'unknown',
    reason: 'lianjia 的受保护页面要求**人机验证**（不是未登录）',
    verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
  }],
  rows: [{
    siteId: 'lianjia', label: '链家', state: 'unknown',
    reason: 'lianjia 的受保护页面要求**人机验证**（不是未登录）',
    verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
    required: true, stateLabel: '无法检查',
    challenge: {
      detected: true, attempted: true, state: 'waiting-user',
      reasonCode: 'challenge-visible', verifyUrl: 'https://bj.lianjia.com/ershoufang/',
    },
  }],
  gate: {
    released: false, required: ['lianjia'], optional: [],
    reason: '还有必需来源没有通过登录检查', unavailable: false, checkedAt: '2026-10-15T02:00:00.000Z',
  },
  loginJobs: [],
  opened: false,
  openError: '',
}

test('能力区：被人机验证挡住时给"完成验证"的处置，且不给登录入口', async () => {
  const port = makePort({ preflight: async () => PREFLIGHT_CHALLENGED })
  const controller = createReportEvaluationController(port)
  controller.recheckAuth()
  await tick()
  const { tree } = await mountPane(controller)

  // 协议 39：被挑战**不改阶段**（它不是"没登录"，也不该造成整页拦截）。
  assert.equal(controller.getState().phase, 'draft')
  const text = textOf(tree)
  assert.match(text, /人机验证（不是未登录）/, '要说清是验证而不是没登录')
  assert.match(text, /完成验证/, '要给出员工该做的动作')
  assert.match(text, /重新检查/, '唯一主动作仍是重新检查')
  assert.equal(text.includes(zhCN.valuationAuthLogin.replace('{label}', '链家')), false,
    '被人机验证挡住时不许给登录入口')
  // 门禁的挑战处置必须落在 DOM 上（数据属性），供真机验收脚本核对。
  const row = find(tree, (n) => n.props?.['data-valuation-site'] === 'lianjia')
  assert.equal(row?.props?.['data-valuation-site-challenge'], 'waiting-user')
})

test('门禁：某个来源自动恢复成功、另一个还没好 → 门禁仍在，并说明恢复发生了什么', async () => {
  // 恢复成功但门禁**没释放**（房天下还没通过）：这时门禁还在页面上，员工看得到"自动恢复已通过"，
  // 也看得到剩下该做什么。恢复成功后门禁整个消失的情况由下一条用例钉住。
  const partial = {
    ...PREFLIGHT_CHALLENGED,
    sites: [
      { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '',
        verdict: 'ok', protectedUrl: 'https://bj.lianjia.com/ershoufang/' },
      { siteId: 'fang', label: '房天下', state: 'unauthenticated', reason: '没有登录凭据：请先登录该来源',
        verdict: '', protectedUrl: 'https://search.fang.com/house/' },
    ],
    rows: [
      { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '',
        verdict: 'ok', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
        required: true, stateLabel: '已登录',
        challenge: { detected: true, attempted: true, state: 'recovered',
          reasonCode: 'page-ok', verifyUrl: 'https://bj.lianjia.com/ershoufang/' } },
      { siteId: 'fang', label: '房天下', state: 'unauthenticated', reason: '没有登录凭据：请先登录该来源',
        verdict: '', protectedUrl: 'https://search.fang.com/house/',
        required: true, stateLabel: '未登录' },
    ],
    gate: {
      released: false, required: ['lianjia', 'fang'], optional: [],
      reason: '还有必需来源没有通过登录检查', unavailable: false, checkedAt: '2026-10-15T02:00:00.000Z',
    },
  }
  const port = makePort({ preflight: async () => partial })
  const controller = createReportEvaluationController(port)
  controller.recheckAuth()
  await tick()
  const { tree } = await mountPane(controller)

  const text = textOf(tree)
  assert.match(text, /自动恢复已通过/, '恢复成功后要说明发生了什么')
  assert.match(text, /已登录/)
  // 另一个来源确实是"没登录"，所以那里**要**给登录入口 —— 两种处置不能混成一句。
  assert.equal(text.includes(zhCN.valuationAuthLogin.replace('{label}', '房天下')), true)
})

test('门禁：必需来源全部通过后门禁整个消失（正文可用，不再显示恢复说明）', async () => {
  const released = {
    ...PREFLIGHT_CHALLENGED,
    sites: [{ siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '', verdict: 'ok',
      protectedUrl: 'https://bj.lianjia.com/ershoufang/' }],
    rows: [{ siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '', verdict: 'ok',
      protectedUrl: 'https://bj.lianjia.com/ershoufang/', required: true, stateLabel: '已登录',
      challenge: { detected: true, attempted: true, state: 'recovered',
        reasonCode: 'page-ok', verifyUrl: 'https://bj.lianjia.com/ershoufang/' } }],
    gate: { released: true, required: ['lianjia'], optional: [], reason: '', unavailable: false, checkedAt: '' },
  }
  const port = makePort({ preflight: async () => released })
  const controller = createReportEvaluationController(port)
  const { tree } = await mountPane(controller)

  assert.equal(controller.getState().phase, 'draft', '必需来源已通过时正文应当可用')
  assert.equal(find(tree, (n) => n.props?.['data-valuation-auth-gate'] !== undefined), null,
    '已释放时不再画门禁（员工直接看到工作面）')
})

test('门禁：凭据有效但来源被挑战 → 放行正文，并在正文里给出非阻塞的验证提示', async () => {
  const released = {
    ...PREFLIGHT_CHALLENGED,
    sites: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated',
      reason: 'lianjia 已登录（到期 2026-10-15 16:54）；受保护页当前要求人机验证 —— 这是页面访问问题、不是未登录。',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
      expiresAt: '2026-10-15T08:54:42Z', sessionCookie: false,
    }],
    rows: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated',
      reason: 'lianjia 已登录（到期 2026-10-15 16:54）；受保护页当前要求人机验证 —— 这是页面访问问题、不是未登录。',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
      expiresAt: '2026-10-15T08:54:42Z', sessionCookie: false,
      required: true, stateLabel: '已登录',
      challenge: { detected: true, attempted: false, state: '', reasonCode: '', verifyUrl: 'https://bj.lianjia.com/ershoufang/' },
    }],
    gate: { released: true, required: ['lianjia'], optional: [], reason: '', unavailable: false, checkedAt: '' },
  }
  const port = makePort({ preflight: async () => released })
  const controller = createReportEvaluationController(port)
  controller.recheckAuth()
  await tick()
  const { tree } = await mountPane(controller)

  // 关键：**凭据有效 + 页面被挑战 = 已登录** —— 页面照常可用（挑战不是门禁）。
  assert.equal(controller.getState().phase, 'draft')
  const text = textOf(tree)
  assert.match(text, /人机验证/, '要说清来源当前要求验证')
  assert.match(text, /取数时会自动尝试恢复/, '要说清验证由后续取数流程处理')
  assert.equal(text.includes('2026-10-15T08:54:42Z'), true, '有效期的展示要能被核对')
  const notes = find(tree, (n) => n.props?.['data-valuation-challenge-notes'] === 'true')
  assert.notEqual(notes, null, '提示必须落在 DOM 上（供真机验收脚本核对）')
})

test('门禁：会话 cookie 的提示文案与"到期时间"区分开', async () => {
  const released = {
    ...PREFLIGHT_CHALLENGED,
    sites: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '已登录；受保护页当前要求人机验证',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/', expiresAt: '', sessionCookie: true,
    }],
    rows: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '已登录；受保护页当前要求人机验证',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/', expiresAt: '', sessionCookie: true,
      required: true, stateLabel: '已登录',
      challenge: { detected: true, attempted: false, state: '', reasonCode: '', verifyUrl: 'https://bj.lianjia.com/ershoufang/' },
    }],
    gate: { released: true, required: ['lianjia'], optional: [], reason: '', unavailable: false, checkedAt: '' },
  }
  const port = makePort({ preflight: async () => released })
  const controller = createReportEvaluationController(port)
  controller.recheckAuth()
  await tick()
  const { tree } = await mountPane(controller)
  assert.match(textOf(tree), /会话 cookie，关掉浏览器即失效/)
})

test('a confirmed workflow clear can reset local intake without navigating or changing the archived task', async () => {
  const port = makePort()
  const controller = createReportEvaluationController(port, { initial: DRAFT_PATCH, onHandoff() {} })
  controller.preparePreview()
  await tick()
  controller.confirm()
  await tick()
  assert.ok(controller.getState().parentSessionId)
  assert.equal(typeof controller.resetDraft, 'function')
  controller.resetDraft()
  assert.equal(controller.getState().phase, 'draft')
  assert.equal(controller.getState().parentSessionId, '')
  assert.deepEqual(controller.getState().selection, [])
  assert.equal(port.calls.start.length, 1)
  assert.equal(port.calls.open.length, 0)
})
