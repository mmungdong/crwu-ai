import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 报告讨论会话的**受限材料范围**（协议 23）：
 *
 * 1. 进程内注册表本身（TTL / 最近使用 / 上限 / 覆盖登记）；
 * 2. 材料范围解析器 `requireMaterialScope` —— 它是"这个调用者能取哪些附件"的**唯一判据**。
 *
 * 为什么这一份必须存在：讨论会话不是审核子会话（它没有审核记录），而附件下载原先只认审核
 * 记录里的白名单。修法不是"让它复用审核 scope"（那是扩大边界），而是给它一份**自己的、
 * 更窄的**范围：Host 登记时重新取一次附件清单，只把那一批 `fileId` 写进白名单。
 * 所以这里逐条钉住"什么情况下**不能**拿到范围"。
 */
const ROOT = new URL('../../', import.meta.url)
const {
  createDiscussionScopeRegistry, DISCUSSION_SCOPE_TTL_MS, requireMaterialScope, isRegisteredDiscussion,
} = await import(new URL('src/host/audit/discussion-scope.ts', ROOT).href)

const CASE = '/Users/me/中瑞世联工作空间/2026-302549-LX10063-BG8856'
const SEQ = '2026-302549-LX10063-BG8856'

/** 只回答 `resolve` 的 fs 替身：`requireMaterialScope` 用它做"规范解析后精确相等"的比较。 */
function makeCtx() {
  return {
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(path) {
          return { targetKey: String(path).replace(/[\\/]+$/, ''), displayPath: path }
        },
      }
    },
  }
}

const makeExec = (id) => ({ agent: { id } })
const state = { audits: {} }

function registry(patch = {}) {
  return createDiscussionScopeRegistry(patch)
}

function register(reg, patch = {}) {
  return reg.register({
    sessionId: 'sess-1', seqNo: SEQ, objectId: 'obj-1', caseDir: CASE,
    allowedAttachmentIds: ['f-1', 'f-2'], ...patch,
  })
}

// ── 注册表本身 ──────────────────────────────────────────────────────────────

test('登记后能取到范围，字段与白名单逐字保留（空数组 = 一个都不允许）', () => {
  const reg = registry()
  const scope = register(reg)
  assert.equal(scope.seqNo, SEQ)
  assert.equal(scope.caseDir, CASE)
  assert.deepEqual([...scope.allowedAttachmentIds], ['f-1', 'f-2'])
  assert.equal(scope.expiresAt - scope.createdAt, DISCUSSION_SCOPE_TTL_MS)
  assert.deepEqual([...reg.use('sess-1').allowedAttachmentIds], ['f-1', 'f-2'])

  const empty = registry()
  register(empty, { sessionId: 'sess-2', allowedAttachmentIds: [] })
  assert.deepEqual([...empty.use('sess-2').allowedAttachmentIds], [], '空白名单不是"都允许"')
})

test('TTL 到期即失效（`use` 与 `peek` 都取不到，也不再占名额）', () => {
  let now = 1_000_000
  const reg = registry({ now: () => now, ttlMs: 60_000 })
  register(reg)
  assert.equal(isRegisteredDiscussion(reg, 'sess-1'), true)
  now += 59_999
  assert.equal(isRegisteredDiscussion(reg, 'sess-1'), true, '还没到期')
  now += 1
  assert.equal(reg.use('sess-1'), undefined, '到期即取不到')
  assert.equal(isRegisteredDiscussion(reg, 'sess-1'), false)
  assert.equal(reg.size(), 0, '过期条目顺手清掉，不占上限')
})

test('重复登记 = 刷新白名单与 TTL（恢复会话那条路）', () => {
  let now = 1_000_000
  const reg = registry({ now: () => now, ttlMs: 60_000 })
  register(reg)
  now += 50_000
  register(reg, { allowedAttachmentIds: ['f-9'] })
  assert.deepEqual([...reg.use('sess-1').allowedAttachmentIds], ['f-9'], '白名单按此刻远端有什么刷新')
  now += 50_000
  assert.notEqual(reg.use('sess-1'), undefined, 'TTL 被重新起算')
})

test('`use` 推最近使用时刻；超出上限时丢最久没用过的那条', () => {
  let now = 1_000_000
  const reg = registry({ now: () => now, limit: 2, ttlMs: 10_000_000 })
  register(reg, { sessionId: 'a' })
  now += 10
  register(reg, { sessionId: 'b' })
  now += 10
  reg.use('a')
  now += 10
  register(reg, { sessionId: 'c' })
  assert.deepEqual(reg.list().map((scope) => scope.sessionId).sort(), ['a', 'c'], '丢掉的是 b（最久没用过）')
  assert.equal(reg.size(), 2)
})

test('drop / clear / 空 sessionId', () => {
  const reg = registry()
  register(reg)
  reg.drop('sess-1')
  assert.equal(reg.peek('sess-1'), undefined)
  register(reg)
  reg.clear()
  assert.equal(reg.size(), 0)
  assert.equal(reg.use(''), undefined)
  assert.equal(reg.peek(''), undefined)
})

// ── 材料范围解析器 ──────────────────────────────────────────────────────────

test('已登记的讨论会话：范围成立，案例目录与白名单都来自 Host 记录', async () => {
  const reg = registry()
  register(reg)
  const checked = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: CASE })
  assert.equal(checked.ok, true)
  assert.equal(checked.material.kind, 'discussion')
  assert.equal(checked.material.scope.caseDir, CASE)
  assert.deepEqual([...checked.material.scope.allowedAttachmentIds], ['f-1', 'f-2'])
})

test('没登记的会话（普通顶层对话 / 别的会话）一律拒绝', async () => {
  const reg = registry()
  register(reg)
  for (const id of ['other-session', '']) {
    const checked = await requireMaterialScope(makeCtx(), state, reg, makeExec(id), { caseDir: CASE })
    assert.equal(checked.ok, false, id)
    assert.equal(checked.errorKind, 'policy')
  }
  // 文案要说清"怎么重新拿到"（重新点一次讨论），而不是让用户以为是报告的问题。
  const denied = await requireMaterialScope(makeCtx(), state, reg, makeExec('other-session'), { caseDir: CASE })
  assert.match(denied.error, /与 DeepSeek 讨论报告/)
})

test('范围过期后拒绝（Host 不认旧授权）', async () => {
  let now = 1_000_000
  const reg = registry({ now: () => now, ttlMs: 1_000 })
  register(reg)
  now += 1_001
  const checked = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: CASE })
  assert.equal(checked.ok, false)
  assert.equal(checked.errorKind, 'policy')
})

test('错误的案例目录被拒绝：工作空间根、兄弟案例、子目录都不行', async () => {
  const reg = registry()
  register(reg)
  for (const wrong of [
    '/Users/me/中瑞世联工作空间',
    '/Users/me/中瑞世联工作空间/2026-302549-LX10063-BG8857',
    `${CASE}/材料-源`,
  ]) {
    const checked = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: wrong })
    assert.equal(checked.ok, false, wrong)
    assert.equal(checked.errorKind, 'policy', wrong)
  }
})

test('流水号 / 记录标识与登记不一致时拒绝（模型提交的标识不是权威）', async () => {
  const reg = registry()
  register(reg)
  const wrongSeq = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: CASE, seqNo: 'SEQ-2' })
  assert.equal(wrongSeq.ok, false)
  assert.equal(wrongSeq.errorKind, 'input')
  const wrongObject = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: CASE, objectId: 'obj-2' })
  assert.equal(wrongObject.ok, false)
  assert.equal(wrongObject.errorKind, 'input')
  // 一致时放行（不是"只要带了就拒绝"）。
  const ok = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), { caseDir: CASE, seqNo: SEQ, objectId: 'obj-1' })
  assert.equal(ok.ok, true)
})

test('缺案例目录：默认拒绝；显式允许（`requireCaseDir: false`）时不校验路径', async () => {
  const reg = registry()
  register(reg)
  const missing = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), {})
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input')
  const allowed = await requireMaterialScope(makeCtx(), state, reg, makeExec('sess-1'), {}, { requireCaseDir: false })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.material.scope.caseDir, CASE)
})

test('审核子会话仍然走审核 scope（讨论范围不会覆盖它）', async () => {
  const reg = registry()
  // 同一个 id 既在审核记录里、又被登记成讨论 —— 以**审核 scope** 为准（边界更窄）。
  const auditState = {
    audits: {
      S1: {
        key: 'S1', childId: 'both', seqNo: SEQ, objectId: 'obj-1', parentSessionId: 'p',
        status: 'running', ended: false, stopped: false, casePath: CASE, attemptId: 'a1',
        allowedAttachmentIds: ['only-audit'],
      },
    },
  }
  register(reg, { sessionId: 'both', allowedAttachmentIds: ['only-discussion'] })
  const checked = await requireMaterialScope(makeCtx(), auditState, reg, makeExec('both'), { caseDir: CASE })
  assert.equal(checked.ok, true)
  assert.equal(checked.material.kind, 'audit')
  assert.deepEqual([...checked.material.scope.allowedAttachmentIds], ['only-audit'])
})
