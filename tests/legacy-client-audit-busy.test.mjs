import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, findButton, loadWorkbench, textContent } from './helpers/legacy-client-renderer.mjs'

test('the active task disables its start button while audit creation is pending', async () => {
  const renderer = createRenderer()
  const Workbench = await loadWorkbench(renderer)
  renderer.renderRoot(Workbench)

  const task = {
    id: 'obj-1',
    seqNo: '2026-302584-LX10102-BG8734',
    project: '测试项目',
    business: '报告审核',
  }
  renderer.setComponentHook('Workbench', 1, 'report')
  renderer.setComponentHook('Workbench', 4, [task])
  renderer.setComponentHook('Workbench', 22, {
    blocked: [], checks: [],
    services: [{ id: 'h3yun', ok: true }, { id: 'dingtalk', ok: true }],
  })
  renderer.setComponentHook('Workbench', 32, task.seqNo)

  const tree = renderer.renderRoot(Workbench)
  const button = findButton(tree, '创建中…')
  assert.ok(button, `pending task should render a 创建中… button; rendered text: ${textContent(tree)}`)
  assert.equal(button.props.disabled, true)
})
