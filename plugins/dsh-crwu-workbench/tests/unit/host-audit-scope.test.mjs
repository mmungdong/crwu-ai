import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * **审核 scope 门禁**（`host/audit/scope.ts`）的反例矩阵。
 *
 * 2026-09-29 用户复查的 P1：案例内的 Tool 此前只校验到"`caseDir` 落在选定工作空间之下"，
 * 而工作空间里通常有**很多**案例目录 —— 于是 S1 的子会话可以传 `<工作空间>/S2`、
 * 或传工作空间根再读 `S2/文件`，把别的案例读出来（`oss_publish` 能把它传上 OSS）、
 * 往别的案例里写（`file_get` / 知识库落盘）。同一个 P1 的另一半是氚云标识：
 * `objectId` / `fileId` 都由模型提交，Host 没有把任何东西绑到**本轮**审核上。
 *
 * 这里的每一条都是"必须被拒绝"：workspace 根、兄弟案例、案例目录的子目录、`seqNo` 不一致、
 * `objectId` 不一致、调用者没有身份、调用者不在进行中的审核里、记录已结束、
 * 以及 scope 字段不完整（认领来的旧记录）。**精确相等**与**fail closed** 是判据的两半。
 *
 * 交付形状（"被拒绝时一个进程都不许起"）在 `host-tools.test.mjs` 的 Tool 级用例里断言 ——
 * 这一层只证明门禁本身，那一层证明门禁接在了真正的入口上。
 */
const ROOT = new URL('../../', import.meta.url)
const { auditScopeFor, callerSessionId, isAuditChild, requireAuditScope, samePathText } = await import(
  new URL('src/host/audit/scope.ts', ROOT).href
)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/work', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600,
  autoUpload: true, requireTopLevelParent: true,
}

/**
 * 一个"resolve 之后"的 fs 替身。
 *
 * ⚠️ `targetKey` 是 **不透明标识**（`Branded<'FsTargetKey'>`），**不是路径**：
 * 夹具必须按"每个真实目录一个稳定 key"来建模，`displayPath` 只用来显示。
 * 2026-09-29 用户复查的 P2 指出：旧夹具把 `targetKey` 直接伪造成路径字符串，
 * 于是"把不透明 ID 当路径做归一化"这个合同错误在测试里完全看不出来。
 *
 * `keys` 是"真实目录 → key"的映射；同一目录的别名（符号链接、`\` 写法、盘符大小写）
 * 映射到**同一个 key**；两个不同目录即使显示路径只差大小写，key 也必须不同。
 */
function ctxWith(keys = new Map(), alias = new Map()) {
  let next = keys.size + 1
  const keyOf = (p) => {
    const raw = alias.get(p) ?? p
    if (!keys.has(raw)) keys.set(raw, `fsk-${next++}`)
    return keys.get(raw)
  }
  return {
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(path) {
          const raw = String(path).replace(/[\\/]+$/, '')
          return { targetKey: keyOf(raw), displayPath: String(path) }
        },
        async stat() { return { type: 'directory', version: 'v' } },
        contains: () => true,
      }
    },
  }
}

function stateWith(record = {}) {
  const state = createWorkbenchState(CONFIG)
  state.workspacePath = '/work'
  state.workspaceChosen = true
  state.audits = {
    S1: {
      key: 'S1', childId: 'child-1', seqNo: 'S1', project: '', objectId: 'obj-1',
      startedAt: '', parentSessionId: 'root-1', status: 'running', ended: false, stopped: false,
      stopReason: '', endReason: '', casePath: '/work/S1', attemptId: 'S1-a1-x',
      allowedAttachmentIds: ['f-1'],
      resultFile: '', htmlFile: '', caseName: '', uploadedAt: '', uploadError: '', ossPrefix: '', attempt: 1,
      ...record,
    },
  }
  state.activeKey = 'S1'
  state.activeChildId = 'child-1'
  return state
}

const execOf = (childId) => ({
  callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name: 'x', arguments: {},
  signal: new AbortController().signal,
  ...(childId === undefined ? {} : { agent: { id: childId } }),
  deferContext() {}, concludeTurn() {},
})

// ── 纯函数：scope 查找 ──────────────────────────────────────────────────────

test('auditScopeFor：只认进行中且 scope 完整的记录（找不到 / 已结束 / 缺字段都返回 undefined）', () => {
  assert.equal(auditScopeFor(stateWith(), 'child-1')?.casePath, '/work/S1')
  assert.equal(auditScopeFor(stateWith(), 'child-2'), undefined, '未知 childId 必须没有 scope')
  assert.equal(auditScopeFor(stateWith(), ''), undefined, '空身份必须没有 scope')
  assert.equal(auditScopeFor(stateWith({ ended: true }), 'child-1'), undefined, '已结束的审核不再有 scope')
  assert.equal(auditScopeFor(stateWith({ stopped: true }), 'child-1'), undefined, '被停止的审核不再有 scope')
  // 认领来的旧记录没有 casePath / attemptId：**不许拿工作空间兜底**。
  assert.equal(auditScopeFor(stateWith({ casePath: '', attemptId: '' }), 'child-1'), undefined)
  assert.equal(auditScopeFor(stateWith({ attemptId: '' }), 'child-1'), undefined)
  assert.equal(auditScopeFor(stateWith({ seqNo: '' }), 'child-1'), undefined)
})

test('samePathText 比的是**我们自己的路径字符串**：去尾部分隔符、逐字相等、不折叠大小写', () => {
  assert.equal(samePathText('/work/S1', '/work/S1'), true)
  assert.equal(samePathText('/work/S1/', '/work/S1'), true, '尾部分隔符不改变身份')
  assert.equal(samePathText('/work/S1', '/work/s1'), false, '不折叠大小写：区分大小写的卷上这是两个目录')
  assert.equal(samePathText('', ''), false, '空串不是身份')
  assert.equal(samePathText('C:\\Cases\\S1', 'c:\\cases\\s1'), false, '路径字符串也不折叠大小写')
})

// ── 门禁：三条"必须是本次案例目录"的反例 ────────────────────────────────────

test('案例目录必须精确等于本轮 casePath：工作空间根 / 兄弟案例 / 子目录一律拒绝', async () => {
  const cases = [
    ['/work', '工作空间根本身'],
    ['/work/S2', '兄弟案例'],
    ['/work/S1/输入快照', '案例目录的子目录'],
    ['/work/S1-evil', '前缀相似的目录'],
    ['/etc', '完全无关的目录'],
  ]
  for (const [given, label] of cases) {
    const check = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'), { caseDir: given })
    assert.equal(check.ok, false, `${label} 必须被拒绝：${given}`)
    assert.equal(check.errorKind, 'policy')
    assert.match(check.error, /本次审核自己的/)
  }
  const ok = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'), { caseDir: '/work/S1' })
  assert.equal(ok.ok, true, ok.ok ? '' : ok.error)
  // 通过时**返回 Host 的路径**：调用方必须用它，而不是自己再拼一次模型给的字符串。
  assert.equal(ok.casePath, '/work/S1')
})

test('别名按**不透明 key** 判：符号链接指向本案例 → 通过；指向兄弟案例 → 拒绝', async () => {
  // 后端 `resolve` 把两条写法归到同一个 key（这就是"同一个目录"的全部含义）。
  const keys = new Map([['/work/S1', 'k-s1'], ['/work/S2', 'k-s2']])
  const alias = new Map([['/link/S1', '/work/S1'], ['/link/S2', '/work/S2']])
  const linked = await requireAuditScope(ctxWith(keys, alias), stateWith(), execOf('child-1'), { caseDir: '/link/S1' })
  assert.equal(linked.ok, true, '同一个目录的别名应当通过（否则员工侧的正常写法会被拒）')
  assert.equal(linked.casePath, '/work/S1', '返回的仍然是 Host 记录里的那个路径')

  const sibling = await requireAuditScope(ctxWith(keys, alias), stateWith(), execOf('child-1'), { caseDir: '/link/S2' })
  assert.equal(sibling.ok, false, '指向兄弟案例的符号链接必须被拒绝')
  assert.equal(sibling.errorKind, 'policy')
})

test('两个**不同**的不透明 key 即使显示路径只差大小写也必须拒绝（不许把 targetKey 当路径归一化）', async () => {
  // 这是 P2 的核心反例：一个合法后端可以返回"形似 Windows 路径但区分大小写"的 key。
  // 旧实现把它们归一化后判成同一个位置 → 门禁被错误放行。
  // ⚠️ 两个 key 必须**只差大小写**：这样"精确等值"与"按路径归一化"才会给出不同答案
  // （否则用例会因为别的原因通过，抓不到归一化这个缺陷 —— 第一版就写错了）。
  // 两个 key **只差大小写**（`Key-S1` vs `key-s1`）：精确等值 → 不同；归一化 → 相同。
  const keys = new Map([['C:\\Cases\\S1', 'Key-S1'], ['c:\\cases\\s1', 'key-s1']])
  const state = stateWith({ casePath: 'C:\\Cases\\S1' })
  const refused = await requireAuditScope(ctxWith(keys), state, execOf('child-1'), { caseDir: 'c:\\cases\\s1' })
  assert.equal(refused.ok, false, '不同的 key 就是不同的位置')
  assert.equal(refused.errorKind, 'policy')

  // 反过来：同一个 key（后端说它们是一个目录）必须通过。
  const sameKeys = new Map([['C:\\Cases\\S1', 'Key-S1'], ['c:\\cases\\s1', 'Key-S1']])
  const allowed = await requireAuditScope(ctxWith(sameKeys), stateWith({ casePath: 'C:\\Cases\\S1' }),
    execOf('child-1'), { caseDir: 'c:\\cases\\s1' })
  assert.equal(allowed.ok, true, '后端说是同一个 key，就按同一个处理')
})

// ── 门禁：身份与业务标识 ────────────────────────────────────────────────────

test('seqNo / objectId 必须与本轮记录一致', async () => {
  const wrongSeq = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'),
    { caseDir: '/work/S1', seqNo: 'S2' })
  assert.equal(wrongSeq.ok, false)
  assert.equal(wrongSeq.errorKind, 'input')
  assert.match(wrongSeq.error, /流水号与本次审核不一致/)

  const wrongObject = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'),
    { caseDir: '/work/S1', objectId: 'obj-OTHER' })
  assert.equal(wrongObject.ok, false)
  assert.equal(wrongObject.errorKind, 'input')
  assert.match(wrongObject.error, /记录标识与本次审核不一致/)

  const same = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'),
    { caseDir: '/work/S1', seqNo: 'S1', objectId: 'obj-1' })
  assert.equal(same.ok, true, same.ok ? '' : same.error)
})

test('身份缺失 / 未知 childId / 已结束的审核：一律 fail closed', async () => {
  const noAgent = await requireAuditScope(ctxWith(), stateWith(), execOf(undefined), { caseDir: '/work/S1' })
  assert.equal(noAgent.ok, false)
  assert.equal(noAgent.errorKind, 'policy')
  assert.match(noAgent.error, /无法确认调用者身份/)

  const unknown = await requireAuditScope(ctxWith(), stateWith(), execOf('ghost'), { caseDir: '/work/S1' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /不在进行中的审核里/)

  for (const patch of [{ ended: true }, { stopped: true }, { casePath: '', attemptId: '' }]) {
    const check = await requireAuditScope(ctxWith(), stateWith(patch), execOf('child-1'), { caseDir: '/work/S1' })
    assert.equal(check.ok, false, `scope 不成立时必须拒绝：${JSON.stringify(patch)}`)
    assert.match(check.error, /不在进行中的审核里/)
  }
})

test('**待接管窗口**：没有权威 childId 就不给 scope（案例内 Tool fail closed）', async () => {
  // 用户第三轮复查的 P1：窗口内曾按"父会话 = 审核根"认领 scope，于是同一个 root 下的
  // 旧 sibling 能在窗口里冒领新审核的案例 scope。one-shot `start()` 没有预留 child id 的参数，
  // 拿不到不可伪造的 launch token → 唯一安全的做法是**没有权威 childId 就没有 scope**。
  const pendingState = () => {
    const state = stateWith({ childId: '', pending: true, casePath: '/work/S1' })
    state.audits.S1.parentSessionId = 'root-1'
    return state
  }
  const childExec = (parentSessionId) => ({
    ...execOf('child-brand-new'),
    agent: { id: 'child-brand-new', session: { header: { parentSession: parentSessionId } } },
  })

  // ① 本次的 child（父会话 = 审核根）：**同样拒绝**，并给出"稍后重试"的明确原因
  const mine = await requireAuditScope(ctxWith(), pendingState(), childExec('root-1'), { caseDir: '/work/S1' })
  assert.equal(mine.ok, false, '窗口内一律 fail closed')
  assert.match(mine.error, /还在建立中/)
  assert.equal(mine.errorKind, 'policy')

  // ② **旧 sibling 冒领**（用户复现的那条）：同一个 root 下的另一个 child 也拿不到
  const sibling = await requireAuditScope(ctxWith(), pendingState(), childExec('root-1'), { caseDir: '/work/S1' })
  assert.equal(sibling.ok, false, 'sibling 不许冒领新审核的案例 scope')
  // ③ 别的 root 的 child：一样拿不到
  const foreign = await requireAuditScope(ctxWith(), pendingState(), childExec('some-other-root'), { caseDir: '/work/S1' })
  assert.equal(foreign.ok, false)
  // ④ 服务退路（listChildren 说"它是这个 root 的孩子"）也**不能**放行 —— 它只证明归属，不证明本次启动
  const both = {
    get(name) {
      if (name === 'fs') return ctxWith().get('fs')
      if (name === 'subagents') return { async listChildren() { return [{ kind: 'child', id: 'child-brand-new' }] } }
      return undefined
    },
  }
  const viaService = await requireAuditScope(both, pendingState(), { ...execOf('child-brand-new'), agent: { id: 'child-brand-new' } }, { caseDir: '/work/S1' })
  assert.equal(viaService.ok, false, 'listChildren 只能做归属/存活查询，不能当启动身份绑定')

  // ⑤ `isAuditChild` 在窗口内仍然认得出（**拒绝方向**：面板类 Tool 靠它拒绝）
  assert.equal(isAuditChild(pendingState(), 'child-brand-new', 'root-1'), true)
  assert.equal(isAuditChild(pendingState(), 'child-brand-new', 'other-root'), false)
  assert.equal(isAuditChild(pendingState(), 'child-brand-new'), false, '没有父会话信息就不认')
  assert.equal(isAuditChild(pendingState(), ''), false, '空 childId 永远不是审核子会话')

  // ⑥ childId 写回之后（真身份到手）正常放行
  const finalized = stateWith({ childId: 'child-brand-new', pending: false, casePath: '/work/S1' })
  const ok = await requireAuditScope(ctxWith(), finalized, { ...execOf('child-brand-new'), agent: { id: 'child-brand-new' } }, { caseDir: '/work/S1' })
  assert.equal(ok.ok, true, 'childId 落记录后这轮 scope 才存在')
})

test('缺少案例目录 / 缺少 fs 服务：分别报 input 与 infrastructure（不是放行）', async () => {
  const missing = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'), {})
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input')

  const noFs = await requireAuditScope({ get: () => undefined }, stateWith(), execOf('child-1'), { caseDir: '/work/S1' })
  assert.equal(noFs.ok, false)
  assert.equal(noFs.errorKind, 'infrastructure')

  // `requireCaseDir: false` 是给"这一轮调用不带案例目录"的显式出口：仍然要求 scope 成立。
  const optional = await requireAuditScope(ctxWith(), stateWith(), execOf('child-1'), {}, { requireCaseDir: false })
  assert.equal(optional.ok, true, optional.ok ? '' : optional.error)
  assert.equal(optional.casePath, '/work/S1')
})

test('callerSessionId 只认 Agent.id；拿不到就是空串（由门禁 fail closed）', () => {
  assert.equal(callerSessionId(execOf('child-1')), 'child-1')
  assert.equal(callerSessionId(execOf(undefined)), '')
  assert.equal(callerSessionId({ ...execOf(undefined), agent: {} }), '')
})
