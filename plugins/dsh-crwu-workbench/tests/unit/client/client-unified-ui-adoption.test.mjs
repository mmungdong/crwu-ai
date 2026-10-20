/**
 * Library-adoption contracts for the shared UI.
 *
 * ValuationIntakePane is exercised with a local unresolved-root render: the top-level component
 * runs against a fake hook instance, but nested components stay as elements, so a DatePicker
 * element can be extracted and its callbacks invoked. Nested instances do not persist rerender
 * state in the fake renderer, which is why the intake is tested directly.
 *
 * The walker also calls FormField render-function children with the documented field descriptor,
 * so controls nested inside FormField are still discoverable without resolving components.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const { render, findAll, textOf } = await import(new URL('tests/helpers/render.mjs', ROOT).href)
const shared = await import(new URL('src/client/ui/components/index.ts', ROOT).href)
const { ValuationIntakePane } = await import(
  new URL('src/client/modules/report-evaluation/ui/ValuationIntakePane.tsx', ROOT).href)
const { VALUATION_CLASSES } = await import(
  new URL('src/client/modules/report-evaluation/model/styles.ts', ROOT).href)
const state = await import(
  new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)

/** Ready-to-confirm draft: files scanned and both required choices made. */
function readyState(patch = {}) {
  return state.initialValuationState({
    phase: 'draft',
    assetType: 'real-estate',
    method: 'market',
    selection: ['/Users/someone/资料'],
    files: [{
      path: '/Users/someone/资料', name: '资料', dirHint: '', kind: 'directory',
      sizeBytes: 0, status: 'scanned', reason: '', fileCount: 2,
    }],
    fileRows: [{
      path: '/Users/someone/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf',
      sizeBytes: 2048, parentPath: '/Users/someone/资料', state: 'included',
    }],
    scanState: 'ready',
    fileCount: 1,
    readableCount: 1,
    ...patch,
  })
}

function intakeProps(current, patch = {}) {
  return {
    state: current,
    onPickFiles: () => {}, onPickFolder: () => {}, onRemoveSelection: () => {},
    onExcludeFile: () => {}, onReincludeFile: () => {}, onUndoRemoval: () => {}, onRescan: () => {},
    onMethodChange: () => {}, onAssetTypeChange: () => {}, onCheckCapability: () => {},
    onLoginSite: () => {}, onVerifySite: () => {}, onCancelLogin: () => {},
    onBaseDateChange: () => {}, onPurposeChange: () => {}, onValueTypeChange: () => {},
    onPromptChange: () => {}, onConfirm: () => {}, onBackToEdit: () => {},
    ...patch,
  }
}

function createInstance() {
  return { cursor: 0, state: {}, refs: {}, effects: [] }
}

/** Run the root component without resolving nested components. */
function renderRoot(component, componentProps, instance) {
  const previous = globalThis.__crwuTestInstance
  globalThis.__crwuTestInstance = instance
  try {
    return component(componentProps)
  } finally {
    if (previous === undefined) delete globalThis.__crwuTestInstance
    else globalThis.__crwuTestInstance = previous
  }
}

function rerenderRoot(component, componentProps, instance) {
  instance.cursor = 0
  instance.effects = []
  return renderRoot(component, componentProps, instance)
}

const PROBE_FIELD = { id: 'crwu-probe', labelId: 'crwu-probe-label', describedBy: undefined, invalid: false, required: false }

function childNodesOf(node) {
  const children = node?.props?.children
  // Evaluate only the shared FormField render-function child so its control becomes visible;
  // every other component element stays unresolved.
  if (node?.type === shared.FormField && typeof children === 'function') {
    try { return children(PROBE_FIELD) } catch (error) { void error; return null }
  }
  return children
}

function findUnresolved(node, predicate) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findUnresolved(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  return findUnresolved(childNodesOf(node), predicate)
}

function findAllUnresolved(node, predicate) {
  const hits = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (Array.isArray(current)) { for (const child of current) walk(child); return }
    if (typeof current !== 'object') return
    if (predicate(current)) hits.push(current)
    walk(childNodesOf(current))
  }
  walk(node)
  return hits
}

// The confirm action may still be a native button or may already use the shared Button.
const isButtonNode = (node) => node.type === 'button' || node.type === shared.Button
const confirmIn = (tree) => findUnresolved(tree, (node) => {
  if (!isButtonNode(node)) return false
  const classes = String(node.props?.className ?? '').split(/\s+/)
  return classes.includes(VALUATION_CLASSES.btnPrimary) || node.props?.variant === 'primary'
})
const describedByOf = (node) => node.props?.['aria-describedby'] ?? node.props?.describedBy

test('估值工作面：必填两项 → 可选资料 → 条件 → 辅助', () => {
  const tree = render(ValuationIntakePane, intakeProps(readyState())).tree
  const order = findAll(tree, (node) => node.props?.['data-valuation-block'] !== undefined)
    .map((node) => node.props['data-valuation-block'])
  assert.deepEqual(order, ['required', 'files', 'conditions', 'capability'],
    '必填两项必须先于可选资料、条件与辅助能力')
})

test('估值工作面接入共享控件：不用原生 type=date，改用共享 DatePicker/Select/FormField/Input/TextArea', () => {
  const instance = createInstance()
  const tree = renderRoot(ValuationIntakePane, intakeProps(readyState()), instance)
  assert.equal(findAllUnresolved(tree, (node) => node.type === 'input' && node.props?.type === 'date').length, 0,
    '估值页不许再用原生 type="date"')
  assert.ok(findUnresolved(tree, (node) => node.type === shared.DatePicker), '基准日要用共享 DatePicker')
  assert.equal(findAllUnresolved(tree, (node) => node.type === shared.Select).length >= 2, true,
    '资产类型与方法要用共享 Select')
  assert.equal(findAllUnresolved(tree, (node) => node.type === shared.FormField).length >= 2, true,
    '字段要用共享 FormField')
  assert.equal(findAllUnresolved(tree, (node) => node.type === shared.TextInput).length >= 2, true,
    '目的与价值类型要用共享 TextInput')
  assert.equal(findAllUnresolved(tree, (node) => node.type === shared.TextArea).length >= 1, true,
    '补充要求要用共享 TextArea')
})

test('DatePicker 有效性回调接入估值主操作门禁', () => {
  const instance = createInstance()
  const componentProps = intakeProps(readyState())
  let tree = renderRoot(ValuationIntakePane, componentProps, instance)
  let datePicker = findUnresolved(tree, (node) => node.type === shared.DatePicker)
  assert.ok(datePicker, '基准日要用共享 DatePicker')
  assert.equal(typeof datePicker.props.onValidityChange, 'function', 'DatePicker 要上报有效性')
  assert.equal(confirmIn(tree).props.disabled, false, '资料就绪时应可确认')

  datePicker.props.onValidityChange(false)
  tree = rerenderRoot(ValuationIntakePane, componentProps, instance)
  const blocked = confirmIn(tree)
  assert.equal(blocked.props.disabled, true, '日期无效时主操作必须禁用')
  assert.equal(describedByOf(blocked), VALUATION_CLASSES.actionReason, '禁用原因要可读')
  const reason = findUnresolved(tree, (item) => item.props?.id === VALUATION_CLASSES.actionReason)
  assert.ok(reason, '要有可见的禁用原因')
  assert.equal(textOf(reason).trim() !== '', true, '禁用原因不能为空')

  datePicker = findUnresolved(tree, (node) => node.type === shared.DatePicker)
  datePicker.props.onValidityChange(true)
  tree = rerenderRoot(ValuationIntakePane, componentProps, instance)
  assert.equal(confirmIn(tree).props.disabled, false, '恢复有效后主操作可用')
})

test('审核搜索 / 本地审核提示词 / 环境凭据字段改用共享输入控件', () => {
  const contracts = [
    ['src/client/modules/report-audit/ui/ReportPane.tsx', '审核搜索', 'TextInput'],
    ['src/client/modules/local-audit/ui/LocalAuditPromptField.tsx', '本地审核提示词', 'TextArea'],
    ['src/client/modules/environment/ui/OssCredCard.tsx', '环境凭据', 'TextInput'],
  ]
  for (const [file, what, component] of contracts) {
    const source = readFileSync(new URL(file, ROOT), 'utf8')
    assert.match(source, /from '[^']*ui\/components/, `${what} 要从共享组件入口导入`)
    assert.match(source, new RegExp(`\\b${component}\\b`), `${what} 要使用共享 ${component}`)
  }
})
