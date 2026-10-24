/**
 * Render the real valuation-experience components to static HTML for visual checks.
 *
 * Why: this environment has no react-dom / Playwright, but Edge can screenshot a local
 * HTML file headlessly. The tree comes from the repository's existing fake renderer, so
 * these pages are the real components and the real stylesheet, not a hand-copied mock.
 *
 * Usage:
 *   node install/valuation-experience-preview.mjs --out <new-directory>
 *
 * The output directory must not exist; the script never deletes a caller-supplied path.
 * Screenshots are a separate, explicit step (see docs/valuation-experience-pages.md):
 *   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
 *     --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
 *     --user-data-dir=<temp-dir> --window-size=1440,1000 --virtual-time-budget=1500 \
 *     --screenshot=<png> file://<html>
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
function argOf(name) {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? '' : (argv[index + 1] ?? '')
}
const outDir = resolve(argOf('out'))
if (argOf('out') === '') {
  console.error('用法：node install/valuation-experience-preview.mjs --out <新目录>')
  process.exit(2)
}
if (existsSync(outDir)) {
  console.error(`FAIL 输出目录已存在，拒绝覆盖：${outDir}`)
  process.exit(2)
}

const { registerTsxLoader } = await import(pathToFileURL(join(ROOT, 'tests/helpers/tsx-loader.mjs')).href)
registerTsxLoader()
const { render } = await import(pathToFileURL(join(ROOT, 'tests/helpers/render.mjs')).href)
const { composeWorkbenchStyles } = await import(pathToFileURL(join(ROOT, 'src/client/styles/bundle.ts')).href)
const { initialValuationState } = await import(pathToFileURL(join(ROOT, 'src/client/modules/report-evaluation/model/valuation-state.ts')).href)
const { createValuationExperienceController } = await import(
  pathToFileURL(join(ROOT, 'src/client/modules/report-evaluation/valuation/controller.ts')).href)
const { AssetAssessmentWorkflow } = await import(
  pathToFileURL(join(ROOT, 'src/client/modules/report-evaluation/ui/AssetAssessmentWorkflow.tsx')).href)

/* ------------------------------------------------------------------ */
/* Fake ports: no Host, no file, no network                            */
/* ------------------------------------------------------------------ */

function fakeEvaluation() {
  let state = initialValuationState()
  const listeners = new Set()
  const emit = () => { for (const listener of [...listeners]) listener(state) }
  const set = (patch) => { state = { ...state, ...patch }; emit() }
  const noop = () => {}
  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    pickFiles: noop, pickFolder: noop, removeSelection: noop, excludeFile: noop,
    reincludeFile: noop, undoRemoval: noop, rescan: noop,
    setAssetType: (value) => { set({ assetType: value }) },
    setMethod: (value) => { set({ method: value }) },
    setPurpose: (value) => { set({ purpose: value }) },
    setValueType: (value) => { set({ valueType: value }) },
    setBaseDate: (value) => { set({ baseDate: value }) },
    setPrompt: (value) => { set({ supplementalPrompt: value }) },
    pickTemplate: noop, clearTemplate: noop,
    preparePreview: () => { set({ phase: 'confirmation' }) },
    backToEdit: () => { set({ phase: 'draft' }) },
    confirm: () => { set({ phase: 'handed-off', projectId: 'preview', parentSessionId: 'preview-session' }) },
    openCreatedSession: noop, invalidate: noop, resetDraft: noop, markStale: noop,
    checkAuth: noop, recheckAuth: noop, login: noop, cancelLogin: noop, openVerification: noop,
  }
}

function fakeWorkflow() {
  const state = { current: null, detail: null, loading: false, busy: false, error: '', questionDrafts: {} }
  return {
    getState: () => state,
    subscribe: () => () => {},
    activate: async () => {},
    deactivate: () => {},
    refresh: async () => {},
    approvePlan: async () => true,
    submitQuestions: async () => true,
    openArtifact: async () => true,
  }
}

const evaluation = fakeEvaluation()
const workflow = fakeWorkflow()
const controller = createValuationExperienceController({ evaluation, workflow })

/* ------------------------------------------------------------------ */
/* HTML serialization                                                 */
/* ------------------------------------------------------------------ */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use'])
const ATTR_ALIASES = {
  className: 'class',
  htmlFor: 'for',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
  tabIndex: 'tabindex',
  autoComplete: 'autocomplete',
  readOnly: 'readonly',
  colSpan: 'colspan',
  rowSpan: 'rowspan',
  acceptCharset: 'accept-charset',
  'aria-hidden': 'aria-hidden',
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function styleText(style) {
  if (style === null || typeof style !== 'object') return ''
  return Object.entries(style).map(([key, value]) => {
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    return `${name}:${String(value)}`
  }).join(';')
}

function attrText(key, value) {
  if (key.startsWith('on') || key === 'children' || key === 'key' || key === 'ref') return ''
  if (key === 'dangerouslySetInnerHTML') return ''
  if (value === null || value === undefined || value === false) return ''
  const name = ATTR_ALIASES[key] ?? key
  if (key === 'style') {
    const text = styleText(value)
    return text === '' ? '' : ` style="${escapeHtml(text)}"`
  }
  if (value === true) return ` ${name}`
  return ` ${name}="${escapeHtml(value)}"`
}

function attrsOf(props, omit = []) {
  return Object.entries(props)
    .filter(([key]) => !omit.includes(key))
    .map(([key, value]) => attrText(key, value))
    .join('')
}

function childrenOf(node) {
  const children = node.props?.children
  return serialize(children)
}

function serialize(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  const type = node.type
  if (typeof type !== 'string') return childrenOf(node)
  const props = node.props ?? {}
  if (type === 'select') {
    const value = props.value
    const flat = (value) => Array.isArray(value) ? value.flatMap(flat) : [value]
    const options = flat(props.children).filter(Boolean)
    const inner = options.map((option) => {
      if (option === null || typeof option !== 'object' || option.type !== 'option') return serialize(option)
      const selected = option.props?.value === value
      const optionProps = { ...option.props, ...(selected ? { selected: true } : {}) }
      return `<option${attrsOf(optionProps, ['children'])}>${serialize(option.props?.children)}</option>`
    }).join('')
    return `<select${attrsOf(props, ['children', 'value'])}>${inner}</select>`
  }
  if (type === 'textarea') {
    return `<textarea${attrsOf(props, ['children', 'value'])}>${escapeHtml(props.value ?? '')}</textarea>`
  }
  if (VOID.has(type)) return `<${type}${attrsOf(props, ['children'])} />`
  return `<${type}${attrsOf(props, ['children'])}>${childrenOf(node)}</${type}>`
}

/* ------------------------------------------------------------------ */
/* Page states                                                        */
/* ------------------------------------------------------------------ */

function viewHtml(name, component, props, { dark = false, width = 1440, height = 1000, backdrop = '' } = {}) {
  const tree = render(component, props).tree
  const styles = composeWorkbenchStyles()
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRWU valuation · ${escapeHtml(name)}</title>
<style>
html, body { height: 100%; margin: 0; }
body { background: #F5F5F7; }
body[data-ds-dark-theme] { background: #101216; }
#root { height: 100vh; width: 100%; overflow: hidden; }
.ve-preview-frame { height: 100vh; width: 100%; }
${styles}
</style></head>
<body${dark ? ' data-ds-dark-theme="true"' : ''}>
<div id="root"><div class="ve-preview-frame" data-preview-width="${width}" data-preview-height="${height}">${serialize(tree)}</div></div>
${backdrop}
</body></html>`
}

const baseProps = { workflow, evaluation, experience: controller, onStep() {}, onOpenParentSession() {} }
const overviewProps = { ...baseProps, step: 'overview' }
const experienceProps = { ...baseProps, step: 'valuation' }

const pages = []
const capture = (name, component, props, options = {}) => {
  pages.push([name, viewHtml(name, component, props, options), options])
}
const run = async () => {
  await mkdir(outDir, { recursive: false })

  // 1. Overview
  controller.setView('intake')
  controller.setIntakeStage('object')
  capture('01-overview', AssetAssessmentWorkflow, overviewProps, { dark: false })

  // 2. Intake: object selection
  capture('02-intake-object', AssetAssessmentWorkflow, experienceProps)

  // 3. Intake: materials + form with the explicit demo fixture
  controller.loadDemo()
  capture('03-intake-info-demo', AssetAssessmentWorkflow, experienceProps)
  capture('12-intake-info-narrow', AssetAssessmentWorkflow, experienceProps, { width: 600, height: 900 })

  // 4. Review with the area conflict still unresolved
  controller.chooseArea('user')
  controller.setIntakeStage('review')
  capture('04-intake-review-conflict', AssetAssessmentWorkflow, experienceProps)

  // 5. Workspace: docs
  controller.chooseArea('material')
  controller.confirmIntake()
  capture('05-workspace-docs', AssetAssessmentWorkflow, experienceProps)

  // 6. Info review
  controller.setWorkspaceStep('check')
  capture('06-workspace-check', AssetAssessmentWorkflow, experienceProps, { dark: true })

  // 7. Plan reasoning
  controller.generatePlan()
  capture('07-workspace-reasoning', AssetAssessmentWorkflow, experienceProps)

  // 8. Plan confirmation
  controller.submitPlan()
  controller.setWorkspaceStep('confirm')
  capture('08-workspace-confirm', AssetAssessmentWorkflow, experienceProps)

  // 9. Cases
  controller.toggleAck()
  controller.confirmPlan()
  controller.retrieveCases()
  const cases = controller.getState().candidates
  if (cases.length > 0) controller.toggleAdopt(cases[0].id)
  if (cases.length > 1) controller.toggleAdopt(cases[1].id)
  capture('09-workspace-cases', AssetAssessmentWorkflow, experienceProps)

  // 10. Case check with one fully checked case
  controller.setWorkspaceStep('caseCheck')
  if (cases.length > 0) {
    for (const key of ['deal', 'area', 'built', 'rights', 'time']) controller.toggleCheck(cases[0].id, key)
  }
  capture('10-workspace-case-check', AssetAssessmentWorkflow, experienceProps)

  // 11. Narrow panel: docs page, light theme
  controller.setWorkspaceStep('docs')
  capture('11-workspace-narrow', AssetAssessmentWorkflow, experienceProps, { width: 900, height: 1000 })

  for (const [name, html] of pages) {
    await writeFile(join(outDir, `${name}.html`), html)
  }
  // A manifest makes it obvious these are fixture screenshots, not production results.
  await writeFile(join(outDir, 'README.txt'),
    'Valuation experience visual fixtures. Generated from real React components with a fake, in-memory Host; ' +
    'the demo project and cases are explicitly labelled demo data. Not a production result.\n')
  console.log(`OK ${pages.length} pages → ${outDir}`)
  console.log('Screenshot example:')
  console.log('  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless=new --no-sandbox \\')
  console.log(`    --disable-gpu --hide-scrollbars --user-data-dir=/tmp/crwu-edge --window-size=${pages[0][2].width ?? 1440},${pages[0][2].height ?? 1000} \\`)
  console.log(`    --virtual-time-budget=1500 --screenshot=${join(outDir, '01-overview.png')} file://${join(outDir, '01-overview.html')}`)
}

await run()
