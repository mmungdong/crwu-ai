/**
 * 工作空间清理的**契约与授权门面**（协议 49）。
 *
 * 这一条不测行为，只钉四件"后来者很容易悄悄改回去"的事实：
 * 1. 明细展示上限只有一份（Host 截断、Client 提示都用它）；
 * 2. 协议升到 49、授权收据升到 2；
 * 3. 新能力排在清单末尾（顺序变化会让老收据按规范顺序比对失败）；
 * 4. 封闭操作表里确实登记了这条能力对应的唯一操作。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { WORKSPACE_CLEANUP_ENTRY_LIMIT } = await import(
  new URL('src/shared/contracts/workspace-cleanup.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_SCHEMA_VERSION } = await import(
  new URL('src/shared/access/types.ts', ROOT).href)
const { LOCAL_ACCESS_OPERATIONS, LOCAL_ACCESS_OPERATION_NAMES } = await import(
  new URL('src/host/core/access/operations.ts', ROOT).href)

test('清理明细的展示上限统一为 500', () => {
  assert.equal(WORKSPACE_CLEANUP_ENTRY_LIMIT, 500)
})

test('协议 50 保留授权收据 2 与 workspace-cleanup 能力', () => {
  assert.equal(WORKBENCH_PROTOCOL, 52)
  assert.equal(LOCAL_ACCESS_SCHEMA_VERSION, 2)
  assert.equal(LOCAL_ACCESS_CAPABILITIES.at(-1), 'workspace-cleanup')
})

test('system.workspace-cleanup 是 filesystem / 特权 / 只给面板', () => {
  assert.ok(LOCAL_ACCESS_OPERATION_NAMES.includes('system.workspace-cleanup'))
  const descriptor = LOCAL_ACCESS_OPERATIONS['system.workspace-cleanup']
  assert.equal(descriptor.capability, 'workspace-cleanup')
  assert.equal(descriptor.transport, 'filesystem')
  assert.equal(descriptor.privileged, true)
  assert.deepEqual(descriptor.allowedSources, ['panel'])
})
