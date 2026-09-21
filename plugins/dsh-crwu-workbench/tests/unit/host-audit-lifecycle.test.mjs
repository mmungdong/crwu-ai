/**
 * 第 3 层（审核生命周期）的单元测试。
 *
 * 这一层是事故高发区，每条规则都对应一次真实故障：
 * 「状态跟丢」、两条子会话交叉写同一案例目录、锁被永久占住、点两次起两条。
 * 所以这里全部是**反向**验证：把坏情况摆出来，确认它被挡住或自愈。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { auditStart, auditStop, auditStatus, auditRelease } = await import(new URL('src/host/audit/ops.ts', ROOT).href)
const { assessAudit, applyAssessment, reclaimActive, releaseActive, collectChildren, makeAgentStatusOf } = await import(
  new URL('src/host/audit/state.ts', ROOT).href
)
const { auditLabel, seqNoFromLabel, dirMarker, fileMarker } = await import(new URL('src/host/audit/consts.ts', ROOT).href)
const { inspectCase, caseNameOf } = await import(new URL('src/host/audit/case.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { normalizeAudit } = await import(new URL('src/host/state/registry.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', installDocUrl: '', manifestUrl: '', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600,
  autoUpload: true, requireTopLevelParent: true,
}

function fakeWorld(patch = {}) {
  return {
    platform: async () => patch.platform ?? 'darwin-arm64',
    home: async () => patch.home ?? '/Users/x',
    workdir: async () => patch.workdir ?? '/cases/session',
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
}

/** ctx：shell 失败、fs 内存化、sessions/agents/subagents 按需注入。 */
function makeCtx({ sessions, agents, subagents, dirs = [], files = {}, entries = [] } = {}) {
  const directories = new Set(dirs)
  const listDirs = { ...entries }
  return {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async run() {
            return { exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: 'stub', truncated: false } }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
            if (directories.has(key)) return { type: 'directory' }
            return files[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content) { files[target.targetKey] = content; return { operation: 'update', version: 'v', before: null, after: content } },
          async listDir(target) { return listDirs[target.targetKey] ?? [] },
        }
      }
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      if (name === 'subagents') return subagents
      return undefined
    },
  }
}

function makeState(patch = {}) {
  return { ...createWorkbenchState(CONFIG), ...patch }
}

function record(overrides = {}) {
  return { ...normalizeAudit('k', {}), key: 'k', childId: 'child-1', seqNo: 'S1', attempt: 1, ...overrides }
}

// ── 纯函数：标记与 label ────────────────────────────────────────────────────

test('auditLabel keeps the serial number as the first token', () => {
  const label = auditLabel('2026-301705-LX10170', new Date(2026, 8, 20, 10, 16, 27))
  assert.equal(label, '审核 2026-301705-LX10170 · 10:16:27')
  // 停止/重审全靠它反查 —— 第一个 token 必须是流水号。
  assert.equal(seqNoFromLabel(label), '2026-301705-LX10170')
  assert.equal(seqNoFromLabel('别的 label'), '')
  assert.equal(seqNoFromLabel(null), '')
})

test('dirMarker and fileMarker recognize the case layout', () => {
  assert.equal(dirMarker('材料-源20260920'), 'materials')
  assert.equal(dirMarker('工作版'), 'work')
  assert.equal(dirMarker('复核-人工'), 'review')
  assert.equal(dirMarker('随便什么'), '')
  assert.equal(fileMarker('审核结果.S1.json'), '', '交付件由独立规则识别，不在这里')
  assert.equal(fileMarker('材料盘点.json'), 'inventory')
  assert.equal(fileMarker('冻结指纹.json'), 'frozen')
  assert.equal(caseNameOf('/cases/a/S1/'), 'S1')
})

// ── inspectCase ─────────────────────────────────────────────────────────────

function caseCtx(entries, files = {}) {
  return makeCtx({
    entries: { '/cases/a/S1': entries },
    files,
    dirs: ['/cases/a/S1'],
  })
}

test('inspectCase reports a case only when it looks like one', async () => {
  const empty = await inspectCase(caseCtx([]), { targetKey: '/cases/a/S1', displayPath: '/cases/a/S1' })
  assert.equal(empty, null, '空目录不是案例目录')

  const withMaterials = await inspectCase(
    caseCtx([{ type: 'directory', name: '材料-源20260920', target: { targetKey: '/cases/a/S1/材料-源20260920' } }]),
    { targetKey: '/cases/a/S1', displayPath: '/cases/a/S1' },
  )
  assert.ok(withMaterials)
  assert.equal(withMaterials.flags.materials, true)
  assert.equal(withMaterials.name, 'S1')
})

test('inspectCase prefers the canonical audit opinion over backups', async () => {
  const item = await inspectCase(
    caseCtx([
      { type: 'file', name: '审核意见.S1.html.before-20260919', target: { targetKey: 'b' } },
      { type: 'file', name: '审核意见.旧名.html', target: { targetKey: 'c' } },
      { type: 'file', name: '审核意见.S1.html', target: { targetKey: 'd' } },
    ]),
    { targetKey: '/cases/a/S1', displayPath: '/cases/a/S1' },
  )
  assert.ok(item)
  assert.equal(item.htmlFile, '审核意见.S1.html', 'canonical 必须优先，否则界面显示旧备份')
})

test('inspectCase reads the result JSON but never fails the whole scan on bad JSON', async () => {
  const good = await inspectCase(
    caseCtx(
      [{ type: 'file', name: '审核结果.S1.json', target: { targetKey: '/cases/a/S1/审核结果.S1.json' } }],
      { '/cases/a/S1/审核结果.S1.json': '{"ok":true}' },
    ),
    { targetKey: '/cases/a/S1', displayPath: '/cases/a/S1' },
  )
  assert.deepEqual(good.audit, { ok: true })

  const bad = await inspectCase(
    caseCtx(
      [{ type: 'file', name: '审核结果.S1.json', target: { targetKey: '/cases/a/S1/审核结果.S1.json' } }],
      { '/cases/a/S1/审核结果.S1.json': '{oops' },
    ),
    { targetKey: '/cases/a/S1', displayPath: '/cases/a/S1' },
  )
  assert.equal(bad.resultFile, '审核结果.S1.json')
  assert.equal(bad.audit, null)
  assert.ok(bad.error.length > 0)
})

// ── assessAudit：存活判据与状态 ─────────────────────────────────────────────

function assessContext(patch = {}) {
  return {
    ctx: makeCtx(),
    state: makeState(),
    listed: {},
    agentStatusOf: () => '',
    caseRoot: '',
    now: Date.parse('2026-09-20T10:00:00Z'),
    ...patch,
  }
}

test('a child whose agent is running stays running regardless of the parent session', async () => {
  const result = await assessAudit(
    assessContext({ agentStatusOf: () => 'running', listed: { 'child-1': true } }),
    record({ parentSessionId: 'some-other-parent', startedAt: '2026-09-20T09:00:00Z' }),
  )
  assert.equal(result.status, 'running')
  assert.equal(result.childAlive, true)
  assert.equal(result.release, false)
})

test('a listed but no-longer-running child is NOT treated as alive', async () => {
  // listChildren 扫的是会话存储：跑完的一次性子会话依然在列。
  const result = await assessAudit(
    assessContext({ agentStatusOf: () => 'idle', listed: { 'child-1': true } }),
    record({ startedAt: '2026-09-20T09:00:00Z' }),
  )
  assert.equal(result.childAlive, false, '在清单里不等于还活着')
  assert.equal(result.status, 'idle', '没有交付件、正常跑完 → 未出结果（不是 failed）')
})

test('a freshly started child gets a 20s grace window', async () => {
  const now = Date.parse('2026-09-20T10:00:00Z')
  const fresh = await assessAudit(
    assessContext({ now, agentStatusOf: () => '' }),
    record({ startedAt: new Date(now - 5_000).toISOString() }),
  )
  assert.equal(fresh.childAlive, true, '刚起的子会话还没被驱动翻成 running，不应判定为结束')
  assert.equal(fresh.status, 'running')

  const stale = await assessAudit(
    assessContext({ now, agentStatusOf: () => '' }),
    record({ startedAt: new Date(now - 60_000).toISOString() }),
  )
  assert.equal(stale.childAlive, false)
})

test('an adopted record releases its lock once the agent stops running', async () => {
  // 认领来的记录永远等不到 subagent/end；不这样处理就会把单条门禁永久锁住。
  const result = await assessAudit(
    assessContext({ agentStatusOf: () => 'idle', listed: { 'child-1': true } }),
    record({ adopted: true, startedAt: '' }),
  )
  assert.equal(result.release, true)
  assert.equal(result.status, 'idle')
})

test('an error end reason marks the audit failed, a completed one does not', async () => {
  // startedAt 必须非空：空 startedAt 会被判为「认领来的记录」（listedOnly），
  // 那种记录没有本地历史、永远等不到 subagent/end，所以统一按「正常结束」处理。
  const started = '2026-09-20T09:00:00Z'
  const failed = await assessAudit(assessContext({ agentStatusOf: () => 'idle' }), record({ startedAt: started, ended: true, endReason: 'error' }))
  assert.equal(failed.status, 'failed')

  const completed = await assessAudit(assessContext({ agentStatusOf: () => 'idle' }), record({ startedAt: started, ended: true, endReason: 'completed' }))
  assert.equal(completed.status, 'idle')

  const aborted = await assessAudit(assessContext({ agentStatusOf: () => 'idle' }), record({ startedAt: started, ended: true, endReason: 'aborted' }))
  assert.equal(aborted.status, 'idle', '被外部取消不算失败')

  // 认领来的记录即使 endReason 是 error 也算「正常结束」—— 它没有本地历史可判定。
  const adopted = await assessAudit(assessContext({ agentStatusOf: () => 'idle' }), record({ adopted: true, startedAt: '', ended: true, endReason: 'error' }))
  assert.equal(adopted.status, 'idle')
})

test('a stopped record stays stopped and releases its lock', async () => {
  const result = await assessAudit(assessContext(), record({ stopped: true, ended: true }))
  assert.equal(result.status, 'stopped')
  assert.equal(result.release, true)
})

test('a delivered result marks the audit done', async () => {
  const result = await assessAudit(
    assessContext({
      agentStatusOf: () => 'idle',
      caseRoot: '/cases',
      ctx: makeCtx({
        dirs: ['/cases/S1'],
        entries: { '/cases/S1': [{ type: 'file', name: '审核结果.S1.json', target: { targetKey: '/cases/S1/审核结果.S1.json' } }] },
        files: { '/cases/S1/审核结果.S1.json': '{"ok":true}' },
      }),
    }),
    record({ ended: true, endReason: 'completed' }),
  )
  assert.equal(result.status, 'done')
  assert.equal(result.resultFile, '审核结果.S1.json')
  assert.equal(result.casePath, '/cases/S1')
})

test('applyAssessment keeps an existing endReason and stamps adopted records', async () => {
  const assessment = { status: 'done', casePath: '/c', resultFile: 'r', htmlFile: 'h', caseName: 'n', childAlive: false, changed: true, release: true }
  assert.equal(applyAssessment(record({ endReason: 'error' }), assessment, 'act').endReason, 'error')
  const adopted = applyAssessment(record({ adopted: true }), assessment, '')
  assert.equal(adopted.ended, true)
  assert.equal(adopted.endReason, 'completed')
  assert.equal(adopted.childAlive, false)
})

// ── 占用锁 ──────────────────────────────────────────────────────────────────

test('releaseActive only clears the lock that belongs to the given child', () => {
  const state = makeState({ activeKey: 'a', activeChildId: 'child-a' })
  releaseActive(state, 'child-b')
  assert.equal(state.activeChildId, 'child-a', '别人交接时不能把当前锁清掉')
  releaseActive(state, 'child-a')
  assert.equal(state.activeChildId, '')
  assert.equal(state.activeSince, 0)
})

test('releaseActive clears the lock when no child is specified', () => {
  const state = makeState({ activeKey: 'a', activeChildId: 'child-a' })
  releaseActive(state)
  assert.equal(state.activeKey, '')
  assert.equal(state.activeChildId, '')
})

test('reclaimActive only re-acquires a free lock', () => {
  const state = makeState()
  assert.equal(reclaimActive(state, 'k', 'child-1', 5), true)
  assert.equal(state.activeKey, 'k')
  assert.equal(state.activeSince, 5)
  assert.equal(reclaimActive(state, 'other', 'child-2', 9), false, '已有占用时不得抢占')
  assert.equal(state.activeChildId, 'child-1')
})

// ── 多父会话聚合与认领 ──────────────────────────────────────────────────────

test('collectChildren aggregates several parents and skips only the failing one', async () => {
  const ctx = makeCtx({
    subagents: {
      async listChildren(parentId) {
        if (parentId === 'p-bad') throw new Error('gone')
        if (parentId === 'p1') return [{ kind: 'child', id: 'c1', label: '审核 S1 · 10:00:00' }]
        return [{ kind: 'child', id: 'c2', label: '审核 S2 · 11:00:00' }, { kind: 'other', id: 'x' }]
      },
    },
  })
  const collected = await collectChildren(ctx, ['p1', 'p2', 'p-bad'])
  assert.deepEqual(Object.keys(collected.listed).sort(), ['c1', 'c2'])
  assert.equal(collected.parentOf.c1, 'p1')
  assert.equal(collected.parentOf.c2, 'p2')
  assert.equal(collected.labels.c2, '审核 S2 · 11:00:00')
})

test('collectChildren degrades to empty when the service is missing', async () => {
  const collected = await collectChildren(makeCtx(), ['p1'])
  assert.deepEqual(collected, { listed: {}, labels: {}, parentOf: {} })
})

test('makeAgentStatusOf reads the agent status and stays quiet on failure', () => {
  const ok = makeAgentStatusOf(makeCtx({ agents: { get: (id) => (id === 'c1' ? { status: 'running' } : undefined) } }))
  assert.equal(ok('c1'), 'running')
  assert.equal(ok('missing'), '')
  assert.equal(ok(''), '')
  const throwing = makeAgentStatusOf(makeCtx({ agents: { get: () => { throw new Error('boom') } } }))
  assert.equal(throwing('c1'), '')
})

// ── audit-start ─────────────────────────────────────────────────────────────

function startDeps(patch = {}) {
  // 默认已选定工作空间：发起审核的前置门禁，绝大多数用例都需要它。
  // 另外默认给一个**可用的审核根会话**（parent-1）：审核一律挂在它下面，不再看「绑定了哪个会话」。
  const state = makeState({
    workspaceChosen: true,
    workspacePath: '/cases/space',
    auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: '审核子代理根节点 · 01-01 00:00', assignedAt: '' },
    ...(patch.state ?? {}),
  })
  const ctx = patch.ctx ?? makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_provider, request) { return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request } },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { delegationDepth: 0 } } : undefined) },
  })
  return { deps: { ctx, config: CONFIG, state, world: fakeWorld() }, state }
}

test('audit-start refuses without a chosen workspace', async () => {
  // 安全门禁：案例目录由工作空间决定，为空时指令里不会出现「唯一根目录」，
  // 子会话就只能写进它继承的 cwd（常常是源码仓库）。
  const { deps, state } = startDeps({ state: { workspaceChosen: false, workspacePath: '', parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /尚未选定工作空间/)
  assert.equal(state.activeChildId, '', '被拒绝时不得占用门禁')
})

test('audit-start requires a task key', async () => {
  const noKey = startDeps()
  assert.equal((await auditStart(noKey.deps, {})).ok, false)
  // 父级不再由用户登记决定：根会话不可用时是「自动建一个」，不是报错（见 host-audit-root.test.mjs）。
})

test('audit-start refuses when another report is already running', async () => {
  const { deps } = startDeps({ state: { parentSessionId: 'parent-1', activeKey: 'other', activeChildId: 'child-x' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /已有审核在进行中/)
})

test('audit-start hangs off the audit root, not off whichever session was bound', async () => {
  // 用户报的「创建新会话时挂错了」：父级原来是「哪个会话头最后挂载」，于是从工作空间 A 的会话
  // 点开面板，审核就挂到 A 之下。现在父级一律是**审核根会话**（建在插件选定工作空间里的那个）。
  const { deps, state } = startDeps({ state: { parentSessionId: 'some-other-session' } })
  const started = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(started.ok, true)
  assert.equal(started.parentSessionId, 'parent-1', '父级必须是根会话，不是绑定的那个会话')
  assert.equal(state.audits.k.parentSessionId, 'parent-1', '记录里也要记根会话，重启后还能找到这棵树')
})

// ── audit-status / audit-stop / audit-release ───────────────────────────────

test('audit-start refuses a duplicate submission while one is being created', async () => {
  const { deps } = startDeps({ state: { parentSessionId: 'parent-1', startingKey: 'k' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /正在创建/)
})

test('audit-start creates the first attempt and takes the occupancy lock', async () => {
  const { deps, state } = startDeps({ state: { parentSessionId: 'parent-1', workspacePath: '/cases/space' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1', project: '某项目' })
  assert.equal(result.ok, true)
  assert.equal(result.childId, 'child-1')
  assert.equal(result.provider, 'spawn')
  assert.equal(result.attempt, 1)
  assert.equal(result.isRetry, false)
  // 门禁必须立刻被占住：否则同一条报告能被连点起两条子会话，两条对写同一个案例目录。
  assert.equal(state.activeKey, 'k')
  assert.equal(state.activeChildId, 'child-1')
  assert.equal(state.audits.k.attempt, 1)
  assert.equal(state.startingKey, '', '创建结束后要放掉进程内锁')
})

test('a second start for the same report becomes a timestamped restart', async () => {
  const labels = []
  const ctx = makeCtx({
    sessions: { get: (id) => (id === 'parent-1' ? { header: { cwd: '/cases/space' } } : undefined) },
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_provider, request) {
        labels.push(request.label)
        return { id: `child-${labels.length}`, provider: 'spawn', dispose: async () => {}, request }
      },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const first = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(first.ok, true)
  assert.equal(first.attempt, 1)

  const again = await auditStart(deps, { key: 'k', seqNo: 'S1', retry: true })
  assert.equal(again.ok, true)
  assert.equal(again.isRetry, true, '同一条报告再次发起就是重审')
  assert.equal(again.attempt, 2, 'attempt 要递增，界面才有「第 2 次」')
  assert.match(labels[1], /^审核 S1 · \d{2}:\d{2}:\d{2}$/, 'label 带时间戳，同一条报告的多次运行才分得清')
  assert.equal(state.audits.k.childId, 'child-2', '记录指向最新那条子会话')
})

test('audit-start aborts the restart when the stale child cannot be stopped', async () => {
  const ctx = makeCtx({
    // 根会话活着；旧子会话（gone）查不到 —— 于是「停不掉」，这才是本用例要验的事。
    sessions: { get: (id) => (id === 'parent-1' ? { header: { cwd: '/cases/space' } } : undefined) },
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', audits: { k: record({ key: 'k', childId: 'gone', ended: false, stopped: false }) } },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /停不掉/)
  assert.equal(state.activeChildId, '', '中止时不得留下半截状态')
})

test('audit-status adopts a running unclaimed child and restores the lock', async () => {
  const ctx = makeCtx({
    agents: { get: () => ({ status: 'running' }) },
    subagents: { async listChildren() { return [{ kind: 'child', id: 'ghost-1', label: '审核 S9 · 12:00:00' }] } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStatus(deps, {})
  assert.equal(result.ok, true)
  assert.equal(state.audits.S9.childId, 'ghost-1', '还在跑但没有记录的审核必须被认领回来')
  assert.equal(state.audits.S9.adopted, true)
  assert.equal(state.activeChildId, 'ghost-1', '占用锁必须一起恢复，否则能被起第二条')
})

test('audit-status does not adopt a child that already stopped running', async () => {
  // 认领一个已结束的会话 = 凭空造出一条「审核进行中」，门禁被永久锁死。
  const ctx = makeCtx({
    agents: { get: () => ({ status: 'idle' }) },
    subagents: { async listChildren() { return [{ kind: 'child', id: 'done-1', label: '审核 S9 · 12:00:00' }] } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  await auditStatus(deps, {})
  assert.equal(state.audits.S9, undefined)
  assert.equal(state.activeChildId, '')
})

test('audit-status heals a lock that was wrongly released', async () => {
  const ctx = makeCtx({
    agents: { get: () => ({ status: 'running' }) },
    subagents: { async listChildren() { return [] } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1',
      audits: { k: record({ key: 'k', childId: 'child-1', startedAt: new Date().toISOString() }) },
    },
  })
  assert.equal(state.activeChildId, '')
  await auditStatus(deps, {})
  assert.equal(state.activeChildId, 'child-1', '只要真的看到有子会话在跑，门禁必须重新挂回')
})

test('audit-status releases the lock for a finished adopted record', async () => {
  const ctx = makeCtx({
    agents: { get: () => ({ status: 'idle' }) },
    subagents: { async listChildren() { return [{ kind: 'child', id: 'old-1', label: '审核 S1 · 09:00:00' }] } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', activeKey: 'S1', activeChildId: 'old-1' },
  })
  await auditStatus(deps, {})
  assert.equal(state.activeChildId, '', '早就跑完的审核不能把门禁永久锁住')
})

test('audit-status queries the audit root and every recorded parent', async () => {
  const seen = []
  const ctx = makeCtx({
    agents: { get: () => ({ status: 'idle' }) },
    subagents: { async listChildren(parentId) { seen.push(parentId); return [] } },
  })
  const { deps } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-now',
      auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-root', title: '', assignedAt: '' },
      activeKey: 'old',
      activeChildId: 'dead',
      audits: { old: record({ key: 'old', childId: 'dead', parentSessionId: 'parent-then' }) },
    },
  })
  await auditStatus(deps, {})
  // 主查询目标是**审核根会话**：子代理真正挂着的是它，而不是「用户最后看过哪个会话」。
  assert.ok(seen.includes('parent-root'), '根会话一定要查')
  assert.ok(seen.includes('parent-then'), '历史记录里的旧父会话也要查，否则那些记录会集体退化成「未出结果」')
})

test('audit-stop marks the record stopped and releases the lock', async () => {
  const aborts = []
  const ctx = makeCtx({
    agents: { get: () => undefined },
    subagents: { async listChildren() { return [] }, interrupt() {} },
  })
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1',
      activeKey: 'k',
      activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
      runs: { 'child-1': { run: { dispose: async () => {} }, abort: () => { aborts.push('abort') } } },
    },
  })
  const result = await auditStop(deps, {})
  assert.equal(result.ok, true)
  assert.equal(result.key, 'k')
  assert.ok(aborts.includes('abort'))
  assert.equal(state.audits.k.stopped, true)
  assert.equal(state.audits.k.status, 'stopped')
  assert.equal(state.activeChildId, '')
  assert.deepEqual(Object.keys(state.runs), [], '句柄必须清掉')
})

test('audit-stop explains that there is nothing to stop', async () => {
  const { deps } = startDeps({ state: { parentSessionId: 'parent-1' } })
  const result = await auditStop(deps, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /当前没有正在运行的审核子会话/)
})

test('audit-release reports what it released and is idempotent', async () => {
  const { deps, state } = startDeps({ state: { parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1' } })
  assert.deepEqual(await auditRelease(deps), { ok: true, released: 'k' })
  assert.equal(state.activeChildId, '')
  assert.deepEqual(await auditRelease(deps), { ok: true, released: '' })
})
