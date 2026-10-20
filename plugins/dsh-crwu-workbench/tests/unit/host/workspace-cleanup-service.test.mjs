/**
 * 清理服务：授权、计划、指纹与工作空间身份校验，以及两条 RPC 的返回形状。
 *
 * 这里刻意用**内存 IO** 与假控制器：服务是"删什么"的决策层，测试要在不碰磁盘的前提下
 * 逐条核对"失败时到底有没有删"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { createWorkspaceCleanupService } = await import(
  new URL('src/host/domains/workspace-cleanup/index.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)

function service(options = {}) {
  const calls = []
  let current = options.workspace ?? { id: 'w', path: '/w', title: 'w' }
  const io = options.io ?? memoryCleanupIo([
    { path: '/w', kind: 'dir' }, { path: '/w/a', kind: 'dir' },
  ])
  return {
    calls, io,
    setWorkspace: (next) => { current = next },
    service: createWorkspaceCleanupService({
      access: {
        authorize: () => options.denied === true ? { ok: false, error: '未授权' } : { ok: true },
        note: () => {},
      },
      resolveWorkspace: async () => options.resolve ?? { ok: true, workspace: current },
      home: async () => '/Users/x',
      platform: async () => 'darwin-arm64',
      sessionPort: () => options.noSessions === true
        ? { ok: false, error: '没有会话控制器' }
        : { ok: true, port: { list: async () => options.rows ?? [], archive: async (input) => [input.sessionId] } },
      io,
      closeWorkflowStores: async () => {},
      clearAudits: () => calls.push('clearAudits'),
      persistAudits: async () => true,
      invalidate: () => calls.push('invalidate'),
      now: () => 1_000,
    }),
  }
}

test('未授权 → policy，且不扫描', async () => {
  const { service: svc, io } = service({ denied: true })
  const plan = await svc.plan()
  assert.equal(plan.ok, false)
  assert.equal(plan.errorKind, 'policy')
  assert.deepEqual(io.calls, [])
})

test('缺少会话控制器 → capability-gap', async () => {
  const { service: svc } = service({ noSessions: true })
  const plan = await svc.plan()
  assert.equal(plan.errorKind, 'capability-gap')
})

test('扫描抛错 → infrastructure，不生成计划', async () => {
  const io = memoryCleanupIo([{ path: '/w', kind: 'dir' }])
  io.readdir = async () => { throw new Error('EACCES') }
  const { service: svc } = service({ io })
  const plan = await svc.plan()
  assert.equal(plan.ok, false)
  assert.equal(plan.errorKind, 'infrastructure')
  assert.equal(plan.planId, '')
})

test('plan 正常产出：计数、指纹与展示上限', async () => {
  const { service: svc } = service()
  const plan = await svc.plan()
  assert.equal(plan.ok, true)
  assert.equal(plan.workspace.name, 'w')
  assert.equal(plan.totals.folders, 1)
  assert.equal(plan.entriesTruncated, 0)
  assert.equal(plan.digest.length > 0, true)
  assert.equal(plan.notes.length, 2)
  assert.equal(plan.expiresAt > 1_000, true, '线上计划必须带真实到期时间')
})

test('apply 的 planId 不认识 → conflict', async () => {
  const { service: svc } = service()
  const out = await svc.apply({ planId: 'nope', digest: 'x', confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.status, 'failed')
  assert.equal(out.errorKind, 'conflict')
})

test('确认期间工作空间被换掉 → conflict，零删除', async () => {
  const { service: svc, io, setWorkspace } = service()
  const plan = await svc.plan()
  setWorkspace({ id: 'w2', path: '/w2', title: 'w2' })
  const out = await svc.apply({ planId: plan.planId, digest: plan.digest,
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.errorKind, 'conflict')
  assert.deepEqual(io.calls.filter((line) => line.startsWith('removeTree')), [])
})

test('目录名不匹配 → input，零删除', async () => {
  const { service: svc, io } = service()
  const plan = await svc.plan()
  const out = await svc.apply({ planId: plan.planId, digest: plan.digest,
    confirmName: 'W', deleteSessionLogs: false })
  assert.equal(out.errorKind, 'input')
  assert.deepEqual(io.calls.filter((line) => line.startsWith('removeTree')), [])
})

test('客户端指纹不对 → input，零删除', async () => {
  const { service: svc, io } = service()
  const plan = await svc.plan()
  const out = await svc.apply({ planId: plan.planId, digest: 'wrong',
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.errorKind, 'input')
  assert.deepEqual(io.calls.filter((line) => line.startsWith('removeTree')), [])
})

test('正常路径：plan → apply 完成，remaining=0 且作废环境快照', async () => {
  const { service: svc, io, calls } = service()
  const plan = await svc.plan()
  const out = await svc.apply({ planId: plan.planId, digest: plan.digest,
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.status, 'completed')
  assert.equal(out.remaining, 0)
  assert.deepEqual(io.calls.filter((line) => line.startsWith('removeTree')), ['removeTree /w/a'])
  assert.deepEqual(calls, ['clearAudits', 'invalidate'])
})
