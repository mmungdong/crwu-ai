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
const { caseDirOf } = await import(new URL('src/shared/utils/case-dir.ts', ROOT).href)
const { auditPrompt } = await import(new URL('src/host/audit/prompt.ts', ROOT).href)

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

/**
 * **忠实**的客户端 `sessions` 服务替身。
 *
 * 2026-09-25 的教训：上一版的假 port 用 `bindings.set(id, face)` 把**每条**会话都预置了 binding，
 * 比真实服务宽容 —— 真实实现（DSH `ClientSessions`）是：
 *
 * - `binding(id)` = `this.scopes.get(id)?.binding`：**只有被 retain 过的会话**才有值；
 * - `create()` 只登记清单，**不 retain** → 刚建出来的会话 `binding(id)` 是 `undefined`；
 * - `using(id, {source}, op)` = `retain` + 等 `ready` + 跑 `op(reference)` + `release`，
 *   是唯一对「刚建出来的会话」也成立的取 face 路径；
 * - 上面**没有** `open()`；切会话是 `uiWorkspace.openSession(id)`。
 *
 * 替身宽容 = 缺陷漏过门禁。所以这里把四件事都按真实语义建模，包括一个「诱饵 open」：
 * 谁要是回去写 `sessions.open(...)`，用例会红。
 */
class FakeSessions {
  constructor(options = {}) {
    this.calls = { create: [], using: [], rename: [], prompt: [], decoyOpen: [] }
    // `known` = 会话控制器认识的 id（清单里的 + 刚 create 的）；`scopes` = **当前被 retain** 的。
    this.known = new Set()
    this.scopes = new Map()
    this.options = options
    if (options.existing !== undefined) this.known.add(options.existing)
    this.list = { getSnapshot: () => ({ ids: [...this.known], byId: {}, phase: 'ready' }) }
  }
  create(input = {}) {
    this.calls.create.push(input)
    if (this.options.createFails === true) return Promise.reject(new Error('宿主拒绝'))
    // 真实实现：create 只登记清单/摘要，**不** retain —— 所以紧接着 `binding(id)` 是 undefined。
    this.known.add('session-new')
    return Promise.resolve('session-new')
  }
  /** 只有**当前被 retain** 的 id 才有 binding —— 真实实现就是这个语义。 */
  binding(id) { return this.scopes.get(id) }
  /** retain → 跑 op(reference) → release。已知的 id 都能 retain（真实实现会 materializeScope）。 */
  async using(id, options, operation) {
    this.calls.using.push({ id, source: options?.source })
    if (!this.known.has(id)) throw new Error(`Session reference "${id}" is released`)
    this.scopes.set(id, this.face(id))
    try {
      return await operation({ binding: this.scopes.get(id) })
    } finally {
      this.scopes.delete(id)
    }
  }
  /** 诱饵：真实服务上不存在这个方法。 */
  open(id) { this.calls.decoyOpen.push(id) }
  face(id) {
    const calls = this.calls
    return {
      session: {
        rename: async (title) => {
          if (this.options.renameFails === true) throw new Error('改名被拒绝')
          calls.rename.push({ id, title })
        },
        prompt: async (content, mode) => {
          if (this.options.promptFails === true) throw new Error('发送被拒绝')
          calls.prompt.push({ id, content, mode })
        },
      },
    }
  }
}

/** 真实的「切会话」入口：uiWorkspace.openSession。 */
function fakeUiWorkspace() {
  const opened = []
  return { opened, service: { openSession: (id) => { opened.push(id) } } }
}

/**
 * 把会话服务适配成 port —— 与 `src/client/features/workbench/services.ts` 的 `discussionPortOf` 同形：
 * **只转发真实存在的四个动词**。「跳到会话」不在这里（由面板的 `onOpenDiscussion` 负责）。
 */
function portOf(sessions) {
  const port = {}
  if (sessions === undefined) return port
  port.create = (input) => sessions.create(input)
  port.using = (id, options, operation) => sessions.using(id, options, operation)
  port.binding = (id) => sessions.binding(id)
  port.list = sessions.list
  return port
}

/** 只提供 `binding`（没有 `using`）的旧宿主。 */
function legacyPort(bindings) {
  const calls = { rename: [], prompt: [], open: [] }
  return {
    calls,
    port: {
      create: async () => 'session-new',
      open: (id) => { calls.open.push(id) },
      binding: (id) => bindings.get(id),
    },
  }
}

function fakePort(options = {}) {
  const sessions = new FakeSessions(options)
  return { port: portOf(sessions), calls: sessions.calls, workspace: fakeUiWorkspace() }
}

const BASE = { seqNo: FACTS.seqNo, workspaceId: 'ws-1', workspacePath: '/Users/me/中瑞世联工作空间' }

test('已经有讨论会话就复用（不新建）', async () => {
  const { port, calls } = fakePort({ existing: 'session-old' })
  const sessions = [{ id: 'session-old', displayTitle: discussionTitle(FACTS.seqNo) }]
  assert.deepEqual(
    await ensureDiscussion({ port, sessions, ...BASE }),
    { ok: true, id: 'session-old', created: false },
  )
  assert.deepEqual(calls.create, [], '复用时不许再建一条')
  assert.deepEqual(calls.using, [], '复用时连 retain 都不用做')
})

test('材料登记（协议 23）：新建与**恢复**都要登记，且用的是 Host 回传的案例目录与附件名', async () => {
  const material = {
    ok: true, error: '', caseDir: '/Users/me/中瑞世联工作空间/S-1',
    attachmentCount: 1,
    attachments: [{ fileId: 'c8ef13b8-1111', fileName: '广兴建筑v3.zip', localName: '广兴建筑v3__c8ef13b8.zip', fileSize: '20342311', nameTotal: 2 }],
  }
  const seen = []
  const openMaterial = async (sessionId) => { seen.push(sessionId); return material }

  // ① 新建：登记发生在**拿到会话 id 之后**，调用方据此再发 kickoff。
  const fresh = fakePort()
  const created = await ensureDiscussion({ port: fresh.port, sessions: [], ...BASE, openMaterial })
  assert.deepEqual(seen, ['session-new'])
  assert.equal(created.ok, true)
  assert.equal(created.material.caseDir, material.caseDir)

  // ② 恢复已有的：**也必须重新登记**（范围只活在 Host 内存里，重启/TTL 之后就失效了）。
  seen.length = 0
  const reused = fakePort({ existing: 'session-old' })
  const sessions = [{ id: 'session-old', displayTitle: discussionTitle(FACTS.seqNo) }]
  const again = await ensureDiscussion({ port: reused.port, sessions, ...BASE, openMaterial })
  assert.deepEqual(seen, ['session-old'], '恢复路径也要登记，且登记的是那条已有会话')
  assert.equal(again.created, false)
  assert.equal(again.material.caseDir, material.caseDir)

  // ③ 提示词里给出的落盘名来自 Host（不是本地拼的），并且 fileId 成对出现。
  const brief = discussionBrief({ ...FACTS, caseDir: material.caseDir, materials: material.attachments })
  assert.equal(brief.includes('广兴建筑v3.zip'), true)
  assert.equal(brief.includes('材料-源/广兴建筑v3__c8ef13b8.zip'), true)
  assert.equal(brief.includes('c8ef13b8-1111'), true)
  assert.equal(brief.includes(zhCN.aiMaterialsHead), true)
})

test('材料登记失败：**不发 kickoff**（调用方拿到 ok:false），会话保留可重试', async () => {
  const fail = async () => ({ ok: false, error: '取不到附件清单' })
  const fresh = fakePort()
  const result = await ensureDiscussion({ port: fresh.port, sessions: [], ...BASE, openMaterial: fail })
  assert.equal(result.ok, false)
  assert.match(result.error, new RegExp(zhCN.aiMaterialFailed))
  assert.match(result.error, /取不到附件清单/)
  // 会话**建出来了**（保留）：用户点一下重试即可，不降级去扫本机目录。
  assert.deepEqual(fresh.calls.create.length, 1)
  // 抛错的形态也要变成人话，不许把异常抛到界面上。
  const thrower = fakePort()
  const thrown = await ensureDiscussion({ port: thrower.port, sessions: [], ...BASE, openMaterial: async () => { throw new Error('boom') } })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /boom/)
  // 旧宿主（没有这个能力）→ 行为与以前完全一致：不登记、也不报错。
  const legacy = fakePort()
  const old = await ensureDiscussion({ port: legacy.port, sessions: [], ...BASE })
  assert.deepEqual(old, { ok: true, id: 'session-new', created: true })
})

test('forceNew（气泡里选「新建对话」）：有旧的也新建，并命名成下一条序号', async () => {
  const { port, calls } = fakePort()
  const sessions = [
    { id: 'a', displayTitle: discussionTitle(FACTS.seqNo) },
    { id: 'b', displayTitle: discussionTitle(FACTS.seqNo, 2) },
  ]
  const result = await ensureDiscussion({ port, sessions, ...BASE, forceNew: true })
  assert.deepEqual(result, { ok: true, id: 'session-new', created: true })
  assert.deepEqual(calls.rename, [{ id: 'session-new', title: discussionTitle(FACTS.seqNo, 3) }], '已是第 2 条，新建就是第 3 条')
})

test('没有讨论会话就新建：建在工作空间下、按流水号命名、并设为当前会话', async () => {
  const { port, calls, workspace } = fakePort()
  const result = await ensureDiscussion({ port, sessions: [], ...BASE })
  assert.deepEqual(result, { ok: true, id: 'session-new', created: true })
  assert.deepEqual(calls.create, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(calls.rename, [{ id: 'session-new', title: discussionTitle(FACTS.seqNo) }])
  // 跳转归调用方：`ensureDiscussion` 只负责「建好 + 命名」，返回 id 让面板去 openSession。
  assert.deepEqual(calls.decoyOpen, [], 'sessions 上没有 open：不许走那条不存在的路')
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
  assert.deepEqual(calls.prompt, [{ id: 'session-old', content: [{ type: 'text', text: '要发出去的话' }], mode: 'queue' }])
  assert.equal(await askDiscussion(port, 'session-old', ''), '')
  assert.equal(calls.prompt.length, 1, '空提问不该真的发一次')
  assert.equal(await askDiscussion(undefined, 'session-old', '你好'), zhCN.aiUnsupported)
})

// ── 4. 真实客户端服务的两条硬约束（2026-09-25 用户报的两个症状） ─────────────

test('刚 create 出来的会话还没被 retain：rename 与 prompt 都必须经 using 拿到 face', async () => {
  // 症状：点小鲸鱼「创建不出新对话」——旧实现 `port.binding(id)?.session` 在 create 之后拿到
  // undefined，于是 rename 被静默跳过（会话没名字 → 下次找不到、只能再建一条），
  // kickoff prompt 也根本没发出去（面板报「这个宿主版本不支持…」）。
  const { port, calls } = fakePort()
  const created = await ensureDiscussion({ port, sessions: [], ...BASE })
  assert.equal(created.ok, true)
  assert.equal(created.renameError, undefined, '正常路径不该报改名失败')
  assert.deepEqual(calls.using.map((row) => row.id), ['session-new'], '必须经 using retain 一次')
  assert.deepEqual(calls.rename.map((row) => row.title), [discussionTitle(FACTS.seqNo)], '名字是复用的唯一凭据，必须真的写上')

  assert.equal(await askDiscussion(port, 'session-new', '要发出去的话'), '')
  assert.deepEqual(calls.prompt.map((row) => row.id), ['session-new'], 'prompt 也必须经 using')
})

test('改名失败要如实报出来（它是「下次会再建一条」的根因），但不阻断本次会话', async () => {
  const { port } = fakePort({ renameFails: true })
  const created = await ensureDiscussion({ port, sessions: [], ...BASE })
  assert.equal(created.ok, true, '改名失败不该把会话判成失败')
  assert.ok(created.renameError !== undefined && created.renameError.includes('改名被拒绝'))
})

test('port 上不许出现「服务里没有的方法」（open 就是这么变成静默 no-op 的）', async () => {
  // 症状：点小鲸鱼「跳不到对应的会话」——真实 ClientSessions 上**没有** open()，
  // `sessions?.open?.(id)` 被可选链吞掉，只剩半截 selectPanel。
  // 现在 port 只含真实存在的四个动词，跳转由面板 onOpenDiscussion → uiWorkspace.openSession 负责。
  const { port } = fakePort()
  assert.deepEqual(Object.keys(port).sort(), ['binding', 'create', 'list', 'using'])
  assert.equal('open' in port, false)
})

test('旧宿主只有 binding 时仍能对已 retain 的会话改名/发问（退路不许一起删掉）', async () => {
  const face = { session: { rename: async (title) => { face.renamed = title }, prompt: async () => { face.asked = true } } }
  const { port, calls } = legacyPort(new Map([['session-old', face]]))
  const reused = await ensureDiscussion({
    port, sessions: [{ id: 'session-old', displayTitle: discussionTitle(FACTS.seqNo) }], ...BASE,
  })
  assert.deepEqual(reused, { ok: true, id: 'session-old', created: false })
  void calls
  assert.equal(await askDiscussion(port, 'session-old', '你好'), '')
  assert.equal(face.asked, true)
})

// ── 5. 案例目录：Host 审核提示词与客户端讨论提示词必须同一条约定 ────────────────

test('案例目录约定只有一份：Host 审核指令与讨论上下文算出的是同一个路径', async () => {
  // 漂移的代价实测过（2026-09-25）：审核链路用 `<工作空间>/<流水号>`，而讨论会话没人告诉它目录，
  // 模型自己 ls + find 去猜，猜成了 `cases/<流水号>` —— 既扫了磁盘，又把材料下到错的地方。
  const ws = '/Users/me/中瑞世联工作空间/'
  const seq = 'S-1'
  const expected = '/Users/me/中瑞世联工作空间/S-1'
  assert.equal(caseDirOf(ws, seq), expected, '去掉工作空间末尾斜杠后拼接')
  assert.equal(caseDirOf('', seq), '', '没工作空间就不给半截路径')
  assert.equal(caseDirOf(ws, ''), '', '没流水号也不给')

  const { discussionBrief } = await import(new URL('src/client/features/report-audit/assistant-context.ts', ROOT).href)
  const hostText = auditPrompt({
    objectId: 'obj-1', seqNo: seq, project: '某项目', workspace: ws,
    oss: { bucket: '', prefix: '', endpoint: '', enabled: false }, isRetry: false,
  })
  const clientText = discussionBrief({
    seqNo: seq, objectId: '', project: '', name: '', risk: '', reviewLevel: '', reviewState: '',
    currentNode: '', modifiedAt: '', formName: '', caseDir: caseDirOf(ws, seq),
    files: [], fetchedAt: '', sources: [],
  })
  // 协议 19 起 Host 侧的措辞把"cwd 与可写范围"一起说出来（根会话的 cwd 与沙箱边界都是它）；
  // **路径本身**仍然只由 `caseDirOf` 算一次 —— 这条用例守的是"约定只有一份"，不是某句文案。
  assert.equal(hostText.includes(`${expected}**`), true, 'Host 侧用这条约定（同一个路径）')
  assert.equal(hostText.includes('本案例目录（也是你的工作目录与可写范围）'), true, 'Host 侧要说清它就是 cwd 与可写范围')
  assert.equal(clientText.includes(`${zhCN.aiCaseDirHead}${expected}`), true, '客户端侧用同一条约定')
})
