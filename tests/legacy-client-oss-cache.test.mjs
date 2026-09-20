import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, findButton, loadWorkbench } from './helpers/legacy-client-renderer.mjs'


test('reuses the OSS index for search and only lists OSS again on explicit refresh', async () => {
  const calls = []
  const renderer = createRenderer()
  const Workbench = await loadWorkbench(renderer, (method, args) => {
    calls.push({ method, args })
    if (method === 'workbench:pending') {
      return Promise.resolve({ ok: true, rows: [], total: 0, page: 1, size: 20 })
    }
    if (method === 'workbench:oss-index') {
      return Promise.resolve({ ok: true, items: {} })
    }
    return Promise.resolve({ ok: true })
  })
  renderer.renderRoot(Workbench)

  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [])
  renderer.setComponentHook('Workbench', 17, {})
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })
  renderer.setComponentHook('Workbench', 44, true)

  let tree = renderer.renderRoot(Workbench)
  findButton(tree, '检索').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.filter((call) => call.method === 'workbench:pending').length, 1)
  assert.equal(calls.filter((call) => call.method === 'workbench:oss-index').length, 0)

  tree = renderer.renderRoot(Workbench)
  findButton(tree, '刷新数据').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.filter((call) => call.method === 'workbench:pending').length, 2)
  assert.equal(calls.filter((call) => call.method === 'workbench:oss-index').length, 1)
})

test('keeps the H3Yun page and does not retry OSS implicitly when the initial list fails', async () => {
  const calls = []
  const renderer = createRenderer()
  const seqNo = '2026-302584-LX10102-BG8734'
  const Workbench = await loadWorkbench(renderer, (method, args) => {
    calls.push({ method, args })
    if (method === 'workbench:pending') {
      return Promise.resolve({
        ok: true,
        rows: [{ id: 'obj-1', seqNo, project: 'OSS 失败也应显示的项目', business: '报告审核' }],
        total: 1,
        page: 1,
        size: 20,
      })
    }
    if (method === 'workbench:oss-index') return Promise.reject(new Error('OSS unavailable'))
    return Promise.resolve({ ok: true })
  })
  renderer.renderRoot(Workbench)
  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [])
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })

  let tree = renderer.renderRoot(Workbench)
  findButton(tree, '检索').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.renderRoot(Workbench)
  assert.match(JSON.stringify(tree), new RegExp(seqNo))

  findButton(tree, '检索').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((call) => call.method === 'workbench:oss-index').length, 1)
})
