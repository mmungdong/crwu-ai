/**
 * 第 3 层（审核生命周期）的单元测试。
 *
 * 这一层是事故高发区，每条规则都对应一次真实故障：
 * 「状态跟丢」、两条子会话交叉写同一案例目录、锁被永久占住、点两次起两条。
 * 所以这里全部是**反向**验证：把坏情况摆出来，确认它被挡住或自愈。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../helpers/shell-effects.mjs'

const ROOT = new URL('../../', import.meta.url)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { makeAuditAgent, makeAuditSession, auditPolicyServices, subagentProviderStub } = await import(
  new URL('tests/helpers/audit-policy-fixture.mjs', ROOT).href)

const { auditStart, auditStop, auditStatus, auditRelease } = await import(new URL('src/host/audit/ops.ts', ROOT).href)
const { AUDIT_CHILD_DENIED_TOOLS, REQUIRED_AUDIT_CHILD_TOOLS } = await import(new URL('src/host/tools/consts.ts', ROOT).href)
const { auditToolsVisible } = await import(new URL('src/host/audit/preflight.ts', ROOT).href)
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
/**
 * 一个"健康部署"的 agents 替身：根 + **任意**子 id 都能读到正确 cwd/策略的 child Agent。
 *
 * `absent` 列出的 id 返回 `undefined`（模拟"注册表里查不到、已结束"），
 * `childOptions` 用来改状态（例如 `{ status: 'idle' }` 让停止判定直接确认静默）。
 */
/**
 * 等到这条审核的停止流程收敛。
 *
 * F1 起 `audit-stop` 是**两阶段**的：RPC 只接受请求（立刻返回 phase=requested），
 * abort → dispose → 静默复查在后台跑，阶段逐段落盘。测试要断言最终结论就必须等它。
 */
async function settleStop(deps, childId) {
  const task = deps.state.stopInFlight?.[childId]
  if (task !== undefined) await task
}

function agentsServingChild({ absent = [], childOptions = {} } = {}) {
  return {
    get: (id) => {
      if (id === 'parent-1') return rootAgentOf()
      if (absent.includes(id)) return undefined
      return makeAuditAgent(
        makeAuditSession({ cwd: '/cases/space', mode: 'workspace-write', policy: 'never' }),
        { id, status: 'running', ...childOptions },
      )
    },
  }
}

// `dirs` 缺省包含工作空间本身：审核启动会先只读探测它（`system.workspace-directory.read`），
// 不存在就不建案例目录 —— 替身必须如实回答，否则每个用例都会撞在"工作空间不存在"上。
function makeCtx({ sessions, agents, subagents, dirs = ['/cases/space'], files = {}, entries = [], patch = {}, trace = [], preset } = {}) {
  const directories = new Set(dirs)
  const policyServices = auditPolicyServices({ ...(preset === undefined ? {} : { preset }) })
  // 审核启动现在要求 provider **声明支持 `toolFilter`**（真边界：deny 的工具既不进 prompt、也拒绝执行）。
  // 夹具在这里统一补上，用例自己的 `getProvider` 优先。
  // 默认的 agents 替身：根 Agent 就绪，**并且**任何未知 id 都当成"那个已发布的子会话"，
  // 且 cwd/策略都是本轮案例目录的正确值 —— 这正是真实 in-process provider 兑现时的形态。
  // 用例要测"读不到 child Agent"时显式传自己的 agents 替身。
  const defaultChildAgent = () => makeAuditAgent(
    makeAuditSession({ cwd: '/cases/space', mode: 'workspace-write', policy: 'never' }),
    { id: 'child-1', status: 'running' },
  )
  const agentsService = agents ?? {
    get: (id) => (id === 'parent-1' ? rootAgentOf() : defaultChildAgent()),
  }
  const base = subagents === undefined
    ? undefined
    : Object.assign({ getProvider: () => subagentProviderStub() }, subagents)
  // `start()` 的兑现要带上 `localAgent`（真实 in-process provider 就是这么给的）；
  // 夹具统一补，避免每条用例各写一遍 —— 也避免"忘了写"导致整条审核被 fail closed 拦掉。
  const subagentsService = base === undefined ? undefined : {
    ...base,
    async start(provider, request) {
      const started = await base.start(provider, request)
      if (started === null || typeof started !== 'object') return started
      if (started.localAgent !== undefined) return started
      const child = agentsService?.get?.(started.id)
      return child === undefined ? started : { ...started, localAgent: child }
    },
  }
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
            // `shellFails`：所有命令都失败（探测也失败 → 必须报"无法确认"，不是"不存在"）。
            // `mkdirFails`：只让建目录那一条失败（探针正常）—— 验的是写失败那条路。
            const exitCode = patch.shellFails === true
              ? 1
              : (patch.mkdirFails === true && command.startsWith('mkdir') ? 1 : 0)
            // 让成功的建/删命令在 fs 替身上真的生效：实现会回读后置条件（见 helpers/shell-effects.mjs）。
            applyShellEffect(command, exitCode, {
              addDir: (path) => directories.add(path),
              removeFile: (path) => { delete files[path] },
            })
            // 只读路径探测：替身按内存 fs 如实回答（实现用它回读后置条件 / 探测工作空间）。
            const probe = exitCode === 0
              ? probeAnswer(command, {
                hasDir: (path) => directories.has(probeKey(path)),
                hasFile: (path) => files[path] !== undefined || files[probeKey(path)] !== undefined,
              })
              : undefined
            const stdout = probe ?? ''
            return { result: async () => ({ exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: stdout, truncated: false }, stderr: { text: exitCode === 0 ? '' : 'stub', truncated: false } }) }
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
      if (name === 'agents') return agentsService
      if (name === 'subagents') return subagentsService
      // 协议 18 · C：审核根与子代理的沙箱/审批策略事实由 DSH 的三个服务回答。
      if (name === 'sandboxPolicy') return policyServices.sandboxPolicy
      if (name === 'approval') return policyServices.approval
      if (name === 'permissionPresets') return policyServices.permissionPresets
      if (name === 'tools') {
        // 审核发起前要真走一遍 registry：`get` 回答可见性，`execute` 依次真调
        // `crwu_audit_capabilities`（能力预检）与 `crwu_audit_case_bootstrap`（输入快照交接）。
        // 替身必须同时提供这两个面，并且**记下调用**，用例才能断言「各只调一次」。
        return {
          // ⚠️ 必须**真的模拟 `toolFilter`**：子会话看不到被 deny 的三条（bootstrap 是其中一条）。
          // 夹具若对任何 agent 都回答"可见"，那"子会话复查用错必需集"这类缺陷永远不会红
          //（2026-09-29 第三轮复查的 P1 就是这么漏掉的）。
          get: (name, agent) => {
            const scopeId = agent?.id
            if (scopeId !== undefined && scopeId !== 'parent-1'
              && AUDIT_CHILD_DENIED_TOOLS.includes(name)) return undefined
            return { name: 'crwu_audit_capabilities' }
          },
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

/**
 * 一个**策略已收敛**的可用审核根（协议 18 · C）。
 *
 * 根不可用的后果是"去建一个新的" —— 那会走 `agents.create`，多数用例并不覆盖那条路。
 * 所以这里的根必须同时满足：Agent 活着、cwd 是工作空间、**沙箱 workspace-write + 审批 never**。
 */
// 审核根的 cwd **就是本轮的案例目录**（协议 19 起）：子会话继承它，沙箱边界也钉在它上面。
// 夹具里默认 seqNo 是 S1，所以案例目录是 `/cases/space/S1`。
const rootAgentOf = (extra = {}) => makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), { id: 'parent-1', status: 'running', ...extra })

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
  // Windows：`split('/')` 会把整条路径当成目录名（界面上的案例名变成一长串）。
  assert.equal(caseNameOf('C:\\Cases\\2026-301705-LX10170-BG8746\\'), '2026-301705-LX10170-BG8746')
  assert.equal(caseNameOf('C:/Cases/2026-301705-LX10170-BG8746'), '2026-301705-LX10170-BG8746')
  assert.equal(caseNameOf('\\\\server\\share\\S1'), 'S1')
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
    // ⚠️ 根的 `casePath` 必须与用例的 seqNo 一致（默认 S1）：它是复用判据的锚，
    // 空串会被当成"工作空间级旧根"→ 过期 → 代码会去新建一个根。
    auditRoot: { workspacePath: '/cases/space', casePath: '/cases/space/S1', sessionId: 'parent-1', title: '审核子代理根节点 · 01-01 00:00', assignedAt: '' },
    ...(patch.state ?? {}),
  })
  const ctx = patch.ctx ?? makeCtx({
    // 工作空间**真实存在**：审核启动会先只读探测它（`system.workspace-directory.read`），
    // 不存在就不建案例目录。替身必须如实回答，否则每个用例都会撞在"工作空间不存在"上。
    dirs: ['/cases/space'],
    // 健康部署的默认面：根 Agent 就绪，子 Agent 也可读（正确 cwd/策略）—— 审核子会话的
    // 沙箱/审批/工具可见性复查现在**必须**读到它（读不到就 fail closed，2026-09-29 第三轮复查的 P1）。
    // 要测"读不到"的用例显式传自己的 agents 替身。
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
  return { deps: { ctx, config: CONFIG, state, world: fakeWorld(), access: makeTestAccess(ctx).access, form, python }, state }
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
  const { deps, state } = startDeps({ form: spy.resolver, state: { parentSessionId: 'parent-1', formCode: 'FORM-1', formName: '报告审核' } })
  // 上一轮失败留下的记录：发起成功必须把它清掉（它只描述"最近一次失败"）。
  state.lastAuditFailure = {
    at: '2026-09-30T00:00:00.000Z', reason: '上一轮的失败', stage: '输入快照', errorKind: 'sandbox',
    seqNo: 'S1', objectId: 'o1', caseDir: '/cases/space/S1', attemptId: '', notes: [],
  }
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true)
  assert.equal(state.lastAuditFailure, undefined, '发起成功要清掉上一次的失败记录')
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
    agents: agentsServingChild(),
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
    agents: agentsServingChild(),
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

  // §8-8（2026-09-30 口径）：审核启动**不得**创建工作空间根目录 —— 只允许建本轮案例目录。
  // 判据是真实 shell 轨迹：没有一条命令的目标恰好是工作空间根。
  const shellCommands = trace.filter((event) => event.kind === 'shell').map((event) => String(event.command))
  assert.equal(
    shellCommands.some((command) => /mkdir[^\n]*\/cases\/space(?![\w/-])/.test(command)),
    false,
    `审核启动不许 mkdir 工作空间根目录，实际跑了：${shellCommands.join(' | ')}`,
  )
  assert.equal(
    shellCommands.some((command) => command.includes('/cases/space/S1')),
    true,
    '案例目录仍然由 Host 建（这是允许创建的那一级）',
  )
})

test('案例目录建不出来时在创建子代理之前终止（不许留下"审核已启动"的假状态）', async () => {
  const trace = []
  const ctx = makeCtx({
    trace,
    patch: { mkdirFails: true },
    agents: agentsServingChild(),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /创建案例目录失败/)
  assert.match(result.error, /\/cases\/space\/S1/)
  assert.equal(state.activeChildId, '', '目录都没建出来就不许占用门禁')
  assert.equal(state.activeKey, '')
  assert.equal(state.audits.k, undefined, '不许留下"在跑"的记录')
  // 失败原因要**能归因**：带上操作名与工作空间，而不是一句裸的 `mkdir: ...`（§三 的要求）。
  assert.match(result.error, /system\.case-directory\.write/)
  assert.match(result.error, /\/cases\/space/)
  // **失败必须留档**（2026-09-30 加）：界面上只有一句话，进程一重启就没了 ——
  // 真机连挂三次都是靠"复现 + 读代码"倒推。这里把全部结构化事实钉在 `state.lastAuditFailure` 上。
  const recorded = state.lastAuditFailure
  assert.notEqual(recorded, undefined, '失败必须落一条记录')
  assert.equal(recorded.stage, '案例目录', '卡在哪一步要由代码说，不从文案里猜')
  // 归因是**照抄**工具回报的结构化 `errorKind`，不是在这里按文案猜：
  // 这个夹具让 mkdir 直接失败、不带沙箱事实，所以正确答案是 infrastructure
  //（带沙箱事实的那一支见 `host-case-files.test.mjs` 与 `host-tools.test.mjs`：那里是 sandbox）。
  assert.equal(recorded.errorKind, 'infrastructure')
  assert.equal(recorded.seqNo, 'S1')
  assert.equal(recorded.objectId, 'o1')
  assert.match(recorded.reason, /创建案例目录失败/)
  assert.match(recorded.caseDir, /\/cases\/space\/S1/)
  assert.equal(typeof recorded.at, 'string')
  // §8.2 的严格顺序：失败这一步之后，**一个后续步骤都不许发生**。
  assert.equal(trace.some((event) => event.kind === 'tool'), false, '不许交接输入快照')
  assert.equal(trace.some((event) => event.kind === 'start'), false, '不许创建子代理')
  assert.equal(trace.some((event) => event.kind === 'shell' && event.command.includes('files list')), false,
    '目录都不存在，更不该去取数')
})

test('工作空间探测**没有结论**时如实说"无法确认"，不许说成"工作空间不存在"', async () => {
  // 这一条是 2026-09-30 复查抓到的：探测命令自己失败（shell 服务没起来 / 被沙箱拦下）时，
  // 折叠成"所选工作空间不存在"会把一次宿主侧的拒绝说成"员工选错了目录"，
  // 让员工去重选一个本来没错的目录 —— 正是错误分类要消灭的那种误诊。
  const trace = []
  const ctx = makeCtx({
    trace,
    patch: { shellFails: true },
    agents: agentsServingChild(),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /无法确认所选工作空间是否存在/)
  assert.equal(/所选工作空间不存在/.test(result.error), false, '不许把"查不出来"说成"不存在"')
  // 归因要带上探测那条操作（而不是一句裸报错）。
  assert.match(result.error, /system\.workspace-directory\.read/)
  assert.equal(state.audits.k, undefined)
  assert.equal(trace.some((event) => event.kind === 'start'), false)
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

test('宿主**没问到**运行时（unresolved）不再拒绝启动：交给子会话自己解析', async () => {
  // 2026-09-29 员工实测：宿主（启动/自检）没有会话作用域 → 那个工具必报错。
  // 「没问到」不等于「缺失」：子会话有作用域，能在那里解析出来，所以不该卡在启动。
  const { deps, state } = startDeps({
    state: { parentSessionId: 'parent-1' },
    python: {
      cached: () => null,
      check: async () => ({
        ok: false, state: 'capability-gap', unresolved: true, path: '', versionText: '',
        distributions: {}, missingPackages: [],
        error: '调用 load_workspace_dependencies 失败：agent scope required', source: 'stub',
      }),
    },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  // 关键：错误**不是**"DSH 脚本运行时不可用"那一条（那条只在确实缺失时出现）。
  if (result.ok === false) assert.doesNotMatch(result.error, /DSH 脚本运行时不可用/, result.error)
})

test('启动审核：bootstrap 只调一次、agent scope 传的是审核根 Agent、attemptId 每轮都新', async () => {
  const ctx = makeCtx({
    // 根 Agent 要带 `ctx`（scope）：输入快照那一步断言的是「传给 Tool 的 agent 就是审核根」。
    agents: agentsServingChild(),
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
    agents: agentsServingChild(),
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

test('C-03 正向：**可见**且策略正确的子会话必须正常启动（不许被判错停掉）', async () => {
  // 2026-09-29 用户复查的 P1：child policy 复查一度拿 `workspacePath` 当期望值，
  // 而协议 19 之后子会话的边界/cwd 是**案例目录** —— 于是每一个正常可见的子会话都会被稳定判错并停掉。
  // 旧夹具的 `agents.get()` 只返回根 Agent，整段复查被跳过，所以这条永远绿；这里**真的返回 child**。
  const disposed = []
  const childSession = makeAuditSession({ cwd: '/cases/space', mode: 'workspace-write', policy: 'never' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        if (id === 'child-1') return makeAuditAgent(childSession, { id, status: 'running' })
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        return { id: 'child-1', provider: 'spawn', dispose: async () => { disposed.push('child-1') }, request }
      },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { cwd: '/cases/space', delegationDepth: 0 } } : undefined) },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true, result.error)
  assert.equal(disposed.length, 0, '策略正确的子会话不许被停掉')
  assert.equal(state.activeChildId, 'child-1', '占用锁要落在它身上')
})

test('C-03 · 子会话发布后复查策略：不对就停掉它（不带着错的边界跑完）', async () => {
  // 安全性来自"创建前把根设对并验证过"；发布后这次复查是为了**证伪**那一步。
  // 真读到不对（比如某个 preset 把边界换掉了）就停掉 —— 让一条越界的审核跑完，
  // 后果是它写到了工作区外面的东西上，那比"这次审核没跑成"严重得多。
  const stopped = []
  const disposed = []
  // 子会话的 **abort 信号**与 **run 句柄**：`stopChild` 的两个可观察效果。
  // 只断言错误文案是不够的 —— 把 stopChild 那一行删掉，错误文案与锁清理照样成立，
  // "不让一条越界的审核跑完"就成了一句无法证伪的话（2026-09-29 复查抓到）。
  let childSignal
  const childSession = makeAuditSession({ cwd: '/cases/space', mode: 'danger-full-access' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        if (id === 'child-1') return makeAuditAgent(childSession, { id, status: 'running' })
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        childSignal = request.signal
        return { id: 'child-1', provider: 'spawn', dispose: async () => { disposed.push('child-1') }, request }
      },
      async interrupt() { stopped.push('interrupt') },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /子代理的策略不符合要求/)
  assert.match(result.error, /danger-full-access/)
  assert.match(result.error, /已停止该子会话/)
  assert.equal(childSignal?.aborted, true, '复查发现策略不对时必须真的中止子会话（abort 信号）')
  assert.deepEqual(disposed, ['child-1'], '并且要释放它的 run 句柄')
  // 第三个可观察效果：`interrupt` 也发过一次（句柄没了的退路才是 agents.cancel）。
  assert.deepEqual(stopped, ['interrupt'], '停止时要走一次 subagents.interrupt')
  assert.equal(state.activeChildId, '', '策略不对时不得留下占用锁')
  assert.equal(state.audits.k, undefined, '也不得留下审核记录')
})

test('C-03b · 子会话的工具可见性复查：根本可见、**子会话 scope 不可见**时也要停掉它', async () => {
  // 硬门禁四（child scope）：`provider` 可能在子会话上再收窄一次。根 Agent 可见
  // **不等于**子代理可见 —— 而"子代理自己去找 PATH 上的命令"正是这套改造要消灭的行为，
  // 所以这条复查必须真的停掉子会话，不只是回一个错。
  const disposed = []
  let childSignal
  const childSession = makeAuditSession({ cwd: '/cases/space' })
  const childAgent = makeAuditAgent(childSession, { id: 'child-1', status: 'running' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        if (id === 'child-1') return childAgent
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        childSignal = request.signal
        return { id: 'child-1', provider: 'spawn', dispose: async () => { disposed.push('child-1') }, request }
      },
    },
  })
  // 只有在**子会话 scope** 下 `crwu_audit_oss_publish` 不可见（根 scope 一切正常）。
  const original = ctx.get
  ctx.get = (name) => {
    const base = original(name)
    if (name !== 'tools') return base
    return {
      ...base,
      get: (toolName, agent) => (agent === childAgent && toolName === 'crwu_audit_oss_publish'
        ? undefined
        : { name: toolName }),
    }
  }
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /crwu_audit_oss_publish/, '必须点名子会话里缺失的那个工具')
  assert.match(result.error, /已停止该子会话/)
  assert.equal(childSignal?.aborted, true, '必须真的中止子会话')
  assert.deepEqual(disposed, ['child-1'], '并且要释放它的 run 句柄')
  assert.equal(state.activeChildId, '', '失败后不得留下占用锁')
})

test('硬门禁二：**别的报告**在跑时拒绝第二条（同一条走重启，但跨报告绝不放行）', async () => {
  // 模块头的第 2 条门禁是"单条并发"。这个门禁有**两个方向**，此前只有"同一条报告 → 带时间戳重启"
  // 那一个方向有用例；"另一条报告正在跑 → 拒绝"没有任何证据（删掉那段 if 也不会红）。
  // 放行的后果很具体：两条子会话往**同一个案例目录**对写交付件。
  let starts = 0
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { starts += 1; return { id: 'child-2', provider: 'spawn', dispose: async () => {}, request: {} } },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { delegationDepth: 0 } } : undefined) },
  })
  const { deps, state } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', activeChildId: 'child-running', activeKey: 'other-report', activeSince: 1 },
  })
  const result = await auditStart(deps, { key: 'k-new', seqNo: 'S2', objectId: 'o2', project: '另一个项目' })
  assert.equal(result.ok, false, '别的报告在跑时必须拒绝')
  assert.match(result.error, /同一时间只允许一条/)
  assert.equal(starts, 0, '被拒绝时一个子代理都不许起')
  // 原有占用必须**原样保留**（不能被这次尝试覆盖或释放）。
  assert.equal(state.activeKey, 'other-report')
  assert.equal(state.activeChildId, 'child-running')
  assert.equal(state.startingKey, '', '进程内锁必须在 finally 里放掉（否则再也发不起来）')
})

test('门禁顺序：并发冲突**先于**能力预检 —— 冲突时零预检、报的也是冲突', async () => {
  // 源码注释（`audit/ops.ts` 硬门禁三）："放在占用门禁之后：并发冲突是更早、更便宜的拒绝理由，
  // 不该被能力检查的耗时挡在后面。" 顺序被换掉的表现不是"错了"，而是员工先等一轮昂贵预检、
  // 再看到一条与真正原因无关的错误 —— 所以顺序本身要可证伪：
  // 同时制造"有别的报告在跑"与"环境不就绪"，断言报的是**并发**，且预检一次都没跑。
  let starts = 0
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { starts += 1; return { id: 'child-2', provider: 'spawn', dispose: async () => {}, request: {} } },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { delegationDepth: 0 } } : undefined) },
  })
  const { deps } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', activeChildId: 'child-running', activeKey: 'other-report' },
  })
  let readinessCalls = 0
  const result = await auditStart(
    { ...deps, readiness: async () => { readinessCalls += 1; return { ok: false, error: '本机访问尚未允许' } } },
    { key: 'k-new', seqNo: 'S2', objectId: 'o2' },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /同一时间只允许一条/, '冲突要报冲突，不许报成环境问题')
  assert.equal(result.error.includes('环境已不就绪'), false, '错误必须是更早、更便宜的那一条')
  assert.equal(starts, 0)
  assert.equal(readinessCalls, 0, '占用门禁要在预检之前：冲突时预检一次都不该跑')
  // 光看 `readiness` 还不够：它是**排在能力预检之后**的一道门。这条注释说的是
  // "不该被**能力检查**的耗时挡在后面"，所以判据必须落在**工具真的被调用**上 ——
  // 只断言 readiness 的话，把占用门禁挪到能力预检之后仍然全绿（实测）。
  assert.deepEqual(ctx.toolCalls, [], '冲突时一个结构化 Tool 都不许调（能力预检要整个跳过）')
})

test('C-07 · 创建子代理之前环境已不就绪：终止，且一个子代理都不起', async () => {
  // 到这一步之前已经花掉了策略收敛、工具预检、能力自检与输入快照四段外部调用；
  // 期间"允许本机访问"可能被撤销、工作空间可能被换掉。带着过期事实起一条审核的后果不是
  // "晚点失败"，而是**一条注定拿不到凭据的审核**（它会把「未登录」当结论写进交付件）。
  let starts = 0
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { starts += 1; return { id: 'child-1', provider: 'spawn', dispose: async () => {} } },
    },
    sessions: { get: (id) => (id === 'parent-1' ? { header: { delegationDepth: 0 } } : undefined) },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(
    { ...deps, readiness: async () => ({ ok: false, error: '本机访问尚未允许：请先在「账号连接」里允许一次' }) },
    { key: 'k', seqNo: 'S1', objectId: 'o1' },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /环境已不就绪/)
  assert.match(result.error, /未创建子代理/)
  assert.equal(starts, 0, '必须一个子代理都没起')
  assert.equal(state.activeChildId, '', '被拒绝时不得占用门禁')
})

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
    agents: agentsServingChild({ childOptions: { status: 'idle' } }),
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

test('重启中止：旧子会话**仍在运行**（dispose 不收敛）时不许起第二条', async () => {
  // 2026-09-29 用户复查的 P1：旧实现里 dispose 超时是"正常完成"的计时器先赢 →
  // `disposed=false` 但 `errors=[]`，上层只要 abort 发出就继续重试 → 起第二条并覆盖旧 childId。
  // 现在判据是**静默**：dispose 未完成且 Agent 仍 running = 不许重启，并且**保留**旧身份。
  const started = []
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        // 旧子会话仍显示 running（它没停下来）
        if (id === 'gone') return makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), { id, status: 'running' })
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { started.push('start'); return { id: 'child-2', provider: 'spawn', dispose: async () => {} } },
    },
  })
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1',
      audits: { k: record({ key: 'k', childId: 'gone', ended: false, stopped: false }) },
      runs: { gone: { run: { dispose: () => new Promise(() => {}) }, abort: () => {} } },
    },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没法确认已经停下来/)
  assert.deepEqual(started, [], '没确认停下来就不许起第二条')
  assert.equal(state.audits.k.childId, 'gone', '旧身份不许被覆盖/丢弃')
})

test('stopChild：**问不到** agents 服务时 `quiesced=false`（fail closed，且不丢身份）', async () => {
  // 三态判据：`true` 还在跑 / `false` 确认不在跑 / `undefined` 问不到。
  // 问不到时**不许**当成"已经停了" —— 否则重启会在旧子会话可能还在跑时起第二条。
  const { stopChild } = await import(new URL('src/host/audit/spawn.ts', ROOT).href)
  const ctx = makeCtx({})
  const originalGet = ctx.get
  // 计时器用"立刻完成"的替身：这几条用例只关心判据，不该真等 8 秒。
  ctx.get = (name) => (name === 'agents' ? undefined : (name === 'timer' ? { timeout: async () => {} } : originalGet(name)))

  const outcome = await stopChild(ctx, 'gone', '测试：问不到状态', {})
  assert.equal(outcome.quiesced, false, '问不到状态 → 不算停下来')
  assert.equal(outcome.disposed, false)
  assert.match(outcome.errors.join('；'), /agents 服务不可用/)

  // 反向：注册表在、且查不到这个 child → **确认**不在运行。
  const okCtx = makeCtx({ agents: { get: () => undefined } })
  const confirmed = await stopChild(okCtx, 'gone', '测试：确认不在运行', {})
  assert.equal(confirmed.quiesced, true, '注册表在且查不到 → 确认已经不在运行')
  assert.deepEqual(confirmed.errors, [])
})

test('stopChild：dispose 不收敛 + Agent 仍 running → `disposed=false` 且**有错误**（超时不算成功）', async () => {
  // 用户复查 P1 的直接复现：旧实现里计时器先完成时不会进 catch，于是
  // `{aborted:true, disposed:false, errors:[]}` —— 上层据此继续重试。
  const { stopChild } = await import(new URL('src/host/audit/spawn.ts', ROOT).href)
  const base = makeCtx({ agents: { get: () => ({ id: 'gone', status: 'running' }) } })
  const baseGet = base.get
  base.get = (name) => (name === 'timer' ? { timeout: async () => {} } : baseGet(name))
  const ctx = base
  const outcome = await stopChild(ctx, 'gone', '测试：dispose 不收敛', {
    handle: { run: { dispose: () => new Promise(() => {}) }, abort: () => {} },
  })
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.disposed, false, 'dispose 没完成就不能算 disposed')
  assert.equal(outcome.quiesced, false, 'Agent 仍 running → 不算停下来')
  assert.equal(outcome.errors.length > 0, true, '超时必须留下错误（旧实现这里是空的）')
  assert.match(outcome.errors.join('；'), /无法确认子会话已经停下来/)
})

test('旧子会话确实已经不在运行（注册表查不到）时，重启照常继续', async () => {
  // 反面：把"停不掉"当成一律中止会让**正常重启**（旧会话早就结束了）永远起不来。
  const started = []
  const ctx = makeCtx({
    agents: agentsServingChild({ absent: ['gone'], childOptions: { status: 'idle' } }),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start(_p, request) { started.push('start'); return { id: 'child-2', provider: 'spawn', dispose: async () => {}, request } } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', audits: { k: record({ key: 'k', childId: 'gone', ended: false, stopped: false }) } },
  })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(started, ['start'], '确认旧会话不在运行 → 允许重启')
  assert.equal(state.audits.k.childId, 'child-2')
})

test('两阶段启动：**创建子会话之前**就落 pending scope，返回后写上真 childId', async () => {
  // 用户复查 P1：`subagents.start()` 返回时子会话已经发布并能执行工具，而权威记录那时还不存在。
  // 现在：先落 pending（父会话 = 审核根）→ 再创建 → 拿到 childId 后补齐并清掉 pending。
  let seenDuringStart = null
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        // **在 start 内部**看状态：这一刻就已经必须有可认领的 scope。
        seenDuringStart = JSON.parse(JSON.stringify(state.audits.k ?? null))
        return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request }
      },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true, result.error)
  assert.notEqual(seenDuringStart, null, 'start 必须被调用')
  assert.equal(seenDuringStart.pending, true, 'start 期间必须已有 pending 记录')
  assert.equal(seenDuringStart.childId, '', 'pending 期间 childId 还是空的（真 id 由 start 返回）')
  assert.equal(seenDuringStart.casePath, '/cases/space/S1', 'pending 记录里要有本轮案例目录')
  assert.equal(seenDuringStart.parentSessionId, 'parent-1', '父会话 = 审核根（窗口内按它认领）')
  assert.equal(state.audits.k.pending, false, '返回后要清掉 pending')
  assert.equal(state.audits.k.childId, 'child-1')
})

test('两阶段启动：scope 落盘失败就**不创建**子会话（最初的 Windows 权限现场）', async () => {
  let started = 0
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { started += 1; return { id: 'child-1', provider: 'spawn', dispose: async () => {} } },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  // 让状态文件写不进去：Broker 的 writeText 抛错。
  const broken = {
    ...deps,
    access: { ...deps.access, writeText: async () => ({ ok: false, error: 'write failed' }) },
  }
  const result = await auditStart(broken, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /scope 没能写入状态文件/)
  assert.equal(started, 0, 'scope 落不下来就不许创建子会话')
  assert.equal(state.audits.k, undefined, '不许留下半截记录')
  assert.equal(state.activeChildId, '', '不许占用门禁')
})

test('子会话创建失败：pending 记录必须回滚（不留"在跑但没人"的假记录）', async () => {
  const ctx = makeCtx({
    agents: agentsServingChild(),
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { throw new Error('provider 罢工') },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /创建子会话失败/)
  assert.equal(state.audits.k, undefined, 'pending 必须回滚')
  assert.equal(state.activeChildId, '')
})

test('手动停止：**没确认停下来**时必须报失败，并保留记录与句柄（不许半截状态）', async () => {
  // B 注入的靶子：`stopAuditChild` 里那条 `if (!outcome.quiesced)`。
  // 没有它就等于"abort 发出去了 = 停好了" —— 旧子会话可能还在跑，而记录已被标成 stopped、
  // 句柄已被删除、占用已释放（用户复查 P1 的"旧身份不能在确认静默前丢弃"）。
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        // 旧子会话仍显示 running，且 dispose 永不收敛
        if (id === 'child-1') return makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), { id, status: 'running' })
        return undefined
      },
    },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const base = makeCtx({})
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1', ended: false, stopped: false }) },
      runs: { 'child-1': { run: { dispose: () => new Promise(() => {}) }, abort: () => {} } },
    },
  })
  // 计时器立刻完成：让 dispose 的 race 立刻判超时，然后按"Agent 仍 running"判未静默。
  const originalGet = deps.ctx.get
  deps.ctx.get = (name) => (name === 'timer' ? { timeout: async () => {} } : originalGet(name))
  void base

  const stopped = await auditStop(deps, { childId: 'child-1' })
  // 两阶段：RPC 只**接受**请求（还没停好就不许说"已停止"）
  assert.equal(stopped.accepted, true, '停止请求必须被接受')
  assert.equal(stopped.phase, 'requested', '立刻回到"已请求"阶段')
  assert.equal(stopped.quiesced, false, '这一刻绝不许声称已静默')
  await settleStop(deps, 'child-1')
  assert.equal(state.audits.k.stopPhase, 'timeout', '后台跑完仍然无法确认静默 → timeout')
  assert.equal(state.audits.k.quiesced, false)
  assert.equal(state.audits.k.stopped, false, '记录不许被标成已停止')
  assert.equal(state.audits.k.ended, false, '更不许标成已结束')
  assert.equal(state.activeChildId, 'child-1', '占用不许释放（它可能还在写案例目录）')
  assert.notEqual(state.runs['child-1'], undefined, '句柄不许丢（还要靠它再停一次）')
})

test('audit-stop 透传**真实**停止结果（不许写死 aborted/disposed）', async () => {
  // 用户第三轮复查的 P2：`auditStop` 曾固定返回 aborted:true + disposed/interrupted/agentCancelled:false，
  // 于是"dispose 成功"、"只是 Agent 已结束"、"超时未静默"三种情况在界面上长得一模一样。
  const childAgent = makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), { id: 'child-1', status: 'running' })
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? rootAgentOf() : (id === 'child-1' ? childAgent : undefined)) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
    },
  })

  // ① dispose 真的完成 + Agent 已不在 running → aborted/disposed/quiesced 都是 true
  const { deps: d1, state: s1 } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
      runs: { 'child-1': { run: { dispose: async () => {} }, abort: () => {} } },
    },
  })
  const quiet = await auditStop(d1, { childId: 'child-1' })
  assert.equal(quiet.ok, true, quiet.error)
  assert.equal(quiet.accepted, true)
  assert.equal(quiet.phase, 'requested')
  await settleStop(d1, 'child-1')
  // **真实结果落在状态里**（不许写死）：abort 发了、dispose 完成了、确认静默
  assert.equal(s1.audits.k.stopPhase, 'quiesced')
  assert.equal(s1.audits.k.stopAborted, true, 'abort 真的发出去了')
  assert.equal(s1.audits.k.stopDisposed, true, 'dispose 真的完成了')
  assert.equal(s1.audits.k.quiesced, true)
  const view1 = await auditStatus(d1, {})
  assert.equal(view1.canStartNext, true, '确认静默 → 可以启动下一条')
  assert.equal(view1.audits.find((item) => item.key === 'k').stop.disposed, true)

  // ② 没有 run 句柄、"Agent 已不在 running"（句柄丢了但会话已结束）：aborted=false，但确认静默 → ok
  const idleCtx = makeCtx({
    agents: agentsServingChild({ childOptions: { status: 'idle' } }),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps: d2 } = startDeps({
    ctx: idleCtx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
    },
  })
  const dormant = await auditStop(d2, { childId: 'child-1' })
  assert.equal(dormant.accepted, true)
  await settleStop(d2, 'child-1')
  const view2 = await auditStatus(d2, {})
  const stop2 = view2.audits.find((item) => item.key === 'k').stop
  assert.equal(stop2.aborted, false, '没有 abort 通道就不许写死 true')
  assert.equal(stop2.disposed, false, '没有 dispose 就不许写死 true')
  assert.equal(stop2.quiesced, true, 'Agent 已不在 running → 静默成立')
  assert.equal(view2.canStartNext, true)

  // ③ 无句柄 + Agent **仍 running**：不许写死成功（fail closed，保留身份）
  const { deps: d3, state: s3 } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
    },
  })
  const stuck = await auditStop(d3, { childId: 'child-1' })
  assert.equal(stuck.accepted, true, '请求照样被接受')
  await settleStop(d3, 'child-1')
  assert.equal(s3.audits.k.stopPhase, 'timeout', '拿不到句柄又确认不了静默 → 不是 quiesced')
  assert.equal(s3.audits.k.quiesced, false)
  assert.equal(s3.audits.k.stopped, false, '身份与占用都保留')
  const view3 = await auditStatus(d3, {})
  assert.equal(view3.canStartNext, false)

  void state
})

test('停止 / 释放：状态文件写不进去时**不能**报成功（P2）', async () => {
  // 用户复查 P2：`persistAudits` 的返回值此前被忽略 —— 内存里放开了、磁盘上还留着占用锁，
  // 重启后又冒出来。停止与释放都是"员工的安全出口"，报成功必须是真成功。
  const brokenAccess = (deps) => ({ ...deps.access, writeText: async () => ({ ok: false, error: 'write failed' }) })

  // ① 停止：子会话已经确认停下来，但状态没落盘 → ok:false + 说清后果
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? rootAgentOf() : (id === 'child-1' ? makeAuditAgent(makeAuditSession({ cwd: '/cases/space' }), { id, status: 'idle' }) : undefined)) },
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1', audits: { k: record({ key: 'k', childId: 'child-1' }) } },
  })
  const stopped = await auditStop({ ...deps, access: brokenAccess(deps) }, { childId: 'child-1' })
  // 两阶段：**接受阶段**的 ok 表示"请求已被接受"，但 `quiesced` 仍然是 false（还没停好）。
  // 落盘失败本身在后台阶段体现为 `stopPhase: 'failed'`，见下面的断言。
  assert.equal(stopped.accepted, true)
  assert.equal(stopped.quiesced, false, '接受 ≠ 已停止')
  await settleStop(deps, 'child-1')
  assert.equal(state.audits.k.stopPhase, 'failed', '落盘失败必须如实记 failed，不许伪装成已停止')
  // 子会话本身确实停下了（quiesced=true 是事实），但**持久化失败**让这一步不算完成：
  // 不许启动下一条（磁盘上可能还留着占用锁）。这两件事必须能同时被表达出来。
  const failedView = await auditStatus(deps, {})
  assert.equal(failedView.canStartNext, false, 'failed 阶段一律不许启动下一条')

  // ② 释放：同样不许报成功（**独立的夹具**：停止已经清掉占用了）
  const releaseDeps = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1', audits: { k: record({ key: 'k', childId: 'child-1' }) } },
  })
  const released = await auditRelease({ ...releaseDeps.deps, access: brokenAccess(releaseDeps.deps) })
  assert.equal(released.ok, false, '释放的落盘失败同样要如实报')
  assert.equal(released.released, 'k', '仍然要告诉调用方释放的是哪一条')
})

test('真实 toolFilter 生效（deny 工具对子会话不可见）时，子会话仍然齐备并启动成功', async () => {
  // 用户第三轮复查要求的组合：`tools.get()` 对三条 denied 工具返回 undefined，其余可见；
  // 子会话必须**启动成功**（bootstrap 不该被算成"子会话缺必需工具"），
  // 而那三条对子会话必须**不可见**（可见性这一半；可执行性那一半在 host-tools.test.mjs）。
  const childSession = makeAuditSession({ cwd: '/cases/space', mode: 'workspace-write', policy: 'never' })
  const childAgent = makeAuditAgent(childSession, { id: 'child-1', status: 'running' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        if (id === 'child-1') return childAgent
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) { return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request } },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })

  // 夹具本身先被证明"真的在模拟过滤"，否则这条用例是空转。
  assert.deepEqual(auditToolsVisible(ctx, childAgent, REQUIRED_AUDIT_CHILD_TOOLS), [],
    '子会话必需集必须齐备')
  assert.deepEqual(auditToolsVisible(ctx, childAgent), ['crwu_audit_case_bootstrap'],
    '拿根必需集查子会话会误报 —— 这正是被修掉的缺陷形态')

  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true, result.error)
  assert.equal(state.activeChildId, 'child-1', '子会话没有被误杀')
})

test('启动后复查失败 + dispose 不收敛：**保留**身份 / 句柄 / 占用（不许抹掉仍在跑的子会话）', async () => {
  // 用户第三轮复查的 P1：这三条失败分支调用 stopChild 后直接 rollbackRecord ——
  // 若 dispose 超时且 Agent 仍 running，旧子会话还在写案例目录，而 Host 已经删掉它的身份与 scope。
  const childSession = makeAuditSession({ cwd: '/cases/space', mode: 'danger-full-access' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        // 子会话仍显示 running（没停下来）
        if (id === 'child-1') return makeAuditAgent(childSession, { id, status: 'running' })
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() {
        return {
          id: 'child-1', provider: 'spawn',
          // ⚠️ `stopChild` 用的是 `handle.run.dispose`，而 `handle.run` 就是 start 返回的**整个
          // run 对象** —— 所以"dispose 不收敛"要写在**这一层**（2026-09-29 我在这里写错过一次，
          // 用例于是走了干净回滚那条路，断言全绿但没测到目标分支）。
          dispose: () => new Promise(() => {}),
          request: {},
        }
      },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const originalGet = deps.ctx.get
  deps.ctx.get = (name) => (name === 'timer' ? { timeout: async () => {} } : originalGet(name))

  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没法确认它已经停下来/)
  assert.match(result.error, /停止审核/, '要告诉用户去哪重试')
  // **身份 / 句柄 / 占用都不许丢**
  assert.notEqual(state.audits.k, undefined, '记录必须保留（否则 Host 不再认识那个子会话）')
  assert.equal(state.audits.k.retired, true, '标成退役：只拒绝、不放行')
  assert.equal(state.audits.k.childId, 'child-1', 'childId 留着，才能再停一次')
  assert.notEqual(state.runs['child-1'], undefined, 'run 句柄必须保留')
  assert.equal(state.activeChildId, 'child-1', '占用不许释放')
})

test('启动后复查失败且**确认**停下来：才允许回滚记录与占用', async () => {
  // 反面：确认静默之后必须干净回滚（否则会留下一条永远"在跑"的假记录）。
  const childSession = makeAuditSession({ cwd: '/cases/space', mode: 'danger-full-access' })
  const ctx = makeCtx({
    agents: {
      get: (id) => {
        if (id === 'parent-1') return rootAgentOf()
        if (id === 'child-1') return makeAuditAgent(childSession, { id, status: 'idle' })
        return undefined
      },
    },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start() { return { id: 'child-1', provider: 'spawn', dispose: async () => {}, request: {} } },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /策略不符合要求/)
  assert.equal(state.audits.k, undefined, '确认停下来 → 记录回滚')
  assert.equal(state.runs['child-1'], undefined, '句柄回滚')
  assert.equal(state.activeChildId, '', '占用释放')
})

test('读不到子会话的 Agent（远程 provider / 注册表查不到）：**fail closed**，不是记一条 warning 继续跑', async () => {
  // 用户第三轮复查的 P1：`SubagentRun.localAgent` 对远程 provider 是 undefined，
  // 而沙箱/审批/工具可见性的复查全靠读到那个 child Agent。只 warning 继续 = 在无法验证边界的
  // 子会话里把审核跑完。
  const stoppedSignals = []
  const ctx = makeCtx({
    // 根可读；子 Agent **读不到**（agents.get 对子 id 返回 undefined）
    agents: { get: (id) => (id === 'parent-1' ? rootAgentOf() : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        // 远程运行的形态：没有 localAgent
        stoppedSignals.push(request)
        return { id: 'child-remote', provider: 'spawn', dispose: async () => {}, request }
      },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, false, '读不到子 Agent 就不许继续')
  assert.match(result.error, /读不到审核子代理的 Agent/)
  assert.equal(state.audits.k, undefined, '确认停下后不留记录')
  assert.equal(state.activeChildId, '', '不占锁')
})

test('`localAgent` 优先于注册表：注册表查不到它也能完成复查（真实 in-process provider 的形态）', async () => {
  // 反向：provider 在 start 兑现时给出了本进程子 Agent —— 那就不该因为 agents.get 查不到而失败。
  const localChild = makeAuditAgent(
    makeAuditSession({ cwd: '/cases/space', mode: 'workspace-write', policy: 'never' }),
    { id: 'child-local', status: 'running' },
  )
  const ctx = makeCtx({
    agents: { get: (id) => (id === 'parent-1' ? rootAgentOf() : undefined) },
    subagents: {
      list: () => ['spawn'],
      async listChildren() { return [] },
      async start(_p, request) {
        // 夹具的统一包装不会再补（这里显式给），模拟 provider 兑现时带 localAgent
        return { id: 'child-local', provider: 'spawn', dispose: async () => {}, request, localAgent: localChild }
      },
    },
  })
  const { deps, state } = startDeps({ ctx, state: { parentSessionId: 'parent-1' } })
  const result = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(result.ok, true, result.error)
  assert.equal(state.activeChildId, 'child-local')
})

test('F1 幂等：重复点停止不启动第二条流程，也不重复 abort', async () => {
  const aborts = []
  let disposeCalls = 0
  const ctx = makeCtx({
    agents: agentsServingChild({ childOptions: { status: 'idle' } }),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
      runs: { 'child-1': { run: { dispose: async () => { disposeCalls += 1 } }, abort: () => { aborts.push('abort') } } },
    },
  })
  const first = await auditStop(deps, { childId: 'child-1' })
  assert.equal(first.accepted, true)
  assert.equal(first.alreadyStopping, false, '第一次不是"已在停"')
  const second = await auditStop(deps, { childId: 'child-1' })
  assert.equal(second.accepted, true, '重复点击照样被接受（幂等）')
  assert.equal(second.alreadyStopping, true, '但必须告诉调用方"已经在停了"')
  await settleStop(deps, 'child-1')
  assert.deepEqual(aborts, ['abort'], 'abort 只许发一次')
  assert.equal(disposeCalls, 1, 'dispose 只许调一次')
  assert.equal(state.audits.k.stopPhase, 'quiesced')
})

test('F1 门禁：停止流程在跑（或上一条 timeout/failed）时不许启动新的审核', async () => {
  const ctx = makeCtx({
    agents: agentsServingChild({ childOptions: { status: 'running' } }),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  // ① 停止在跑（用一个永不收敛的 dispose 卡住它）
  const { deps, state } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
      runs: { 'child-1': { run: { dispose: () => new Promise(() => {}) }, abort: () => {} } },
    },
  })
  const originalGet = deps.ctx.get
  deps.ctx.get = (name) => (name === 'timer' ? { timeout: async () => {} } : originalGet(name))
  await auditStop(deps, { childId: 'child-1' })
  const blocked = await auditStart(deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(blocked.ok, false, '停止过程中不许启动新的审核')
  assert.match(blocked.error, /还在停止过程中|确认停止前/)
  await settleStop(deps, 'child-1')
  assert.equal(state.audits.k.stopPhase, 'timeout')

  // ② 上一条留下 timeout（未确认静默）→ 同样拒绝，且**跨重启**成立
  const fresh = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1', stopPhase: 'timeout', quiesced: false }) },
    },
  })
  const blocked2 = await auditStart(fresh.deps, { key: 'k', seqNo: 'S1', objectId: 'o1' })
  assert.equal(blocked2.ok, false)
  assert.match(blocked2.error, /还在停止过程中|确认停止前/)
})

test('F4 契约：停止阶段跨重启保留，且 canStartNext 由 Host 判定', async () => {
  // ① 记录里的阶段/结果落盘
  const ctx = makeCtx({
    agents: agentsServingChild({ childOptions: { status: 'idle' } }),
    subagents: { list: () => ['spawn'], async listChildren() { return [] }, async start() { throw new Error('不应被调用') } },
  })
  const { deps } = startDeps({
    ctx,
    state: {
      parentSessionId: 'parent-1', activeKey: 'k', activeChildId: 'child-1',
      audits: { k: record({ key: 'k', childId: 'child-1' }) },
      runs: { 'child-1': { run: { dispose: async () => {} }, abort: () => {} } },
    },
  })
  await auditStop(deps, { childId: 'child-1' })
  await settleStop(deps, 'child-1')
  const saved = deps.state.audits.k
  assert.equal(saved.stopPhase, 'quiesced')
  assert.equal(typeof saved.stopRequestedAt, 'number')
  assert.equal(saved.quiesced, true)

  // ② 换个进程（新 state）恢复：阶段与 quiesced 都还在，canStartNext 由 Host 现算
  const restored = startDeps({
    ctx,
    state: { parentSessionId: 'parent-1', audits: { k: record({ key: 'k', childId: 'child-1', stopPhase: 'timeout', quiesced: false, stopRequestedAt: 1, stopElapsedMs: 5 }) } },
  })
  const view = await auditStatus(restored.deps, {})
  const stop = view.audits.find((item) => item.key === 'k').stop
  assert.equal(stop.phase, 'timeout', '阶段跨重启保留')
  assert.equal(stop.quiesced, false)
  assert.equal(stop.requestedAt, 1)
  assert.equal(view.canStartNext, false, 'timeout 未确认静默 → Host 说不能启动下一条')
  assert.equal(typeof stop.elapsedMs, 'number')
  assert.ok(Array.isArray(stop.notes))
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
      auditRoot: { workspacePath: '/cases/space', casePath: '/cases/space/S1', sessionId: 'parent-root', title: '', assignedAt: '' },
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
  assert.equal(result.accepted, true, '停止请求被接受')
  assert.equal(result.key, 'k')
  await settleStop(deps, 'child-1')
  assert.ok(aborts.includes('abort'), 'abort 真的发出去了')
  assert.equal(state.audits.k.stopPhase, 'quiesced', '确认静默')
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
    auditRoot: { workspacePath: '/cases/space', casePath: '/cases/space/S1', sessionId: 'parent-1', title: '', assignedAt: '' },
  })
  const ctx = makeCtx({
    agents: agentsServingChild(),
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
  // `access` 是审核启动的硬依赖：建本轮案例目录要走 `system.case-directory.write`。
  return { deps: { ctx, config: CONFIG, state, world: fakeWorld(), access: makeTestAccess(ctx).access }, state, spawned }
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

// ── Windows 本地路径：案例目录候选必须用 `\` 拼 ──────────────────────────────

test('assessAudit 在 Windows 案例根下用 `\\` 拼候选目录（否则扫不到交付件）', async () => {
  // 2026-09-28 复查：`rootCandidates` 原来写 `${caseRoot}/${seqNo}` —— Windows 上拼出
  // `C:\Cases/S1`，`isDir` 判它不是目录，于是磁盘上明明有交付件，界面却退化成「未出结果」。
  const winRoot = 'C:\\Cases'
  const winCase = `${winRoot}\\S1`
  const ctx = makeCtx({
    dirs: [winCase],
    entries: { [winCase]: [{ type: 'file', name: '审核结果.S1.json', target: { targetKey: `${winCase}\\审核结果.S1.json` } }] },
    files: { [`${winCase}\\审核结果.S1.json`]: '{"ok":true}' },
  })
  const result = await assessAudit(
    { ctx, state: makeState(), listed: {}, agentStatusOf: () => '', caseRoot: winRoot, now: Date.parse('2026-09-20T10:00:00Z') },
    record({ casePath: '', seqNo: 'S1', key: 'k', startedAt: '2026-09-20T09:59:00Z', ended: true }),
  )
  assert.equal(result.casePath, winCase, `候选目录必须是 ${winCase}`)
  assert.equal(result.resultFile, '审核结果.S1.json', '必须真的扫到交付件')
  assert.equal(result.casePath.includes('/'), false, '不得混用分隔符')
})

test('assessAudit 在 Windows 案例根下用 `\\` 拼 key 候选', async () => {
  const winRoot = 'C:\\Cases'
  const winCase = `${winRoot}\\key-1`
  const ctx = makeCtx({
    dirs: [winCase],
    entries: { [winCase]: [{ type: 'file', name: '审核结果.key-1.json', target: { targetKey: `${winCase}\\审核结果.key-1.json` } }] },
    files: { [`${winCase}\\审核结果.key-1.json`]: '{}' },
  })
  const result = await assessAudit(
    { ctx, state: makeState(), listed: {}, agentStatusOf: () => '', caseRoot: winRoot, now: Date.parse('2026-09-20T10:00:00Z') },
    record({ casePath: '', seqNo: '', key: 'key-1', startedAt: '2026-09-20T09:59:00Z', ended: true }),
  )
  assert.equal(result.casePath, winCase)
  assert.equal(result.resultFile, '审核结果.key-1.json')
})
