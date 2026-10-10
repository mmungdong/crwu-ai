/**
 * 第 6 层（Client 本地审核）的单元测试。
 *
 * 这一层全是**纯逻辑 + 注入替身**，所以不需要 DOM、不需要 Electron，也不需要 React：
 * 1. §8 主按钮状态表的九种状态逐条（禁用还必须给出可理解的原因文字）；
 * 2. `formatBytes` 与汇总行 / 超限文案；
 * 3. 选择的去重、保序与移除；
 * 4. Host 的 `status` → 图标/文字/颜色三态映射；
 * 5. 「本机文件选择不支持」的降级文案（绝不暴露 JS 错误或底层服务名）；
 * 6. 会话创建失败时**已选内容与提示词不丢**（这是本地审核最容易踩坏的一条：
 *    Host 已经建好快照并给出提示词，若客户端把手里的选择清了，用户只能从头重选）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  formatBytes, addSelection, removeSelection, buttonStateOf, summaryLineOf,
  overLimitMessageOf, itemStatusOf, itemMetaOf, basenameOf, relativePathOf,
  pickSupported, hasHostPaths, supportsDirectoryPick, supportsFilePick,
} = await import(new URL('src/client/features/local-audit/selection.ts', ROOT).href)
const {
  createLocalAuditController, initialLocalAuditState, stageIndexOf,
} = await import(new URL('src/client/features/local-audit/controller.ts', ROOT).href)
const { pickDirectory, pickFile } = await import(new URL('src/client/features/local-audit/pick.ts', ROOT).href)
const { createLocalAuditSession } = await import(new URL('src/client/features/local-audit/session.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { WORKBENCH_CLASSES: WORKBENCH_CLASSES_LOCAL } = await import(
  new URL('src/client/features/workbench/consts.ts', ROOT).href
)

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 空扫描结果（Host 在没有任何选择时就是这个形状）。 */
function scanOf(patch = {}) {
  return {
    ok: true, error: '', errorKind: '', fileCount: 0, limit: 30, overLimit: false,
    readableCount: 0, skippedCount: 0, items: [], skipped: [], ...patch,
  }
}

function itemOf(name, patch = {}) {
  return {
    path: `/Users/someone/资料/${name}`, name, kind: 'file', sizeBytes: 1024,
    fileCount: 1, status: 'scanned', reason: '', ...patch,
  }
}

/** 一个只回固定事实的 Host 替身。 */
function fakePort(patch = {}) {
  const calls = { status: [], start: [], claim: [] }
  const port = {
    status: async (args) => { calls.status.push(args); return scanOf({ items: [itemOf('a.xlsx')], fileCount: 1, readableCount: 1 }) },
    start: async (args) => {
      calls.start.push(args)
      return {
        ok: true, error: '', errorKind: '', handoffId: 'h-1', prompt: '固定提示词',
        providedCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000,
        workspacePath: '/Users/someone/中瑞世联工作空间', casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [],
      }
    },
    claim: async (args) => { calls.claim.push(args); return { ok: true } },
    pickDirectory: async () => '/Users/someone/资料',
    sessions: {
      create: async () => 's-1',
      using: async (id, options, operation) => {
        await operation({ binding: { session: { rename: async () => ({}), prompt: async () => ({}) } } })
      },
      openSession: () => {},
    },
    ...patch,
  }
  return { port, calls }
}

/** 一个已选好两个入口、扫描已经回到 'idle' 的控制器状态。 */
function readyState(patch = {}) {
  const a = '/Users/someone/资料/计算表.xlsx'
  const b = '/Users/someone/资料/附件'
  return {
    ...initialLocalAuditState(),
    selected: [a, b],
    items: [
      { path: a, kind: 'file', name: '计算表.xlsx', sizeBytes: 2_500_000, fileCount: 1, status: 'scanned', reason: '', relativePath: '计算表.xlsx' },
      { path: b, kind: 'directory', name: '附件', sizeBytes: 0, fileCount: 8, status: 'scanned', reason: '', relativePath: '附件' },
    ],
    fileCount: 9, readableCount: 9, limit: 30, overLimit: false,
    ...patch,
  }
}

/** 把一个完整状态装进控制器（控制器只做字段合并，所以这里必须给完整的那一份）。 */
function setFullState(controller, state) {
  controller.setState(state)
}

// ── 1. §8 主按钮状态表（九种状态逐条）─────────────────────────────────────

test('§8 没有文件：请选择文件后开始（禁用 + 原因文字）', () => {
  const state = buttonStateOf(readyState({ items: [], fileCount: 0, readableCount: 0 }))
  assert.equal(state.label, '请选择文件后开始')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditNeedFiles)
})

test('§8 扫描中：正在扫描文件…（禁用）', () => {
  const state = buttonStateOf(readyState({ phase: 'scanning' }))
  assert.equal(state.label, '正在扫描文件…')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditScanning)
})

test('§8 超过 30 个文件：文件数量超限（禁用，扫描中优先）', () => {
  const state = buttonStateOf(readyState({ overLimit: true, fileCount: 36, readableCount: 36 }))
  assert.equal(state.label, '文件数量超限')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditOverLimit)
  // 扫描中优先：还没扫完就断言"超限"是不成立的。
  assert.equal(buttonStateOf(readyState({ phase: 'scanning', overLimit: true })).label, '正在扫描文件…')
})

test('§8 有不可读但仍有可读：开始本地审核（可用，没有原因文字）', () => {
  const state = buttonStateOf(readyState({ readableCount: 7 }))
  assert.equal(state.label, '开始本地审核')
  assert.equal(state.disabled, false)
  assert.equal(state.reason, '')
})

test('§8 没有任何可读文件：没有可审核文件（禁用 + 原因文字）', () => {
  const state = buttonStateOf(readyState({ readableCount: 0 }))
  assert.equal(state.label, '没有可审核文件')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditNoReadable)
})

test('§8 准备快照：正在准备文件…（禁用）', () => {
  const state = buttonStateOf(readyState({ phase: 'preparing' }))
  assert.equal(state.label, '正在准备文件…')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditPreparing)
})

test('§8 创建会话：正在创建审核对话…（禁用）', () => {
  const state = buttonStateOf(readyState({ phase: 'creating' }))
  assert.equal(state.label, '正在创建审核对话…')
  assert.equal(state.disabled, true)
  assert.equal(state.reason, zhCN.localAuditCreating)
})

test('§8 已准备 handoff：开始本地审核（可用，再点就是复用这份快照建会话）', () => {
  const state = buttonStateOf(readyState({ phase: 'ready' }))
  assert.equal(state.label, '开始本地审核')
  assert.equal(state.disabled, false)
  assert.equal(state.reason, '')
})

test('§8 普通错误：重试准备（可用），但硬失败时也说得清为什么不能开始', () => {
  const retry = buttonStateOf(readyState({ phase: 'failed' }))
  assert.equal(retry.label, '重试准备')
  assert.equal(retry.disabled, false)
  assert.equal(retry.reason, '')

  // 「普通错误」不等于"可以重试"：一条都没读到、或本身超限时仍然禁用并给原因。
  assert.equal(buttonStateOf(readyState({ phase: 'failed', readableCount: 0 })).disabled, true)
  assert.equal(buttonStateOf(readyState({ phase: 'failed', overLimit: true })).label, '文件数量超限')
})

// ── 2. formatBytes 与汇总行 / 超限文案 ─────────────────────────────────────

test('formatBytes 用 1024 进制、一位小数，0 就是 0 B', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2_500_000), '2.4 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB')
  // 非有限值 / 负数不许渲染出 NaN / -1 MB。
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(formatBytes(-5), '0 B')
})

test('summaryLineOf 说清"选了几个项目、展开后多少个文件"', () => {
  assert.equal(summaryLineOf(scanOf({ fileCount: 0 })), '')
  const line = summaryLineOf(scanOf({
    fileCount: 12,
    items: [
      itemOf('计算表.xlsx'),
      itemOf('附件', { kind: 'directory', fileCount: 11, sizeBytes: 0 }),
    ],
  }))
  assert.equal(line, '已选择 2 个项目，展开后共 12 个文件')
})

test('overLimitMessageOf 只在上限被突破时给一句可执行的话', () => {
  const over = overLimitMessageOf(scanOf({ overLimit: true, fileCount: 36, limit: 30 }))
  assert.equal(over, '当前选择会展开为 36 个文件，超过单次最多 30 个文件的限制。请移除部分文件或文件夹后再继续。')
  assert.equal(overLimitMessageOf(scanOf({ overLimit: false, fileCount: 3 })), '')
})

// ── 3. 选择：去重、保序、移除 ──────────────────────────────────────────────

test('addSelection 去重且保序（多入口同一个文件只出现一次）', () => {
  const list = addSelection([], ['/a/1.xlsx', '/a/sub'])
  assert.deepEqual(list, ['/a/1.xlsx', '/a/sub'])
  // 同一个路径再次加入（例如同一个文件既被单独选、又在选中的文件夹里）：只保留一份。
  assert.deepEqual(addSelection(list, ['/a/sub']), ['/a/1.xlsx', '/a/sub'])
  assert.deepEqual(addSelection(list, ['/a/2.xlsx', '/a/1.xlsx']), ['/a/1.xlsx', '/a/sub', '/a/2.xlsx'])
  // 空串与空白不是选择项。
  assert.deepEqual(addSelection([], ['', '   ', '/b']), ['/b'])
})

test('removeSelection 去掉一项且保留顺序（Windows 反斜杠也算同一项）', () => {
  const list = ['/a/1.xlsx', '/a/2.xlsx', 'C:\\资料\\附件']
  assert.deepEqual(removeSelection(list, '/a/1.xlsx'), ['/a/2.xlsx', 'C:\\资料\\附件'])
  assert.deepEqual(removeSelection(list, 'C:/资料/附件'), ['/a/1.xlsx', '/a/2.xlsx'])
  assert.deepEqual(removeSelection(list, '/a/没有这个'), list)
})

test('basenameOf / relativePathOf 只做展示，兼容两种分隔符', () => {
  assert.equal(basenameOf('/a/b/计算表.xlsx'), '计算表.xlsx')
  assert.equal(basenameOf('C:\\资料\\附件'), '附件')
  assert.equal(relativePathOf('/a/b/计算表.xlsx', '/a/b'), '计算表.xlsx')
  // 根就是这一项所在的目录 → 相对路径就是文件名本身（不是空串、也不是文件名+目录名）。
  assert.equal(relativePathOf('/a/b/附件/c.xlsx', '/a/b/附件'), 'c.xlsx')
  // 显示名与根相同（用户直接选了那个文件）：给文件名，而不是空串。
  assert.equal(relativePathOf('/a/b/附件', '/a/b/附件'), '附件')
  assert.equal(relativePathOf('C:\\资料\\附件\\c.xlsx', 'C:/资料'), '附件/c.xlsx')
})

// ── 4. 状态映射（图标 + 文字 + 颜色三重表达）────────────────────────────────

test('itemStatusOf 四态各有 tone 与中文标签', () => {
  assert.deepEqual(itemStatusOf('scanned'), { tone: 'ok', label: '已扫描' })
  assert.deepEqual(itemStatusOf('unreadable'), { tone: 'error', label: '无法读取' })
  assert.deepEqual(itemStatusOf('skipped'), { tone: 'muted', label: '已跳过' })
  assert.deepEqual(itemStatusOf('over-limit'), { tone: 'warn', label: '超过数量限制' })
  // 认不出的取值不谎报成功。
  assert.deepEqual(itemStatusOf('???'), { tone: 'muted', label: '未知状态' })
})

test('itemMetaOf 分开说文件与文件夹，且带上展开后的文件数', () => {
  assert.equal(itemMetaOf({ kind: 'file', sizeBytes: 2_500_000, fileCount: 1 }), '文件 · 2.4 MB')
  assert.equal(itemMetaOf({ kind: 'directory', sizeBytes: 0, fileCount: 8 }), '文件夹 · 展开 8 个文件')
  assert.equal(itemMetaOf({ kind: 'directory', sizeBytes: 0, fileCount: 0 }), '文件夹 · 没有可审核文件')
})

// ── 5. 本机文件选择的降级 ──────────────────────────────────────────────────

test('两条选择能力都缺席时给"宿主不支持"的明确结果（各说各的那一条）', async () => {
  // 2026-10-11 起：两条能力**分开判**，所以缺哪条就说哪条 —— 只有两条都没有时，
  // 界面才说设计 §4 那句「当前 DeepSeek Harness 版本不支持本机文件选择」。
  assert.deepEqual(await pickDirectory(undefined), {
    ok: false, paths: [], unsupported: true, error: zhCN.localAuditPickDirectoryUnsupported,
  })
  assert.deepEqual(await pickFile(undefined), {
    ok: false, paths: [], unsupported: true, error: zhCN.localAuditPickFilesUnsupported,
  })
  // 用户取消（服务返回空）不是错误，也不该说"不支持"。
  assert.deepEqual(await pickDirectory({ pickDirectory: async () => null }), { ok: true, paths: [], unsupported: false, error: '' })
  assert.deepEqual(
    await pickDirectory({ pickDirectory: async () => '/Users/someone/资料' }),
    { ok: true, paths: ['/Users/someone/资料'], unsupported: false, error: '' },
  )
})

test('选择服务抛错时必须收敛成一句人话，而且**不能说成"宿主不支持"**', async () => {
  const failure = await pickDirectory({
    pickDirectory: async () => { throw new Error('uiWorkspace.pickDirectory is not a function') },
  })
  assert.equal(failure.ok, false)
  // 服务在、这一次没打开：是"打不开"，不是"不支持"。说成不支持会把用户指去换宿主（换也没用）。
  assert.equal(failure.unsupported, false)
  assert.equal(failure.error, zhCN.localAuditPickFailed)
  assert.equal(failure.error.includes('uiWorkspace'), false)
  assert.equal(failure.error.includes('Error'), false)
})

test('选取文件后按 entry 相对所选文件夹算展示路径；拿不到绝对路径就如实失败', async () => {
  const picked = await pickFile({
    hostPaths: { pathFor: (file) => `/Users/someone/资料/${file.name}` },
  }, [
    { name: 'a.xlsx', webkitRelativePath: '', path: '' },
    { name: 'b.pdf', webkitRelativePath: '附件/b.pdf', path: '' },
    { name: 'c.txt', webkitRelativePath: '', path: '/Users/someone/资料/c.txt' },
  ])
  assert.deepEqual(picked, { ok: true, paths: ['/Users/someone/资料/a.xlsx', '/Users/someone/资料/b.pdf', '/Users/someone/资料/c.txt'], unsupported: false, error: '' })

  const missing = await pickFile({ hostPaths: {} }, [{ name: 'd.docx', webkitRelativePath: '', path: '' }])
  assert.equal(missing.ok, false)
  assert.equal(missing.unsupported, true)
  assert.equal(missing.error, zhCN.localAuditPickFilesUnsupported)
})

test('控制器把不支持的选择如实写进界面状态，已选内容不受影响', async () => {
  const { port } = fakePort({ pickDirectory: undefined, pickFile: undefined })
  const controller = createLocalAuditController({ port })
  const before = controller.state()
  const next = await controller.pickDirectory()
  assert.deepEqual(next.items, before.items)
  assert.equal(next.pickError, zhCN.localAuditPickDirectoryUnsupported)
})

// ── 6. 会话接线（失败时已选内容与提示词不丢）────────────────────────────────

test('会话创建成功：cwd=工作空间（会话挂到工作空间下）、建完立刻命名并发提示词、认领 handoff、切过去', async () => {
  const seq = []
  const { port } = fakePort({
    claim: async (args) => { seq.push(['claim', args]); return { ok: true } },
    sessions: {
      create: async (input) => { seq.push(['create', input]); return 's-9' },
      using: async (id, options, operation) => {
        seq.push(['using', id, options.source])
        await operation({
          binding: {
            session: {
              rename: async (title) => { seq.push(['rename', title]); return {} },
              prompt: async (content, mode) => { seq.push(['prompt', content, mode]); return {} },
            },
          },
        })
      },
      openSession: (id) => { seq.push(['open', id]) },
    },
  })
  const controller = createLocalAuditController({ port })
  setFullState(controller, readyState())

  const result = await controller.prepare()
  assert.equal(result.ok, true)
  const started = await controller.start()
  assert.equal(started.ok, true)

  // 会话的 cwd **必须**是本轮案例目录：DSH 的会话沙箱边界就是 cwd，不设它的话
  // 对话里的案例内工具（crwu_run_python_script 等）写不进快照。
  assert.deepEqual(seq[0], ['create', { cwd: '/Users/someone/中瑞世联工作空间' }])
  assert.deepEqual(seq[1], ['using', 's-9', 'crwuWorkbench:localAudit'])
  assert.match(seq[2][1], /^本地审核 · \d{2}-\d{2} \d{2}:\d{2}$/)
  assert.deepEqual(seq[3], ['prompt', [{ type: 'text', text: '固定提示词' }], 'queue'])
  // 案例目录**只用于建会话**：提示词里不许出现它，否则绝对路径就跟着对话文本流出去了。
  // 发给对话的提示词里不许出现任何绝对路径（工作空间与案例目录都不行）。
  assert.equal(JSON.stringify(seq[3]).includes('/Users/someone/中瑞世联工作空间'), false, '提示词里不得出现工作空间绝对路径')
  assert.equal(JSON.stringify(seq[3]).includes('本地审核/h-1'), false, '提示词里不得出现案例目录')
  assert.equal(controller.state().handoff.casePath, '/Users/someone/中瑞世联工作空间/本地审核/h-1')
  assert.equal(controller.state().handoff.workspacePath, '/Users/someone/中瑞世联工作空间')
  assert.deepEqual(seq[4], ['claim', { handoffId: 'h-1', sessionId: 's-9' }])
  assert.deepEqual(seq[5], ['open', 's-9'])
  assert.equal(controller.state().phase, 'done')
  assert.equal(controller.state().providedCount, 1)
})

test('会话创建失败：phase=failed、给可读原因，且**已选内容与提示词都不丢**', async () => {
  const state = readyState({ prompt: '重点检查金额汇总' })
  const { port } = fakePort({
    sessions: {
      create: async () => { throw new Error('sessions.create is not available in this build') },
      using: async (id, options, operation) => { await operation({}) },
    },
  })
  const controller = createLocalAuditController({ port })
  setFullState(controller, state)

  const started = await controller.start()
  assert.equal(started.ok, false)
  assert.equal(started.error, `${zhCN.localAuditSessionFailed}sessions.create is not available in this build`)
  const after = controller.state()
  assert.deepEqual(after.items, state.items, '已选内容必须原样保留')
  assert.equal(after.prompt, '重点检查金额汇总', '提示词必须原样保留')
  assert.equal(after.handoff.prompt, '固定提示词', '提示词必须留着给"复制审核提示词"')
  assert.equal(after.phase, 'failed')
  assert.equal(after.error, `${zhCN.localAuditSessionFailed}sessions.create is not available in this build`)
})

test('发送提示词失败也算中断：已选内容不丢，且不再切会话', async () => {
  const opened = []
  const { port } = fakePort({
    sessions: {
      create: async () => 's-1',
      using: async (id, options, operation) => {
        await operation({ binding: { session: { rename: async () => ({}), prompt: async () => { throw new Error('queue full') } } } })
      },
      openSession: (id) => { opened.push(id) },
    },
  })
  const controller = createLocalAuditController({ port })
  setFullState(controller, readyState())
  const started = await controller.start()
  assert.equal(started.ok, false)
  assert.equal(started.error, `${zhCN.localAuditSessionSendFailed}queue full`)
  assert.deepEqual(opened, [], '会话没建成就不要跳过去')
  assert.equal(controller.state().items.length, 2)
  assert.equal(controller.state().handoff.prompt, '固定提示词')
})

test('认领失败不阻塞：仍然算移交成功，只把原因留在状态里', async () => {
  const { port } = fakePort({ claim: async () => ({ ok: false, error: 'handoff 已被使用' }) })
  const controller = createLocalAuditController({ port })
  setFullState(controller, readyState())
  const started = await controller.start()
  assert.equal(started.ok, true)
  assert.equal(controller.state().claimError, 'handoff 已被使用')
})

test('handoff 过期：不再尝试建会话，直接说"重新准备文件"', async () => {
  let created = 0
  const { port } = fakePort({
    sessions: {
      create: async () => { created++; return 's-1' },
      using: async (id, options, operation) => { await operation({}) },
    },
  })
  const controller = createLocalAuditController({ port, now: () => Date.now() + 10 * 60_000 })
  setFullState(controller, readyState({
    handoff: {
      handoffId: 'h-1', prompt: 'p', providedCount: 1, skippedCount: 0, expiresAt: Date.now(),
      workspacePath: '/Users/someone/中瑞世联工作空间', casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [],
    },
  }))
  const started = await controller.start()
  assert.equal(started.ok, false)
  assert.equal(started.expired, true)
  assert.equal(started.error, zhCN.localAuditHandoffExpired)
  assert.equal(created, 0)
  assert.equal(controller.state().expired, true)
})

test('createLocalAuditSession 用 workspaceId 挂工作空间（拿不到 id 才退回 cwd）', async () => {
  const calls = []
  const result = await createLocalAuditSession({
    port: {
      create: async (input) => { calls.push(input); return 's-7' },
      using: async (id, options, operation) => { await operation({ binding: { session: { rename: async () => ({}), prompt: async () => ({}) } } }) },
    },
    handoffId: 'h-9',
    prompt: '固定提示词',
    workspaceId: 'ws-42',
    workspacePath: '/Users/someone/中瑞世联工作空间',
    casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-9',
  })
  assert.equal(result.ok, true)
  // DSH 自己的界面就是这么建的（`ui-workspace` 的 `reuseOrCreateBlank`）：
  // 侧栏「未分组」的判据是 `workspace.sessionIds`（注册表成员关系），只给 cwd 挂不上去。
  assert.deepEqual(calls, [{ workspaceId: 'ws-42' }])
})

test('createLocalAuditSession 拿不到 workspaceId 时退回 cwd（落在对的目录里）', async () => {
  const calls = []
  const result = await createLocalAuditSession({
    port: {
      create: async (input) => { calls.push(input); return 's-8' },
      using: async (id, options, operation) => { await operation({ binding: { session: { rename: async () => ({}), prompt: async () => ({}) } } }) },
    },
    handoffId: 'h-9',
    prompt: '固定提示词',
    workspaceId: '',
    workspacePath: '/Users/someone/中瑞世联工作空间',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ cwd: '/Users/someone/中瑞世联工作空间' }])
})

test('createLocalAuditSession 建会话抛错时收敛成可读失败（不回传路径）', async () => {
  const result = await createLocalAuditSession({
    port: {
      create: async () => { throw new Error('cwd is outside the allowed roots') },
      using: async (id, options, operation) => { await operation({}) },
    },
    handoffId: 'h-9',
    prompt: '固定提示词',
    workspacePath: '/Users/someone/中瑞世联工作空间',
    casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-9',
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'session')
  assert.match(result.error, /创建审核对话失败/)
  assert.match(result.error, /cwd is outside the allowed roots/, '真实原因要带出来，否则用户无从下手')
})

test('createLocalAuditSession 独立可用：服务缺席时返回 { ok:false, error:… } 而不是抛错', async () => {
  const missing = await createLocalAuditSession({ port: {}, handoffId: 'h-1', prompt: 'p', workspaceId: 'ws-1', workspacePath: '/Users/someone/中瑞世联工作空间' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, zhCN.localAuditSessionUnsupported)

  const noPort = await createLocalAuditSession({ port: undefined, handoffId: 'h-1', prompt: 'p', workspaceId: 'ws-1', workspacePath: '/Users/someone/中瑞世联工作空间' })
  assert.equal(noPort.ok, false)
  assert.equal(noPort.error, zhCN.localAuditSessionUnsupported)
})

test('准备工作失败（Host 回 ok:false）时，选择与提示词同样不丢，按钮回到"重试准备"', async () => {
  const { port } = fakePort({
    start: async () => ({
      ok: false, error: '当前选择会展开为 36 个文件，超过单次最多 30 个文件的限制。', errorKind: 'input',
      handoffId: '', prompt: '', providedCount: 0, skippedCount: 0, expiresAt: 0, files: [], skipped: [],
    }),
  })
  const controller = createLocalAuditController({ port })
  const state = readyState({ prompt: '重点看汇总' })
  setFullState(controller, state)
  const result = await controller.prepare()
  assert.equal(result.ok, false)
  assert.equal(result.error, '当前选择会展开为 36 个文件，超过单次最多 30 个文件的限制。')
  assert.equal(controller.state().phase, 'failed')
  assert.deepEqual(controller.state().items, state.items)
  assert.equal(controller.state().prompt, '重点看汇总')
  assert.equal(buttonStateOf(controller.state()).label, '重试准备')
})

// ── 阶段条 ──────────────────────────────────────────────────────────────────

test('阶段条：准备文件时第 1 步已完成、第 2 步进行中', () => {
  assert.equal(stageIndexOf({ phase: 'idle' }), 0)
  assert.equal(stageIndexOf({ phase: 'scanning' }), 0)
  assert.equal(stageIndexOf({ phase: 'preparing' }), 1)
  assert.equal(stageIndexOf({ phase: 'creating' }), 2)
  assert.equal(stageIndexOf({ phase: 'done' }), 5)
  // 失败落在"还没跑完的那一步"上，不假装成功（扫描失败 = 第 1 步都没过）。
  assert.equal(stageIndexOf({ phase: 'failed', failedAt: 'scan' }), 0)
  assert.equal(stageIndexOf({ phase: 'failed', failedAt: 'prepare' }), 1)
  assert.equal(stageIndexOf({ phase: 'failed', failedAt: 'session' }), 3)
})

// ── 7. 页签（报告审核 / 本地审核）────────────────────────────────────────────

test('页签的左右方向键在两项之间循环，Home/End 直达两端', async () => {
  const { nextTabKey, LOCAL_AUDIT_TABS } = await import(new URL('src/client/features/local-audit/tabs.ts', ROOT).href)
  assert.deepEqual([...LOCAL_AUDIT_TABS], ['report', 'local'])
  assert.equal(nextTabKey('report', 'ArrowRight', LOCAL_AUDIT_TABS), 'local')
  assert.equal(nextTabKey('local', 'ArrowRight', LOCAL_AUDIT_TABS), 'report')
  assert.equal(nextTabKey('report', 'ArrowLeft', LOCAL_AUDIT_TABS), 'local')
  assert.equal(nextTabKey('local', 'ArrowLeft', LOCAL_AUDIT_TABS), 'report')
  assert.equal(nextTabKey('local', 'Home', LOCAL_AUDIT_TABS), 'report')
  assert.equal(nextTabKey('report', 'End', LOCAL_AUDIT_TABS), 'local')
  assert.equal(nextTabKey('report', 'Enter', LOCAL_AUDIT_TABS), 'report', '别的键不动页签')
})

// ── 草稿的持有者：必须是 apply 层，而不是页面组件 ────────────────────────────
//
// 这一条用**注入式渲染器**（`tests/helpers/tsx-loader.mjs`）真渲染一次页面，因为要断言的
// 是"页面用的是外面那份状态机、不是自己新建一份"。纯逻辑测不到这件事。
//
// 背景：用户点一下「报告审核」看一眼再切回「本地审核」，页面会被卸载重建。状态机若长在
// 组件里，那份已经扫过、甚至已经建好快照的选择就没了 —— 与设计 §8「不要丢弃已选内容」冲突。

/** 展开函数组件（与该 loader 的既有用法同一套：嵌套组件各自拿新实例）。 */
function resolveNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolveNode)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
    try {
      return resolveNode(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolveNode(node.props.children) } }
}

function renderPane(component, props) {
  globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
  const { createElement } = globalThis.__crwuTestReact ?? {}
  void createElement
  return resolveNode(component(props))
}

/** 深度收集所有带某个类名的节点。 */
function collectByClass(node, className, into) {
  if (node === null || node === undefined || typeof node !== 'object') return into
  if (Array.isArray(node)) { for (const child of node) collectByClass(child, className, into); return into }
  if (String(node.props?.className ?? '').split(/\s+/).includes(className)) into.push(node)
  collectByClass(node.props?.children, className, into)
  return into
}

/** 深度查找第一个满足条件的节点。 */
function findByClass(node, className, into = null) {
  if (into !== null) return into
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByClass(child, className); if (hit) return hit }
    return null
  }
  if (String(node.props?.className ?? '').split(/\s+/).includes(className)) return node
  return findByClass(node.props?.children, className)
}

/** 树上所有 **`<button>` 的标签**（逐字；用来把按钮和卡片标题区分开）。 */
function buttonLabelsOf(node, into = []) {
  if (node === null || node === undefined || typeof node !== 'object') return into
  if (Array.isArray(node)) { for (const child of node) buttonLabelsOf(child, into); return into }
  if (node.type === 'button' && typeof node.props?.children === 'string') into.push(node.props.children)
  buttonLabelsOf(node.props?.children, into)
  return into
}

/** 深度收集树上的所有文本（用来断言"屏幕上有没有那个文件名"）。 */
function textOf(node, into = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return into
  if (typeof node === 'string' || typeof node === 'number') { into.push(String(node)); return into }
  if (Array.isArray(node)) { for (const child of node) textOf(child, into); return into }
  textOf(node.props?.children, into)
  return into
}

test('草稿由 apply 层持有：注入同一份状态机时，页面重挂后仍带着选择', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }

  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  await controller.pickDirectory()
  assert.equal(controller.state().items.length, 1, '先让它真的选到一批文件')

  const first = renderPane(LocalAuditPane, { services, controller })
  assert.match(textOf(first).join(' '), /a\.xlsx/, '第一次挂载要显示已选文件')
  // 重挂（= 切到「报告审核」再切回来）：同一份状态机 → 选择还在。
  const second = renderPane(LocalAuditPane, { services, controller })
  assert.match(textOf(second).join(' '), /a\.xlsx/, '重挂后已选内容不能丢')
  // 反证：换一份**全新**的状态机就该是空态（说明上面那条不是恒真）。
  const { port: freshPort } = fakePort()
  const fresh = renderPane(LocalAuditPane, { services, controller: createLocalAuditController({ port: freshPort }) })
  assert.equal(/a\.xlsx/.test(textOf(fresh).join(' ')), false, '新状态机必须是空态，否则这条断言没有意义')
})

test('订阅可解除：解除之后状态变化不再回调（状态机比页面活得久）', async () => {
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  const seen = []
  const unsubscribe = controller.subscribe((state) => { seen.push(state.items.length) })
  assert.equal(seen.length, 1, '订阅时立刻回调一次当前状态')
  await controller.pickDirectory()
  assert.ok(seen.length > 1, '状态变化要回调（一次选择会推进几个阶段）')
  unsubscribe()
  const before = seen.length
  controller.clear()
  assert.equal(seen.length, before, '解除之后不许再回调（否则会把 state 写回已卸载的组件）')
})

// ── 失败与过期的结果卡（设计 §8/§9 的用户可见结论）─────────────────────────
//
// 这两条是**真渲染**断言：验收场景 16（Windows 启动失败时能看到完全权限操作提示）与
// 场景 12（handoff 过期后明确提示重新准备）都落在这张卡上。

function handoffOf(patch = {}) {
  return {
    handoffId: 'h-1', prompt: '固定提示词（Host 原样）', providedCount: 1, skippedCount: 0,
    expiresAt: 0, workspacePath: '/Users/someone/中瑞世联工作空间', casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [], ...patch,
  }
}

test('会话启动失败卡：给出完全权限三步说明 + 复制提示词，且没有「自动重试」', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditHandoffCard } = await import(new URL('src/client/features/local-audit/LocalAuditHandoffCard.tsx', ROOT).href)
  const tree = renderPane(LocalAuditHandoffCard, {
    done: false, expired: false, failed: true,
    error: '创建审核对话失败：沙箱拒绝',
    handoff: handoffOf(),
    providedCount: 1, skippedCount: 0, copied: false, copyError: '', claimError: '', busy: false,
    onCopy: () => {}, onReprepare: () => {},
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /审核对话启动中断/)
  assert.match(text, /将 DeepSeek Harness 切换到完全权限/)
  assert.match(text, /手动创建一个新对话/)
  assert.match(text, /粘贴审核提示词并发送/)
  assert.match(text, /创建审核对话失败：沙箱拒绝/, '失败原因要紧邻标题说清楚')
  assert.match(text, /复制审核提示词/)
  assert.match(text, /重新准备文件/)
  // 用户口径（设计 §8）：**不要**显示「自动重试创建会话」。
  assert.equal(/自动重试/.test(text), false)
})

test('handoff 过期卡：只说「重新准备文件」，不再提供复制', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditHandoffCard } = await import(new URL('src/client/features/local-audit/LocalAuditHandoffCard.tsx', ROOT).href)
  const tree = renderPane(LocalAuditHandoffCard, {
    done: false, expired: true, failed: false, error: '', handoff: handoffOf(),
    providedCount: 1, skippedCount: 0, copied: false, copyError: '', claimError: '', busy: false,
    onCopy: () => {}, onReprepare: () => {},
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /审核提示词已过期，请重新准备文件。/)
  assert.match(text, /重新准备文件/)
  assert.equal(/复制审核提示词/.test(text), false, '过期的提示词没有复制价值，不该给这个按钮')
})

// ── 源码守卫：本地审核**不引入任何监控面** ─────────────────────────────────
//
// 设计 §1/§17.15：不保存审核历史、不加 sidecar、不轮询其他对话、不列出活动会话。
// 这套约束靠"没写那些代码"成立，所以用一条**源码守卫**把它钉住（与本仓 B-01c/B-01e
// 那类守卫同一套做法：剥掉注释再找，避免把注释里的说明算成违规）。

test('本地审核的源码里没有轮询、没有会话列表、没有报告审核的状态操作', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = new URL('src/client/features/local-audit/', ROOT)
  const files = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name))
  assert.ok(files.length >= 10, `本地审核的实现文件太少（${files.length}），扫描根可能不对`)

  /** 去掉块注释与行注释，避免注释里的说明被当成违规。 */
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const offenders = []
  for (const name of files) {
    const code = strip(readFileSync(new URL(name, dir), 'utf8'))
    // 轮询：本地审核的进度只活在这一页，任何定时轮询都意味着监控面。
    if (/\bsetInterval\s*\(/.test(code)) offenders.push(`${name}（setInterval 轮询）`)
    // 报告审核的状态/列表操作：本地审核不该读它们（读了就等于跨流程共享状态）。
    if (/\bauditStatus\b|'audit-status'|\bauditStart\b|'audit-start'/.test(code)) offenders.push(`${name}（报告审核状态操作）`)
    // 会话列表：不列活动会话、不拿别人的会话做判断。
    if (/\bsessions\s*\.\s*list\b|sessions\?\.\s*list\b/.test(code)) offenders.push(`${name}（会话列表）`)
  }
  assert.deepEqual(offenders, [], `本地审核不许出现这些：${offenders.join('、')}`)
})

// ── 文案契约：设计 §2–§9 里逐字给出的用户可见文字，必须真的在文案表里 ──────────
//
// 为什么单独一条：设计把每一句都写死了（它是给员工看的承诺），而文案漂移在单测里是**静默**的
// —— 换个说法测试照样绿，但用户看到的已经不是设计里那句话。所以这里逐字钉一遍。
// 只认"这句话在 `localAudit*` 文案里存在"，不认它挂在哪个状态上（那是上面那些用例的事）。

test('文案契约：设计 §2–§9 的逐字文案都在（含五个文件状态）', () => {
  const blob = Object.entries(zhCN)
    .filter(([key]) => key.startsWith('localAudit'))
    .map(([, value]) => (Array.isArray(value) ? value.join('\n') : String(value)))
    .join('\n')

  const expected = [
    // §2 页面顶部说明
    '本地审核',
    '选择本机文件或文件夹，创建一个新的审核对话。',
    '文件只会用于本次对话，不会进入报告审核或云端交付流程。',
    // §3 已选择内容
    '还没有选择文件',
    '请选择文件或文件夹开始本地审核。',
    '单次最多审核 30 个文件。',
    '已选择 %s 个项目，展开后共 %s 个文件',
    '当前选择会展开为 %s 个文件，超过单次最多 %s 个文件的限制。请移除部分文件或文件夹后再继续。',
    // §3 五个文件状态
    '待审核', '已扫描', '无法读取', '已跳过', '超过数量限制',
    // §4 选择区域
    '选择文件', '选择文件夹',
    '支持任意文件类型。文件夹会递归读取。',
    // 「重新扫描」按用户 2026-10-11 口径下掉了：移除本身就会重扫，两个动作放一起说不清关系。
    '清空选择',
    '当前 DeepSeek Harness 版本不支持本机文件选择。请更新宿主后重试。',
    // §5 提示词区域
    '补充提示词（可选）',
    '例如：重点检查计算表中的资产数量、金额汇总和异常波动。',
    '为空时使用默认本地审核规则。',
    '你的内容会作为额外要求追加，不会覆盖固定审核约束。',
    // §6 主按钮九态
    '请选择文件后开始', '正在扫描文件…', '文件数量超限', '开始本地审核',
    '没有可审核文件', '正在准备文件…', '正在创建审核对话…', '重试准备',
    // §7 成功流程与阶段名
    '本地审核已移交到新对话',
    '已提供 %s 个文件', '跳过 %s 个文件',
    '后续审核结果会直接显示在新对话中。',
    '已读取选择范围', '正在创建文件快照', '正在创建审核对话', '正在切换到新对话',
    // §8 失败兜底
    '审核对话启动中断',
    '将 DeepSeek Harness 切换到完全权限；',
    '手动创建一个新对话；',
    '粘贴审核提示词并发送。',
    '复制审核提示词', '重新准备文件',
    '审核提示词已复制',
    '请切换到完全权限，创建新对话，然后粘贴并发送。',
    '当前已选择的文件和提示词仍然保留。',
    // §9 过期
    '审核提示词已过期，请重新准备文件。',
  ]
  const missing = expected.filter((line) => !blob.includes(line))
  assert.deepEqual(missing, [], `这些设计里的原话在文案表里找不到：${missing.join(' / ')}`)
  // §8 明确要求**不要**出现「自动重试创建会话」。
  assert.equal(/自动重试/.test(blob), false)
})

test('「待审核」是扫描窗口的状态，不是「未知状态」', () => {
  assert.deepEqual(itemStatusOf('pending'), { tone: 'muted', label: '待审核' })
  assert.deepEqual(itemStatusOf(''), { tone: 'muted', label: '待审核' })
  assert.deepEqual(itemStatusOf('谁也认不出的取值'), { tone: 'muted', label: zhCN.localAuditStatusUnknown })
})

test('扫描窗口：已选的行先画成「待审核」占位行，计数不拿旧数字冒充', async () => {
  const { pendingEntriesOf } = await import(new URL('src/client/features/local-audit/controller.ts', ROOT).href)
  const rows = pendingEntriesOf(['/Users/someone/资料/计算表.xlsx', '/Users/someone/资料/附件'])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => [row.name, row.status, row.kind]), [
    ['计算表.xlsx', 'pending', ''], ['附件', 'pending', ''],
  ])
  // 扫之前不知道是文件还是文件夹：kind 留空，行上画中性图标；大小也不冒充 0 B。
  assert.equal(itemMetaOf(rows[0]), zhCN.localAuditScanningMeta)

  const { port } = fakePort({ status: () => new Promise(() => undefined) })
  const controller = createLocalAuditController({ port })
  await controller.selectionChanged(['/Users/someone/资料/计算表.xlsx'])
  const scanning = controller.rescan()
  // 扫描还没回来：行是待审核、计数归零（界面据此说"正在统计文件数量…"）。
  assert.equal(controller.state().phase, 'scanning')
  assert.deepEqual(controller.state().items.map((row) => row.status), ['pending'])
  assert.equal(controller.state().fileCount, 0)
  void scanning
})

test('页面顶部说明与扫描窗口都真的画到屏幕上（不只是文案表里有）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
  // status 永不 resolve：停在"扫到一半"，行就应该是「待审核」而不是空态。
  const { port } = fakePort({ status: () => new Promise(() => undefined) })
  const controller = createLocalAuditController({ port })
  await controller.selectionChanged(['/Users/someone/资料/计算表.xlsx'])
  void controller.rescan()
  const tree = renderPane(LocalAuditPane, { services, controller })
  const text = textOf(tree).join(' ')
  // §2 副标题与辅助说明（页签条承担标题，正文这两行在这里）。
  assert.match(text, /选择本机文件或文件夹，创建一个新的审核对话。/)
  assert.match(text, /文件只会用于本次对话，不会进入报告审核或云端交付流程。/)
  // §3 五个状态里的「待审核」：选了但还没扫完的行就是它。
  assert.match(text, /待审核/)
  assert.match(text, /正在读取…/)
  // 扫描窗口里**不报数字**（这时还没有结论）。
  assert.match(text, /正在统计文件数量…/)
  assert.equal(/展开后共 0 个文件/.test(text), false, '扫描中不许拿 0 冒充结论')
  void tree
})

test('复制成功的反馈是设计 §8 的三行（切权限 / 建新对话 / 粘贴发送 + 内容仍保留）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditHandoffCard } = await import(new URL('src/client/features/local-audit/LocalAuditHandoffCard.tsx', ROOT).href)
  const tree = renderPane(LocalAuditHandoffCard, {
    done: false, expired: false, failed: true, error: '创建审核对话失败：沙箱拒绝',
    handoff: handoffOf(), providedCount: 1, skippedCount: 0,
    copied: true, copyError: '', claimError: '', busy: false,
    onCopy: () => {}, onReprepare: () => {},
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /审核提示词已复制/)
  assert.match(text, /请切换到完全权限，创建新对话，然后粘贴并发送。/)
  assert.match(text, /当前已选择的文件和提示词仍然保留。/)
})

// ── 选择能力：两条分开判，而且**宿主路径服务是对象不是函数** ─────────────────────
//
// 2026-10-11 用户实测反馈：「当前 DeepSeek Harness 版本不支持本机文件选择」——
// 问「不能选择文件夹吗」。根因两条，都在这一组里钉住：
// ① `pickSupported` 早先把 `__DSH_HOST_PATHS__`（对象 `{ pathFor }`）当成函数判，
//    于是「选择文件」这条能力**永远为假**（替身恰好传了函数形状，单测全绿）；
// ② 两条能力共用一个布尔：只有一条可用时**整块**被换成"不支持"，另一条按钮也一起没了。

test('宿主路径服务是对象 { pathFor }，也要认出来（早先按函数判，永远为假）', () => {
  assert.equal(hasHostPaths({ pathFor: () => '/a' }), true, '真实注入形态是对象')
  assert.equal(hasHostPaths(() => '/a'), true, '函数形状也接受（注入形态可能变）')
  assert.equal(hasHostPaths({}), false)
  assert.equal(hasHostPaths({ pathFor: 'nope' }), false)
  assert.equal(hasHostPaths(undefined), false)
  assert.equal(hasHostPaths(null), false)
  assert.equal(supportsFilePick({ pathFor: () => '/a' }, () => Promise.resolve(null)), true)
  assert.equal(supportsDirectoryPick(() => Promise.resolve(null)), true)
  assert.equal(supportsDirectoryPick(undefined), false)
})

test('两条能力分开判：只有文件夹可用时，那个布尔仍然是 true', () => {
  // 桌面端（有 file input + 目录选择器）、只有目录选择器、两条都没有 —— 三种都要对。
  const fileInput = () => Promise.resolve(null)
  assert.equal(pickSupported({ pickDirectory: () => null, hostPaths: { pathFor: () => '/a' }, fileInput }), true)
  assert.equal(pickSupported({ pickDirectory: () => null }), true, '只有目录选择器也算"能选"')
  assert.equal(pickSupported({ hostPaths: { pathFor: () => '/a' }, fileInput }), true, '只有文件选择也算"能选"')
  assert.equal(pickSupported({}), false, '两条都没有才叫不支持')
})

test('目录选择失败与"宿主不支持"是两句不同的话', async () => {
  // 能力在、这一次没打开：说"重试/反馈"，**不能**说"请更新宿主"（换宿主也修不好）。
  const broken = await pickDirectory({ pickDirectory: async () => { throw new Error('sandbox denied') } })
  assert.equal(broken.ok, false)
  assert.equal(broken.unsupported, false, '这是"打不开"，不是"不支持"')
  assert.match(broken.error, /打不开系统的选择窗口/)
  assert.equal(/更新宿主/.test(broken.error), false, '别把用户指到错的处置上')
  assert.equal(/sandbox|denied/i.test(broken.error), false, '不把底层错误端给用户')

  // 能力根本不在：才是设计 §4 那句固定的话。
  const absent = await pickDirectory(undefined)
  assert.equal(absent.unsupported, true)
  assert.equal(absent.error, zhCN.localAuditPickDirectoryUnsupported)

  // 文件选择的两条同理。
  const fileAbsent = await pickFile({}, [{ name: 'a.xlsx', webkitRelativePath: '', path: '' }])
  assert.equal(fileAbsent.unsupported, true)
  assert.match(fileAbsent.error, /绝对路径/)
  const fileBroken = await pickFile({ hostPaths: { pathFor: () => '/a' }, fileInput: async () => { throw new Error('x') } })
  assert.equal(fileBroken.unsupported, false)
  assert.match(fileBroken.error, /打不开系统的选择窗口/)
})

test('只有文件夹可用时，界面给「选择文件夹」+ 一句"改用文件夹"，而不是整块替换', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  // 只给目录选择器：`__DSH_HOST_PATHS__` 缺席（浏览器里就是这样）。
  const services = {
    uiWorkspace: { pickDirectory: async () => '/Users/someone/资料' },
    layout: undefined,
    sessions: undefined,
  }
  const saved = globalThis.__DSH_HOST_PATHS__
  delete globalThis.__DSH_HOST_PATHS__
  try {
    const tree = renderPane(LocalAuditPane, { services, controller })
    const text = textOf(tree).join(' ')
    // 用**按钮标签逐字比对**：卡片标题是「选择文件或文件夹」，子串匹配会把标题当成按钮。
    const labels = buttonLabelsOf(tree)
    assert.ok(labels.includes('选择文件夹'), `能用的那条必须还在（实际按钮：${labels.join('/')}）`)
    assert.equal(labels.includes('选择文件'), false, '拿不到绝对路径的那条不给按钮')
    assert.match(text, /改用「选择文件夹」/, '缺的那条要说清该改用哪条')
    assert.equal(text.includes(zhCN.localAuditPickUnsupported), false,
      '还有一条可用时，不许说"这个版本不支持本机文件选择"')
  } finally {
    if (saved !== undefined) globalThis.__DSH_HOST_PATHS__ = saved
  }
})

// ── 「页签下面那条横线」的结构判据（2026-10-11 用户实测反馈）──────────────────
//
// 根因是**双层 Workspace Surface**：外层纸包着页签，报告审核页自己又带一层框，
// 那圈 1px 描边正好落在页签正下方 —— 看起来就是"页签按钮下面有一条横线"。
// 修法是让嵌在页签内容块里的 surface **不再画框**（子页面只有一层纸，见 ui-design-guidelines §6.0）。
// 这里把这条约束钉在**样式表**上，因为修法本身就在样式里。

test('页签内容块：嵌在里面的第二层 surface 不画框（页签下面那条线的根因）', async () => {
  const { readFileSync } = await import('node:fs')
  const { WORKBENCH_CLASSES: C, WORKBENCH_STYLE_TEXT } = await import(
    new URL('src/client/features/workbench/consts.ts', ROOT).href
  )
  assert.equal(C.tabPanel, 'crwu-audit-tab-panel')

  // 两个 tabpanel 都要挂这个类 —— 少挂一个，那一侧就还会出现那条线。
  const panel = readFileSync(new URL('src/client/features/workbench/WorkbenchPanel.tsx', ROOT), 'utf8')
  assert.equal((panel.match(/className=\{C\.tabPanel\}/g) ?? []).length, 2, '两个 tabpanel 都要挂 C.tabPanel')

  const start = WORKBENCH_STYLE_TEXT.indexOf('.crwu-audit-tab-panel > .crwu-audit-surface')
  assert.ok(start >= 0, '缺「嵌在页签内容块里的 surface」这条规则')
  const block = WORKBENCH_STYLE_TEXT.slice(start, WORKBENCH_STYLE_TEXT.indexOf('}', start))
  for (const decl of ['border: 0', 'border-radius: 0', 'box-shadow: none']) {
    assert.ok(block.includes(decl), `嵌套 surface 要撤掉 ${decl}（否则页签下面会有一条线）`)
  }
  // 报告审核页自己的框**还在**（它单独渲染时要用），只是被这一层撤掉。
  assert.ok(/\.crwu-audit-surface\s*\{/.test(WORKBENCH_STYLE_TEXT), 'surface 本身的样式要保留')
})

// ── 样式表完整性 + 滚动条契约（两次踩过的坑，各一条）────────────────────────
//
// ① 样式表本身是**一个大模板字符串**：注释里出现一个反引号就会把它截断。
//    这个错误 typecheck **不一定**报（截断后剩下的仍是合法 JS 的场合），
//    表现是"样式莫名其妙少了一截"。所以用**尾部哨兵**钉住整串到底（2026-10-11 亲手踩了两次）。
// ② 滚动条：Chromium 里只要写了标准属性 scrollbar-width / scrollbar-color，
//    同一容器上的 ::-webkit-scrollbar 就整段失效 → 退回 macOS 的 overlay 滚动条（不滚不画），
//    用户看到的就是"滚动条没了"。无头实测 offsetWidth-clientWidth：带=0、去掉=10。

test('样式表完整性：模板字符串没被反引号截断（尾部哨兵必须在）', async () => {
  const { WORKBENCH_STYLE_TEXT } = await import(new URL('src/client/features/workbench/consts.ts', ROOT).href)
  assert.ok(WORKBENCH_STYLE_TEXT.length > 50_000, `样式表太短（${WORKBENCH_STYLE_TEXT.length}），可能被截断`)
  assert.match(WORKBENCH_STYLE_TEXT, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*$/,
    '末尾的 prefers-reduced-motion 段落不见了（模板字符串被反引号截断的典型症状）')
  // 截断的另一个症状：样式串里混进了反引号残留。
  assert.equal(WORKBENCH_STYLE_TEXT.includes('`'), false, '样式里混进了反引号')
})

test('滚动条：交给 ::-webkit-scrollbar 画（不写标准属性，否则那条规则整段失效）', async () => {
  const { WORKBENCH_STYLE_TEXT } = await import(new URL('src/client/features/workbench/consts.ts', ROOT).href)
  // 报告审核正文用自定义滚动条：一定要有 10px 的 webkit 规则。
  assert.match(WORKBENCH_STYLE_TEXT, /::-webkit-scrollbar \{ width: 10px; height: 10px; \}/)
  // 而那两个标准属性只允许**抽屉**那一处保留（它没有 webkit 规则、靠平台细条就够了）。
  // 一旦有人把它们写回报告审核正文那一组，webkit 规则就整段失效 —— 用户看到的是"滚动条没了"。
  for (const pattern of [/scrollbar-width:\s*thin/g, /scrollbar-color:\s*var\(/g]) {
    const hits = WORKBENCH_STYLE_TEXT.match(pattern) ?? []
    assert.ok(hits.length <= 1, `${String(pattern)} 只允许出现在抽屉那一处，实际 ${hits.length} 处`)
  }
  assert.equal(/\.crwu-audit-pane-main,\s*\n\.crwu-audit-table-wrap,\s*\n\.crwu-audit-body \{/.test(WORKBENCH_STYLE_TEXT),
    false, '报告审核正文那一组标准属性必须整块删掉（它会让 ::-webkit-scrollbar 失效）')
  // 预留滚动条槽位，避免出现/消失时正文横向跳动。
  assert.match(WORKBENCH_STYLE_TEXT, /\.crwu-audit-pane-main \{ scrollbar-gutter: stable; \}/)
})

// ── 客户端服务晚注册：能力必须"用时现读"，不能在 apply() 里快照 ────────────────
//
// 2026-10-11 用户实测：点「选择文件夹」得到「当前宿主不支持本机目录选择」，而 `uiWorkspace`
// 在页面上是好的。根因是 `portOf()` 里判一次就固化了 `port.pickDirectory`
// （本仓在 `sessions` / `uiWorkspace` 上踩过的同一个坑：快照下来就"永远不会再变"）。
// 这一组把"晚注册也要能用"钉死 —— 改回快照就会红。

test('目录选择：uiWorkspace 晚于状态机注册，也必须在点击时现读（不是 apply 时快照）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  // 建状态机时：客户端服务**还没注册**（复现 apply() 那一刻的激活顺序）。
  const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
  const controller = createLocalAuditPaneController(services)

  // 服务晚一步注册（真实的激活顺序：我们可能比 ui-workspace 先跑）。
  services.uiWorkspace = { pickDirectory: async () => '/Users/someone/资料' }
  const picked = await controller.pickDirectory()
  assert.deepEqual(picked.selected, ['/Users/someone/资料'],
    'uiWorkspace 晚注册也要能选到目录（改回"apply 时快照"这一条就会红）')
  assert.equal(picked.pickError, '')
})

test('会话：sessions 晚于状态机注册，也必须在建会话时现读（整条链路走完）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  // 三个 Host 操作走真实门面 → 这里把 fetch 换成替身（与 client-package 的 stubOps 同一套做法）。
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const { op, args } = JSON.parse(String(init?.body ?? '{}'))
    const payload = op === 'local-audit-status'
      ? { ok: true, error: '', errorKind: '', fileCount: 1, limit: 30, overLimit: false, readableCount: 1, skippedCount: 0, items: [{ path: args.selection[0], name: 'a.xlsx', kind: 'file', sizeBytes: 1, fileCount: 1, status: 'scanned', reason: '' }], skipped: [] }
      : op === 'local-audit-start'
        ? { ok: true, error: '', errorKind: '', handoffId: 'h-1', prompt: '固定提示词', providedCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000, workspacePath: '/Users/someone/中瑞世联工作空间', casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [] }
        : { ok: true }
    return { ok: true, json: async () => payload }
  }
  try {
    const calls = []
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const controller = createLocalAuditPaneController(services)
    // 服务**晚注册**：create / using / openSession 都在这之后才有。
    services.sessions = {
      create: async (input) => { calls.push(['create', input]); return 'session-1' },
      using: async (id, options, operation) => {
        calls.push(['using', id, options.source])
        await operation({ binding: { session: { rename: async () => ({}), prompt: async (content) => { calls.push(['prompt', content[0].text]) } } } })
      },
    }
    services.uiWorkspace = { pickDirectory: async () => '', openSession: (id) => { calls.push(['open', id]) } }

    controller.selectionChanged(['/Users/someone/资料/a.xlsx'])
    await controller.rescan()
    const result = await controller.start()
    assert.equal(result.ok, true, result.error)
    const kinds = calls.map((call) => call[0])
    assert.deepEqual(kinds, ['create', 'using', 'prompt', 'open'],
      `晚注册的 sessions 也要能完整走完（实际：${kinds.join('→')}）`)
    assert.equal(String(calls[0][1].cwd), '/Users/someone/中瑞世联工作空间',
      'cwd 必须是员工选定的工作空间（会话据此挂到那个工作空间下，沙箱边界罩住案例目录）')
    assert.equal(String(calls[2][1]), '固定提示词', '发给对话的是 Host 原样提示词')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── 旧宿主：绝不发空 cwd（2026-10-11 用户实测的 `mkdir ''`）────────────────────
//
// 症状：`创建审核对话失败：session create failed: … failed to ensure project directory "":
// ENOENT: no such file or directory, mkdir ''`。
// 根因：界面上加了跨进程字段 `workspacePath`，而宿主是旧构建（不回这个字段）——
// 客户端拿空串当 cwd 发了出去。协议号（29）现在会先拦住这种情况，这一条是第二道闸：
// **空工作空间路径一律不许发请求**，并给出唯一正确的处置（重启 profile）。

test('工作空间 id 与路径都为空时绝不发 create（旧宿主 / 字段缺失）', async () => {
  const calls = []
  const result = await createLocalAuditSession({
    port: {
      create: async (input) => { calls.push(input); return 's-1' },
      using: async () => { calls.push('using') },
    },
    handoffId: 'h-1',
    prompt: 'p',
    workspaceId: '  ',
    workspacePath: '   ',
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'session')
  assert.deepEqual(calls, [], '空 cwd 一个请求都不许发（发出去就是那句看不懂的 mkdir \'\'）')
  assert.match(result.error, /完全退出并重新打开 DeepSeek Harness/)
  assert.equal(result.error.includes('mkdir'), false, '不把底层报错端给用户')
})

test('宿主是旧构建时：主按钮禁用 + 说明「重启 profile」，且不发任何请求', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => { seen.push(JSON.parse(String(init?.body ?? '{}')).op); return { ok: true, json: async () => ({ ok: true }) } }
  try {
    const { port } = fakePort()
    const controller = createLocalAuditController({ port })
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const tree = renderPane(LocalAuditPane, { services, controller, hostStale: true })
    const text = textOf(tree).join(' ')
    assert.match(text, /完全退出并重新打开 DeepSeek Harness/)
    const primary = findByClass(tree, WORKBENCH_CLASSES_LOCAL.btnPrimary)
    assert.ok(primary, '主按钮还在（只是禁用）')
    assert.equal(primary.props['aria-disabled'] ?? primary.props.disabled, true, '旧宿主下主按钮必须禁用')
    // 渲染本身不该发任何请求（快照/扫描都不该发生）。
    assert.deepEqual(seen, [])
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── 会话 cwd 用"界面已经显示的工作区"（用户 2026-10-11 的指出）─────────────────
//
// 用户原话：「我插件的【环境信息】中不是已经规定了工作区吗」。对：面板本来就有
// `env.workspace.path`，把它传给状态机就够了 —— 不必要求宿主在 `local-audit-start` 里
// 新回一个字段（那个新字段在"界面新、宿主旧"时是空的，会发出空 cwd）。

test('界面把 workspaceId 一路带到建会话（挂到环境信息里那个工作区下）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const created = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const { op } = JSON.parse(String(init?.body ?? '{}'))
    const payload = op === 'local-audit-status'
      ? { ok: true, error: '', errorKind: '', fileCount: 1, limit: 30, overLimit: false, readableCount: 1, skippedCount: 0, items: [{ path: 'a.xlsx', name: 'a.xlsx', kind: 'file', sizeBytes: 1, fileCount: 1, status: 'scanned', reason: '' }], files: [], skipped: [] }
      : op === 'local-audit-start'
        ? { ok: true, error: '', errorKind: '', handoffId: 'h-1', prompt: 'p', providedCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000, workspacePath: '/Users/someone/中瑞世联工作空间', casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [] }
        : { ok: true }
    return { ok: true, json: async () => payload }
  }
  try {
    const { port } = fakePort({
      sessions: {
        create: async (input) => { created.push(input); return 's-1' },
        using: async (id, options, operation) => { await operation({ binding: { session: { rename: async () => ({}), prompt: async () => ({}) } } }) },
      },
    })
    const controller = createLocalAuditController({ port })
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const tree = renderPane(LocalAuditPane, {
      services,
      controller,
      workspacePath: '/Users/someone/中瑞世联工作空间',
      workspaceId: 'ws-42',
    })
    // 页面照常渲染出主按钮（这条只关心"传下去的东西"）。
    assert.ok(findByClass(tree, WORKBENCH_CLASSES_LOCAL.btnPrimary), '主按钮在')
    controller.selectionChanged(['a.xlsx'])
    await controller.rescan()
    const result = await controller.start({
      workspacePath: '/Users/someone/中瑞世联工作空间',
      workspaceId: 'ws-42',
    })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(created, [{ workspaceId: 'ws-42' }],
      '界面传下来的 workspaceId 必须原样用上（DSH 就是这么把会话挂到工作区下的）')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('宿主没回 workspacePath 时，用界面显示的工作区建会话（不发空 cwd）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  const created = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const { op } = JSON.parse(String(init?.body ?? '{}'))
    const payload = op === 'local-audit-status'
      ? { ok: true, error: '', errorKind: '', fileCount: 1, limit: 30, overLimit: false, readableCount: 1, skippedCount: 0, items: [{ path: 'a.xlsx', name: 'a.xlsx', kind: 'file', sizeBytes: 1, fileCount: 1, status: 'scanned', reason: '' }], skipped: [] }
      // 关键：**旧宿主**的应答没有 workspacePath（新字段）—— 案例目录也照旧回。
      : op === 'local-audit-start'
        ? { ok: true, error: '', errorKind: '', handoffId: 'h-1', prompt: '固定提示词', providedCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000, casePath: '/Users/someone/中瑞世联工作空间/本地审核/h-1', files: [], skipped: [] }
        : { ok: true }
    return { ok: true, json: async () => payload }
  }
  try {
    const services = {
      uiWorkspace: { openSession: () => {} },
      layout: undefined,
      sessions: {
        create: async (input) => { created.push(input); return 's-1' },
        using: async (id, options, operation) => { await operation({ binding: { session: { rename: async () => ({}), prompt: async () => ({}) } } }) },
      },
    }
    const controller = createLocalAuditPaneController(services)
    controller.selectionChanged(['a.xlsx'])
    await controller.rescan()
    const result = await controller.start({ workspacePath: '/Users/someone/中瑞世联工作空间' })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(created, [{ cwd: '/Users/someone/中瑞世联工作空间' }],
      'cwd 用界面显示的工作区，绝不发空串')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('两个来源不一致：拒绝并让人重新准备（不赌案例目录落在哪）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  const created = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const { op } = JSON.parse(String(init?.body ?? '{}'))
    const payload = op === 'local-audit-status'
      ? { ok: true, error: '', errorKind: '', fileCount: 1, limit: 30, overLimit: false, readableCount: 1, skippedCount: 0, items: [{ path: 'a.xlsx', name: 'a.xlsx', kind: 'file', sizeBytes: 1, fileCount: 1, status: 'scanned', reason: '' }], skipped: [] }
      : op === 'local-audit-start'
        ? { ok: true, error: '', errorKind: '', handoffId: 'h-1', prompt: 'p', providedCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000, workspacePath: '/Users/someone/旧工作空间', casePath: '/Users/someone/旧工作空间/本地审核/h-1', files: [], skipped: [] }
        : { ok: true }
    return { ok: true, json: async () => payload }
  }
  try {
    const services = { uiWorkspace: undefined, layout: undefined, sessions: { create: async (i) => { created.push(i); return 's-1' } } }
    const controller = createLocalAuditPaneController(services)
    controller.selectionChanged(['a.xlsx'])
    await controller.rescan()
    const result = await controller.start({ workspacePath: '/Users/someone/新工作空间' })
    assert.equal(result.ok, false)
    assert.match(result.error, /工作空间在准备文件之后变了/)
    assert.deepEqual(created, [], '不一致时一个会话都不建')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── 扫描后展开到文件级 + 逐个移除（用户 2026-10-11 口径）──────────────────────
//
// 「审核文件在扫描后应该完整展示文件名称，右侧有个 X 的 icon，表示移除该文件」。
// 两条语义必须分开：入口行上的 X = 不审这个入口；文件行上的 X = 只不审这个文件，
// 而且要**记进排除清单**（否则重新扫描后它自己长回来）。

test('界面：文件夹展开成文件行，每行右侧一枚 X（可访问名说出具体文件）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditSelectionList } = await import(
    new URL('src/client/features/local-audit/LocalAuditSelectionList.tsx', ROOT).href
  )
  const { LOCAL_AUDIT_CLASSES: L } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const items = [itemOf('资料', { path: '/Users/someone/资料', kind: 'directory', fileCount: 2, sizeBytes: 0 })]
  const files = [
    { parentPath: '/Users/someone/资料', path: '/Users/someone/资料/资产清单.xlsx', name: '资产清单.xlsx', relativePath: '资产清单.xlsx', sizeBytes: 2048 },
    { parentPath: '/Users/someone/资料', path: '/Users/someone/资料/子目录/一份名字很长的评估说明文件.pdf', name: '一份名字很长的评估说明文件.pdf', relativePath: '子目录/一份名字很长的评估说明文件.pdf', sizeBytes: 4096 },
  ]
  const removed = []
  const tree = renderPane(LocalAuditSelectionList, {
    items, files, fileCount: 2, limit: 30, overLimit: false, skippedCount: 0, skipped: [],
    onRemove: (path) => { removed.push(path) },
  })
  // 完整文件名逐行在屏幕上（不截断）。
  const text = textOf(tree).join(' ')
  for (const file of files) assert.ok(text.includes(file.name), `要显示完整文件名：${file.name}`)
  // 文件夹行 + 两个文件行 = 两枚以上的 X。
  const removeButtons = []
  collectByClass(tree, L.rowRemove, removeButtons)
  assert.equal(removeButtons.length, 3, '文件夹一行 + 两个文件行，各一枚 X')
  const labels = removeButtons.map((node) => node.props['aria-label'])
  assert.ok(labels.includes('移除 资产清单.xlsx'), `文件行的 X 要说清是哪一个：${labels.join(' / ')}`)
  assert.ok(labels.includes('移除 一份名字很长的评估说明文件.pdf'))
  assert.ok(labels.includes('移除 资料'), '文件夹行也保留 X（移除整个入口）')
  // 点文件行的 X → 回调拿到的必须是那个**文件**的绝对路径（不是文件夹）。
  removeButtons.find((node) => node.props['aria-label'] === '移除 资产清单.xlsx').props.onClick()
  assert.deepEqual(removed, ['/Users/someone/资料/资产清单.xlsx'])
})

test('状态机：目录选择器回的尾斜杠路径也能被移除（"移除文件夹移不掉"的回归）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    ok: true, error: '', errorKind: '', fileCount: 0, limit: 30, overLimit: false, readableCount: 0, skippedCount: 0,
    // Host 回的 item.path 是**去掉过尾斜杠**的（macOS 的 choose folder 回的是带斜杠的）。
    items: [{ path: '/Users/someone/资料', name: '资料', kind: 'directory', sizeBytes: 0, fileCount: 0, status: 'scanned', reason: '' }],
    files: [], skipped: [],
  }) })
  try {
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const controller = createLocalAuditPaneController(services)
    // 选择器回的是带尾斜杠的拼法。
    controller.selectionChanged(['/Users/someone/资料/'])
    assert.deepEqual(controller.state().selected, ['/Users/someone/资料'], '选择项要归一掉尾部分隔符')
    controller.remove('/Users/someone/资料')
    assert.deepEqual(controller.state().selected, [], '点 X 必须真的移掉这个文件夹')
    assert.deepEqual(controller.state().excluded, [], '入口不许被当成"入口里的文件"塞进排除清单')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('界面：辅助操作里没有「重新扫描」（移除即重扫）', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  const services = { uiWorkspace: { pickDirectory: async () => undefined }, layout: undefined, sessions: undefined }
  const tree = renderPane(LocalAuditPane, { services, controller })
  const labels = buttonLabelsOf(tree)
  assert.equal(labels.includes('重新扫描'), false, '「重新扫描」不该再出现')
  assert.ok(labels.includes('清空选择'), '「清空选择」保留')
})

test('状态机：文件行进排除清单（入口行移整个入口），两者都不许互相污染', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  const realFetch = globalThis.fetch
  const ops = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    ops.push(body)
    const payload = body.op === 'local-audit-status'
      ? { ok: true, error: '', errorKind: '', fileCount: 1, limit: 30, overLimit: false, readableCount: 1, skippedCount: 0,
          items: [{ path: '/Users/someone/资料', name: '资料', kind: 'directory', sizeBytes: 0, fileCount: 1, status: 'scanned', reason: '' }],
          files: [{ parentPath: '/Users/someone/资料', path: '/Users/someone/资料/表.xlsx', name: '表.xlsx', relativePath: '表.xlsx', sizeBytes: 1 }],
          skipped: [] }
      : { ok: true }
    return { ok: true, json: async () => payload }
  }
  try {
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const controller = createLocalAuditPaneController(services)
    controller.selectionChanged(['/Users/someone/资料'])
    await controller.rescan()
    assert.deepEqual(controller.state().files.map((file) => file.path), ['/Users/someone/资料/表.xlsx'])

    // 文件行上的 X：只排除这个文件，入口还在。
    controller.remove('/Users/someone/资料/表.xlsx')
    assert.deepEqual(controller.state().excluded, ['/Users/someone/资料/表.xlsx'])
    assert.deepEqual(controller.state().selected, ['/Users/someone/资料'], '入口不许被顺带移除')
    await controller.rescan()
    assert.deepEqual(ops.at(-1), { op: 'local-audit-status', args: { selection: ['/Users/someone/资料'], excluded: ['/Users/someone/资料/表.xlsx'] } },
      '重扫必须把排除清单带上（否则被移除的文件会自己长回来）')

    // 入口行上的 X：从选择里去掉，并顺手清掉它下面的排除项。
    controller.remove('/Users/someone/资料')
    assert.deepEqual(controller.state().selected, [])
    assert.deepEqual(controller.state().excluded, [])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('状态机：换了选择就丢掉不属于任何入口的排除项', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { createLocalAuditPaneController } = await import(
    new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href
  )
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, error: '', errorKind: '', fileCount: 0, limit: 30, overLimit: false, readableCount: 0, skippedCount: 0, items: [], files: [], skipped: [] }) })
  try {
    const services = { uiWorkspace: undefined, layout: undefined, sessions: undefined }
    const controller = createLocalAuditPaneController(services)
    controller.selectionChanged(['/Users/someone/资料'])
    controller.remove('/Users/someone/资料/表.xlsx')
    assert.deepEqual(controller.state().excluded, ['/Users/someone/资料/表.xlsx'])
    // 换成另一个目录：原来那条排除项已经不在任何入口之内，必须丢掉。
    controller.selectionChanged(['/Users/someone/别的目录'])
    assert.deepEqual(controller.state().excluded, [])
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── UI 重构（2026-10-11）：扫描态、折叠、唯一主按钮、双栏 ──────────────────────
//
// 这一组钉"用户能不能判断现在发生了什么、下一步能做什么"：
// ① 扫描中不许显示空态（会让人以为自己没选上）；
// ② 跳过原因默认收起、要能展开（`<details>`，键盘与读屏语义自带）；
// ③ 整页只有一枚 primary（底部「开始本地审核」），选择按钮与卡片动作都是次级；
// ④ 桌面双栏：左=选择/已选择，右=提示词与交接；
// ⑤ 主按钮的"为什么不能点"要能被读屏关联到（`aria-describedby`）。

test('界面：扫描中显示骨架与状态，而不是"还没有选择文件"', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditSelectionList } = await import(
    new URL('src/client/features/local-audit/LocalAuditSelectionList.tsx', ROOT).href
  )
  const { LOCAL_AUDIT_CLASSES: L } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const tree = renderPane(LocalAuditSelectionList, {
    items: [], files: [], fileCount: 0, limit: 30, overLimit: false, skippedCount: 0, skipped: [],
    scanning: true, onRemove: () => {},
  })
  const text = textOf(tree).join(' ')
  assert.equal(text.includes(zhCN.localAuditEmptyTitle), false, '扫描中不许显示空态')
  assert.match(text, /正在统计文件数量/)
  assert.ok(findByClass(tree, L.skeleton), '要有骨架')
  const status = findByClass(tree, L.skeleton)
  assert.equal(status.props.role, 'status', '骨架要能被读屏播报')
})

test('界面：跳过原因收在 details 里，展开后才逐条列原因', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditSelectionList } = await import(
    new URL('src/client/features/local-audit/LocalAuditSelectionList.tsx', ROOT).href
  )
  const { LOCAL_AUDIT_CLASSES: L } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const tree = renderPane(LocalAuditSelectionList, {
    items: [itemOf('a.xlsx')], files: [], fileCount: 1, limit: 30, overLimit: false,
    skippedCount: 1, skipped: [{ relativePath: '坏.zip', name: '坏.zip', reason: '快照读取失败' }],
    onRemove: () => {},
  })
  const details = findByClass(tree, L.skippedDetails)
  assert.ok(details, '跳过项要用 details 包起来')
  assert.ok(findByClass(details, L.skippedSummary), 'summary 上要有数量与"查看原因"')
  assert.match(textOf(details).join(' '), /查看原因/)
  assert.match(textOf(details).join(' '), /坏\.zip.*快照读取失败/)
})

test('界面：整页只有一枚 primary（底部开始按钮），选择与卡片动作都是次级', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  const services = { uiWorkspace: { pickDirectory: async () => undefined }, layout: undefined, sessions: undefined }
  const tree = renderPane(LocalAuditPane, { services, controller })
  const primary = collectByClass(tree, WORKBENCH_CLASSES_LOCAL.btnPrimary, [])
  assert.equal(primary.length, 1, `整页只允许一枚主按钮，实际 ${primary.length} 枚`)
  assert.equal(primary[0].props.children, zhCN.localAuditNeedFilesButton, '主按钮是底部那枚（空态下显示"请选择文件后开始"）')
  // 选择按钮仍是次级（能点，只是不抢主操作的视觉）。
  // 这个替身只给了目录选择能力（`__DSH_HOST_PATHS__` 在测试环境里不存在 = 文件能力缺席），
  // 所以这里断言的是「选择文件夹」那一枚。
  const labels = buttonLabelsOf(tree)
  assert.ok(labels.includes(zhCN.localAuditSelectDirectory), `要保留可用的选择按钮：${labels.join(' / ')}`)
})

test('界面：桌面双栏结构（左选择/已选择，右提示词与交接），主导航仍在一条 tablist 里', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const { LOCAL_AUDIT_CLASSES: L } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  const services = { uiWorkspace: { pickDirectory: async () => undefined }, layout: undefined, sessions: undefined }
  const tree = renderPane(LocalAuditPane, { services, controller })
  const columns = findByClass(tree, L.columns)
  assert.ok(columns, '要有双栏容器')
  const inner = collectByClass(columns, L.column, [])
  assert.equal(inner.length, 2, '两栏')
  // 左栏是已选择内容，右栏是提示词（DOM 顺序 = 阅读顺序）。
  assert.match(String(textOf(inner[0])), /已选择内容/)
  assert.match(String(textOf(inner[1])), /补充提示词/)
})

test('界面：主按钮用 aria-describedby 关联旁边那句可见原因', async () => {
  const { registerTsxLoader } = await import('../helpers/tsx-loader.mjs')
  registerTsxLoader()
  const { LocalAuditPane } = await import(new URL('src/client/features/local-audit/LocalAuditPane.tsx', ROOT).href)
  const { LOCAL_AUDIT_CLASSES: L } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const { port } = fakePort()
  const controller = createLocalAuditController({ port })
  controller.setState({ selected: [], fileCount: 0 })
  const services = { uiWorkspace: { pickDirectory: async () => undefined }, layout: undefined, sessions: undefined }
  const tree = renderPane(LocalAuditPane, { services, controller })
  const primary = collectByClass(tree, WORKBENCH_CLASSES_LOCAL.btnPrimary, [])[0]
  const describedBy = primary.props['aria-describedby']
  assert.ok(typeof describedBy === 'string' && describedBy !== '', '主按钮要指向原因文字')
  const reason = findByClass(tree, L.actionReason)
  assert.ok(reason, '原因文字要在按钮旁边')
  assert.equal(reason.props.id, describedBy, 'id 要对得上')
})

test('样式契约：页签 44px + 底部强调线；移除按钮命中区外扩；骨架在 reduced-motion 下不动', async () => {
  const { LOCAL_AUDIT_STYLE_TEXT } = await import(
    new URL('src/client/features/local-audit/consts.ts', ROOT).href
  )
  const text = LOCAL_AUDIT_STYLE_TEXT
  // 页签：44px 命中高度 + 选中项用品牌色画 3px 底部强调线（形状 + 颜色双重表达）。
  assert.match(text, /\.crwu-audit-tab \{[\s\S]*?height: 44px/)
  assert.match(text, /\.crwu-audit-tab::after \{[\s\S]*?height: 3px/)
  assert.match(text, /\.crwu-audit-tab-on::after \{ background: var\(--crwu-brand\); \}/)
  // 移除按钮：视觉 28px、命中区靠 ::after 外扩 8px（触屏也点得到）。
  assert.match(text, /\.crwu-audit-local-row-remove::after \{ content: ''; position: absolute; inset: -8px; \}/)
  // 骨架呼吸在 reduced-motion 下关掉。
  assert.match(text, /prefers-reduced-motion[\s\S]*\.crwu-audit-local-skeleton-line \{ animation: none; \}/)
})

// ── 「切到报告审核时下面一大片空白」的根因（2026-10-11 用户实测）────────────────
//
// 两个 tabpanel 现在**常驻**（非选中者是 hidden 空壳），而 `.crwu-audit-tab-panel` 上写了
// `display: flex` —— 作者样式优先于 UA 样式表对 `[hidden]` 的 `display: none`，于是那个空壳
// 照样参与布局。无头实测（900px 视口）：空壳占 **320px 高**，报告页只剩 484px。
// 这条把它钉在样式表上（替身渲染器算不了布局，判据只能落在 CSS 上）。

test('样式契约：hidden 的 tabpanel 必须真的不占位', async () => {
  const { WORKBENCH_STYLE_TEXT } = await import(
    new URL('src/client/features/workbench/consts.ts', ROOT).href
  )
  assert.match(WORKBENCH_STYLE_TEXT, /\.crwu-audit-tab-panel\[hidden\] \{ display: none; \}/,
    'hidden 的空壳必须 display:none —— 缺这一条就会在页签下面留一大片空白')
  // 而且它必须排在那条 `display: flex` 之后（同优先级后者胜）。
  const panel = WORKBENCH_STYLE_TEXT.indexOf('.crwu-audit-tab-panel {')
  const hidden = WORKBENCH_STYLE_TEXT.indexOf('.crwu-audit-tab-panel[hidden]')
  assert.ok(panel >= 0 && hidden > panel, '隐藏规则要写在基础规则之后')
  // 两个 tabpanel 都要挂这个类（少一个，另一侧就还是会占位）。
  const { readFileSync } = await import('node:fs')
  const jsx = readFileSync(new URL('src/client/features/workbench/WorkbenchPanel.tsx', ROOT), 'utf8')
  assert.equal((jsx.match(/className=\{C\.tabPanel\}/g) ?? []).length, 2, '两个 tabpanel 都要挂 C.tabPanel')
  assert.equal((jsx.match(/hidden=\{auditTab !== '/g) ?? []).length, 2, '两个 tabpanel 都要按选中态 hidden')
})
