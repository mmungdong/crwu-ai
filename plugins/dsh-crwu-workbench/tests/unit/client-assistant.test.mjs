/**
 * 「与 DeepSeek 讨论这份报告」的纯逻辑测试。
 *
 * 用户 2026-09-22 定稿的形态：**不做右侧自绘对话框**（"只会增加负担"）。点操作列那枚小鲸鱼时：
 * 先用 crwu 拉这份报告的全部文件元数据（只列举、不下载），
 * 有绑定会话 → 气泡问「新建对话 / 继续上次聊天」；没有 → 直接建新会话并跳过去。
 *
 * 所以这份测试盯三件事：
 * 1. 会话名（多会话的前缀匹配 + 序号命名）—— 找错人就会"继续"到别的报告的对话；
 * 2. 注入给 AI 的上下文（角色 + 职责 + 报告事实 + crwu 拉到的文件清单）；
 * 3. 会话接线（复用 / 新建 / forceNew / 没工作空间 / 服务缺席 / 发问形状）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { discussionBrief, discussionPrompt, discussionTitle, findDiscussions, nextOrdinal } = await import(
  new URL('src/client/features/report-audit/assistant-context.ts', ROOT).href
)
const { askDiscussion, ensureDiscussion } = await import(
  new URL('src/client/features/report-audit/assistant-session.ts', ROOT).href
)

const FACTS = {
  seqNo: '2026-302441-LX9967-BG8790',
  objectId: '5f6924e2-f722-4477-9d34-d52aa855a1ad',
  project: '华润万家有限公司拟处置房地产项目',
  name: '2026-302441-LX9967-BG8790',
  risk: 'B',
  reviewLevel: '初审',
  reviewState: '审核中',
  currentNode: '一级复核人',
  modifiedAt: '2026-09-22 18:15:08',
  formName: '报告审核',
  // **远端-only**：不许出现本地案例目录的文件名或路径（用户 2026-09-23 强制口径）。
  files: ['氚云附件 V2定稿-估值报告.zip（75.1 MB）', '云端交付件 审核意见.S.html'],
  fetchedAt: '2026-09-23T10:00:00.000Z',
  sources: ['h3yun · f1 · V2定稿-估值报告.zip', 'oss · crwu/audit/S/审核意见.S.html · digest 4850d73d2a28ca5a'],
}

// ── 1. 会话名：多会话的前缀匹配 ──────────────────────────────────────────────

test('会话名以流水号为前缀：第一条不带序号，之后依次 #2 #3', () => {
  assert.equal(discussionTitle('X-1'), `${zhCN.aiSessionPrefix}X-1`)
  assert.equal(discussionTitle('X-1', 1), `${zhCN.aiSessionPrefix}X-1`)
  assert.equal(discussionTitle('X-1', 2), `${zhCN.aiSessionPrefix}X-1 #2`)
})

test('找回这份报告的全部讨论：前缀匹配，别的报告与别的会话都不算', () => {
  const sessions = [
    { id: 's1', displayTitle: `${zhCN.aiSessionPrefix}X-1` },
    { id: 's2', displayTitle: `${zhCN.aiSessionPrefix}X-1 #2` },
    { id: 's3', displayTitle: `${zhCN.aiSessionPrefix}X-10` },
    { id: 's4', displayTitle: '随便聊聊' },
    { id: 's5', title: `${zhCN.aiSessionPrefix}X-1 #3` },
  ]
  assert.deepEqual(findDiscussions(sessions, 'X-1').map((row) => row.id), ['s1', 's2', 's5'])
  // `X-1` 不能把 `X-10` 也算进来（前缀后面必须就是分隔符或结尾）。
  assert.equal(findDiscussions(sessions, 'X-10').map((row) => row.id).includes('s1'), false)
  assert.equal(nextOrdinal(sessions, 'X-1'), 4, '已有 3 条就建第 4 条')
  assert.equal(nextOrdinal([], 'X-1'), 1)
})

// ── 2. 注入的上下文 ──────────────────────────────────────────────────────────

test('上下文：角色 + 职责 + 报告事实，缺项不写、文件为空要说明', () => {
  const brief = discussionBrief(FACTS)
  // 注入的是用户 2026-09-22 定稿的**专业版协作 Prompt**（逐字），不再是旧的两句角色/职责。
  assert.ok(brief.includes('你是一名资深资产评估师'), '要有专业版 Prompt 的开头')
  assert.ok(brief.includes('共同发现问题') && brief.includes('核验问题'), 'Prompt 正文要完整注入')
  assert.ok(brief.includes(FACTS.seqNo) && brief.includes(FACTS.project))
  assert.ok(brief.includes('B') && brief.includes('一级复核人'))
  for (const file of FACTS.files) assert.ok(brief.includes(file), `文件清单要带上 ${file}`)

  const thin = discussionBrief({ ...FACTS, project: '', name: '', currentNode: '', files: [] })
  assert.equal(thin.includes(zhCN.aiFactNode), false, '空字段不该占一行')
  assert.equal(thin.includes(zhCN.aiFactProject), false, '项目名与 name 都空时也不写行')
  assert.ok(thin.includes(zhCN.aiFactFilesNone), '一个文件都没有时要说明，而不是给空清单')
})

test('首轮提问 = 上下文 + 开场问题；后续轮次只发问题；空问题不发', () => {
  const first = discussionPrompt(FACTS, zhCN.aiKickoff, true)
  assert.ok(first.includes('你是一名资深资产评估师') && first.endsWith(zhCN.aiKickoff))
  assert.equal(discussionPrompt(FACTS, '再补充一点', false), '再补充一点')
  assert.equal(discussionPrompt(FACTS, '   ', true), '')
})

// ── 3. 会话接线（假 port） ───────────────────────────────────────────────────

function fakePort(options = {}) {
  const calls = { create: [], rename: [], open: [], prompt: [] }
  const bindings = new Map()
  const make = () => ({
    session: {
      rename: async (title) => { calls.rename.push(title) },
      prompt: async (content, mode) => { calls.prompt.push({ content, mode }) },
    },
  })
  const port = {
    create: async (input) => {
      calls.create.push(input)
      if (options.createFails === true) throw new Error('宿主拒绝')
      bindings.set('session-new', make())
      return 'session-new'
    },
    open: (id) => { calls.open.push(id) },
    binding: (id) => bindings.get(id),
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
  }
  if (options.existing !== undefined) bindings.set(options.existing, make())
  return { port, calls }
}

const BASE = { seqNo: FACTS.seqNo, workspaceId: 'ws-1', workspacePath: '/Users/me/中瑞世联工作空间' }

test('已经有讨论会话就复用（不新建、只 open）', async () => {
  const { port, calls } = fakePort({ existing: 'session-old' })
  const sessions = [{ id: 'session-old', displayTitle: discussionTitle(FACTS.seqNo) }]
  assert.deepEqual(
    await ensureDiscussion({ port, sessions, ...BASE }),
    { ok: true, id: 'session-old', created: false },
  )
  assert.deepEqual(calls.create, [], '复用时不许再建一条')
  assert.deepEqual(calls.open, ['session-old'])
})

test('forceNew（气泡里选「新建对话」）：有旧的也新建，并命名成下一条序号', async () => {
  const { port, calls } = fakePort()
  const sessions = [
    { id: 'a', displayTitle: discussionTitle(FACTS.seqNo) },
    { id: 'b', displayTitle: discussionTitle(FACTS.seqNo, 2) },
  ]
  const result = await ensureDiscussion({ port, sessions, ...BASE, forceNew: true })
  assert.deepEqual(result, { ok: true, id: 'session-new', created: true })
  assert.deepEqual(calls.rename, [discussionTitle(FACTS.seqNo, 3)], '已是第 2 条，新建就是第 3 条')
})

test('没有讨论会话就新建：建在工作空间下、按流水号命名、并设为当前会话', async () => {
  const { port, calls } = fakePort()
  const result = await ensureDiscussion({ port, sessions: [], ...BASE })
  assert.deepEqual(result, { ok: true, id: 'session-new', created: true })
  assert.deepEqual(calls.create, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(calls.rename, [discussionTitle(FACTS.seqNo)])
  assert.deepEqual(calls.open, ['session-new'])
})

test('没有工作空间不新建；只有路径时退化用 cwd', async () => {
  const { port, calls } = fakePort()
  const missing = await ensureDiscussion({
    port, sessions: [], seqNo: FACTS.seqNo, workspaceId: '', workspacePath: '',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, zhCN.aiNoWorkspace)
  assert.deepEqual(calls.create, [])
  const byCwd = await ensureDiscussion({
    port, sessions: [], seqNo: FACTS.seqNo, workspaceId: '', workspacePath: '/tmp/ws',
  })
  assert.equal(byCwd.ok, true)
  assert.deepEqual(calls.create, [{ cwd: '/tmp/ws' }])
})

test('建会话失败、服务缺席：都要说得出原因，不抛到界面上', async () => {
  const failed = await ensureDiscussion({ port: fakePort({ createFails: true }).port, sessions: [], ...BASE })
  assert.equal(failed.ok, false)
  assert.ok(failed.error.startsWith(zhCN.aiCreateFailed) && failed.error.includes('宿主拒绝'))
  assert.deepEqual(await ensureDiscussion({ port: undefined, sessions: [], ...BASE }), {
    ok: false, error: zhCN.aiUnsupported,
  })
  assert.deepEqual(await ensureDiscussion({ port: {}, sessions: [], ...BASE }), {
    ok: false, error: zhCN.aiUnsupported,
  })
})

test('发问：文本块 + queue 模式；空提问不发；port 缺席不炸', async () => {
  const { port, calls } = fakePort({ existing: 'session-old' })
  assert.equal(await askDiscussion(port, 'session-old', '要发出去的话'), '')
  assert.deepEqual(calls.prompt, [{ content: [{ type: 'text', text: '要发出去的话' }], mode: 'queue' }])
  assert.equal(await askDiscussion(port, 'session-old', ''), '')
  assert.equal(calls.prompt.length, 1, '空提问不该真的发一次')
  assert.equal(await askDiscussion(undefined, 'session-old', '你好'), zhCN.aiUnsupported)
})
