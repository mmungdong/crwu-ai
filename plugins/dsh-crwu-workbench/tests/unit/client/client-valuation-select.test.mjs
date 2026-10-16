/**
 * 表单单选下拉（`Select`）—— 资产类型与评估方法共用的那一种控件。
 *
 * 这一份钉住的是本轮新增交互里"删掉就会静默坏掉"的部分：
 *
 * 1. **select-only combobox 语义**：`role="combobox"` + `aria-expanded` / `aria-controls` /
 *    `aria-activedescendant`，选项是 `role="option"` + `aria-selected`（**不是** menu/menuitem）；
 * 2. **键盘**：Enter/Space 打开、方向键移动、Home/End 到首尾、Enter/Space 确定、
 *    Escape 关闭并保留原值、Tab 关闭但**不拦截**（焦点照常走下一个控件）、字符快速定位；
 * 3. **浮层定位**：与触发器等宽、约 8px 间距、贴底翻到上方、靠右夹在视口内、限高滚动；
 * 4. **同时只开一个**：后开的把先开的关掉；
 * 5. **关闭动画与清理**：淡出后才卸载；减少动画时**不多等一帧**；卸载时摘掉监听与计时器。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const { Select } = await import(new URL('src/client/ui/components/Select.tsx', ROOT).href)
const {
  selectIntentFor, typeaheadIndexOf, selectRegistry, resetSelectRegistry,
  SELECT_GAP, SELECT_MARGIN, SELECT_MAX_HEIGHT, SELECT_CLOSE_MS,
} = await import(new URL('src/client/ui/components/select-model.ts', ROOT).href)
const { placementOf, intersectRect, containmentRootOf } = await import(
  new URL('src/client/ui/components/popover-model.ts', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)
const { render, rerender, find, findAll, textOf } = await import(
  new URL('tests/helpers/render.mjs', ROOT).href)

const OPTIONS = [
  { value: 'auto', label: zhCN.valuationMethodAuto, hint: zhCN.valuationMethodAutoHint, badge: zhCN.valuationMethodRecommended },
  { value: 'market', label: zhCN.valuationMethodMarket, hint: zhCN.valuationMethodMarketHint },
  { value: 'income', label: zhCN.valuationMethodIncome, hint: zhCN.valuationMethodIncomeHint },
  { value: 'cost', label: zhCN.valuationMethodCost, hint: zhCN.valuationMethodCostHint },
]

function props(patch = {}) {
  return {
    name: 'method',
    labelId: 'crwu-valuation-method-label',
    value: '',
    placeholder: zhCN.valuationMethodPlaceholder,
    options: OPTIONS,
    onChange: () => {},
    ...patch,
  }
}

const triggerOf = (tree) => findAll(tree, (node) => node.props?.role === 'combobox')[0]
const optionsOf = (tree) => findAll(tree, (node) => node.props?.role === 'option')

/** 渲染 → 点开：返回展开后的树（`rerender` 复用同一实例，所以内部 state 是活的）。 */
function openTree(patch = {}) {
  const first = render(Select, props(patch))
  triggerOf(first.tree).props.onClick()
  return rerender(Select, props(patch))
}

// ── 纯几何：定位与翻转 ──────────────────────────────────────────────────────

test('浮层几何：默认贴下方、与触发器等宽、约 8px 间距', () => {
  const box = placementOf({
    anchor: { left: 100, top: 100, right: 360, bottom: 140, width: 260 },
    bounds: { left: 0, top: 0, right: 1200, bottom: 900, width: 1200 },
    contentHeight: 200,
  })
  assert.equal(box.flip, false)
  assert.equal(box.left, 100)
  assert.equal(box.top, 140 + SELECT_GAP)
  assert.equal(box.width, 260)
  // 限高取"可用空间"与 280px 的较小者：内容更矮时浮层自然更矮（不拉伸）。
  assert.equal(box.maxHeight, SELECT_MAX_HEIGHT)
})

test('浮层几何：贴底时翻到上方（上方更宽裕才翻）', () => {
  const box = placementOf({
    anchor: { left: 100, top: 800, right: 360, bottom: 840, width: 260 },
    bounds: { left: 0, top: 0, right: 1200, bottom: 900, width: 1200 },
    contentHeight: 200,
  })
  assert.equal(box.flip, true)
  assert.equal(box.top, 800 - SELECT_GAP - 200)
  // 上方也放不下时**不翻**（翻过去只会更糟），改为在下方限高。
  const tight = placementOf({
    anchor: { left: 100, top: 40, right: 360, bottom: 860, width: 260 },
    bounds: { left: 0, top: 0, right: 1200, bottom: 900, width: 1200 },
    contentHeight: 300,
  })
  assert.equal(tight.flip, false)
})

test('浮层几何：靠右夹在可用区域内，四周至少留 8px；超出限高在选项区滚动', () => {
  const box = placementOf({
    anchor: { left: 1380, top: 100, right: 1600, bottom: 140, width: 220 },
    bounds: { left: 0, top: 0, right: 1440, bottom: 900, width: 1440 },
    contentHeight: 120,
  })
  assert.equal(box.left, 1440 - SELECT_MARGIN - 220)
  assert.ok(box.left + box.width <= 1440 - SELECT_MARGIN + 0.001)
  const tall = placementOf({
    anchor: { left: 20, top: 100, right: 280, bottom: 140, width: 260 },
    bounds: { left: 0, top: 0, right: 1200, bottom: 900, width: 1200 },
    contentHeight: 900,
  })
  assert.equal(tall.maxHeight, SELECT_MAX_HEIGHT)
})

test('浮层几何：可用区域 = 视口 ∩ 包含块（不为负）', () => {
  const hit = intersectRect(
    { left: 0, top: 0, right: 100, bottom: 100, width: 100 },
    { left: 50, top: 20, right: 300, bottom: 400, width: 250 },
  )
  assert.deepEqual(hit, { left: 50, top: 20, right: 100, bottom: 100, width: 50 })
  const empty = intersectRect(
    { left: 0, top: 0, right: 10, bottom: 10, width: 10 },
    { left: 50, top: 50, right: 60, bottom: 60, width: 10 },
  )
  assert.equal(empty.width, 0)
})

test('包含块探测：认 transform / backdrop-filter / contain，但**不认** container-type', () => {
  const make = (name, style) => ({
    name, parentElement: null, ownerDocument: { defaultView: { getComputedStyle: () => style } },
  })
  const outer = make('outer', {})
  // ⚠️ 这是真机实测纠正过来的一条：`container-type: inline-size` **不会**让固定定位以它为参照
  //（Chromium 的计算值 `contain: none`）。认它会把浮层推离正确位置 —— 所以这里要求返回 null，
  // 真正的补偿交给组件的自校准偏移。
  const container = make('container', { containerType: 'inline-size' })
  container.parentElement = outer
  assert.equal(containmentRootOf({ parentElement: container, ownerDocument: outer.ownerDocument }), null,
    'container-type 不是固定定位的包含块（认它反而会摆错）')
  for (const [what, style] of [
    ['transform', { transform: 'translateX(0)' }],
    ['backdrop-filter', { backdropFilter: 'blur(2px)' }],
    ['contain: layout', { contain: 'layout' }],
    ['will-change: transform', { willChange: 'transform' }],
  ]) {
    const node = make(what, style)
    node.parentElement = outer
    assert.equal(containmentRootOf({ parentElement: node, ownerDocument: outer.ownerDocument }), node, what)
  }
  // 没有这些属性的一路向上 → null（浮层按视口摆位，与审核页的浮层一致）。
  assert.equal(containmentRootOf({ parentElement: outer, ownerDocument: outer.ownerDocument }), null)
  // 没有 DOM 时也不抛（注入式渲染器 / 首帧）。
  assert.equal(containmentRootOf(null), null)
})

// ── 纯键盘模型 ──────────────────────────────────────────────────────────────

test('键盘模型：打开 / 移动 / 首尾 / 确定 / 关闭 / Tab', () => {
  const base = { open: false, active: 0, count: 4, selected: 2 }
  assert.deepEqual(selectIntentFor({ ...base, key: 'ArrowDown' }), { kind: 'open', active: 2 },
    '收起时按方向键：先打开，并停在当前选择上')
  assert.deepEqual(selectIntentFor({ ...base, key: 'ArrowUp' }), { kind: 'open', active: 2 })
  assert.deepEqual(selectIntentFor({ ...base, key: 'Enter' }), { kind: 'open', active: 2 })
  assert.deepEqual(selectIntentFor({ ...base, key: ' ' }), { kind: 'open', active: 2 })
  const open = { ...base, open: true }
  assert.deepEqual(selectIntentFor({ ...open, key: 'ArrowDown' }), { kind: 'move', active: 1 })
  assert.deepEqual(selectIntentFor({ ...open, key: 'ArrowDown', active: 3 }), { kind: 'move', active: 0 },
    '方向键在首尾循环')
  assert.deepEqual(selectIntentFor({ ...open, key: 'ArrowUp', active: 0 }), { kind: 'move', active: 3 })
  assert.deepEqual(selectIntentFor({ ...open, key: 'Home' }), { kind: 'move', active: 0 })
  assert.deepEqual(selectIntentFor({ ...open, key: 'End' }), { kind: 'move', active: 3 })
  // Enter 确定的是**活动项**（不是当前选中项）。
  assert.deepEqual(selectIntentFor({ ...open, key: 'Enter' }), { kind: 'commit', active: 0 })
  assert.deepEqual(selectIntentFor({ ...open, key: 'Enter', active: 3 }), { kind: 'commit', active: 3 })
  assert.deepEqual(selectIntentFor({ ...open, key: 'Escape' }), { kind: 'close' })
  // Escape 在收起时什么也不做（不许把已选值清掉）。
  assert.deepEqual(selectIntentFor({ ...base, key: 'Escape' }), { kind: 'none' })
  // Tab **永远**只是"关掉并放行"，不拦截。
  assert.deepEqual(selectIntentFor({ ...open, key: 'Tab' }), { kind: 'tab' })
  assert.deepEqual(selectIntentFor({ ...base, key: 'Tab' }), { kind: 'tab' })
  // 没有选项时什么也不做。
  assert.deepEqual(selectIntentFor({ open: true, active: 0, count: 0, selected: -1, key: 'ArrowDown' }),
    { kind: 'none' })
  // 还不认识别的键。
  assert.deepEqual(selectIntentFor({ ...open, key: 'F5' }), { kind: 'none' })
})

test('字符快速定位：按标签前缀找，找不到返回 -1', () => {
  const labels = OPTIONS.map((option) => option.label)
  assert.equal(typeaheadIndexOf(labels, '市'), 1)
  assert.equal(typeaheadIndexOf(labels, '收'), 2)
  assert.equal(typeaheadIndexOf(labels, '自'), 0)
  assert.equal(typeaheadIndexOf(labels, '无此方法'), -1)
  assert.equal(typeaheadIndexOf(labels, ''), -1)
})

// ── 同时只开一个 ────────────────────────────────────────────────────────────

test('同时只开一个：后开的先关掉前一个；释放只清掉自己', () => {
  resetSelectRegistry()
  const closed = []
  selectRegistry.claim('asset-type', () => { closed.push('asset-type') })
  assert.equal(selectRegistry.openId(), 'asset-type')
  selectRegistry.claim('method', () => { closed.push('method') })
  assert.deepEqual(closed, ['asset-type'], '开第二个之前必须先关掉第一个')
  assert.equal(selectRegistry.openId(), 'method')
  // 旧的实例延迟释放时不许把新的那个清掉。
  selectRegistry.release('asset-type')
  assert.equal(selectRegistry.openId(), 'method', '释放不是当前那个时不动')
  selectRegistry.release('method')
  assert.equal(selectRegistry.openId(), '')
  resetSelectRegistry()
})

// ── 渲染与交互 ──────────────────────────────────────────────────────────────

test('收起时：combobox 语义完整、不画浮层、不指向不存在的 listbox', () => {
  const { tree } = render(Select, props())
  const trigger = triggerOf(tree)
  assert.ok(trigger, '触发器就是 combobox 本体')
  assert.equal(trigger.props['aria-haspopup'], 'listbox')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(trigger.props['aria-controls'], undefined, '收起时 aria-controls 不指向不存在的元素')
  assert.equal(trigger.props['aria-activedescendant'], undefined)
  // 生产 Select 的 value 元素 id 来自实例计数器（`crwu-ui-select-<instance>-value`），
  // 所以按实际渲染出来的 id 对账，而不是写死一个旧包装的名字。
  const valueId = findAll(tree, (node) => typeof node.props?.id === 'string' && node.props.id.endsWith('-value'))[0].props.id
  assert.equal(trigger.props['aria-labelledby'], `crwu-valuation-method-label ${valueId}`)
  assert.equal(textOf(tree).includes(zhCN.valuationMethodPlaceholder), true, '未选时显示占位')
  assert.equal(findAll(tree, (node) => node.props?.role === 'listbox').length, 0, '收起时不画浮层')
  assert.equal(findAll(tree, (node) => node.props?.role === 'option').length, 0)
})

test('展开后：listbox + option 语义、当前选中用 aria-selected、活动项用 aria-activedescendant', () => {
  const tree = openTree({ value: 'income' })
  const trigger = triggerOf(tree)
  assert.equal(trigger.props['aria-expanded'], true)
  const list = findAll(tree, (node) => node.props?.role === 'listbox')[0]
  assert.ok(list, '展开后有 listbox')
  assert.equal(trigger.props['aria-controls'], list.props.id)
  const options = optionsOf(tree)
  assert.deepEqual(options.map((node) => node.props['data-crwu-option']),
    ['auto', 'market', 'income', 'cost'])
  assert.deepEqual(options.map((node) => node.props['aria-selected']),
    [false, false, true, false], '只有当前值 aria-selected')
  // 活动项默认就是当前选中那一项；活动项不与选中混淆（选中靠勾 + aria-selected）。
  assert.equal(trigger.props['aria-activedescendant'], options[2].props.id)
  // 选项说明是辅助文本，不是选项名的一部分。
  assert.equal(optionsOf(tree)[0].props['aria-label'], undefined)
  assert.equal(textOf(options[0]).includes(zhCN.valuationMethodAutoHint), true)
  // 「推荐」只是一枚轻标记，且**不是**默认选中。
  assert.equal(textOf(options[0]).includes(zhCN.valuationMethodRecommended), true)
  assert.equal(options[0].props['aria-selected'], false)
})

test('点选项：回传值并立刻收起（取消不会把原值清空）', () => {
  const picked = []
  const tree = openTree({ value: 'market', onChange: (value) => { picked.push(value) } })
  const options = optionsOf(tree)
  // 点**当前**那一项：不重复回调，但照常收起（取消不清空原值）。
  options[1].props.onClick()
  assert.deepEqual(picked, [], '点当前项不产生变更')
  const closed = rerender(Select, props({ value: 'market', onChange: (v) => { picked.push(v) } }))
  assert.equal(triggerOf(closed).props['aria-expanded'], false, '点当前项也收起')
  // 再开一次点别的项：回传值 + 收起。
  triggerOf(closed).props.onClick()
  const again = rerender(Select, props({ value: 'market', onChange: (v) => { picked.push(v) } }))
  optionsOf(again)[3].props.onClick()
  assert.deepEqual(picked, ['cost'])
  const after = rerender(Select, props({ value: 'market', onChange: (v) => { picked.push(v) } }))
  assert.equal(triggerOf(after).props['aria-expanded'], false)
})

test('键盘：方向键移动活动项、Enter 确定、Escape 关闭并保留原值、Tab 关闭且不拦截', () => {
  const picked = []
  const onChange = (value) => { picked.push(value) }
  /**
   * 每次按键都从**最新那一棵树**上取处理器。
   *
   * 注入式渲染器不会重跑组件：旧树上的闭包捕获的是旧 `active`，用它按键等于在测一个
   * 已经不存在的界面（真实 React 每次渲染都会换掉处理器）。
   */
  let tree = render(Select, props({ value: 'auto', onChange })).tree
  const press = (key) => {
    const collected = { prevented: false }
    triggerOf(tree).props.onKeyDown({
      key,
      preventDefault: () => { collected.prevented = true },
      stopPropagation: () => {},
    })
    tree = rerender(Select, props({ value: 'auto', onChange }))
    return collected
  }
  // 收起时按 ArrowDown：打开并停在当前值（auto）上 —— 不改成别的。
  press('ArrowDown')
  assert.equal(triggerOf(tree).props['aria-expanded'], true)
  assert.equal(triggerOf(tree).props['aria-activedescendant'], optionsOf(tree)[0].props.id)
  // 再按 ArrowDown：活动项下移一格（但**没有**提交）。
  press('ArrowDown')
  assert.equal(triggerOf(tree).props['aria-activedescendant'], optionsOf(tree)[1].props.id)
  assert.deepEqual(picked, [], '移动活动项不是选择')
  // Enter 确定活动项。
  press('Enter')
  assert.deepEqual(picked, ['market'])
  assert.equal(triggerOf(tree).props['aria-expanded'], false, '确定后收起')
  // Escape：关闭但**不**回调（原值保留）。
  press('ArrowDown')
  assert.equal(triggerOf(tree).props['aria-expanded'], true)
  press('Escape')
  assert.deepEqual(picked, ['market'], 'Escape 不许产生变更')
  assert.equal(triggerOf(tree).props['aria-expanded'], false)
  // Tab：关闭，但**不** preventDefault（焦点照常走到下一个控件）。
  press('ArrowDown')
  assert.equal(triggerOf(tree).props['aria-expanded'], true)
  const tabEvent = press('Tab')
  assert.equal(tabEvent.prevented, false, 'Tab 必须放行')
  assert.equal(triggerOf(tree).props['aria-expanded'], false)
  // 方向键的默认行为要被拦掉（否则页面会跟着滚）。
  const scrolled = press('ArrowDown')
  assert.equal(scrolled.prevented, true)
})

test('键盘：Home / End 到首尾，字符快速定位跳到匹配项', () => {
  let tree = render(Select, props()).tree
  const press = (key) => {
    triggerOf(tree).props.onKeyDown({ key, preventDefault: () => {}, stopPropagation: () => {} })
    tree = rerender(Select, props())
  }
  press('ArrowDown')
  press('End')
  assert.equal(triggerOf(tree).props['aria-activedescendant'], optionsOf(tree)[3].props.id)
  press('Home')
  assert.equal(triggerOf(tree).props['aria-activedescendant'], optionsOf(tree)[0].props.id)
  // 字符定位：'收' → 收益法。
  press('收')
  assert.equal(triggerOf(tree).props['aria-activedescendant'], optionsOf(tree)[2].props.id)
})

test('disabled：点了也不展开（省略 aria-expanded 之外的一切副作用）', () => {
  const { tree } = render(Select, props({ disabled: true }))
  const trigger = triggerOf(tree)
  assert.equal(trigger.props.disabled, true)
  trigger.props.onClick()
  const after = rerender(Select, props({ disabled: true }))
  assert.equal(triggerOf(after).props['aria-expanded'], false)
  assert.equal(findAll(after, (node) => node.props?.role === 'listbox').length, 0)
})

test('关闭：先播淡出（-out）再卸载；减少动画时立即卸载，且不多等一帧', () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length }
  globalThis.clearTimeout = () => {}
  try {
    const first = render(Select, props())
    triggerOf(first.tree).props.onClick()
    let tree = rerender(Select, props())
    assert.equal(triggerOf(tree).props['aria-expanded'], true)
    // 关闭：进入 closing（浮层还在，但已经不可交互）。
    triggerOf(tree).props.onClick()
    tree = rerender(Select, props())
    const root = find(tree, (node) => node.props?.['data-crwu-select'] === 'method')
    assert.equal(root.props['data-crwu-select-state'], 'closing')
    const list = findAll(tree, (node) => node.props?.role === 'listbox')[0]
    assert.ok(list, '淡出期间浮层仍在（否则动画根本不会播）')
    assert.equal(String(list.props.className).includes('crwu-ui-select-list-out'), true)
    assert.equal(list.props['aria-hidden'], 'true', '淡出期间不再对读屏可见')
    assert.equal(timers.length, 1, '淡出只用一个计时器')
    assert.equal(timers[0].delay, SELECT_CLOSE_MS)
    // 计时器到点 → 真正卸载。
    timers[0].callback()
    tree = rerender(Select, props())
    assert.equal(findAll(tree, (node) => node.props?.role === 'listbox').length, 0)
    assert.equal(find(tree, (node) => node.props?.['data-crwu-select'] === 'method')
      .props['data-crwu-select-state'], 'closed')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('减少动画：关闭**立即**完成（不进入 closing、不留计时器）', () => {
  const realMatch = globalThis.matchMedia
  const realSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.matchMedia = () => ({ matches: true })
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length }
  try {
    const first = render(Select, props())
    triggerOf(first.tree).props.onClick()
    rerender(Select, props())
    triggerOf(rerender(Select, props())).props.onClick()
    const tree = rerender(Select, props())
    assert.equal(findAll(tree, (node) => node.props?.role === 'listbox').length, 0,
      '减少动画时立刻卸载，不额外等一帧')
    assert.deepEqual(timers, [], '减少动画时不该有动画计时器')
  } finally {
    if (realMatch === undefined) delete globalThis.matchMedia
    else globalThis.matchMedia = realMatch
    globalThis.setTimeout = realSetTimeout
  }
})

test('展开期间挂上外部点击 / Escape / scroll / resize 监听，卸载时逐条摘掉', () => {
  const added = []
  const removed = []
  const previous = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = {
    activeElement: null,
    addEventListener: (type, listener, options) => { added.push({ target: 'document', type, listener, options }) },
    removeEventListener: (type, listener, options) => { removed.push({ target: 'document', type, listener, options }) },
  }
  globalThis.window = {
    innerWidth: 1200, innerHeight: 900,
    addEventListener: (type, listener, options) => { added.push({ target: 'window', type, listener, options }) },
    removeEventListener: (type, listener, options) => { removed.push({ target: 'window', type, listener, options }) },
  }
  try {
    const first = render(Select, props())
    // 收起时不挂任何监听（省掉一个全局副作用）。
    for (const effect of first.instance.effects) effect.callback()
    assert.deepEqual(added, [], '收起时不挂监听')
    triggerOf(first.tree).props.onClick()
    // 展开后再取一次 effects（`rerender` 会先清空列表，所以这里拿到的是展开后的那一份）。
    const opened = render(Select, props())
    triggerOf(opened.tree).props.onClick()
    const openTree = rerender(Select, props())
    const cleanups = []
    for (const effect of opened.instance.effects) {
      const dispose = effect.callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
    }
    const types = added.map((entry) => `${entry.target}:${entry.type}`)
    assert.deepEqual(types.sort(), ['document:keydown', 'document:pointerdown', 'window:resize', 'window:scroll'])
    // scroll 必须在**捕获相位**（任何祖先滚动都要收得到）。
    assert.equal(added.find((entry) => entry.type === 'scroll').options, true)
    // 外部点击：点在浮层内不算外部。生产 Select 的登记键是实例 id（不是业务 name）。
    const instanceKey = find(openTree, (node) => node.props?.['data-crwu-select-instance'] !== undefined)
      .props['data-crwu-select-instance']
    const onDown = added.find((entry) => entry.type === 'pointerdown').listener
    const registryBefore = selectRegistry.openId()
    assert.equal(registryBefore, instanceKey)
    onDown({ target: { closest: () => ({}) } })
    assert.equal(selectRegistry.openId(), instanceKey, '点浮层内部不关闭')
    onDown({ target: { closest: () => null } })
    assert.equal(selectRegistry.openId(), '', '点外部关闭')
    // 清理函数把监听摘干净。
    for (const dispose of cleanups) dispose()
    assert.equal(removed.length, 4, '四条监听都要摘掉')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    resetSelectRegistry()
  }
})
