/**
 * DatePicker contract (public entry src/client/ui/components/index.ts).
 * Query hooks: trigger has data-crwu-date-trigger / aria-haspopup="dialog"; open popup is
 * role="dialog" and handles Escape via onKeyDown; day cells carry data-date; clear/today use
 * data-crwu-date-action; month/year nav uses data-crwu-date-nav. Focus and real geometry are
 * left for supervisor browser checks.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const ENTRY = new URL('src/client/ui/components/index.ts', ROOT).href

const { render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)

let cache = null
async function components() {
  if (cache !== null) return cache
  await assert.doesNotReject(
    () => import(ENTRY),
    undefined,
    '公共组件入口缺失或无法加载：src/client/ui/components/index.ts',
  )
  cache = await import(ENTRY)
  return cache
}

function props(patch = {}) {
  return { value: '', onChange: () => {}, ...patch }
}

const inputOf = (tree) => find(tree, (node) => node.type === 'input')
const triggerOf = (tree) => find(tree, (node) =>
  node.props?.['data-crwu-date-trigger'] !== undefined
  || (node.type === 'button' && node.props?.['aria-haspopup'] === 'dialog'))
// Only accessible dialogs count as open: a popup playing its exit animation may stay mounted
// with aria-hidden="true" and must not satisfy "dialog present" assertions.
const dialogOf = (tree) => find(tree, (node) =>
  node.props?.role === 'dialog'
  && node.props?.['aria-hidden'] !== true
  && node.props?.['aria-hidden'] !== 'true')
const dayOf = (tree, iso) => find(tree, (node) => node.props?.['data-date'] === iso)
const actionOf = (tree, name) => find(tree, (node) => node.props?.['data-crwu-date-action'] === name)
const navOf = (tree, name) => find(tree, (node) => node.props?.['data-crwu-date-nav'] === name)

/** Render, open the calendar, return the expanded tree. */
function open(DatePicker, patch = {}) {
  const first = render(DatePicker, props(patch))
  const trigger = triggerOf(first.tree)
  assert.ok(trigger, 'DatePicker 必须有日历触发器')
  trigger.props.onClick?.()
  return rerender(DatePicker, props(patch))
}

test('空值不默认今天：输入为空，挂载也不产生变更', async () => {
  const { DatePicker } = await components()
  const picked = []
  const { tree } = render(DatePicker, props({ value: '', onChange: (value) => { picked.push(value) } }))
  const input = inputOf(tree)
  assert.ok(input, 'DatePicker 必须渲染文本输入')
  assert.equal(input.props.value, '', '空值必须保持空，不许回填今天')
  assert.deepEqual(picked, [], '挂载不许自动写入日期')
})

test('文本输入 + 日历触发器取代原生 date 控件', async () => {
  const { DatePicker } = await components()
  const { tree } = render(DatePicker, props({ value: '2026-01-15' }))
  const input = inputOf(tree)
  assert.ok(input, 'DatePicker 必须渲染文本输入')
  assert.notEqual(input.props.type, 'date', '不许再用原生 type="date"')
  assert.equal(input.props.type === undefined ? 'text' : input.props.type, 'text')
  assert.equal(input.props.value, '2026-01-15', '受控值要直接显示')
  const trigger = triggerOf(tree)
  assert.ok(trigger, '必须有日历触发器')
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(trigger.props['aria-expanded'], false)
})

test('id / describedBy / invalid 透传到输入', async () => {
  const { DatePicker } = await components()
  const { tree } = render(DatePicker, props({
    value: '2026-01-15', id: 'base-date', describedBy: 'base-date-hint', invalid: true,
  }))
  const input = inputOf(tree)
  assert.ok(input, 'DatePicker 必须渲染文本输入')
  assert.equal(input.props.id, 'base-date')
  assert.equal(input.props['aria-describedby'], 'base-date-hint')
  assert.equal(input.props['aria-invalid'], true)
})

test('键入合法 YYYY-MM-DD：失焦提交一次', async () => {
  const { DatePicker } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = render(DatePicker, props({ value: '', onChange })).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-01-31' } })
  tree = rerender(DatePicker, props({ value: '', onChange }))
  assert.equal(inputOf(tree).props.value, '2026-01-31', '输入过程中的文本要保留')
  inputOf(tree).props.onBlur?.({ target: { value: '2026-01-31' } })
  assert.deepEqual(picked, ['2026-01-31'], '合法日期只提交一次')
})

test('非法文本：原样保留、显示错误、不回调', async () => {
  const { DatePicker } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = render(DatePicker, props({ value: '', onChange })).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props({ value: '', onChange }))
  inputOf(tree).props.onBlur?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props({ value: '', onChange }))
  assert.equal(inputOf(tree).props.value, '2026-02-30', '非法文本必须原样保留，不许静默归一')
  assert.equal(inputOf(tree).props['aria-invalid'], true, '非法输入要暴露 aria-invalid')
  const alert = find(tree, (node) => node.props?.role === 'alert')
  assert.ok(alert, '非法输入要显示错误提示')
  assert.equal(textOf(alert).trim() !== '', true, '错误提示不能是空文本')
  assert.deepEqual(picked, [], '非法日期不回调')
})

test('日历点选：回传 YYYY-MM-DD 并关闭浮层', async () => {
  const { DatePicker } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = open(DatePicker, { value: '2026-01-15', onChange })
  assert.ok(dialogOf(tree), '打开后必须有 dialog 浮层')
  const day = dayOf(tree, '2026-01-31')
  assert.ok(day, '当月网格里必须有 2026-01-31')
  day.props.onClick?.()
  tree = rerender(DatePicker, props({ value: '2026-01-31', onChange }))
  assert.deepEqual(picked, ['2026-01-31'])
  assert.equal(dialogOf(tree), null, '点选后浮层关闭')
  assert.equal(triggerOf(tree).props['aria-expanded'], false)
})

test('清空动作回传空串', async () => {
  const { DatePicker } = await components()
  const picked = []
  const { tree } = render(DatePicker, props({ value: '2026-01-31', onChange: (value) => { picked.push(value) } }))
  const clear = actionOf(tree, 'clear')
  assert.ok(clear, '必须有清空操作')
  clear.props.onClick?.()
  assert.deepEqual(picked, [''])
})

test('Escape 关闭浮层并保留原值', async () => {
  const { DatePicker } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = open(DatePicker, { value: '2026-01-15', onChange })
  const dialog = dialogOf(tree)
  assert.ok(dialog, '打开后必须有 dialog 浮层')
  assert.equal(typeof dialog.props.onKeyDown, 'function', '浮层要自己处理 Escape')
  dialog.props.onKeyDown({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} })
  tree = rerender(DatePicker, props({ value: '2026-01-15', onChange }))
  assert.equal(dialogOf(tree), null, 'Escape 关闭浮层')
  assert.equal(inputOf(tree).props.value, '2026-01-15', '取消后原值保留')
  assert.deepEqual(picked, [], 'Escape 不产生变更')
})

test('disabled / readOnly 阻止弹层与变更', async () => {
  const { DatePicker } = await components()
  for (const flag of ['disabled', 'readOnly']) {
    const picked = []
    const patch = { value: '2026-01-31', [flag]: true, onChange: (value) => { picked.push(value) } }
    const first = render(DatePicker, props(patch))
    triggerOf(first.tree)?.props.onClick?.()
    const tree = rerender(DatePicker, props(patch))
    assert.equal(dialogOf(tree), null, `${flag} 时不许打开弹层`)
    const input = inputOf(tree)
    assert.ok(input, `${flag} 时仍要渲染输入`)
    assert.equal(Boolean(input.props[flag]), true, `${flag} 必须落到输入上`)
    input.props.onChange?.({ target: { value: '2026-02-01' } })
    input.props.onBlur?.({ target: { value: '2026-02-01' } })
    assert.deepEqual(picked, [], `${flag} 时不许产生变更`)
  }
})

test('头部有上/下一年与上/下一个月导航', async () => {
  const { DatePicker } = await components()
  const tree = open(DatePicker, { value: '2026-01-15' })
  for (const nav of ['prev-month', 'next-month', 'prev-year', 'next-year']) {
    assert.ok(navOf(tree, nav), `缺少 ${nav} 导航`)
  }
  assert.equal(/2026/.test(textOf(tree)), true, '头部要显示当前年月')
})

test('min / max 之外的日期不可选', async () => {
  const { DatePicker } = await components()
  const picked = []
  const tree = open(DatePicker, {
    value: '2026-01-15', min: '2026-01-10', max: '2026-01-20',
    onChange: (value) => { picked.push(value) },
  })
  const before = dayOf(tree, '2026-01-05')
  const inside = dayOf(tree, '2026-01-15')
  const after = dayOf(tree, '2026-01-25')
  assert.ok(before && inside && after, '当月网格要包含边界内外的日期')
  const isOff = (node) => node.props?.disabled === true || node.props?.['aria-disabled'] === true
  assert.equal(isOff(before), true, '早于 min 的日子不可选')
  assert.equal(isOff(after), true, '晚于 max 的日子不可选')
  assert.equal(isOff(inside), false, '范围内的日子可选')
  before.props.onClick?.()
  after.props.onClick?.()
  assert.deepEqual(picked, [], '范围外点击不产生变更')
})

// ── Range / validity regressions (supervisor-observed defects) ───────────────

test('手动键入范围外日期：失焦保留草稿、显示错误、不回调', async () => {
  const { DatePicker } = await components()
  const picked = []
  const patch = { value: '', min: '2026-01-10', max: '2026-01-20', onChange: (value) => { picked.push(value) } }
  let tree = render(DatePicker, props(patch)).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-02-01' } })
  tree = rerender(DatePicker, props(patch))
  inputOf(tree).props.onBlur?.({ target: { value: '2026-02-01' } })
  tree = rerender(DatePicker, props(patch))
  assert.equal(inputOf(tree).props.value, '2026-02-01', '范围外草稿必须原样保留')
  assert.equal(inputOf(tree).props['aria-invalid'], true, '范围外要暴露 aria-invalid')
  assert.ok(find(tree, (node) => node.props?.role === 'alert'), '范围外要显示可见错误')
  assert.deepEqual(picked, [], '范围外日期不许回调')
})

test('「今天」在范围外时不可点、不回调', async () => {
  const { DatePicker } = await components()
  const picked = []
  const tree = open(DatePicker, {
    value: '', min: '2000-01-01', max: '2000-12-31', onChange: (value) => { picked.push(value) },
  })
  const today = actionOf(tree, 'today')
  assert.ok(today, '要有显式的「今天」动作')
  assert.equal(today.props.disabled === true || today.props['aria-disabled'] === true, true,
    '范围外的今天必须禁用')
  today.props.onClick?.()
  assert.deepEqual(picked, [], '禁用的今天不许回调')
})

test('键盘焦点落在范围外日期时 Enter 不能提交', async () => {
  const { DatePicker } = await components()
  const picked = []
  const patch = {
    value: '2026-01-15', min: '2026-01-15', max: '2026-01-15',
    onChange: (value) => { picked.push(value) },
  }
  let tree = open(DatePicker, patch)
  dialogOf(tree).props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {}, stopPropagation: () => {} })
  tree = rerender(DatePicker, props(patch))
  const outside = dayOf(tree, '2026-01-16')
  assert.ok(outside, '网格里要有相邻的范围外日期')
  assert.equal(outside.props.disabled === true || outside.props['aria-disabled'] === true, true,
    '相邻日期在范围外不可选')
  dialogOf(tree).props.onKeyDown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} })
  assert.deepEqual(picked, [], '范围外日期不许用键盘提交')
})

test('父值为空但草稿非法时，清空动作仍可见并恢复有效态', async () => {
  const { DatePicker } = await components()
  const picked = []
  const validity = []
  const patch = {
    value: '',
    onChange: (value) => { picked.push(value) },
    onValidityChange: (valid) => { validity.push(valid) },
  }
  let tree = render(DatePicker, props(patch)).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props(patch))
  inputOf(tree).props.onBlur?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props(patch))
  const clear = actionOf(tree, 'clear')
  assert.ok(clear, '父值为空但草稿非法时，清空动作必须可见')
  clear.props.onClick?.()
  assert.equal(picked.includes('2026-02-30'), false, '非法草稿不许回调')
  assert.equal(validity.includes(false), true, '编辑非法草稿时先报无效')
  assert.equal(validity[validity.length - 1], true, '清空后恢复有效')
})

test('非法草稿的错误提示 id 要进入输入框 aria-describedby', async () => {
  const { DatePicker } = await components()
  const patch = { value: '', onChange: () => {} }
  let tree = render(DatePicker, props(patch)).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props(patch))
  inputOf(tree).props.onBlur?.({ target: { value: '2026-02-30' } })
  tree = rerender(DatePicker, props(patch))
  const alert = find(tree, (node) => node.props?.role === 'alert')
  assert.ok(alert && typeof alert.props.id === 'string' && alert.props.id !== '', '错误提示要有稳定 id')
  const ids = String(inputOf(tree).props['aria-describedby'] ?? '').split(/\s+/).filter((one) => one !== '')
  assert.equal(ids.includes(alert.props.id), true, '输入框要关联内部错误提示 id')
})

test('onValidityChange：非法非空编辑先报 false，换成合法日期恢复 true 且不回调非法值', async () => {
  const { DatePicker } = await components()
  const picked = []
  const validity = []
  const patch = {
    value: '',
    onChange: (value) => { picked.push(value) },
    onValidityChange: (valid) => { validity.push(valid) },
  }
  const tree = render(DatePicker, props(patch)).tree
  inputOf(tree).props.onChange?.({ target: { value: '2026-2-3' } })
  assert.equal(validity[validity.length - 1], false, '非法或残缺草稿要立刻报无效')
  assert.deepEqual(picked, [], '无效编辑不许回调')
  const next = rerender(DatePicker, props(patch))
  inputOf(next).props.onChange?.({ target: { value: '2026-02-03' } })
  assert.equal(validity[validity.length - 1], true, '换成合法日期要恢复有效')
  assert.deepEqual(picked, [], '编辑阶段仍不许回调')
})

test('年月头部不再使用原生 select', async () => {
  const { DatePicker } = await components()
  const tree = open(DatePicker, { value: '2026-01-15' })
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 0, '年月定位不能用原生 select')
})

test('月份导航按当前可见月份推进', async () => {
  const { DatePicker } = await components()
  let tree = open(DatePicker, { value: '2026-01-15' })
  navOf(tree, 'next-month').props.onClick?.()
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  assert.equal(/2026年2月/.test(textOf(tree)), true, '下一个月要显示 2026年2月')
  navOf(tree, 'next-month').props.onClick?.()
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  assert.equal(/2026年3月/.test(textOf(tree)), true, '第二次推进要停在可见月份上')
})

// ── Visible-month focus / tab-order regressions ─────────────────────────────

const tabStopDays = (tree) => findAll(tree, (node) =>
  node.props?.['data-date'] !== undefined && node.props.tabIndex === 0)

test('下一个月后仍恰有一天在 Tab 顺序内，键盘从可见月继续', async () => {
  const { DatePicker } = await components()
  let tree = open(DatePicker, { value: '2026-01-15' })
  navOf(tree, 'next-month').props.onClick?.()
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  const stops = tabStopDays(tree)
  assert.equal(stops.length, 1, '可见月份必须恰有一天在 Tab 顺序内')
  assert.equal(stops[0].props['data-date'], '2026-02-15', '焦点日要跟到可见月份')
  dialogOf(tree).props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} })
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  assert.equal(tabStopDays(tree)[0].props['data-date'], '2026-02-22',
    '键盘从可见月继续，不回跳到旧月份')
})

test('空值 + 限定范围时打开在实际可选的边界月', async () => {
  const { DatePicker } = await components()
  const tree = open(DatePicker, { value: '', min: '2000-01-01', max: '2000-12-31' })
  assert.equal(/2000年12月/.test(textOf(tree)), true, '要打开在最大可选月')
  const stops = tabStopDays(tree)
  assert.equal(stops.length, 1, '恰有一个可聚焦日')
  assert.equal(stops[0].props['data-date'], '2000-12-31', '聚焦到最大可选日')
})

test('Tab 不再无条件关闭浮层（只有真正离开非模态选择器才关）', async () => {
  const { DatePicker } = await components()
  let tree = open(DatePicker, { value: '2026-01-15' })
  dialogOf(tree).props.onKeyDown({ key: 'Tab', preventDefault: () => {}, stopPropagation: () => {} })
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  assert.ok(dialogOf(tree), '选择器内 Tab 后浮层仍在')
  assert.equal(findAll(tree, (node) => node.props?.role === 'grid').length >= 1, true, '日期网格仍在')
})

test('月份/年份视图使用分组语义而不是空 grid', async () => {
  const { DatePicker } = await components()
  let tree = open(DatePicker, { value: '2026-01-15' })
  find(tree, (node) => node.props?.['data-crwu-date-view'] === 'months').props.onClick?.()
  tree = rerender(DatePicker, props({ value: '2026-01-15' }))
  assert.equal(findAll(tree, (node) => node.props?.role === 'group').length >= 1, true,
    '月份视图要有 group 语义')
  assert.equal(findAll(tree, (node) => node.props?.['data-crwu-date-view'] === 'month').length, 12,
    '要有 12 个月份按钮')
})
