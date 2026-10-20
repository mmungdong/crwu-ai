// Source-repository acceptance: isolated DSH Web runtime, real source components, synthetic ports.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return resolve(process.argv[index + 1])
}
const root = fileURLToPath(new URL('..', import.meta.url))
const out = arg('out'), runtimeRoot = arg('playwright'), hostLog = arg('host-log')
const log = await readFile(hostLog, 'utf8')
const nativeUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
assert.ok(nativeUrl, 'isolated local DSH Web host did not advertise its URL')
await mkdir(out, { recursive: true })
const { build } = await import(pathToFileURL(join(root, 'node_modules/rolldown/dist/index.mjs')).href)
const { chromium } = await import(pathToFileURL(join(runtimeRoot, 'playwright-core/index.mjs')).href)
await build({ input: join(root, 'tests/browser/valuation-workflow-fixture.tsx'), platform: 'browser',
  external: ['react', 'react/jsx-runtime', 'react-dom/client'],
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
  output: { file: join(out, 'fixture.js'), format: 'iife', globals: {
    react: '__fixtureReact', 'react/jsx-runtime': '__fixtureJSX', 'react-dom/client': '__fixtureDOM',
  } } })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const results = [], pageErrors = []
const cleanError = (error) => String(error?.message ?? error).replaceAll(nativeUrl, '[isolated-host]').slice(0, 1500)
const check = async (name, run) => {
  try { await run(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: cleanError(error) }) }
}
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => pageErrors.push(cleanError(error)))
  await page.addInitScript(() => {
    let loader
    const wrap = (registration) => ({ ...registration, factory: (require) => {
      try {
        window.__fixtureReact = require('react')
        window.__fixtureDOM = require('react-dom/client')
        window.__fixtureJSX = require('react/jsx-runtime')
      } catch { /* Early native factories may not depend on React yet. */ }
      return registration.factory(require)
    } })
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, get: () => loader, set: (value) => {
      loader = value
      let load = value.load
      Object.defineProperty(value, 'load', { configurable: true, get: () => (registration) => load(wrap(registration)),
        set: (next) => { load = next } })
    } })
  })
  const mount = async (query = '', { dark = false, width = 1200 } = {}) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(nativeUrl)
    await page.waitForFunction(() => Boolean(window.__fixtureDOM))
    await page.evaluate(({ query, dark }) => {
      history.replaceState(null, '', `/?${query}`)
      if (dark) document.body.setAttribute('data-ds-dark-theme', '')
      else document.body.removeAttribute('data-ds-dark-theme')
      const host = document.createElement('div')
      host.id = 'workflow-fixture-root'
      host.style.cssText = 'position:fixed;inset:0;z-index:2147480000;height:100%;background:var(--dsw-alias-bg-base,#fff)'
      document.body.replaceChildren(host)
    }, { query, dark })
    await page.addScriptTag({ path: join(out, 'fixture.js') })
    await page.locator('[data-asset-assessment-workflow]').waitFor()
    await page.locator('[data-business-step="valuation"]').click()
  }
  for (const dark of [false, true]) for (const width of [375, 900, 1440]) {
    await check(`drawer layout ${dark ? 'dark' : 'light'} ${width}`, async () => {
      await mount('', { dark, width })
      const node = page.locator('[data-workflow-node="valuation:realestate:rights"]')
      await node.click()
      await page.locator('[data-workflow-node-loading]').waitFor()
      const drawer = page.locator('[data-workflow-node-drawer]')
      await page.locator('[data-workflow-node-detail="valuation:realestate:rights"]').waitFor()
      assert.equal(await drawer.getAttribute('role'), 'dialog')
      assert.match(await drawer.innerText(), /未核与缺口/)
      assert.doesNotMatch(await drawer.innerText(), /修订会影响|完整记录|校正并重新执行/)
      const input = page.locator('[data-workflow-detail="input"]'), output = page.locator('[data-workflow-detail="output"]')
      assert.equal(await input.evaluate((element) => element.open), false)
      assert.equal(await output.evaluate((element) => element.open), false)
      assert.equal(await drawer.locator('[data-workflow-field-value]').count(), 0, 'closed sections must not mount receipt fields')
      await output.locator('summary').click()
      await output.locator('[data-workflow-field-value]').first().waitFor()
      assert.equal(await input.evaluate((element) => element.open), false)
      assert.match(await page.locator('[data-workflow-detail="output"]').innerText(), /第一行\n第二行/)
      await output.locator('summary').click()
      await page.waitForFunction(() => document.querySelectorAll('[data-workflow-field-value]').length === 0)
      await output.locator('summary').click()
      await page.waitForFunction(() => document.querySelectorAll('[data-workflow-field-value]').length > 0)
      const geometry = await drawer.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const backdrop = element.previousElementSibling
        return { width: rect.width, right: rect.right, bottom: rect.bottom, viewport: innerWidth,
          blur: getComputedStyle(backdrop).backdropFilter, overflow: document.documentElement.scrollWidth > innerWidth + 1 }
      })
      assert.equal(geometry.overflow, false)
      assert.ok(geometry.width <= width && Math.abs(geometry.right - width) < 2, JSON.stringify(geometry))
      assert.ok(parseFloat(geometry.blur.match(/[\d.]+/)?.[0] ?? '0') >= 10, geometry.blur)
      assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.open), 0)
      await page.screenshot({ path: join(out, `drawer-${dark ? 'dark' : 'light'}-${width}.png`) })
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'detached' })
      assert.equal(await node.evaluate((element) => document.activeElement === element), true)
    })
  }
  await check('backdrop click closes the drawer', async () => {
    await mount()
    await page.locator('[data-workflow-node="valuation:realestate:rights"]').click()
    await page.locator('[data-workflow-node-drawer]').waitFor()
    await page.locator('.crwu-audit-side-drawer-backdrop').click({ position: { x: 20, y: 50 } })
    await page.locator('[data-workflow-node-drawer]').waitFor({ state: 'detached' })
  })
  await check('running and pre-snapshot graph states have visible motion and reduced-motion support', async () => {
    await mount('scenario=running')
    const spinner = page.locator('[data-workflow-node-indicator="running"] > span')
    assert.notEqual(await spinner.evaluate((element) => getComputedStyle(element).animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await spinner.evaluate((element) => getComputedStyle(element).animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await mount('scenario=preparing')
    await page.locator('[data-workflow-graph-syncing]').waitFor()
    assert.equal(await page.locator('[data-asset-workflow-clear]').count(), 1)
    assert.equal(await page.locator('[data-workflow-node-state="passed"]').count(), 0)
  })
  await check('global parameter edits submit an actual revision without selecting a node', async () => {
    await mount()
    await page.locator('[data-workflow-global-edit]').click()
    await page.locator('[data-workflow-global-input="purpose"]').fill('资产处置参考')
    await page.locator('[data-workflow-global-submit]').click()
    await page.waitForFunction(() => window.fixtureWorkflowCalls.action.length === 1)
    const [action] = await page.evaluate(() => window.fixtureWorkflowCalls.action)
    assert.equal(action.action, 'revise')
    assert.equal(action.payload.expectedRevision, 1)
    assert.deepEqual(action.payload.changes, [{ field: 'purpose', value: '资产处置参考' }])
  })
  await check('node handoff shows initialization and pending nodes reject pointer and keyboard selection', async () => {
    await mount('scenario=initializing')
    const status = page.locator('[data-workflow-node-initializing]')
    assert.match(await status.innerText(), /下一个节点初始化中/)
    const spinner = status.locator('span')
    assert.notEqual(await spinner.evaluate((element) => getComputedStyle(element).animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await spinner.evaluate((element) => getComputedStyle(element).animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const pending = page.locator('[data-workflow-node="valuation:realestate:plan"]')
    assert.equal(await pending.isDisabled(), true)
    await pending.evaluate((element) => { element.click(); element.focus() })
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('[data-workflow-node-drawer]').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.fixtureWorkflowCalls.node), [])
    const toolbar = await page.locator('[data-asset-workflow-toolbar]').innerText()
    assert.doesNotMatch(toolbar, /重新对接|导出\s*JSON|导入\s*JSON/)
    await status.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(out, 'node-initializing.png') })
    for (const scenario of ['running', 'failed', 'blocked', 'waiting']) {
      await mount(`scenario=${scenario}`)
      assert.equal(await page.locator('[data-workflow-node-initializing]').count(), 0)
      const active = page.locator('[data-workflow-node="valuation:realestate:plan"]')
      assert.equal(await active.isEnabled(), true)
      await active.click()
      await page.locator('[data-workflow-node-detail="valuation:realestate:plan"]').waitFor()
    }
  })
  await check('all required structured questions must be answered', async () => {
    await mount('scenario=questions')
    const submit = page.locator('[data-workflow-answer-submit]').first()
    assert.equal(await submit.isDisabled(), true)
    await page.getByRole('radio', { name: '挂牌参考', exact: true }).first().check()
    assert.equal(await submit.isDisabled(), true)
    await page.locator('[data-workflow-answer="community"]').first().fill('合成测试小区')
    await submit.click()
    await page.waitForFunction(() => window.fixtureWorkflowCalls.action.length === 1)
    const [action] = await page.evaluate(() => window.fixtureWorkflowCalls.action)
    assert.deepEqual(action.payload.answers, { community: '合成测试小区', mode: 'listing-reference' })
  })
  await check('clear returns home and the next valuation opens a fresh intake', async () => {
    await mount()
    await page.locator('[data-asset-workflow-clear]').click()
    await page.locator('[data-asset-workflow-clear-confirm]').click()
    await page.locator('[data-business-step="valuation"]').waitFor()
    await page.locator('[data-business-step="valuation"]').click()
    await page.locator('[data-asset-workflow-intake]').waitFor()
    assert.equal(await page.locator('[data-workflow-workspace]').count(), 0)
    assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.start.length), 0)
  })
  await check('durable questions restore accepted A, save drafts, require every typed answer and reload cumulative corrections', async () => {
    await mount('scenario=questionnaire')
    await page.evaluate(() => localStorage.removeItem('crwu-synthetic-questionnaire-questionnaire'))
    await mount('scenario=questionnaire')
    const openQuestions = async () => {
      await page.locator('[data-workflow-node="valuation:realestate:rights"]').click()
      await page.locator('[data-workflow-questionnaire]').waitFor()
    }
    await openQuestions()
    const answer = (id) => page.locator(`[data-workflow-question-answer="${id}"]`)
    const submit = () => page.locator('[data-workflow-questions-submit]')
    assert.equal(await answer('A').inputValue(), '已保存小区 A')
    assert.equal(await submit().isDisabled(), true)
    await answer('A').fill('修正后小区 A')
    await answer('B').selectOption('false')
    await page.locator('[data-workflow-question-unknown="N"]').check()
    assert.equal(await submit().isDisabled(), true)
    await page.locator('[data-workflow-question-reason="N"]').fill('资料中没有租金记录')
    await answer('C').fill('房屋状态已核对')
    await answer('D').fill('2026-10-20')
    await answer('S').selectOption('living')
    await answer('R').check()
    assert.equal(await submit().isDisabled(), true)
    await answer('M').check()
    await page.locator('[data-workflow-note-edit="note-1"]').fill('已修正旧补充')
    await page.locator('[data-workflow-question-supplement]').fill('新增补充记录')
    assert.match(await page.locator('[data-workflow-questionnaire]').innerText(), /不适用.*本轮不涉及/s)
    await page.locator('[data-workflow-draft-status="saved"]').waitFor()
    await mount('scenario=questionnaire')
    await openQuestions()
    assert.equal(await answer('A').inputValue(), '修正后小区 A')
    assert.equal(await answer('B').inputValue(), 'false')
    assert.equal(await page.locator('[data-workflow-question-supplement]').inputValue(), '新增补充记录')
    await submit().click()
    await page.waitForFunction(() => window.fixtureWorkflowCalls.action.some((action) => action.action === 'questions-submit'))
    const action = await page.evaluate(() => window.fixtureWorkflowCalls.action.find((action) => action.action === 'questions-submit'))
    assert.equal(action.payload.answers.A.value, '修正后小区 A')
    assert.equal(action.payload.answers.B.value, 'false')
    assert.deepEqual(action.payload.answers.N, { value: '', unknown: true, reason: '资料中没有租金记录' })
    assert.equal(action.payload.answers.I, undefined)
    await page.locator('[data-workflow-submission-history]').waitFor()
    await mount('scenario=questionnaire')
    await openQuestions()
    assert.equal(await answer('A').inputValue(), '修正后小区 A')
    assert.equal(await page.locator('[data-workflow-question-supplement]').inputValue(), '')
    assert.equal(await page.locator('[data-workflow-note-edit="note-1"]').inputValue(), '已修正旧补充')
    assert.match(await page.locator('[data-workflow-legacy-note]').innerText(), /旧版补充原文不猜类型/)
    await page.locator('[data-workflow-submission-history] > summary').click()
    assert.match(await page.locator('[data-workflow-submission-history]').innerText(), /修正后小区 A.*新增补充记录/s)
    await page.screenshot({ path: join(out, 'durable-questionnaire.png') })
  })
  await check('running questionnaires accept editable drafts and conflict retains local corrections', async () => {
    await mount('scenario=questionnaire-running')
    await page.locator('[data-workflow-node="valuation:realestate:rights"]').click()
    const answer = page.locator('[data-workflow-question-answer="A"]')
    await answer.fill('执行期间可编辑')
    await page.locator('[data-workflow-draft-status="saved"]').waitFor()
    assert.equal(await page.locator('[data-workflow-questions-submit]').isDisabled(), true)
    assert.match(await page.locator('[data-workflow-questionnaire]').innerText(), /节点正在执行/)
    await mount('scenario=questionnaire-conflict')
    await page.locator('[data-workflow-node="valuation:realestate:rights"]').click()
    await page.locator('[data-workflow-question-answer="A"]').fill('发生冲突也保留')
    await page.locator('[data-workflow-draft-status="conflict"]').waitFor()
    await page.evaluate(() => window.fixtureWorkflow.refresh())
    assert.equal(await page.locator('[data-workflow-question-answer="A"]').inputValue(), '发生冲突也保留')
    await page.locator('[data-workflow-draft-reconcile]').click()
    await page.locator('[data-workflow-draft-status="saved"]').waitFor()
  })
  await check('contract faults show concrete requirements and retry the node without inventing answers', async () => {
    await mount('scenario=questionnaire-failure')
    await page.locator('[data-workflow-node="valuation:realestate:rights"]').click()
    const failure = page.locator('[data-workflow-node-failure="output-contract"]')
    await failure.waitFor()
    assert.match(await failure.innerText(), /method 必须为字符串/)
    assert.match(await failure.innerText(), /下一步处理/)
    assert.equal(await page.locator('[data-workflow-questions-submit]').count(), 0)
    await page.screenshot({ path: join(out, 'node-failure.png') })
    await page.locator('[data-workflow-node-retry]').click()
    await page.waitForFunction(() => window.fixtureWorkflowCalls.action.some((action) => action.action === 'revise'))
    assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.action.some((action) => action.action === 'questions-submit')), false)
  })
  results.push({ name: 'no browser exceptions', ok: pageErrors.length === 0, errors: pageErrors })
  await writeFile(join(out, 'report.json'), JSON.stringify({ platform: process.platform, browser: await browser.version(), results }, null, 2))
  const failures = results.filter((result) => !result.ok)
  console.log(JSON.stringify({ passed: failures.length === 0, checks: results.length, failures, out }))
  if (failures.length) process.exitCode = 1
} finally {
  await browser.close()
}
