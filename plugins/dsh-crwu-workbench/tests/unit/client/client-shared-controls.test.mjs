/**
 * Shared controls contract (src/client/ui/components/index.ts).
 *
 * Interface points this file defines for the implementation:
 * - Button: variant primary|secondary|soft|text, loading, disabled, describedBy, onClick; type="button".
 * - TextInput: value / onChange(value) / clearable / readOnly / disabled; the clear action is the only <button>.
 * - FormField: children is a render function (field) => ReactNode with { id, describedBy, invalid, required };
 *   fakeReact has no cloneElement, so the caller builds the control from the field ids.
 * - Select: `name` is a semantic anchor only; instance ids must add a unique suffix so two same-name
 *   mounts never share listbox / option ids.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const ENTRY = new URL('src/client/ui/components/index.ts', ROOT).href

const { React, render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)

/**
 * Load the public entry. assert.doesNotReject turns "entry not implemented yet" into a named
 * assertion failure instead of a test-file load error.
 */
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

test('公共入口导出全部共享组件', async () => {
  const mod = await components()
  for (const name of ['Button', 'IconButton', 'FormField', 'TextInput', 'TextArea', 'Select', 'DatePicker', 'Popover']) {
    assert.equal(typeof mod[name], 'function', `src/client/ui/components/index.ts 必须导出 ${name}`)
  }
})

const buttonOf = (tree) => find(tree, (node) => node.type === 'button')

// ── Button ──────────────────────────────────────────────────────────────────

test('Button：primary/secondary/soft/text 变体各自可区分，且都是普通按钮', async () => {
  const { Button } = await components()
  assert.equal(typeof Button, 'function', 'index.ts 必须导出 Button')
  const clicks = []
  const classNames = []
  for (const variant of ['primary', 'secondary', 'soft', 'text']) {
    const { tree } = render(Button, { variant, children: variant, onClick: () => { clicks.push(variant) } })
    const button = buttonOf(tree)
    assert.ok(button, `Button(${variant}) 必须渲染 <button>`)
    assert.equal(button.props.type, 'button', '普通表单按钮不意外提交')
    classNames.push(String(button.props.className ?? ''))
    button.props.onClick?.()
  }
  assert.deepEqual(clicks, ['primary', 'secondary', 'soft', 'text'])
  assert.equal(new Set(classNames).size, 4, '四种变体的类名必须互不相同，否则视觉上分不开')
})

test('Button：loading 与 disabled 都阻止点击，并暴露 busy / description', async () => {
  const { Button } = await components()
  const clicks = []
  const loading = buttonOf(render(Button, {
    variant: 'primary', loading: true, onClick: () => { clicks.push('loading') },
  }).tree)
  assert.ok(loading, 'loading 态也要渲染按钮')
  assert.equal(loading.props['aria-busy'], true, 'loading 必须对读屏暴露 busy')
  loading.props.onClick?.()

  const disabled = buttonOf(render(Button, {
    variant: 'secondary', disabled: true, describedBy: 'crwu-reason', onClick: () => { clicks.push('disabled') },
  }).tree)
  assert.ok(disabled, 'disabled 态也要渲染按钮')
  assert.equal(disabled.props.disabled, true)
  assert.equal(disabled.props['aria-describedby'], 'crwu-reason', '禁用原因必须可读')
  disabled.props.onClick?.()

  assert.deepEqual(clicks, [], 'loading / disabled 都不许触发点击回调')
})

test('IconButton：有可访问名称，disabled 阻止点击', async () => {
  const { IconButton } = await components()
  const clicks = []
  const { tree } = render(IconButton, {
    'aria-label': '打开日历', label: '打开日历', title: '打开日历',
    disabled: true, onClick: () => { clicks.push('icon') },
  })
  const button = buttonOf(tree)
  assert.ok(button, 'IconButton 必须渲染 <button>')
  const named = button.props['aria-label'] ?? button.props.title
  assert.equal(typeof named === 'string' && named !== '', true, '图标按钮必须有可访问名称')
  assert.equal(button.props.disabled, true)
  button.props.onClick?.()
  assert.deepEqual(clicks, [])
})

// ── TextInput / TextArea ────────────────────────────────────────────────────

test('TextInput：clear 回传空串，readOnly / disabled 阻止变更', async () => {
  const { TextInput } = await components()
  const seen = []
  const tree = render(TextInput, {
    value: '2026-01-31', clearable: true, onChange: (value) => { seen.push(value) },
  }).tree
  const input = find(tree, (node) => node.type === 'input')
  assert.ok(input, 'TextInput 必须渲染 <input>')
  const clear = find(tree, (node) => node.type === 'button')
  assert.ok(clear, '有值且 clearable 时必须渲染清空动作')
  assert.equal(clear.props.type, 'button')
  const clearName = clear.props['aria-label'] ?? clear.props.title ?? textOf(clear)
  assert.equal(String(clearName).trim() !== '', true, '清空动作必须有可访问名称')
  clear.props.onClick?.()
  assert.deepEqual(seen, [''], '清空必须回传空串')

  for (const flag of ['readOnly', 'disabled']) {
    const fields = render(TextInput, {
      value: 'x', [flag]: true, onChange: (value) => { seen.push(`${flag}:${value}`) },
    }).tree
    const field = find(fields, (node) => node.type === 'input')
    assert.ok(field, `TextInput(${flag}) 必须渲染 <input>`)
    assert.equal(Boolean(field.props[flag]), true, `${flag} 要落到输入上`)
    field.props.onChange?.({ target: { value: 'y' } })
  }
  assert.deepEqual(seen, [''], 'readOnly / disabled 时不许产生变更')
})

test('TextInput：装饰位标记只落在外层 wrapper，起点装饰排在 input 之前', async () => {
  const { TextInput } = await components()
  const decorate = (key) => React.createElement('svg', { 'data-fixture-icon': key })

  const start = render(TextInput, { value: '', startAdornment: decorate('start'), onChange: () => {} }).tree
  assert.equal(start.props['data-start-adorned'], 'true', '起点装饰要在 wrapper 上留标记（供 field 样式定内缩）')
  assert.equal(start.props['data-end-adorned'], undefined, '没有终点装饰就不该有这个标记')
  const startInput = find(start, (node) => node.type === 'input')
  assert.ok(startInput, 'TextInput 必须渲染 <input>')
  assert.equal(startInput.props['data-start-adorned'], undefined, 'wrapper 标记不得漏到 input 上')
  const startChildren = Array.isArray(start.props.children) ? start.props.children : [start.props.children]
  assert.equal(startChildren[0]?.type, 'span', '起点装饰必须排在 input 前面')
  assert.equal(startChildren[1]?.type, 'input')

  const end = render(TextInput, { value: '', endAdornment: decorate('end'), onChange: () => {} }).tree
  assert.equal(end.props['data-end-adorned'], 'true', '终点装饰要在 wrapper 上留标记')
  assert.equal(end.props['data-start-adorned'], undefined)
  const endChildren = (Array.isArray(end.props.children) ? end.props.children : [end.props.children])
    .filter((child) => child !== null && child !== undefined && child !== false)
  assert.equal(endChildren[endChildren.length - 1]?.type, 'span', '终点装饰必须排在 input 后面')

  const plain = render(TextInput, { value: '', onChange: () => {} }).tree
  assert.equal(plain.props['data-start-adorned'], undefined, '无装饰的普通输入不加起点标记')
  assert.equal(plain.props['data-end-adorned'], undefined, '无装饰的普通输入不加终点标记')
})

test('TextArea：受控值与 readOnly 阻止变更', async () => {
  const { TextArea } = await components()
  const seen = []
  const { tree } = render(TextArea, {
    value: '补充说明', readOnly: true, onChange: (value) => { seen.push(value) },
  })
  const area = find(tree, (node) => node.type === 'textarea')
  assert.ok(area, 'TextArea 必须渲染 <textarea>')
  assert.equal(area.props.value, '补充说明')
  assert.equal(area.props.readOnly, true)
  area.props.onChange?.({ target: { value: '改了' } })
  assert.deepEqual(seen, [])
})

// ── FormField ───────────────────────────────────────────────────────────────

test('FormField：可见标签、提示与错误都关联到控件', async () => {
  const { FormField, TextInput } = await components()
  const tree = render(FormField, {
    label: '基准日',
    required: true,
    hint: '只接受真实日期',
    error: '该日期不存在',
    children: (field) => React.createElement(TextInput, {
      id: field.id,
      describedBy: field.describedBy,
      invalid: field.invalid,
      required: field.required,
      value: '',
      onChange: () => {},
    }),
  }).tree
  const label = find(tree, (node) => node.type === 'label')
  assert.ok(label, 'FormField 必须渲染 <label>')
  assert.equal(textOf(label).includes('基准日'), true, '标签文案必须可见')
  const input = find(tree, (node) => node.type === 'input')
  assert.ok(input, 'FormField 的 children 必须渲染出控件')
  assert.equal(label.props.htmlFor, input.props.id, 'label.htmlFor 必须等于控件 id')
  assert.equal(input.props['aria-required'] === true || input.props.required === true, true,
    'required 必须传给控件')
  assert.equal(input.props['aria-invalid'], true, 'error 态必须传 aria-invalid')
  const ids = String(input.props['aria-describedby'] ?? '').split(/\s+/).filter((one) => one !== '')
  assert.ok(ids.length >= 2, 'hint 与 error 都要被 aria-describedby 关联')
  const texts = ids.map((id) => {
    const node = find(tree, (item) => item.props?.id === id)
    assert.ok(node, `aria-describedby 指向的 ${id} 必须在树里`)
    return textOf(node)
  })
  assert.equal(texts.includes('只接受真实日期'), true, '提示文本要关联')
  assert.equal(texts.includes('该日期不存在'), true, '错误文本要关联')
})

// ── Select ──────────────────────────────────────────────────────────────────

const SELECT_OPTIONS = [
  { value: 'house', label: '住宅' },
  { value: 'land', label: '土地' },
  { value: 'other', label: '其他', disabled: true },
]

function selectProps(patch = {}) {
  return { name: 'asset-type', value: '', placeholder: '请选择', options: SELECT_OPTIONS, onChange: () => {}, ...patch }
}

const comboboxOf = (tree) => find(tree, (node) => node.props?.role === 'combobox')
// An inert exit surface (aria-hidden) must not count as an accessible open listbox.
const listboxOf = (tree) => find(tree, (node) =>
  node.props?.role === 'listbox'
  && node.props?.['aria-hidden'] !== true
  && node.props?.['aria-hidden'] !== 'true')
const optionNodes = (tree) => findAll(tree, (node) => node.props?.role === 'option')
const isDisabledOption = (node) => node.props['aria-disabled'] === true || node.props.disabled === true

test('Select：空值保持占位，打开 / 取消都不产生变更', async () => {
  const { Select } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = render(Select, selectProps({ onChange })).tree
  const trigger = comboboxOf(tree)
  assert.ok(trigger, 'Select 触发器必须是 combobox')
  assert.equal(trigger.props['aria-haspopup'], 'listbox')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(textOf(tree).includes('请选择'), true, '未选时显示占位')
  assert.equal(listboxOf(tree), null, '收起时不画浮层')

  trigger.props.onClick?.()
  tree = rerender(Select, selectProps({ onChange }))
  assert.ok(listboxOf(tree), '点击后展开 listbox')
  assert.equal(optionNodes(tree).length, SELECT_OPTIONS.length)
  assert.deepEqual(picked, [], '打开浮层不是选择')

  comboboxOf(tree).props.onKeyDown?.({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} })
  tree = rerender(Select, selectProps({ onChange }))
  assert.equal(listboxOf(tree), null, 'Escape 关闭浮层')
  assert.deepEqual(picked, [], '取消不产生变更')
  assert.equal(textOf(tree).includes('请选择'), true, '取消后仍保持空值与占位')
})

test('Select：键盘移动并提交，disabled 项不会成为活动项', async () => {
  const { Select } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = render(Select, selectProps({ onChange })).tree
  const press = (key) => {
    comboboxOf(tree).props.onKeyDown?.({ key, preventDefault: () => {}, stopPropagation: () => {} })
    tree = rerender(Select, selectProps({ onChange }))
  }
  press('ArrowDown')
  assert.equal(comboboxOf(tree).props['aria-expanded'], true, '方向键展开浮层')
  press('ArrowDown')
  const disabledOption = optionNodes(tree).find(isDisabledOption)
  assert.ok(disabledOption, 'disabled 选项必须暴露 aria-disabled')
  assert.notEqual(comboboxOf(tree).props['aria-activedescendant'], disabledOption.props.id,
    '方向键不许停在 disabled 项上')
  press('Enter')
  assert.equal(picked.length, 1, 'Enter 提交活动项')
  assert.notEqual(picked[0], 'other', 'disabled 项不可提交')
  assert.equal(comboboxOf(tree).props['aria-expanded'], false, '提交后收起')
})

test('Select：disabled 选项点击不提交，disabled 触发器不展开', async () => {
  const { Select } = await components()
  const picked = []
  const onChange = (value) => { picked.push(value) }
  let tree = render(Select, selectProps({ onChange })).tree
  comboboxOf(tree).props.onClick?.()
  tree = rerender(Select, selectProps({ onChange }))
  const disabledOption = optionNodes(tree).find(isDisabledOption)
  assert.ok(disabledOption, 'disabled 选项必须在浮层里')
  disabledOption.props.onClick?.()
  assert.deepEqual(picked, [], 'disabled 项点击不产生变更')

  const off = render(Select, selectProps({ onChange, disabled: true })).tree
  assert.equal(comboboxOf(off).props.disabled, true, 'disabled 触发器要真的禁用')
  comboboxOf(off).props.onClick?.()
  const after = rerender(Select, selectProps({ onChange, disabled: true }))
  assert.equal(listboxOf(after), null, 'disabled 时不展开')
})

test('Select：两个同名实例的 listbox / option id 互不冲突', async () => {
  const { Select } = await components()
  const idsOf = () => {
    const first = render(Select, selectProps({ name: 'asset-type' }))
    comboboxOf(first.tree).props.onClick?.()
    const tree = rerender(Select, selectProps({ name: 'asset-type' }))
    const list = listboxOf(tree)
    assert.ok(list, '打开后必须有 listbox')
    return { list: list.props.id, options: optionNodes(tree).map((node) => node.props.id) }
  }
  const one = idsOf()
  const two = idsOf()
  assert.equal(typeof one.list === 'string' && one.list !== '', true, 'listbox 必须有稳定 id')
  assert.notEqual(one.list, two.list, '同名 Select 的 listbox id 必须不同')
  assert.equal(one.options.length, SELECT_OPTIONS.length)
  for (let index = 0; index < one.options.length; index += 1) {
    assert.notEqual(one.options[index], two.options[index], `第 ${index} 个 option id 必须不同`)
  }
  assert.equal(new Set([...one.options, ...two.options]).size, one.options.length * 2,
    'option id 必须全局唯一')
})

// ── Exit presentation / passthrough regressions ─────────────────────────────

test('Select：正常动效关闭时保留 inert 退场浮层，减少动效时立即卸载', async () => {
  const { Select } = await components()
  const realMatch = globalThis.matchMedia
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  try {
    globalThis.matchMedia = () => ({ matches: false })
    globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length }
    globalThis.clearTimeout = () => {}

    let tree = render(Select, selectProps()).tree
    comboboxOf(tree).props.onClick?.()
    tree = rerender(Select, selectProps())
    assert.equal(findAll(tree, (node) => node.props?.role === 'listbox').length, 1, '先展开浮层')
    comboboxOf(tree).props.onClick?.()
    tree = rerender(Select, selectProps())
    const mounted = findAll(tree, (node) => node.props?.role === 'listbox')
    assert.equal(mounted.length, 1, '退场动画期间浮层仍留在树上')
    assert.equal(mounted[0].props['aria-hidden'] === true || mounted[0].props['aria-hidden'] === 'true',
      true, '退场浮层必须是 inert（aria-hidden）')
    assert.equal(listboxOf(tree), null, 'inert 退场浮层不算可访问的打开状态')
    assert.equal(timers.length, 1, '退场只使用一条计时器')
    timers[0].callback()
    tree = rerender(Select, selectProps())
    assert.equal(findAll(tree, (node) => node.props?.role === 'listbox').length, 0, '计时器到点后卸载')

    const timersBeforeReduced = timers.length
    globalThis.matchMedia = () => ({ matches: true })
    let reduced = render(Select, selectProps()).tree
    comboboxOf(reduced).props.onClick?.()
    reduced = rerender(Select, selectProps())
    comboboxOf(reduced).props.onClick?.()
    reduced = rerender(Select, selectProps())
    assert.equal(findAll(reduced, (node) => node.props?.role === 'listbox').length, 0,
      '减少动效时立即卸载，不留退场浮层')
    assert.equal(timers.length, timersBeforeReduced, '减少动效时不应新增计时器')
  } finally {
    if (realMatch === undefined) delete globalThis.matchMedia
    else globalThis.matchMedia = realMatch
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('Button：转发 buttonRef，并透传 data- / aria- / onKeyDown', async () => {
  const { Button } = await components()
  const ref = { current: null }
  const keys = []
  const { tree } = render(Button, {
    variant: 'secondary',
    children: '打开',
    buttonRef: ref,
    'data-action': 'open',
    'aria-expanded': false,
    onKeyDown: (event) => { keys.push(event.key) },
  })
  const button = buttonOf(tree)
  assert.ok(button, 'Button 必须渲染 <button>')
  assert.equal(button.props.ref, ref, 'buttonRef 要挂到真实按钮上')
  assert.equal(button.props['data-action'], 'open', 'data-* 属性要透传')
  assert.equal(button.props['aria-expanded'], false, 'aria-* 属性要透传')
  assert.equal(typeof button.props.onKeyDown, 'function', 'onKeyDown 要透传')
  button.props.onKeyDown({ key: 'Enter' })
  assert.deepEqual(keys, ['Enter'])
})

test('IconButton：变体复用共享按钮族的类名', async () => {
  const { IconButton } = await components()
  for (const variant of ['primary', 'secondary', 'soft', 'text']) {
    const { tree } = render(IconButton, { label: '图标按钮', variant, children: null })
    const button = buttonOf(tree)
    assert.ok(button, `IconButton(${variant}) 必须渲染 <button>`)
    const classes = String(button.props.className ?? '').split(/\s+/).filter((one) => one !== '')
    assert.equal(classes.includes('crwu-ui-btn'), true, `IconButton(${variant}) 要用共享按钮基类`)
    assert.equal(classes.includes(`crwu-ui-btn-${variant}`), true, `IconButton(${variant}) 要用共享变体类`)
  }
})

test('TextArea：透传 IME composition 回调且不改变受控值语义', async () => {
  const { TextArea } = await components()
  const events = []
  const seen = []
  const { tree } = render(TextArea, {
    value: '草稿',
    onChange: (value) => { seen.push(value) },
    onCompositionStart: () => { events.push('start') },
    onCompositionEnd: (event) => { events.push(`end:${event.target.value}`) },
  })
  const area = find(tree, (node) => node.type === 'textarea')
  assert.ok(area, 'TextArea 必须渲染 <textarea>')
  assert.equal(area.props.value, '草稿')
  area.props.onCompositionStart?.()
  area.props.onCompositionEnd?.({ target: { value: '草稿终' } })
  assert.deepEqual(events, ['start', 'end:草稿终'], 'composition 起止回调都要透传')
  assert.deepEqual(seen, [], 'composition 回调本身不改写受控值')
})

// ── M1 browser-red regressions ──────────────────────────────────────────────

test('Button：别名缺省时保留原生 aria-describedby，别名优先', async () => {
  const { Button } = await components()
  const native = buttonOf(render(Button, { children: 'x', 'aria-describedby': 'native-id' }).tree)
  assert.equal(native.props['aria-describedby'], 'native-id', '原生 aria-describedby 要保留')
  const alias = buttonOf(render(Button, {
    children: 'x', 'aria-describedby': 'native-id', describedBy: 'alias-id',
  }).tree)
  assert.equal(alias.props['aria-describedby'], 'alias-id', '别名要优先')
})

test('IconButton 变体外观与加载布局由共享 CSS 保证', () => {
  const css = readFileSync(new URL('src/client/ui/styles/button.ts', ROOT), 'utf8')
  const blockOf = (selector) => {
    const start = css.indexOf(selector)
    assert.notEqual(start, -1, `找不到 ${selector}`)
    const open = css.indexOf('{', start)
    const close = css.indexOf('}', open)
    return css.slice(open + 1, close)
  }
  const icon = blockOf('.crwu-ui-icon-btn {')
  assert.equal(/\bbackground\s*:/.test(icon), false, '图标按钮基类不得覆盖变体背景')
  assert.equal(/\bcolor\s*:/.test(icon), false, '图标按钮基类不得覆盖变体颜色')
  assert.equal(/\bborder\s*:/.test(icon), false, '图标按钮基类不得覆盖变体边界')
  for (const variant of ['primary', 'secondary', 'soft', 'text']) {
    assert.equal(css.includes(`.crwu-ui-btn-${variant} {`), true, `缺少共享变体 ${variant}`)
  }
  assert.equal(css.includes('.crwu-ui-btn-loading .crwu-ui-btn-label'), true, '加载时保留标签宽度')
  const spinner = blockOf('.crwu-ui-btn-spinner {')
  assert.match(spinner, /position:\s*absolute/, '加载指示器要绝对定位，不撑宽按钮')
})
