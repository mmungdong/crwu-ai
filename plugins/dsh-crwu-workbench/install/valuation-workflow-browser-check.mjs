// Source-repository acceptance: real Client shell, synthetic ports, external test-only browser runtime.
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = (key) => { const i = process.argv.indexOf(`--${key}`); assert.ok(i >= 0, `missing --${key}`); return resolve(process.argv[i + 1]) }
const reactRoot = arg('react-root'), playwrightRoot = arg('playwright'), executablePath = arg('browser'), out = arg('out')
await Promise.all([access(join(reactRoot, 'react')), access(join(reactRoot, 'react-dom')), access(executablePath), access(join(playwrightRoot, 'playwright-core/index.mjs'))])
await mkdir(dirname(out), { recursive: true })
await mkdir(out, { recursive: false })
const { build } = await import(pathToFileURL(join(root, 'node_modules/rolldown/dist/index.mjs')).href)
const { chromium } = await import(pathToFileURL(join(playwrightRoot, 'playwright-core/index.mjs')).href)
await build({ input: join(root, 'tests/browser/valuation-workflow-fixture.tsx'), platform: 'browser',
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
  catch (error) { failures.push(name); results.push({ name, ok: false, error: String(error.message).slice(0, 1000) }) }
}
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const dark of [false, true]) for (const width of [375, 900, 1440]) {
    const label = `${dark ? 'dark' : 'light'}-${width}`
    await check(`actual graph workspace ${label}`, async () => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(base)
      if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await page.locator('[data-asset-assessment-workflow="true"]').waitFor()
      await page.locator('[data-valuation-workflow="true"]').waitFor()
      assert.equal(await page.locator('[role="tab"][id*="valuation"]').count(), 0)
      const node = page.locator('[data-workflow-node="valuation:realestate:rights"]')
      await node.click()
      await page.locator('[data-workflow-node-detail="valuation:realestate:rights"]').waitFor()
      assert.equal(await page.locator('[data-workflow-input="useLabel"]').inputValue(), '公寓')
      assert.ok(await page.locator('[data-workflow-detail="knowledge"]').textContent())
      assert.equal(await page.locator('[data-workflow-percentage]').count(), 0)
      const overflow = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }))
      assert.ok(overflow.body <= overflow.viewport + 1, JSON.stringify(overflow))
      assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.open), 0)
      await page.screenshot({ path: join(out, `${label}.png`) })
    })
  }
  await check('exact displayed plan confirmation submits once', async () => {
    await page.goto(base)
    const button = page.locator('[data-workflow-plan-confirm]')
    await button.click()
    await page.waitForFunction(() => window.fixtureWorkflowCalls.action.length === 1)
    const [action] = await page.evaluate(() => window.fixtureWorkflowCalls.action)
    assert.equal(action.action, 'approve-plan')
    assert.equal(action.payload.expectedRevision, 1)
    assert.equal(action.payload.planDigest, 'sha256:synthetic-plan')
    assert.ok(action.payload.submissionId)
  })
  await check('business landing enters valuation without creating a session', async () => {
    await page.goto(`${base}/?empty`)
    await page.locator('[data-business-step="valuation"]').click()
    await page.locator('[data-workflow-step="valuation"]').waitFor()
    assert.equal(await page.locator('[role="tab"][id*="valuation"]').count(), 0)
    assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.start.length), 0)
    assert.equal(await page.evaluate(() => window.fixtureWorkflowCalls.open), 0)
    await page.screenshot({ path: join(out, 'valuation-intake.png') })
  })
  results.push({ name: 'no browser exceptions', ok: pageErrors.length === 0, errors: pageErrors })
  if (pageErrors.length) failures.push('browser exceptions')
  await writeFile(join(out, 'report.json'), JSON.stringify({ platform: process.platform, node: process.version, browser: await browser.version(), results }, null, 2))
  console.log(JSON.stringify({ passed: failures.length === 0, failures, checks: results.length, out }))
  if (failures.length) process.exitCode = 1
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
