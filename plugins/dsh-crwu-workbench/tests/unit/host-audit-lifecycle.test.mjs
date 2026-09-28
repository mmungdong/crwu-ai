/**
 * 第 3 层（审核生命周期）的单元测试。
 *
 * 这一层是事故高发区，每条规则都对应一次真实故障：
 * 「状态跟丢」、两条子会话交叉写同一案例目录、锁被永久占住、点两次起两条。
 * 所以这里全部是**反向**验证：把坏情况摆出来，确认它被挡住或自愈。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect } from '../helpers/shell-effects.mjs'

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
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
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

/**
 * ctx：fs 内存化、sessions/agents/subagents 按需注入。
 *
 * `trace` 是**跨面的事件流水**（shell 命令 / Tool 调用 / 子代理创建），用例据此断言
 * 顺序 —— 「先建案例目录，再交接快照，最后建子代理」这种次序只能靠它证明。
 * shell 默认成功（`patch.shellFails: true` 才模拟命令跑失败）。
 */
function makeCtx({ sessions, agents, subagents, dirs = [], files = {}, entries = [], patch = {}, trace = [] } = {}) {
  const directories = new Set(dirs)
  const listDirs = { ...entries }
  /** 工具调用流水（用例据此断言各只调一次、agent scope 传对了）。 */
  const toolCalls = []
  const ctx = {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(request) {
            const command = String(request?.command ?? '')
            trace.push({ kind: 'shell', command })
            const exitCode = patch.shellFails === true ? 1 : 0
            // 让成功的建/删命令在 fs 替身上真的生效：实现会回读后置条件（见 helpers/shell-effects.mjs）。
            applyShellEffect(command, exitCode, {
              addDir: (path) => directories.add(path),
              removeFile: (path) => { delete files[path] },
            })
            return { result: async () => ({ exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: exitCode === 0 ? '' : 'stub', truncated: false } }) }
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
      if (name === 'tools') {
        // 审核发起前要真走一遍 registry：`get` 回答可见性，`execute` 依次真调
        // `crwu_audit_capabilities`（能力预检）与 `crwu_audit_case_bootstrap`（输入快照交接）。
        // 替身必须同时提供这两个面，并且**记下调用**，用例才能断言「各只调一次」。
        return {
          get: () => ({ name: 'crwu_audit_capabilities' }),
          async execute(input) {
            toolCalls.push({ name: input.name, arguments: input.arguments, agent: input.agent })
            trace.push({ kind: 'tool', name: input.name })
            if (input.name === 'crwu_audit_case_bootstrap') {
              if (patch.bootstrapFails === true) {
                return { isError: false, value: { ok: false, errorKind: 'cli', error: '取数失败：记录接口没跑起来' } }
              }
              const args = input.arguments ?? {}
              return {
                isError: false,
                value: {
                  ok: true, errorKind: '', error: '', reused: false,
                  attemptId: args.attemptId ?? '', objectId: args.objectId ?? '', seqNo: args.seqNo ?? '',
                  schemaCodeDigest: 'sha256:0000000000000000', fetchedAt: '2026-09-25T00:00:00.000Z',
                  digest: 'sha256:1111111111111111', fieldCount: 7, attachmentCount: 2,
                  snapshotDir: `${args.caseDir}/输入快照`,
                  snapshotPath: `${args.caseDir}/输入快照/报告记录.json`,
                  attachmentsPath: `${args.caseDir}/输入快照/附件清单.json`,
                  metadataPath: `${args.caseDir}/输入快照/快照元数据.json`,
                  routingFacts: {
                    project: '某项目', business: '', risk: '', reviewLevel: '', reviewState: '',
                    currentNode: '', modifiedAt: '', seqNo: args.seqNo ?? '', formName: '报告审核',
                  },
                },
              }
            }
            return { isError: false, value: { ok: true, platform: 'darwin-arm64', binPlatform: 'darwin-arm64' } }
          },
        }
      }
      return undefined
    },
  }
  // 保持原契约：`makeCtx()` 返回的就是 ctx（用例直接当 ctx 用），工具调用流水挂在它上面。
  return Object.assign(ctx, { toolCalls, trace })
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
  // 表单解析器与 DSH Python 的替身：审核启动必须在**创建子代理之前**先过这两关。
  const form = patch.form ?? {
    ensure: async () => ({ ok: true, code: 'FORM-1', name: '报告审核', error: '', escalated: false }),
  }
  const python = patch.python ?? {
    cached: () => null,
    check: async () => ({
      ok: true, state: 'ok', path: '/dsh/runtime/python/bin/python3', versionText: '3.12.4',
      distributions: { openpyxl: '3.1.5' }, missingPackages: [], error: '', source: 'stub',
    }),
  }
  return { deps: { ctx, config: CONFIG, state, world: fakeWorld(), form, python }, state }
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

// ── 审核启动的「报告定位交接」（2026-09-25） ────────────────────────────────

/** 记录表单解析器被问了几次、以及它是否成功。 */
function formSpy(options = {}) {
  const calls = []
  return {
    calls,
    resolver: {
      async ensure() {
        calls.push('ensure')
        if (options.fails === true) return { ok: false, code: '', name: '', error: '未在氚云定位到表单「报告审核」', escalated: false }
        return { ok: true, code: 'FORM-1', name: '报告审核', error: '', escalated: false }
      },
    },
  }
}

test('formCode 已缓存时，启动审核不再去发现表单', async () => {
  // 列表早就定位过表单（`state.formCode` 非空）→ 启动这一步必须是零成本复用，
  // 而不是再搜一次（实测搜一次要十几到六十秒）。
  const spy = formSpy()
  const { deps } = startDeps({ form: spy.resolver, state: { parentSessionId: 'parent-1', formCode: 'FORM-1', formName: '报告审核' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true)
  // 缓存的判断在解析器内部（同一份实现），所以这里断言的是「解析器真的被问到、且它只回缓存」——
  // 真正的「不再 discoverForm」由 host-h3yun-pending.test.mjs 用真实 resolver 钉住。
  assert.deepEqual(spy.calls, ['ensure'])
})

test('定位表单失败时在创建子代理之前终止', async () => {
  const spy = formSpy({ fails: true })
  const { deps, state } = startDeps({ form: spy.resolver, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /无法定位氚云表单/)
  assert.equal(state.activeChildId, '', '定位失败不得占用门禁')
  assert.equal(state.audits.k, undefined, '也不得留下审核记录')
})

test('输入快照交接失败时在创建子代理之前终止', async () => {
  const ctx = makeCtx({
    patch: { bootstrapFails: true },
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /输入快照交接未完成/)
  assert.match(result.error, /取数失败/)
  assert.equal(state.activeChildId, '')
})

test('启动审核先由 Host 建出案例目录，再交接快照，最后才建子代理', async () => {
  // 2026-09-28 用户报的真实故障：新报告的 `<工作空间>/<流水号>` 谁都没建过，
  // 而 `crwu_audit_case_bootstrap` 与全部案例内 Tool 都要过 `requireCaseDir`（要求目录已存在），
  // 于是新报告一律卡在「案例目录不存在或不是目录」。旧形态是审核子代理自己 `mkdir -p`，
  // 改成结构化 Tool 之后那条路没了 —— 这一步必须由 Host 在**创建子代理之前**补上。
  const trace = []
  const ctx = makeCtx({
    trace,
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_provider, request) { trace.push({ kind: 'start' }); return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request } },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { delegationDepth: 0 } } : undefined) },
  })
  const { deps } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const started = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(started.ok, true)

  const mkdirAt = trace.findIndex((event) => event.kind === 'shell' && event.command.includes('/cases/space/S1'))
  const bootstrapAt = trace.findIndex((event) => event.kind === 'tool' && event.name === 'crwu_audit_case_bootstrap')
  const startAt = trace.findIndex((event) => event.kind === 'start')
  assert.notEqual(mkdirAt, -1, 'Host 必须建案例目录（mkdir -p 工作空间下的流水号目录）')
  assert.match(trace[mkdirAt].command, /mkdir -p/, '目录已存在时不能报错（重审会再走一次）')
  assert.notEqual(bootstrapAt, -1, '输入快照交接必须发生')
  assert.equal(mkdirAt < bootstrapAt, true, '快照要落进案例目录，必须先有目录')
  assert.equal(bootstrapAt < startAt, true, '交接失败必须在创建子代理之前终止')
})

test('案例目录建不出来时在创建子代理之前终止', async () => {
  const ctx = makeCtx({
    patch: { shellFails: true },
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /创建案例目录失败/)
  assert.match(result.error, /\/cases\/space\/S1/)
  assert.equal(state.activeChildId, '', '目录都没建出来就不许占用门禁')
})

test('DSH Python 不可用时在创建子代理之前终止（不许退回系统 python3）', async () => {
  const { deps, state } = startDeps({
    state: { parentSessionId: 'parent-1' },
    python: {
      cached: () => null,
      check: async () => ({
        ok: false, state: 'missing-package', path: '/dsh/runtime/python/bin/python3', versionText: '3.12.4',
        distributions: {}, missingPackages: ['openpyxl'], error: 'DSH 自带 Python 缺少审核脚本必需的包：openpyxl',
        source: 'stub',
      }),
    },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /DSH 脚本运行时不可用/)
  assert.match(result.error, /openpyxl/)
  assert.equal(state.activeChildId, '')
})

test('启动审核：bootstrap 只调一次、agent scope 传的是审核根 Agent、attemptId 每轮都新', async () => {
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running', ctx: { scoped: 'parent-1' } } : undefined) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start(_p, request) { return { id: `child-${Math.random().toString(36).slice(2, 8)}`, provider: 'spawn', dispose: async () => {}, request } } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const first = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1', project: '某项目' })
  assert.equal(first.ok, true)

  const bootstrapCalls = ctx.toolCalls.filter((call) => call.name === 'crwu_audit_case_bootstrap')
  assert.equal(bootstrapCalls.length, 1, '一个 attempt 只交接一次输入快照')
  assert.equal(bootstrapCalls[0].agent.id, 'parent-1', '必须用审核根 Agent 当 scope（走完整 policy pipeline）')
  assert.equal(bootstrapCalls[0].arguments.caseDir, '/cases/space/S1', '案例目录 = 工作空间 + 流水号')
  assert.equal(bootstrapCalls[0].arguments.objectId, 'o1')
  assert.equal(bootstrapCalls[0].arguments.refresh, false, '首次审核不强制刷新')
  const firstAttempt = String(bootstrapCalls[0].arguments.attemptId)
  assert.match(firstAttempt, /^k-a1-/)

  // 重审：新 attemptId + 强制刷新，绝不复用上一轮的输入快照。
  const again = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1', retry: true })
  assert.equal(again.ok, true)
  const second = ctx.toolCalls.filter((call) => call.name === 'crwu_audit_case_bootstrap')[1]
  assert.equal(second.arguments.refresh, true, '重审必须重新取数覆盖本轮快照')
  assert.notEqual(String(second.arguments.attemptId), firstAttempt, 'attemptId 必须每轮都新')
  assert.match(String(second.arguments.attemptId), /^k-a2-/)
})

test('审核启动把快照路径与 DSH Python 一起写进子代理指令', async () => {
  let prompt = ''
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        // `startChild` 把指令包成 content block 数组（DSH 的 UserMessage 形状），不是裸字符串。
        prompt = Array.isArray(request.prompt)
          ? request.prompt.map((block) => String(block?.text ?? '')).join('\n')
          : String(request.prompt ?? '')
        return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request }
      },
    },
  })
  const { deps } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true)
  assert.match(prompt, /报告已由 Host 精确定位/)
  assert.match(prompt, /\/cases\/space\/S1\/输入快照\/报告记录\.json/)
  assert.match(prompt, /sha256:1111111111111111/)
  assert.match(prompt, /脚本运行时：只用 DSH 自带的 Python/)
  assert.match(prompt, /\/dsh\/runtime\/python\/bin\/python3/)
  // 仍然不许出现基础设施细节：schemaCode、插件 bin、PATH 注入、裸命令
  assert.equal(/schemaCode\s*[:=]\s*[A-Za-z0-9]{8,}/.test(prompt), false, '原文 schemaCode 不得出现')
  assert.equal(prompt.includes('bin/darwin-arm64'), false)
  assert.equal(prompt.includes('export PATH'), false)
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

// ── 能力门禁（在创建子代理之前）──────────────────────────────────────────────

/**
 * 这两条盯的是「**不许只靠提示词**」：子代理看不到必需的 CRWU Tool 时，
 * 插件必须在 `subagents.start` 之前失败，而不是让它跑起来再自己去 shell 里找命令。
 */
function gateDeps(tools) {
  const spawned = []
  const state = makeState({
    workspaceChosen: true,
    workspacePath: '/cases/space',
    auditRoot: { workspacePath: '/cases/space', sessionId: 'parent-1', title: '', assignedAt: '' },
  })
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? { id, status: 'running' } : undefined) },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { cwd: '/cases/space' } } : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_provider, request) { spawned.push(request); return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request } },
    },
  })
  // `tools` 由这两个用例注入；其它服务走 makeCtx 的默认面。
  const original = ctx.get
  ctx.get = (name) => (name === 'tools' ? tools : original(name))
  return { deps: { ctx, config: CONFIG, state, world: fakeWorld() }, state, spawned }
}

test('audit-start refuses before spawning when a required tool is invisible', async () => {
  const { deps, spawned } = gateDeps({
    get: (name) => (name === 'crwu_audit_oss_publish' ? undefined : { name }),
    async execute() { return { isError: false, value: { ok: true } } },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /crwu_audit_oss_publish/, '必须点名缺失的工具')
  assert.equal(spawned.length, 0, '工具不可见时绝不许创建子代理')
})

test('audit-start refuses before spawning when the capability preflight reports a gap', async () => {
  const { deps, spawned } = gateDeps({
    get: (name) => ({ name }),
    async execute() {
      return {
        isError: false,
        value: {
          ok: false, errorKind: 'capability-gap', error: '包内缺少二进制：dws',
          pluginVersion: '0.0.7', platform: 'darwin-arm64', binPlatform: '',
          supportedPlatforms: [], binaries: [], tools: [],
          policy: { credentialsTrusted: false, workspaceKnown: true, pathSearchForAuditCli: false, sandboxEscalation: '' },
          dwsCommands: [],
        },
      }
    },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /审核能力预检未通过/)
  assert.match(result.error, /capability gap/)
  assert.equal(spawned.length, 0, '能力缺失时绝不许创建子代理')
})
