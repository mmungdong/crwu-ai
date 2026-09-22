/**
 * 模块状态 store 的直接测试。
 *
 * 它是「侧栏那张分组卡上的三个子项」与「面板里的三页」之间**唯一**的连接，
 * 所以这里钉的是它的契约而不是界面：只自动落位一次、每次主动选都要推进 epoch、
 * 值没变不许通知、退订之后不许再收到通知。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)
const { createModuleStore } = await import(new URL('src/client/features/workbench/module-store.ts', ROOT).href)

test('autoEnter 只自动落位一次：用户手动选过之后不许再被弹走', () => {
  const store = createModuleStore()
  assert.equal(store.get().active, 'env')
  store.autoEnter(true)
  assert.equal(store.get().active, 'audit', '自检通过就直接进报告审核')
  assert.equal(store.get().autoEntered, true)

  // 用户手动点回「环境信息」，随后自检结论再落地一次（重跑自检）—— 不许把他弹走。
  store.select('env')
  store.autoEnter(true)
  assert.equal(store.get().active, 'env')

  // 自检没通过时停在环境信息页（口径与重构前一致）。
  const fresh = createModuleStore()
  fresh.autoEnter(false)
  assert.equal(fresh.get().active, 'env')
})

test('select 每次主动选都会推进 selectEpoch（同一个子项再点一次也算重新进入）', () => {
  const store = createModuleStore()
  assert.equal(store.get().selectEpoch, 0)
  store.select('audit')
  assert.equal(store.get().selectEpoch, 1)
  store.select('audit')
  assert.equal(store.get().selectEpoch, 2, '同一模块再点一次也要推进：面板靠它清掉过期的拦截屏')
  // 自动落位不是「用户主动选」，不推进 epoch。
  const other = createModuleStore()
  other.autoEnter(true)
  assert.equal(other.get().selectEpoch, 0)
})

test('值没变就不通知，退订之后也不再收到通知', () => {
  const store = createModuleStore()
  let notified = 0
  const dispose = store.subscribe(() => { notified += 1 })

  // 「已经自动落位过」再落一次 = 快照没变 → 不许通知（否则订阅方白重画）。
  store.autoEnter(true)
  assert.equal(notified, 1)
  store.autoEnter(true)
  assert.equal(notified, 1, '快照没变就不该再通知')

  dispose()
  store.select('eval')
  assert.equal(notified, 1, '退订之后不许再收到通知')
  assert.equal(store.get().active, 'eval')
})
