import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, findButton, findButtons, loadWorkbench, textContent } from './helpers/legacy-client-renderer.mjs'


test('loads audit JSON only after the user opens 审核信息', async () => {
  const calls = []
  const renderer = createRenderer()
  const Workbench = await loadWorkbench(renderer, (method, args) => {
    calls.push({ method, args })
    if (method === 'workbench:oss-result') {
      return Promise.resolve({
        ok: true,
        info: {
          projectId: '2026-302584-LX10102-BG8734',
          auditTime: '2026-09-20T14:46:00+08:00',
          stage: '二级复核',
          summary: { decision: 'fail', counts: { high: 2, medium: 6, low: 10 } },
          reviewComparison: { status: 'performed', reviewFiles: [] },
        },
      })
    }
    return Promise.resolve({ ok: true })
  })
  renderer.renderRoot(Workbench)

  const seqNo = '2026-302584-LX10102-BG8734'
  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [{
    id: 'obj-1', seqNo, project: '测试项目', business: '报告审核',
    reviewLevel: '二级复核', reviewState: '审核中', currentNode: '二级复核人',
  }])
  renderer.setComponentHook('Workbench', 17, {
    [seqNo]: {
      seqNo,
      htmlKey: `crwu/audit/${seqNo}/审核意见.${seqNo}.html`,
      jsonKey: `crwu/audit/${seqNo}/审核结果.${seqNo}.json`,
    },
  })
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })

  let tree = renderer.renderRoot(Workbench)
  assert.equal(calls.some((call) => call.method === 'workbench:oss-result'), false)
  const button = findButton(tree, '审核信息')
  assert.ok(button, `audited row should expose 审核信息; rendered text: ${textContent(tree)}`)

  button.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.renderRoot(Workbench)

  const resultCalls = calls.filter((call) => call.method === 'workbench:oss-result')
  assert.equal(resultCalls.length, 1)
  assert.equal(resultCalls[0].args.key, `crwu/audit/${seqNo}/审核结果.${seqNo}.json`)
  assert.match(textContent(tree), /二级复核/)
  assert.match(textContent(tree), /高风险 2/)
})

test('does not expose 审核信息 until both HTML and JSON artifacts exist', async () => {
  const renderer = createRenderer()
  const Workbench = await loadWorkbench(renderer)
  renderer.renderRoot(Workbench)
  const seqNo = '2026-302584-LX10102-BG8734'
  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [{ id: 'obj-1', seqNo, project: '测试项目' }])
  renderer.setComponentHook('Workbench', 17, {
    [seqNo]: { seqNo, jsonKey: `crwu/audit/${seqNo}/审核结果.${seqNo}.json` },
  })
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })

  const tree = renderer.renderRoot(Workbench)
  assert.equal(findButton(tree, '审核信息'), null)
})

test('ignores a stale audit detail response after another report is selected', async () => {
  const deferred = new Map()
  const renderer = createRenderer()
  const Workbench = await loadWorkbench(renderer, (method, args) => {
    if (method !== 'workbench:oss-result') return Promise.resolve({ ok: true })
    return new Promise((resolve) => { deferred.set(args.key, resolve) })
  })
  renderer.renderRoot(Workbench)
  const first = '2026-1-FIRST'
  const second = '2026-2-SECOND'
  const cloud = (seqNo) => ({
    seqNo,
    htmlKey: `crwu/audit/${seqNo}/审核意见.${seqNo}.html`,
    jsonKey: `crwu/audit/${seqNo}/审核结果.${seqNo}.json`,
  })
  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [
    { id: 'obj-1', seqNo: first, project: '第一条' },
    { id: 'obj-2', seqNo: second, project: '第二条' },
  ])
  renderer.setComponentHook('Workbench', 17, { [first]: cloud(first), [second]: cloud(second) })
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })

  let tree = renderer.renderRoot(Workbench)
  const buttons = findButtons(tree, '审核信息')
  assert.equal(buttons.length, 2)
  buttons[0].props.onClick()
  buttons[1].props.onClick()

  deferred.get(cloud(second).jsonKey)({
    ok: true,
    info: { projectId: second, stage: '第二条阶段', summary: { counts: {} }, reviewComparison: {} },
  })
  await new Promise((resolve) => setImmediate(resolve))
  deferred.get(cloud(first).jsonKey)({
    ok: true,
    info: { projectId: first, stage: '第一条阶段', summary: { counts: {} }, reviewComparison: {} },
  })
  await new Promise((resolve) => setImmediate(resolve))

  tree = renderer.renderRoot(Workbench)
  assert.match(textContent(tree), /第二条阶段/)
  assert.doesNotMatch(textContent(tree), /第一条阶段/)
})
