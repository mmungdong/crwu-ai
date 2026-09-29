/**
 * 停止审核的**阶段展示口径**（F1/F2，2026-09-29）。
 *
 * 这份测试盯四件事，都是用户明确点名的：
 * 1. 等待期间**必须有阶段文案**（不许笼统"处理中"），并且阶段跟着 Host 回报走；
 * 2. `canStartNext` **只信 Host**：缺字段 = 未知，绝不推断成"可以启动"；
 * 3. timeout / failed **不许**显示成"已停止"，也不许让"重新审核"可点；
 * 4. timeout / failed 必须给出三个动作（继续等待 / 再次停止 / 复制诊断）与打开会话入口。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { stopPresentationOf } = await import(new URL('src/client/features/report-audit/stop-view.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

/** 一份 Host 回报的停止视图（字段齐全的基线）。 */
const stopOf = (patch = {}) => ({
  phase: 'waiting-quiescence',
  requestedAt: 1_000,
  elapsedMs: 2_000,
  quiesced: false,
  aborted: true,
  disposed: false,
  error: '',
  notes: [],
  canStartNext: false,
  ...patch,
})

test('每个阶段都有明确文案；等待中的阶段不许出现笼统的"处理中"', () => {
  const at = (phase, extra = {}) => stopPresentationOf({ stop: stopOf({ phase, ...extra }), now: 3_000 })
  assert.equal(at('requested').label, zhCN.stopPhaseRequested)
  assert.equal(at('aborting').label, zhCN.stopPhaseAborting)
  assert.equal(at('waiting-quiescence').label, zhCN.stopPhaseWaiting)
  assert.equal(at('quiesced', { quiesced: true, canStartNext: true }).label, zhCN.stopPhaseQuiesced)
  assert.equal(at('timeout').label, zhCN.stopPhaseTimeout)
  assert.equal(at('failed', { error: '写盘失败' }).label, zhCN.stopPhaseFailed)
  for (const phase of ['requested', 'aborting', 'waiting-quiescence', 'timeout', 'failed']) {
    const label = at(phase).label
    assert.equal(label.includes('处理中') || label.includes('请稍候'), false, `${phase} 不许用笼统文案`)
    assert.notEqual(label, '', `${phase} 必须有文案`)
  }
})

test('等待中的阶段：busy=true、停止按钮禁用、给出等待预算与已等待时长', () => {
  const view = stopPresentationOf({ stop: stopOf(), now: 3_500 })
  assert.equal(view.busy, true)
  assert.equal(view.stopDisabled, true, '等待期间不鼓励连点')
  assert.equal(view.waitHint, zhCN.stopWaitBudget)
  assert.equal(view.elapsedText, `${zhCN.stopElapsedPrefix}2${zhCN.stopElapsedSuffix}`, '已等待秒数来自 Host/本地时钟较大者')
  assert.equal(view.hint, zhCN.stopNoRestartHint, '等待期间必须说清"不能启动新的审核"')
})

test('等太久时把文案换成"仍在等待…，请勿启动新的审核"（不许一直显示同一句）', () => {
  const early = stopPresentationOf({ stop: stopOf({ elapsedMs: 1_000 }), now: 2_000 })
  const late = stopPresentationOf({ stop: stopOf({ elapsedMs: 9_000 }), now: 10_000 })
  assert.equal(early.label, zhCN.stopPhaseWaiting)
  assert.equal(late.label, zhCN.stopPhaseStillWaiting)
})

test('canStartNext **只信 Host**：缺字段按未知处理，绝不推断成可以启动', () => {
  // ① Host 说可以 → 可以
  assert.equal(stopPresentationOf({ stop: stopOf({ phase: 'quiesced', quiesced: true, canStartNext: true }), now: 1 }).canStartNext, true)
  // ② Host 说不行 → 不行（哪怕 quiesced 为真：例如落盘失败）
  assert.equal(stopPresentationOf({ stop: stopOf({ phase: 'failed', quiesced: true, canStartNext: false }), now: 1 }).canStartNext, false)
  // ③ **整个 stop 字段缺失**（旧宿主）→ 未知 → 不许说可以启动
  const unknown = stopPresentationOf({ now: 1 })
  assert.equal(unknown.known, false)
  assert.equal(unknown.canStartNext, false, '未知不等于可以启动')
  assert.equal(unknown.hint, zhCN.stopUnknownHint)
  // ④ 本地刚点过停止、宿主还没回报 → 立刻显示"正在请求停止审核…"，但**绝不**声称已停止
  const instant = stopPresentationOf({ requestedAt: 900, now: 1_000 })
  assert.equal(instant.label, zhCN.stopPhaseRequested)
  assert.equal(instant.busy, true)
  assert.equal(instant.canStartNext, false)
  assert.notEqual(instant.label, zhCN.stopPhaseQuiesced)
})

test('timeout：不给"已停止"，给"继续等待 / 再次停止 / 复制诊断"，并说明占用未释放', () => {
  const view = stopPresentationOf({ stop: stopOf({ phase: 'timeout' }), now: 9_000 })
  assert.notEqual(view.label, zhCN.stopPhaseQuiesced, 'timeout 不许显示成已停止')
  assert.equal(view.canStartNext, false, 'timeout 不许放行下一条')
  assert.equal(view.busy, false, '已经不是"正在停"了')
  assert.equal(view.tone, 'error')
  assert.deepEqual(view.actions, { keepWaiting: true, stopAgain: true, openSession: true, copyDiagnostics: true })
  assert.match(view.hint, new RegExp(zhCN.stopNoRestartHint))
  assert.match(view.hint, new RegExp(zhCN.stopKeptHint))
})

test('failed：说清真实原因、保留占用、给"打开当前会话 / 复制诊断"（不显示成功）', () => {
  const view = stopPresentationOf({ stop: stopOf({ phase: 'failed', error: 'EACCES: 状态文件写不进去' }), now: 9_000 })
  assert.notEqual(view.label, zhCN.stopPhaseQuiesced, 'failed 不许显示成已停止')
  assert.equal(view.tone, 'error', '不许是成功态')
  assert.equal(view.canStartNext, false, 'failed 不许放行下一条')
  assert.match(view.hint, /EACCES/, 'failed 必须带上真实原因')
  assert.match(view.hint, new RegExp(zhCN.stopKeptHint))
  assert.deepEqual(view.actions, { keepWaiting: false, stopAgain: false, openSession: true, copyDiagnostics: true })
})

test('quiesced：成功态，允许启动下一条，不再给"再次停止/复制诊断"这些补救动作', () => {
  const view = stopPresentationOf({ stop: stopOf({ phase: 'quiesced', quiesced: true, canStartNext: true }), now: 9_000 })
  assert.equal(view.label, zhCN.stopPhaseQuiesced)
  assert.equal(view.tone, 'success')
  assert.equal(view.busy, false)
  assert.equal(view.canStartNext, true)
  assert.deepEqual(view.actions, { keepWaiting: false, stopAgain: false, openSession: false, copyDiagnostics: false })
})
