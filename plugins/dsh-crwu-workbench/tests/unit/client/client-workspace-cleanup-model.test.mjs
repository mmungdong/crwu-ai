/**
 * 清理弹窗的客户端纯逻辑与控制器。
 *
 * 界面这一侧只守三件事：
 * 1. 只有**逐字输入目录名**、清单非空、且已获授权时才允许执行；
 * 2. 未授权 / 旧宿主 / 目录丢失各有各的话，不压成一句"不可用"；
 * 3. 执行结束必须通知页面刷新（环境快照与审核历史都变了）。
 *
 * 真正的安全边界仍在 Host：这里禁用一个按钮，不能代替服务端的指纹与授权校验。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  initialCleanupState, canApply, cleanupBlockedReason, cleanupIsEmpty, createWorkspaceCleanupController,
} = await import(new URL('src/client/modules/environment/model/workspace-cleanup.ts', ROOT).href)

const plan = (overrides = {}) => ({
  ok: true, error: '', errorKind: '', planId: 'p', digest: 'd', expiresAt: 1,
  workspace: { path: '/w', name: 'w', id: 'w1' },
  entries: [{ name: 'a', kind: 'directory', sizeBytes: 1 }], entriesTruncated: 0,
  sessions: [], totals: {
    folders: 1, files: 0, symlinks: 0, other: 0, bytes: 1,
    bytesComplete: true, sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0,
  },
  notes: [], ...overrides,
})

const granted = (capabilities = ['workspace-cleanup']) => ({
  state: 'granted', schemaVersion: 2, requiredSchemaVersion: 2,
  grantedAt: '2026-10-20T00:00:00.000Z', capabilities, reason: '',
})

test('输入目录名逐字匹配才允许执行', () => {
  const ready = { ...initialCleanupState(), phase: 'ready', plan: plan() }
  assert.equal(canApply({ ...ready, confirmName: 'w' }), true)
  assert.equal(canApply({ ...ready, confirmName: 'w ' }), true)
  assert.equal(canApply({ ...ready, confirmName: 'W' }), false)
  assert.equal(canApply({ ...ready, confirmName: '' }), false)
})

test('空工作空间不允许执行', () => {
  assert.equal(cleanupIsEmpty(plan({
    entries: [], totals: { ...plan().totals, folders: 0, bytes: 0 },
  })), true)
})

test('未授权时给出指向账号连接的原因；缺新能力时要求重新允许', () => {
  const missing = cleanupBlockedReason({
    chosen: true, missing: false, busy: false, schemaMismatch: false,
    consent: { state: 'missing', schemaVersion: 0, requiredSchemaVersion: 2,
      grantedAt: '', capabilities: [], reason: '' },
  })
  assert.match(missing, /账号连接|允许/)
  const outdated = cleanupBlockedReason({
    chosen: true, missing: false, busy: false, schemaMismatch: false,
    consent: granted(['system-integration']),
  })
  assert.match(outdated, /重新允许|新增/)
})

test('目录已消失时说的是"目录不在了"，不是"尚未选择"', () => {
  const reason = cleanupBlockedReason({
    chosen: false, missing: true, busy: false, schemaMismatch: false, consent: granted(),
  })
  assert.match(reason, /目录不在了/)
})

test('旧宿主（权限说明版本不一致）直接给重启原因', () => {
  const reason = cleanupBlockedReason({
    chosen: true, missing: false, busy: false, schemaMismatch: true, consent: granted(),
  })
  assert.match(reason, /重新打开|重启/)
})

test('控制器：扫描成功进入 ready，apply 带指纹与目录名', async () => {
  const applied = []
  const controller = createWorkspaceCleanupController({
    now: () => 10,
    api: {
      plan: async () => plan(),
      apply: async (request) => {
        applied.push(request)
        return {
          ok: true, status: 'completed', error: '', errorKind: '',
          archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
          deleted: { folders: 1, files: 0, symlinks: 0, other: 0 }, failures: [],
          remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [],
        }
      },
    },
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.deepEqual(applied, [{
    planId: 'p', digest: 'd', confirmName: 'w', deleteSessionLogs: false,
  }])
  assert.equal(controller.get().phase, 'done')
})

test('扫描中途关闭：迟到的结果不许把弹窗重新拉回来', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const controller = createWorkspaceCleanupController({
    api: { plan: async () => { await pending; return plan() }, apply: async () => null },
  })
  const scanning = controller.rescan()
  controller.close()
  release()
  await scanning
  assert.equal(controller.get().phase, 'closed')
})

test('执行结束后调用 onSettled（页面据此刷新环境与审核历史）', async () => {
  const settled = []
  const controller = createWorkspaceCleanupController({
    api: {
      plan: async () => plan(),
      apply: async () => ({
        ok: true, status: 'completed', error: '', errorKind: '',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 1, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [],
      }),
    },
    onSettled: (result) => settled.push(result.status),
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.deepEqual(settled, ['completed'])
})

test('apply 返回 input（清单已变）时自动重扫', async () => {
  let scans = 0
  const controller = createWorkspaceCleanupController({
    api: {
      plan: async () => { scans += 1; return plan() },
      apply: async () => ({
        ok: false, status: 'failed', error: '清单已变化', errorKind: 'input',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 0, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [],
      }),
    },
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.equal(scans, 2)
  assert.equal(controller.get().phase, 'ready')
})
