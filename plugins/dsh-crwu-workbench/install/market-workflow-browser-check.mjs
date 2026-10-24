// Source-repository acceptance: real market workface, synthetic ports, external test-only browser runtime.
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = (key) => { const i = process.argv.indexOf(`--${key}`); assert.ok(i >= 0, `missing --${key}`); return resolve(process.argv[i + 1]) }
const reactRoot = arg('react-root'), playwrightRoot = arg('playwright'), executablePath = arg('browser'), out = arg('out')
await Promise.all([access(join(reactRoot, 'react')), access(join(reactRoot, 'react-dom')), access(executablePath), access(join(playwrightRoot, 'playwright-core/index.mjs'))])
await mkdir(dirname(out), { recursive: true })
await mkdir(out, { recursive: false })
const { build } = await import(pathToFileURL(join(root, 'node_modules/rolldown/dist/index.mjs')).href)
const { chromium } = await import(pathToFileURL(join(playwrightRoot, 'playwright-core/index.mjs')).href)
await build({ input: join(root, 'tests/browser/market-workflow-fixture.tsx'), platform: 'browser',
  resolve: { alias: { 'react/jsx-runtime': join(reactRoot, 'react/jsx-runtime'), 'react-dom/client': join(reactRoot, 'react-dom/client'),
    'react-dom': join(reactRoot, 'react-dom'), react: join(reactRoot, 'react') } },
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
  output: { file: join(out, 'fixture.js'), format: 'iife' } })
await writeFile(join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script></html>')
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return }
  if (pathname !== '/' && pathname !== '/fixture.js') { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-type': pathname === '/' ? 'text/html;charset=utf-8' : 'text/javascript' })
  response.end(await readFile(join(out, pathname === '/' ? 'index.html' : 'fixture.js')))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath, headless: true })
const failures = [], results = [], pageErrors = []
const check = async (name, run) => {
  try { await run(); results.push({ name, ok: true }) }
  catch (error) { failures.push(name); results.push({ name, ok: false, error: String(error.message).slice(0, 1200) }) }
}
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const dark of [false, true]) for (const width of [390, 900, 1440]) {
    const label = `${dark ? 'dark' : 'light'}-${width}`
    await check(`market workface ${label}`, async () => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.goto(`${base}/?state=awaiting`)
      if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await page.locator('[data-market-workflow="true"]').waitFor()
      assert.equal(await page.locator('[data-market-node]').count(), 11)
      await page.locator('[data-market-node="templates"]').waitFor()
      await page.locator('[data-market-node="materials"]').waitFor()
      assert.equal(await page.locator('[data-market-row="parallel"] [data-market-node]').count(), 2)
      await page.locator('[data-market-drawer="select-cases"]').waitFor()
      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }))
      assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, JSON.stringify(overflow))
      await page.screenshot({ path: join(out, `${label}-awaiting.png`) })
    })
  }
  await check('closed drawer leaves the full eleven-node graph visible', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}/?state=awaiting`)
    await page.addStyleTag({ content: '[data-fixture-bar]{display:none!important}' })
    await page.locator('.crwu-audit-side-drawer-close').click()
    await page.waitForTimeout(220)
    assert.equal(await page.locator('[data-market-drawer]').count(), 0)
    await page.screenshot({ path: join(out, 'light-1440-graph.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(120)
    await page.screenshot({ path: join(out, 'light-390-graph.png'), fullPage: true })
  })
  await check('drawer body scrolls independently and footer stays visible', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}/?state=awaiting`)
    const body = await page.locator('.crwu-audit-side-drawer-body').evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY }))
    assert.equal(body.overflow, 'auto')
    assert.ok(body.scrollHeight > body.clientHeight, JSON.stringify(body))
    const footer = await page.locator('.crwu-audit-side-drawer-foot').evaluate((el) => el.getBoundingClientRect().toJSON())
    assert.ok(footer.bottom <= 1001 && footer.top >= 0, JSON.stringify(footer))
    await page.screenshot({ path: join(out, 'light-1440-drawer-scroll.png') })
  })
  await check('case selection is not prechecked and other is exclusive with draft retention', async () => {
    await page.goto(`${base}/?state=awaiting`)
    assert.equal(await page.locator('[data-market-case="C01"]').isChecked(), false)
    await page.locator('[data-market-case="C01"]').check({ force: true })
    await page.locator('[data-market-case="C02"]').check({ force: true })
    await page.locator('[data-market-other="select-cases:caseIds"]').check({ force: true })
    assert.equal(await page.locator('[data-market-case="C01"]').isChecked(), false)
    await page.locator('[data-market-other-text="select-cases:caseIds"]').fill('候选都不合适，改为同小区成交案例')
    await page.locator('[data-market-other="select-cases:caseIds"]').uncheck({ force: true })
    assert.equal(await page.locator('[data-market-case="C01"]').isChecked(), true)
    assert.equal(await page.locator('[data-market-other-text="select-cases:caseIds"]').count(), 0)
    await page.screenshot({ path: join(out, 'light-1440-selected.png') })
  })
  await check('submit is disabled until required questions are answered', async () => {
    await page.goto(`${base}/?state=awaiting`)
    assert.equal(await page.locator('[data-market-submit="true"]').isDisabled(), true)
    await page.locator('[data-market-case="C01"]').check({ force: true })
    await page.locator('[data-market-choice="stop"]').check({ force: true })
    await page.waitForTimeout(50)
    assert.equal(await page.locator('[data-market-submit="true"]').isDisabled(), false)
  })
  await check('escape closes the drawer and focus returns to the triggering node', async () => {
    await page.goto(`${base}/?state=awaiting`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const open = await page.locator('[data-market-drawer]').count()
    assert.equal(open, 0)
    await page.locator('[data-market-node="select-cases"]').click()
    await page.locator('[data-market-drawer="select-cases"]').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-market-node')), 'select-cases')
  })
  for (const state of ['executing', 'done', 'restricted', 'failed']) {
    await check(`fixture state ${state}`, async () => {
      await page.goto(`${base}/?state=${state}`)
      await page.locator('[data-market-workflow="true"]').waitFor()
      await page.screenshot({ path: join(out, `light-1440-${state}.png`) })
      const status = await page.locator('[data-market-status]').getAttribute('data-market-status')
      assert.ok(status !== null && status !== '', state)
    })
  }
  for (const state of ['awaiting', 'submitting', 'queued', 'executing', 'done', 'restricted', 'failed']) {
    for (const dark of [false, true]) for (const width of [1440, 390]) {
      await check(`state matrix ${state} ${dark ? 'dark' : 'light'} ${width}`, async () => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
        await page.goto(`${base}/?state=${state}`)
        await page.addStyleTag({ content: '[data-fixture-bar]{display:none!important}' })
        if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
        await page.locator('[data-market-workflow="true"]').waitFor()
        await page.waitForTimeout(250)
        const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }))
        assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, JSON.stringify(overflow))
        await page.screenshot({ path: join(out, `${state}-${dark ? 'dark' : 'light'}-${width}.png`) })
      })
    }
  }
  results.push({ name: 'no browser exceptions', ok: pageErrors.length === 0, errors: pageErrors })
  if (pageErrors.length) failures.push('browser exceptions')
  await writeFile(join(out, 'report.json'), JSON.stringify({ platform: process.platform, node: process.version, browser: await browser.version(), results }, null, 2))
  console.log(JSON.stringify({ passed: failures.length === 0, failures, checks: results.length, out }))
  if (failures.length) process.exitCode = 1
  await check('failed-node retry carries the opened graph identity and unknown stops cannot be retried', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}/?state=failed`)
    assert.equal(await page.locator('[data-market-retry]').isEnabled(), true)
    assert.ok((await page.locator('.mv-foot').innerText()).includes('执行失败'))
    await page.screenshot({ path: join(out, 'failed-node-recovery.png') })
    await page.locator('[data-market-retry]').click()
    assert.equal(await page.locator('body').getAttribute('data-retry-node'), 'valuation:realestate:template-market:select-cases')
    await page.goto(`${base}/?state=failed&stopUnknown=1`)
    assert.equal(await page.locator('[data-market-retry]').isDisabled(), true)
    assert.ok((await page.locator('.mv-foot').innerText()).includes('停止状态尚未确认'))
    await page.screenshot({ path: join(out, 'stop-unknown-blocked.png') })
  })
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
