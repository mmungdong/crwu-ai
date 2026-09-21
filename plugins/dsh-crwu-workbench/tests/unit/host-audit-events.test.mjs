/**
 * 审核事件订阅与「出结果就传」的测试。
 *
 * 这两件事曾经被漏掉，而且**漏掉是静默的**：
 * - 没有 `subagent/end` 订阅 → `ended` / `endReason` 永远是空 → 「已中断」状态永不出现；
 * - `runUploadWatch` 只处理活动中的或 `ended === true` 的记录 → 正常跑完的审核永远不进上传队列，
 *   **「交付件自动上云」整个功能不生效**。
 *
 * 所以这里既测事件驱动的路径，也测「事件丢了也能传」的兜底路径。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { subscribeAuditEvents } = await import(new URL('src/host/audit/events.ts', ROOT).href)
const { auditStatus } = await import(new URL('src/host/audit/ops.ts', ROOT).href)
const { normalizeAudit } = await import(new URL('src/host/state/registry.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { normalizeManifest } = await import(new URL('src/host/environment/manifest.ts', ROOT).href)
const { assessAudit } = await import(new URL('src/host/audit/state.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', installDocUrl: '', manifestUrl: '', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600,
  autoUpload: true, requireTopLevelParent: true,
}
const SEQ = '2026-301705-LX10170'

function fakeWorld() {
  return {
    platform: async () => 'darwin-arm64',
    home: async () => '/Users/x',
    workdir: async () => '/cases/session',
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
}

/** ctx 替身：记录 ctx.on 的订阅，方便测试手动触发事件。 */
function makeCtx({ withAgents = true, agentStatus = 'running', files = {}, entries = {}, dirs = [] } = {}) {
  const listeners = new Map()
  // stat 与 listDir 必须看同一份目录事实：只给 entries（listDir）不给 dirs（stat）时，
  // isDir() 会答「不存在」，于是案例目录被整个跳过、测试假失败。
  const directories = new Set(dirs)
  return {
    listeners,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    get(name) {
      if (name === 'agents' && withAgents) {
        // 状态可配：默认「还活着」，需要验「已结束」的用例要显式给 idle。
        return { get: () => ({ status: agentStatus }) }
      }
      if (name === 'subagents') {
        return { async listChildren() { return [] } }
      }
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async run(spec) {
            const out = spec.command.startsWith('command -v')
              ? { stdout: '/usr/local/bin/ossutil\n' }
              : { stdout: 'ok' }
            return {
              exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout, truncated: false }, stderr: { text: '', truncated: false },
            }
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
          async writeText() { return { operation: 'update', version: 'v', before: null, after: '' } },
          async listDir(target) { return entries[target.targetKey] ?? [] },
        }
      }
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      // Cordis 的 ctx.on 返回解除订阅的函数。
      return () => { list.splice(list.indexOf(listener), 1) }
    },
  }
}

function stateOf(patch = {}) {
  return { ...createWorkbenchState(CONFIG), ...patch }
}

// ── 事件订阅 ────────────────────────────────────────────────────────────────

test('subagent/end marks the record ended and keeps the stop reason', () => {
  const ctx = makeCtx()
  const state = stateOf({ audits: { k: { ...normalizeAudit('k', {}), key: 'k', childId: 'child-1' } } })
  subscribeAuditEvents(ctx, state)

  ctx.emit('subagent/end', { id: 'child-1', stopReason: 'error' })
  assert.equal(state.audits.k.ended, true, '没有这一步 ended 永远为空')
  assert.equal(state.audits.k.endReason, 'error', 'endReason 是「已中断」的唯一依据')
})

test('subagent/end defaults to error when the reason is missing', () => {
  // 宁可在界面上提示「已中断」，也不要假装正常跑完。
  const ctx = makeCtx()
  const state = stateOf({ audits: { k: { ...normalizeAudit('k', {}), key: 'k', childId: 'c1' } } })
  subscribeAuditEvents(ctx, state)
  ctx.emit('subagent/end', { id: 'c1' })
  assert.equal(state.audits.k.endReason, 'error')
})

test('subagent/end never revives a manually stopped record', () => {
  // 用户停过是明确动作，优先于事件推断出的 idle。
  const ctx = makeCtx()
  const state = stateOf({
    audits: { k: { ...normalizeAudit('k', {}), key: 'k', childId: 'c1', stopped: true, status: 'stopped' } },
  })
  subscribeAuditEvents(ctx, state)
  ctx.emit('subagent/end', { id: 'c1', stopReason: 'aborted' })
  assert.equal(state.audits.k.status, 'stopped')
  assert.equal(state.audits.k.endReason, 'aborted')
})

test('subagent/end ignores unrelated children', () => {
  const ctx = makeCtx()
  const state = stateOf({ audits: { k: { ...normalizeAudit('k', {}), key: 'k', childId: 'c1' } } })
  subscribeAuditEvents(ctx, state)
  ctx.emit('subagent/end', { id: 'other', stopReason: 'error' })
  assert.equal(state.audits.k.ended, false)
})

test('agent/status mirrors running/idle but never rewrites an ended record', () => {
  const ctx = makeCtx()
  const state = stateOf({
    audits: {
      live: { ...normalizeAudit('live', {}), key: 'live', childId: 'c1' },
      done: { ...normalizeAudit('done', {}), key: 'done', childId: 'c2', ended: true, status: 'done' },
    },
  })
  subscribeAuditEvents(ctx, state)
  // 事件可能晚于 subagent/end 到达：已结束的记录不能被改写回 running/idle。
  ctx.emit('agent/status', { agent: { id: 'c2' }, status: 'running' })
  assert.equal(state.audits.done.status, 'done')

  ctx.emit('agent/status', { agent: { id: 'c1' }, status: 'running' })
  assert.equal(state.audits.live.status, 'running')
  ctx.emit('agent/status', { agent: { id: 'c1' }, status: 'idle' })
  assert.equal(state.audits.live.status, 'idle')
})

test('the events path makes failed reachable for a finished child', async () => {
  // 端到端：事件把 ended/endReason 写上之后，assessAudit 才能给出 failed。
  const ctx = makeCtx()
  const record = { ...normalizeAudit('k', {}), key: 'k', childId: 'c1', startedAt: '2026-09-20T00:00:00Z' }
  const state = stateOf({ audits: { k: record } })
  subscribeAuditEvents(ctx, state)
  ctx.emit('subagent/end', { id: 'c1', stopReason: 'error' })

  const assessment = await assessAudit({
    ctx,
    state,
    listed: {},
    agentStatusOf: () => 'idle',
    caseRoot: '',
    now: Date.parse('2026-09-21T00:00:00Z'),
  }, state.audits.k)
  assert.equal(assessment.status, 'failed', '接上事件后「已中断」才可能出现')
})

// ── 「出结果就传」的兜底 ────────────────────────────────────────────────────

test('audit-status triggers an upload for a delivered result even without the end event', async () => {
  // 这就是我漏掉的那条兜底：看门狗只认 ended，而 ended 依赖事件。
  const uploaded = []
  const ctx = makeCtx({
    // 事件没到达 = 记录里没有 ended，但子 Agent 已经不在了 —— 这正是要靠轮询兜底的场景。
    agentStatus: 'idle',
    dirs: [`/cases/${SEQ}`],
    files: { [`/cases/${SEQ}/审核结果.${SEQ}.json`]: '{}' },
    entries: {
      [`/cases/${SEQ}`]: [
        { type: 'file', name: `审核意见.${SEQ}.html`, target: { targetKey: 'h' } },
        { type: 'file', name: `审核结果.${SEQ}.json`, target: { targetKey: 'j' } },
      ],
    },
  })
  const state = stateOf({
    parentSessionId: 'p1',
    audits: { [SEQ]: { ...normalizeAudit('k', {}), key: SEQ, seqNo: SEQ, childId: 'c1', casePath: `/cases/${SEQ}` } },
  })

  const result = await auditStatus({
    ctx,
    config: CONFIG,
    state,
    world: fakeWorld(),
    autoUpload: async (record) => { uploaded.push(record.key) },
  }, {})

  assert.equal(result.ok, true)
  assert.deepEqual(uploaded, [SEQ], '按磁盘交付件判定，不依赖 ended')
})

test('audit-status does not upload while the child is still alive', async () => {
  const uploaded = []
  const ctx = makeCtx({
    agentStatus: 'running',
    dirs: [`/cases/${SEQ}`],
    entries: {
      [`/cases/${SEQ}`]: [{ type: 'file', name: `审核意见.${SEQ}.html`, target: { targetKey: 'h' } }],
    },
  })
  const state = stateOf({
    parentSessionId: 'p1',
    activeKey: SEQ,
    activeChildId: 'c1',
    audits: { [SEQ]: { ...normalizeAudit('k', {}), key: SEQ, seqNo: SEQ, childId: 'c1', casePath: `/cases/${SEQ}` } },
  })
  // agents.get 返回 running → 判定为运行中 → 不该触发上传。
  await auditStatus({ ctx, config: CONFIG, state, world: fakeWorld(), autoUpload: async (record) => { uploaded.push(record.key) } }, {})
  assert.deepEqual(uploaded, [], '还在跑就不上传')
})

test('an already uploaded record is never uploaded twice', async () => {
  const uploaded = []
  const ctx = makeCtx({
    agentStatus: 'idle',
    dirs: [`/cases/${SEQ}`],
    entries: {
      [`/cases/${SEQ}`]: [{ type: 'file', name: `审核意见.${SEQ}.html`, target: { targetKey: 'h' } }],
    },
  })
  const state = stateOf({
    parentSessionId: 'p1',
    audits: {
      [SEQ]: {
        ...normalizeAudit('k', {}), key: SEQ, seqNo: SEQ, childId: 'c1', ended: true, endReason: 'completed',
        casePath: `/cases/${SEQ}`, uploadedAt: '2026-09-20T03:00:00Z',
      },
    },
  })
  await auditStatus({ ctx, config: CONFIG, state, world: fakeWorld(), autoUpload: async (record) => { uploaded.push(record.key) } }, {})
  assert.deepEqual(uploaded, [], '传过了就不能再传')
})

test('audit-status works without the optional upload hook', async () => {
  const ctx = makeCtx()
  const state = stateOf({ parentSessionId: 'p1', audits: { k: { ...normalizeAudit('k', {}), key: 'k', childId: 'c1', ended: true } } })
  const result = await auditStatus({ ctx, config: CONFIG, state, world: fakeWorld() }, {})
  assert.equal(result.ok, true)
})

void normalizeManifest
