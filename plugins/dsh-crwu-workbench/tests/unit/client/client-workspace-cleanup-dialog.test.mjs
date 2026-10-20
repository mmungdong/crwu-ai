/**
 * 清理确认弹窗。
 *
 * 这一层只钉"看得见的事实"：数量、会话、不可逆提示、输入目录名才点得动、
 * 执行中不给关闭入口。删除是否真的发生由 Host 测试证明，这里不重复。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { fakeReact, registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const { WorkspaceCleanupDialog } = await import(
  new URL('src/client/modules/environment/ui/WorkspaceCleanupDialog.tsx', ROOT).href)

const React = fakeReact

function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
    try {
      return resolve(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

function render(component, props = {}) {
  globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }
  return resolve(component(props))
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function findButtonLike(node, label) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonLike(child, label)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'button' && textOf(node) === label) return node
  return findButtonLike(node.props?.children, label)
}

function readyState(overrides = {}) {
  return {
    phase: 'ready',
    plan: {
      ok: true, error: '', errorKind: '', planId: 'p', digest: 'd', expiresAt: 1,
      workspace: { path: '/w/中瑞世联工作空间', name: '中瑞世联工作空间', id: 'w1' },
      entries: [{ name: '2026-1', kind: 'directory', sizeBytes: 1 }], entriesTruncated: 0,
      sessions: [], totals: {
        folders: 94, files: 1, symlinks: 0, other: 0, bytes: 1024,
        bytesComplete: true, sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0,
      },
      notes: [],
    },
    result: null, error: '', confirmName: '', deleteSessionLogs: false, startedAt: 0,
    ...overrides,
  }
}

const handlers = {
  onConfirmName() {}, onToggleDeleteSessionLogs() {},
  onApply() {}, onRescan() {}, onClose() {},
}

test('ready 态展示数量、不可逆与输入提示', () => {
  const tree = render(WorkspaceCleanupDialog, { state: readyState(), ...handlers })
  const text = textOf(tree)
  assert.match(text, /94 个文件夹/)
  assert.match(text, /不可逆/)
  assert.match(text, /请输入目录名/)
  assert.match(text, /2026-1/, '必须列出具体会删哪些顶层项')
})

test('输入目录名后执行按钮才可用，并渲染删除日志勾选框', () => {
  const empty = findButtonLike(render(WorkspaceCleanupDialog, { state: readyState(), ...handlers }), '清空工作空间')
  assert.equal(empty.props.disabled, true)
  const filledState = readyState({ confirmName: '中瑞世联工作空间' })
  const filled = findButtonLike(render(WorkspaceCleanupDialog, { state: filledState, ...handlers }), '清空工作空间')
  assert.equal(filled.props.disabled, false)
  assert.match(textOf(render(WorkspaceCleanupDialog, { state: filledState, ...handlers })), /彻底删除会话日志/)
})

test('applying 态显示已用时且不给取消入口', () => {
  const tree = render(WorkspaceCleanupDialog, {
    state: readyState({ phase: 'applying', startedAt: 1_000 }), now: () => 4_000, ...handlers,
  })
  assert.match(textOf(tree), /已用时 3 秒/)
  assert.equal(findButtonLike(tree, '取消'), null)
})

test('限制说明来自 Host 的 plan.notes（不写死在界面里）', () => {
  const text = textOf(render(WorkspaceCleanupDialog, {
    state: readyState({ plan: { ...readyState().plan, notes: ['这条限制来自 Host'] } }),
    ...handlers,
  }))
  assert.match(text, /这条限制来自 Host/)
})

test('failed 态不许说成"清理完成"', () => {
  const tree = render(WorkspaceCleanupDialog, {
    state: readyState({
      phase: 'done',
      result: {
        ok: false, status: 'failed', error: '清理清单已过期，请重新扫描', errorKind: 'conflict',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 0, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 2, remainingNames: ['a', 'b'], stuckSessionIds: [], notes: [],
      },
    }),
    ...handlers,
  })
  const text = textOf(tree)
  assert.match(text, /清理没有开始/)
  assert.doesNotMatch(text, /清理完成/)
})

test('done 态展示计数与剩余项', () => {
  const tree = render(WorkspaceCleanupDialog, {
    state: readyState({
      phase: 'done',
      result: {
        ok: false, status: 'partial', error: '', errorKind: '',
        archivedSessionIds: ['s1'], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 2, files: 1, symlinks: 0, other: 0 },
        failures: [{ name: 'a', kind: 'entry', reason: 'busy' }],
        remaining: 1, remainingNames: ['a'], stuckSessionIds: [], notes: [],
      },
    }),
    ...handlers,
  })
  const text = textOf(tree)
  assert.match(text, /删除 2 个文件夹、1 个文件/)
  assert.match(text, /仍有 1 项未删除/)
})
