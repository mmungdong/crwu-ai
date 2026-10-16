/**
 * Isolated real-source UI browser acceptance.
 *
 * Builds the two `tests/browser/*-fixture.tsx` entries against an **external** test-only
 * React/ReactDOM root, serves the output on 127.0.0.1, drives it with an external Playwright,
 * and writes screenshots plus a pass/fail JSON report. It never touches a DSH profile, account,
 * credential, provider or the user's filesystem outside a **fresh** `--out` directory.
 *
 * Usage:
 *   node install/ui-browser-check.mjs \
 *     --react-root <node_modules with react + react-dom> \
 *     --playwright <node_modules with playwright-core> \
 *     --browser <browser executable> \
 *     --out <new output directory>
 *
 * The React/ReactDOM/Playwright/browser runtime is test-only and never enters the product bundle.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

function argOf(name, fallback = '') {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return fallback
  return process.argv[at + 1] ?? fallback
}

function fail(message) {
  console.error(`ui-browser-check: ${message}`)
  process.exit(2)
}

const reactRoot = resolve(argOf('react-root'))
const playwrightRoot = resolve(argOf('playwright'))
const browserPath = argOf('browser')
const outDir = resolve(argOf('out'))
if (argOf('react-root') === '') fail('missing --react-root <node_modules containing react + react-dom>')
if (argOf('playwright') === '') fail('missing --playwright <node_modules containing playwright-core>')
if (browserPath === '') fail('missing --browser <browser executable>')
if (argOf('out') === '') fail('missing --out <new output directory>')
if (!existsSync(join(reactRoot, 'react')) || !existsSync(join(reactRoot, 'react-dom'))) {
  fail(`--react-root must contain react and react-dom: ${reactRoot}`)
}

/** A tiny check ledger: failures never abort the rest, and nothing is silently skipped. */
class Checks {
  constructor() { this.results = [] }
  that(name, ok, detail = '') {
    this.results.push({ name, ok: ok === true, detail })
    if (ok !== true) console.error('FAIL', name, detail === '' ? '' : JSON.stringify(detail))
  }
  get failed() { return this.results.filter((item) => !item.ok) }
}

async function loadRolldown() {
  const entry = join(PLUGIN_ROOT, 'node_modules', 'rolldown', 'dist', 'index.mjs')
  if (!existsSync(entry)) fail(`project rolldown is required to build the fixtures: ${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  return mod.build ?? mod.default?.build
}

async function loadPlaywright() {
  const candidates = ['playwright-core/index.mjs', 'playwright/index.mjs', 'playwright-core/index.js']
  for (const candidate of candidates) {
    const entry = join(playwrightRoot, candidate)
    if (!existsSync(entry)) continue
    const mod = await import(pathToFileURL(entry).href)
    const chromium = mod.chromium ?? mod.default?.chromium
    if (chromium !== undefined) return chromium
  }
  fail(`--playwright must contain playwright-core with chromium: ${playwrightRoot}`)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }

/** Serve only the fixture output directory on an ephemeral 127.0.0.1 port. */
function serve(dir) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const relative = url.pathname === '/' ? '/unified.html' : url.pathname
    if (relative.includes('..')) { response.writeHead(400).end(); return }
    const file = join(dir, relative)
    if (!file.startsWith(dir) || !existsSync(file)) { response.writeHead(404).end('not found'); return }
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  })
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }))
  })
}

const box = (element) => {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
  }
}

/** WCAG relative-luminance contrast for the rendered theme tokens (hex only). */
async function themeContrast(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('[data-crwu-scope="workbench"]')
    const style = getComputedStyle(scope ?? document.documentElement)
    const toRgb = (value) => {
      const match = /^#([0-9a-f]{6})$/i.exec(String(value).trim())
      if (match === null) return null
      const n = Number.parseInt(match[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const lin = (channel) => {
      const x = channel / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const token = (name) => toRgb(style.getPropertyValue(name))
    const primaryBg = token('--crwu-primary-bg')
    const primaryText = token('--crwu-primary-text')
    const interactive = token('--crwu-interactive')
    const appBg = token('--crwu-app-bg')
    return {
      primary: primaryBg !== null && primaryText !== null ? ratio(primaryText, primaryBg) : 0,
      interactive: interactive !== null && appBg !== null ? ratio(interactive, appBg) : 0,
    }
  })
}

/** WCAG contrast between two rendered elements' computed colors (real styles, rgb/rgba). */
async function elementContrast(page, foregroundSelector, backgroundSelector) {
  return page.evaluate(({ foregroundSelector, backgroundSelector }) => {
    const parse = (value) => {
      const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(value))
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
    }
    const lin = (channel) => {
      const x = channel / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const foreground = document.querySelector(foregroundSelector)
    const background = document.querySelector(backgroundSelector)
    if (foreground === null || background === null) return 0
    const fg = parse(getComputedStyle(foreground).color)
    const bg = parse(getComputedStyle(background).backgroundColor)
    if (fg === null || bg === null) return 0
    const la = lum(fg), lb = lum(bg)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }, { foregroundSelector, backgroundSelector })
}

async function main() {
  const build = await loadRolldown()
  const chromium = await loadPlaywright()
  const checks = new Checks()
  const errors = []

  // A fresh output directory only: never delete an arbitrary caller-supplied path.
  await mkdir(dirname(outDir), { recursive: true })
  try {
    await mkdir(outDir, { recursive: false })
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`--out already exists; pass a fresh directory: ${outDir}`)
    throw error
  }

  let server = null
  let browser = null
  try {
    const fixtures = [
      ['unified', 'tests/browser/unified-ui-fixture.tsx'],
      ['valuation', 'tests/browser/valuation-ui-fixture.tsx'],
      ['environment', 'tests/browser/environment-ui-fixture.tsx'],
      ['audit', 'tests/browser/audit-ui-fixture.tsx'],
    ]
    for (const [name, relative] of fixtures) {
      const file = join(outDir, `${name}.js`)
      await build({
        input: resolve(PLUGIN_ROOT, relative),
        platform: 'browser',
        resolve: {
          alias: {
            'react/jsx-runtime': join(reactRoot, 'react', 'jsx-runtime'),
            'react-dom/client': join(reactRoot, 'react-dom', 'client'),
            'react-dom': join(reactRoot, 'react-dom'),
            'react': join(reactRoot, 'react'),
          },
        },
        transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
        output: { file, format: 'iife', sourcemap: false },
      })
      await writeFile(join(outDir, `${name}.html`),
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>CRWU UI fixture ${name}</title></head><body><div id="root"></div><script src="${name}.js"></script></body></html>`)
    }

    const served = await serve(outDir)
    server = served.server
    const base = `http://127.0.0.1:${served.port}`
    browser = await chromium.launch({ executablePath: browserPath, headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    // Wait for the real fixture root, not the first `#root *` (that is the injected <style> tag).
    const goto = async (path) => {
      await page.goto(`${base}/${path}`)
      await page.locator('[data-crwu-scope=workbench]').first().waitFor()
    }
    const dialog = page.getByRole('dialog')
    // Exit keeps the aria-hidden dialog mounted for ~150ms; wait for the real unmount so a reopen
    // cannot race the old DOM. Role-based operations below stay on `dialog`.
    const dateDialog = page.locator('.crwu-ui-datepicker-dialog')
    const waitDialogClosed = async () => { await dateDialog.waitFor({ state: 'detached', timeout: 10000 }) }
    const openCalendar = async (scopeSelector) => {
      await page.locator(`${scopeSelector} [data-crwu-date-trigger]`).click()
      await dialog.waitFor({ state: 'visible' })
      await page.waitForTimeout(180)
    }

    // ── Shared components ───────────────────────────────────────────────────
    await page.setViewportSize({ width: 500, height: 900 })
    await goto('unified.html')
    await page.locator('[data-fixture="theme"]').click()
    checks.that('components: dark follows the body attribute',
      await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')))
    await page.locator('[data-fixture="theme"]').click()
    checks.that('components: light removes the body attribute',
      await page.evaluate(() => !document.body.hasAttribute('data-ds-dark-theme')))

    const buttons = await page.locator('.crwu-ui-btn').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return {
        text: element.textContent, classes: element.className, background: style.backgroundColor,
        width: element.getBoundingClientRect().width,
      }
    }))
    const variantBackgrounds = new Set(buttons
      .filter((item) => /crwu-ui-btn-(primary|secondary|soft|text)\b/.test(item.classes) && !/crwu-ui-icon-btn/.test(item.classes))
      .map((item) => item.background))
    checks.that('components: button variants keep distinct surfaces', variantBackgrounds.size >= 3,
      [...variantBackgrounds])
    const loading = buttons.filter((item) => item.text === '处理中')
    checks.that('components: loading preserves the button width',
      loading.length === 2 && Math.abs(loading[0].width - loading[1].width) <= 1,
      loading.map((item) => item.width))
    checks.that('components: loading renders the overlay spinner',
      await page.locator('[data-fixture-loading="on"] .crwu-ui-btn-spinner').count() === 1)
    const iconBackgrounds = await page.locator('.crwu-ui-icon-btn').evaluateAll((elements) => elements
      .map((element) => getComputedStyle(element).backgroundColor))
    checks.that('components: icon variants keep blue surfaces',
      iconBackgrounds.length === 4 && iconBackgrounds.filter((value) => value !== 'rgba(0, 0, 0, 0)').length >= 3,
      iconBackgrounds)

    const selectRoots = page.locator('[data-crwu-select="asset-a"]')
    checks.that('components: same-name selects both render', await selectRoots.count() === 2)
    const triggerIds = await selectRoots.evaluateAll((elements) => elements.map((element) => element.querySelector('[role="combobox"]')?.id))
    checks.that('components: same-name selects get unique trigger ids',
      triggerIds.length === 2 && triggerIds[0] !== triggerIds[1], triggerIds)
    await selectRoots.first().locator('[role="combobox"]').click()
    checks.that('components: select opens a listbox', await page.getByRole('listbox').count() === 1)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    checks.that('components: keyboard selects an option',
      (await selectRoots.first().innerText()).includes('房地产'), await selectRoots.first().innerText())
    const disabledTrigger = page.locator('[data-crwu-select="asset-disabled"] [role="combobox"]')
    checks.that('components: disabled select is disabled', await disabledTrigger.isDisabled())
    await page.keyboard.press('Escape')

    // Date: open focus, commit, month/year views, range, clear, reduced motion.
    await openCalendar('[data-fixture="date"]')
    checks.that('components: date opens with the value focused',
      await page.evaluate(() => document.activeElement?.getAttribute('data-date')) === '2026-10-15')
    checks.that('components: date header shows year and month',
      /2026年10月/.test(await page.locator('.crwu-ui-datepicker-title').innerText()))
    await page.locator('[data-date="2026-10-20"]').click()
    checks.that('components: date click commits', await page.locator('[data-result="date"]').innerText() === '2026-10-20')
    await waitDialogClosed()

    await openCalendar('[data-fixture="date"]')
    // Month navigation keeps exactly one day tab stop, inside the visible month and DOM-focused.
    await page.locator('[data-crwu-date-nav="next-month"]').click()
    await page.waitForTimeout(180)
    checks.that('components: next month keeps one day tab stop',
      await page.locator('[data-crwu-date-grid] [data-date][tabindex="0"]').count() === 1)
    const focusAfterNav = await page.evaluate(() => document.activeElement?.getAttribute('data-date') ?? '')
    checks.that('components: month navigation keeps DOM focus in the visible month',
      focusAfterNav.startsWith('2026-11'), focusAfterNav)
    // Month grid → year grid (paged range).
    await page.locator('[data-crwu-date-view="months"]').click()
    checks.that('components: month grid uses group semantics',
      await page.locator('[role="group"] [data-crwu-date-view="month"]').count() === 12)
    await page.locator('[data-crwu-date-view="years"]').click()
    const years = await page.locator('[data-crwu-date-year]').evaluateAll((elements) =>
      elements.map((element) => Number(element.getAttribute('data-crwu-date-year'))).sort((a, b) => a - b))
    checks.that('components: year view is a contiguous paged range',
      years.length === 12 && years[11] - years[0] === 11, years)
    await page.locator(`[data-crwu-date-year="${years[2]}"]`).click()
    checks.that('components: year selection returns to months',
      await page.locator('[data-crwu-date-view="years"]').count() === 1)
    await page.keyboard.press('Escape')
    await waitDialogClosed()

    // Tab from the day reaches the footer without closing the dialog.
    await openCalendar('[data-fixture="date"]')
    let reachedFooter = false
    for (let step = 0; step < 8 && !reachedFooter; step += 1) {
      await page.keyboard.press('Tab')
      reachedFooter = await page.evaluate(() => document.activeElement?.getAttribute('data-crwu-date-action') !== null)
      if (await dialog.count() === 0) break
    }
    checks.that('components: Tab within the picker keeps the dialog open',
      await dialog.count() === 1)
    checks.that('components: Tab reaches a footer action', reachedFooter)
    await page.keyboard.press('Escape')
    await waitDialogClosed()

    // Reduced motion: exit has no exit timer / no lingering dialog.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCalendar('[data-fixture="other"]')
    await page.keyboard.press('Escape')
    checks.that('components: reduced motion closes the calendar immediately',
      await dialog.count() === 0)
    await page.emulateMedia({ reducedMotion: null })

    // Out-of-range draft + clear (non-empty parent).
    const limit = page.locator('[data-fixture="limit"] input')
    await limit.fill('1999-12-31')
    await limit.press('Tab')
    checks.that('components: out-of-range draft is invalid', await limit.getAttribute('aria-invalid') === 'true')
    checks.that('components: out-of-range draft keeps the parent value',
      await page.locator('[data-result="limit"]').innerText() === '2000-10-15')
    checks.that('components: invalid draft shows the localized error',
      await page.locator('[data-fixture="limit"] [role="alert"]').count() >= 1)
    await page.locator('[data-fixture="limit"] [data-crwu-date-action="clear"]').first().click()
    checks.that('components: clearing an invalid draft emits empty',
      await limit.inputValue() === '' && await page.locator('[data-result="limit"]').innerText() === '')
    await limit.fill('1999-12-31')
    await limit.press('Tab')
    await openCalendar('[data-fixture="limit"]')
    checks.that('components: Today is disabled outside the range',
      await page.locator('[role="dialog"] [data-crwu-date-action="today"]').isDisabled())
    await page.keyboard.press('Escape')
    await waitDialogClosed()

    // Clear an invalid draft even when the parent value is already empty.
    const other = page.locator('[data-fixture="other"] input')
    await other.fill('2026-02-30')
    await other.press('Tab')
    checks.that('components: invalid empty-parent draft is invalid',
      await other.getAttribute('aria-invalid') === 'true')
    await page.locator('[data-fixture="other"] [data-crwu-date-action="clear"]').first().click()
    checks.that('components: empty-parent invalid draft can be cleared',
      await other.inputValue() === '' && await page.locator('[data-fixture="other"] [role="alert"]').count() === 0)
    checks.that('components: no native select or date input',
      await page.locator('select, input[type="date"]').count() === 0)
    await page.screenshot({ path: join(outDir, 'components-light.png'), fullPage: true })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(outDir, 'components-dark.png'), fullPage: true })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))

    // ── Valuation page and drawer ───────────────────────────────────────────
    for (const dark of [false, true]) {
      for (const width of [375, 500, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 600 })
        await goto('valuation.html')
        if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
        const intake = await page.locator('.crwu-valuation-intake').evaluate(box)
        const footer = await page.locator('.crwu-valuation-actionbar').evaluate(box)
        checks.that(`valuation layout ${dark ? 'dark' : 'light'} ${width}`,
          intake.scrollWidth <= intake.clientWidth + 1 && footer.bottom <= 601 && footer.top >= 0,
          { intake, footer })
        if (width === 375) {
          const fontSize = await page.locator('.crwu-valuation-purpose').evaluate((element) => getComputedStyle(element).fontSize)
          checks.that('valuation: narrow workface fields use 16px', fontSize === '16px', fontSize)
        }
        await page.locator('[data-valuation-select="method"] [role="combobox"]').click()
        const list = page.getByRole('listbox')
        await list.waitFor()
        await page.waitForTimeout(180)
        checks.that(`valuation methods ${dark ? 'dark' : 'light'} ${width}`,
          await list.getByRole('option').count() === 4)
        const listBox = await list.evaluate(box)
        checks.that(`valuation select clamp ${dark ? 'dark' : 'light'} ${width}`,
          listBox.left >= -1 && listBox.right <= width + 1 && listBox.top >= -1 && listBox.bottom <= 601, listBox)
        await page.keyboard.press('Escape')
        await page.locator('[data-crwu-select-list]').first().waitFor({ state: 'hidden', timeout: 10000 })
        await openCalendar('[data-valuation-base-date-field]')
        const calBox = await dialog.evaluate(box)
        checks.that(`valuation calendar clamp ${dark ? 'dark' : 'light'} ${width}`,
          calBox.left >= -1 && calBox.right <= width + 1 && calBox.top >= -1 && calBox.bottom <= 601, calBox)
        await page.keyboard.press('Escape')
        await waitDialogClosed()
        if (dark || width === 375 || width === 1024) {
          await page.screenshot({ path: join(outDir, `valuation-${dark ? 'dark' : 'light'}-${width}.png`) })
        }
      }
    }

    // Theme contrast for the primary / focus pair.
    for (const dark of [false, true]) {
      await goto('valuation.html')
      if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await page.waitForTimeout(200)
      const ratios = await themeContrast(page)
      checks.that(`theme contrast ${dark ? 'dark' : 'light'}: primary text >= 4.5`,
        ratios.primary >= 4.5, ratios)
      checks.that(`theme contrast ${dark ? 'dark' : 'light'}: interactive >= 3`,
        ratios.interactive >= 3, ratios)
    }

    // Confirmation drawer: no automatic preflight, invalid blocks, read-only, one start.
    await page.setViewportSize({ width: 1024, height: 900 })
    await goto('valuation.html')
    checks.that('valuation: no automatic preflight before confirmation',
      await page.evaluate(() => window.fixtureCalls.preflight) === 0)
    const date = page.locator('[data-valuation-base-date-field] input')
    await date.fill('2026-02-30')
    await date.press('Tab')
    checks.that('valuation: invalid draft blocks confirm',
      await page.getByRole('button', { name: '核对资料', exact: true }).isDisabled())
    checks.that('valuation: invalid draft never posts intake',
      await page.evaluate(() => window.fixtureCalls.intake.length) === 0)
    await date.fill('2026-02-28')
    await date.press('Tab')
    await page.getByRole('button', { name: '核对资料', exact: true }).click()
    const drawer = page.locator('[data-valuation-confirmation-drawer]')
    await drawer.waitFor()
    await page.waitForTimeout(260)
    checks.that('valuation: confirmation is read-only',
      await drawer.locator('input, textarea, select').count() === 0)
    checks.that('valuation: optional capability still allows start',
      await page.getByRole('button', { name: '开始估值', exact: true }).isEnabled())
    await page.screenshot({ path: join(outDir, 'drawer-light-1024.png') })
    // The header theme button sits behind the modal/inert drawer: flip the body attribute directly.
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(outDir, 'drawer-dark-1024.png') })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.getByRole('button', { name: '开始估值', exact: true }).click()
    checks.that('valuation: creating locks the drawer',
      await drawer.isVisible()
        && await page.getByRole('button', { name: '返回修改', exact: true }).isDisabled())
    await page.waitForTimeout(900)
    checks.that('valuation: exactly one start request',
      await page.evaluate(() => window.fixtureCalls.start.length) === 1)

    await goto('valuation.html')
    await page.getByRole('button', { name: '核对资料', exact: true }).click()
    const drawerAgain = page.locator('[data-valuation-confirmation-drawer]')
    await drawerAgain.waitFor()
    await page.waitForTimeout(260)
    await page.getByRole('button', { name: '返回修改', exact: true }).click()
    await drawerAgain.waitFor({ state: 'hidden' })
    checks.that('valuation: return focus goes back to confirm',
      await page.getByRole('button', { name: '核对资料', exact: true }).evaluate((element) => element === document.activeElement))

    await goto('valuation.html?empty')
    checks.that('valuation: empty draft has no default choices',
      await page.evaluate(() => {
        const state = window.fixtureController.getState()
        return state.assetType === '' && state.method === '' && state.baseDate === ''
      }))
    checks.that('valuation: empty draft posts no preflight',
      await page.evaluate(() => window.fixtureCalls.preflight) === 0)
    checks.that('valuation: no native select or date input',
      await page.locator('select, input[type="date"]').count() === 0)

    // ── Valuation full-shell geometry + capability disclosure ────────────────
    // Screenshot-feedback polish, test-first: the red set below is intentional and must
    // stay red until the navigation / paper / body / footer / capability changes land.
    for (const dark of [false, true]) {
      for (const width of [375, 500, 1024, 1440]) {
        await page.setViewportSize({ width, height: 600 })
        await goto('valuation.html')
        if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
        await page.waitForTimeout(140)
        const theme = dark ? 'dark' : 'light'
        const tag = `${theme} ${width}`

        checks.that(`valuation shell ${tag}: no duplicated large heading below navigation`,
          await page.locator('.crwu-audit-nav-page-head, .crwu-audit-nav-page-title').count() === 0)

        const nav = page.locator('.crwu-audit-nav')
        checks.that(`valuation shell ${tag}: valuation navigation stays visible`,
          await nav.isVisible() && await nav.getByRole('tab', { name: '估值', exact: true }).isVisible())

        if (width === 1024) {
          await page.screenshot({ path: join(outDir, `valuation-shell-${theme}-collapsed.png`) })
        }

        const geometry = await page.evaluate(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector)
            if (element === null) return null
            const box = element.getBoundingClientRect()
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
          }
          const styles = (selector) => {
            const element = document.querySelector(selector)
            if (element === null) return null
            const style = getComputedStyle(element)
            return {
              paddingTop: Number.parseFloat(style.paddingTop), paddingBottom: Number.parseFloat(style.paddingBottom),
              paddingLeft: Number.parseFloat(style.paddingLeft), paddingRight: Number.parseFloat(style.paddingRight),
              marginLeft: Number.parseFloat(style.marginLeft), marginRight: Number.parseFloat(style.marginRight),
              borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
              borderRightWidth: Number.parseFloat(style.borderRightWidth),
              borderTopWidth: Number.parseFloat(style.borderTopWidth),
              borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
              backgroundColor: style.backgroundColor,
            }
          }
          const panel = document.querySelector('.crwu-audit-tab-panel')
          return {
            shell: rect('.crwu-audit-root'), paper: rect('.crwu-audit-page-paper'),
            paperStyle: styles('.crwu-audit-page-paper'), body: rect('.crwu-valuation-intake-body'),
            bodyStyle: styles('.crwu-valuation-intake-body'), footer: rect('.crwu-valuation-actionbar'),
            footerStyle: styles('.crwu-valuation-actionbar'),
            panelOverflow: panel === null ? 0 : panel.scrollHeight - panel.clientHeight,
            rootOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          }
        })

        // The valuation paper carries **no padding of its own**: the workface body and its footer own
        // the insets, which is what lets the footer band close against the paper's own edges.
        checks.that(`valuation shell ${tag}: valuation paper adds no padding of its own`,
          geometry.paperStyle !== null && geometry.paperStyle.paddingTop === 0
            && geometry.paperStyle.paddingBottom === 0
            && geometry.paperStyle.paddingLeft === 0 && geometry.paperStyle.paddingRight === 0,
          geometry.paperStyle)
        checks.that(`valuation shell ${tag}: intake body keeps >= 20px bottom inset`,
          geometry.bodyStyle !== null && geometry.bodyStyle.paddingBottom >= 20, geometry.bodyStyle)
        checks.that(`valuation shell ${tag}: footer band and body surface stay distinct`,
          geometry.footerStyle !== null && geometry.bodyStyle !== null
            && geometry.footerStyle.backgroundColor !== geometry.bodyStyle.backgroundColor,
          { footer: geometry.footerStyle?.backgroundColor, body: geometry.bodyStyle?.backgroundColor })
        checks.that(`valuation shell ${tag}: outer tab panel does not scroll vertically`,
          geometry.panelOverflow <= 1 && geometry.rootOverflow <= 1,
          { panel: geometry.panelOverflow, root: geometry.rootOverflow })

        const bodyOverflow = await page.evaluate(() => {
          const element = document.querySelector('.crwu-valuation-intake-body')
          return element === null ? -1 : element.scrollHeight - element.clientHeight
        })
        checks.that(`valuation shell ${tag}: only the intake body owns vertical overflow`,
          bodyOverflow > 0, bodyOverflow)

        const scrollbar = await page.locator('.crwu-valuation-intake-body').evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            standardWidth: style.scrollbarWidth, standardColor: style.scrollbarColor,
            webkitWidth: getComputedStyle(element, '::-webkit-scrollbar').width,
            webkitThumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
          }
        })
        const thin = scrollbar.standardWidth === 'thin'
          || (Number.parseFloat(scrollbar.webkitWidth) > 0 && Number.parseFloat(scrollbar.webkitWidth) <= 8)
        const themed = (scrollbar.standardColor !== '' && scrollbar.standardColor !== 'auto')
          || (scrollbar.webkitThumb !== '' && scrollbar.webkitThumb !== 'transparent'
            && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(scrollbar.webkitThumb))
        checks.that(`valuation shell ${tag}: intake scrollbar is thin and themed`, thin && themed, scrollbar)

        const footer = geometry.footer
        // The footer is a **fixed band**: its own opaque surface + a full-bleed top edge, so it does
        // not read as the last paragraph of the scrolling body (2026-10-16 user call).
        const opaqueBand = geometry.footerStyle !== null
          && geometry.footerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
          && geometry.footerStyle.backgroundColor !== 'transparent'
        checks.that(`valuation shell ${tag}: footer is an opaque band with its own edges`,
          opaqueBand && geometry.footerStyle.paddingLeft >= 16 && geometry.footerStyle.paddingRight >= 16
            && geometry.footerStyle.borderTopWidth >= 1
            && geometry.footerStyle.borderLeftWidth === 0 && geometry.footerStyle.borderRightWidth === 0
            && geometry.footerStyle.borderBottomWidth === 0, geometry.footerStyle)
        checks.that(`valuation shell ${tag}: footer stays inside the shell`,
          footer !== null && footer.left >= geometry.shell.left - 1 && footer.right <= geometry.shell.right + 1)
        // The band must reach the paper's own bottom edge: paper padding left below it shows up as a
        // white line under the band (2026-10-16 user feedback: "why is the white line not closed").
        // Inline it either fills the paper (the workface is `max-width: 1120px`, so it centers with
        // equal gutters on a wider paper) but it must never spill outside the paper.
        const paperInner = geometry.paper === null ? null : {
          left: geometry.paper.left + geometry.paperStyle.borderLeftWidth,
          right: geometry.paper.right - geometry.paperStyle.borderRightWidth,
          bottom: geometry.paper.bottom - geometry.paperStyle.borderBottomWidth,
        }
        const inlineBalanced = footer !== null && paperInner !== null
          && Math.abs((footer.left - paperInner.left) - (paperInner.right - footer.right)) <= 1
        checks.that(`valuation shell ${tag}: footer band closes against the paper's bottom edge`,
          footer !== null && paperInner !== null && Math.abs(footer.bottom - paperInner.bottom) <= 1
            && footer.left >= paperInner.left - 1 && footer.right <= paperInner.right + 1 && inlineBalanced,
          { footer, paperInner })

        // `getBoundingClientRect()` already reflects `margin-inline`; only the padding is added.
        const bodyInsetLeft = geometry.body.left + geometry.bodyStyle.paddingLeft
        const bodyInsetRight = geometry.body.right - geometry.bodyStyle.paddingRight
        const footerInsetLeft = footer.left + geometry.footerStyle.paddingLeft
        const footerInsetRight = footer.right - geometry.footerStyle.paddingRight
        checks.that(`valuation shell ${tag}: body and footer content share one inset`,
          Math.abs(bodyInsetLeft - footerInsetLeft) <= 1 && Math.abs(bodyInsetRight - footerInsetRight) <= 1,
          { bodyInsetLeft, bodyInsetRight, footerInsetLeft, footerInsetRight })

        // Capability summary + directly visible actions, then the details disclosure.
        checks.that(`valuation shell ${tag}: capability summary and actions are visible`,
          await page.locator('.crwu-valuation-auth [data-valuation-capability-summary="true"]:visible').count() === 1
            && await page.locator('.crwu-valuation-auth [data-valuation-capability-action]:visible').count() >= 1)

        const preflightBefore = await page.evaluate(() => window.fixtureCalls.preflight)
        checks.that(`valuation shell ${tag}: no automatic preflight before any click`, preflightBefore === 0)
        const directRecheck = page.locator('.crwu-valuation-auth [data-valuation-capability-action="recheck"]:visible').first()
        const directCount = await directRecheck.count()
        checks.that(`valuation shell ${tag}: recheck is available without opening details`, directCount >= 1)
        if (directCount >= 1) {
          await directRecheck.click()
          await page.waitForTimeout(140)
        }
        checks.that(`valuation shell ${tag}: recheck without opening details posts one preflight`,
          directCount >= 1 && await page.evaluate(() => window.fixtureCalls.preflight) === preflightBefore + 1,
          { before: preflightBefore })

        const disclosure = page.locator('.crwu-valuation-auth button[aria-expanded]').first()
        const disclosureCount = await disclosure.count()
        const detailsId = disclosureCount === 1 ? await disclosure.getAttribute('aria-controls') : null
        const region = page.locator(detailsId === null ? '[id="__missing__"]' : `[id="${detailsId}"]`)
        const regionCount = await region.count()
        checks.that(`valuation shell ${tag}: disclosure starts collapsed with a unique region`,
          disclosureCount === 1 && await disclosure.getAttribute('aria-expanded') === 'false'
            && detailsId !== null && detailsId !== '' && regionCount === 1,
          { disclosureCount, detailsId, regionCount })
        const closedFocusable = regionCount === 1
          ? await region.evaluate((element) => {
            if (element.hidden === true || getComputedStyle(element).display === 'none') return false
            return Array.from(element.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
              .some((item) => (item.checkVisibility ? item.checkVisibility() : item.offsetParent !== null))
          })
          : true
        checks.that(`valuation shell ${tag}: closed details region is not focusable`,
          regionCount === 1 && await region.isVisible() === false && closedFocusable === false)
        if (disclosureCount === 1) {
          await disclosure.click()
          await page.waitForTimeout(180)
        }
        checks.that(`valuation shell ${tag}: disclosure toggles aria and reveals its own region`,
          disclosureCount === 1 && await disclosure.getAttribute('aria-expanded') === 'true'
            && await region.isVisible())

        // Scroll the only scrolling box to the last auxiliary detail and clear the footer.
        await page.evaluate(() => {
          const element = document.querySelector('.crwu-valuation-intake-body')
          if (element !== null) element.scrollTop = element.scrollHeight
        })
        await page.waitForTimeout(140)
        const clearance = await page.evaluate(() => {
          const element = document.querySelector('.crwu-valuation-intake-body')
          const footerElement = document.querySelector('.crwu-valuation-actionbar')
          const last = element === null ? null : element.lastElementChild
          return {
            footerTop: footerElement === null ? 0 : footerElement.getBoundingClientRect().top,
            bodyBottom: element === null ? 0 : element.getBoundingClientRect().bottom,
            lastBottom: last === null ? null : last.getBoundingClientRect().bottom,
          }
        })
        checks.that(`valuation shell ${tag}: last auxiliary content clears the footer`,
          clearance.lastBottom === null || clearance.lastBottom <= clearance.footerTop + 1, clearance)
        checks.that(`valuation shell ${tag}: footer sits directly under the scrolling body`,
          Math.abs(clearance.footerTop - clearance.bodyBottom) <= 1, clearance)

        if (width === 1024) {
          await page.screenshot({ path: join(outDir, `valuation-shell-${theme}-expanded.png`) })
          await page.locator('.crwu-valuation-actionbar').screenshot({ path: join(outDir, `valuation-footer-${theme}.png`) })
        }
      }
    }
    // ── Audit navigation + search geometry ───────────────────────────────────
    // Screenshot-feedback polish, test-first: the red set below is intentional and must
    // stay red until the audit navigation flattens and the shared search inset lands.
    for (const dark of [false, true]) {
      for (const width of [375, 500, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 700 })
        await goto('audit.html')
        if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
        await page.waitForTimeout(160)
        const theme = dark ? 'dark' : 'light'
        const tag = `audit shell ${theme} ${width}`

        // Production change: one primary row (报告审核 / 本地审核); no 审核 parent row,
        // no secondary pill row, and the leaves use the existing underlined tab classes.
        const nav = page.locator('.crwu-audit-nav')
        const navLists = nav.locator('[role="tablist"]')
        const navTabs = nav.locator('[role="tab"]')
        const listCount = await navLists.count()
        checks.that(`${tag}: audit keeps one primary navigation row`, listCount === 1, listCount)
        const navLabels = (await navTabs.allInnerTexts()).map((text) => text.trim())
        checks.that(`${tag}: audit row is only 报告审核/本地审核`,
          navLabels.join('|') === '报告审核|本地审核', navLabels)
        checks.that(`${tag}: redundant 审核 parent tab is gone`,
          await nav.getByRole('tab', { name: '审核', exact: true }).count() === 0)
        checks.that(`${tag}: secondary pill row is gone`,
          await nav.locator('.crwu-audit-nav-children').count() === 0)
        const tabClasses = await navTabs.evaluateAll((elements) => elements.map((element) => element.className))
        checks.that(`${tag}: leaf tabs use the primary underlined style`,
          tabClasses.length === 2
            && tabClasses.every((className) => className.split(/\s+/).includes('crwu-audit-tab')), tabClasses)
        checks.that(`${tag}: exactly one leaf tab is underlined-on and none is a pill`,
          tabClasses.filter((className) => className.split(/\s+/).includes('crwu-audit-tab-on')).length === 1
            && tabClasses.every((className) => !className.split(/\s+/).includes('crwu-audit-nav-child')),
          tabClasses)

        // Click + keyboard + ARIA: the real handlers move selection and the shared tabpanel
        // keeps pointing at the selected leaf tab id.
        const reportTab = nav.getByRole('tab', { name: '报告审核', exact: true })
        const localTab = nav.getByRole('tab', { name: '本地审核', exact: true })
        await localTab.click()
        await page.waitForTimeout(140)
        checks.that(`${tag}: clicking 本地审核 selects it and renders the local pane`,
          await localTab.getAttribute('aria-selected') === 'true'
            && await page.locator('.crwu-audit-local').count() >= 1
            && await page.locator('.crwu-audit-list-area').count() === 0)
        const localPanel = page.locator('.crwu-audit-tab-panel')
        checks.that(`${tag}: tabpanel aria-labelledby follows the selected leaf tab`,
          await localPanel.getAttribute('aria-labelledby') === await localTab.getAttribute('id'))
        await localTab.focus()
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(140)
        checks.that(`${tag}: ArrowRight moves selection to 报告审核`,
          await reportTab.getAttribute('aria-selected') === 'true')
        await page.keyboard.press('ArrowLeft')
        await page.waitForTimeout(140)
        checks.that(`${tag}: ArrowLeft returns to 本地审核`,
          await localTab.getAttribute('aria-selected') === 'true')
        await page.keyboard.press('Home')
        await page.waitForTimeout(140)
        checks.that(`${tag}: Home reaches the first leaf tab`,
          await reportTab.getAttribute('aria-selected') === 'true')
        await page.keyboard.press('End')
        await page.waitForTimeout(140)
        checks.that(`${tag}: End reaches the last leaf tab`,
          await localTab.getAttribute('aria-selected') === 'true')
        await reportTab.click()
        await page.waitForTimeout(140)
        checks.that(`${tag}: clicking 报告审核 restores the list`,
          await reportTab.getAttribute('aria-selected') === 'true'
            && await page.locator('.crwu-audit-list-area').count() === 1)

        // No horizontal page overflow; a wide table may scroll inside its own wrapper.
        const overflow = await page.evaluate(() => {
          const panel = document.querySelector('.crwu-audit-tab-panel')
          const root = document.scrollingElement ?? document.documentElement
          return {
            panel: panel === null ? 0 : panel.scrollWidth - panel.clientWidth,
            page: root.scrollWidth - root.clientWidth,
          }
        })
        checks.that(`${tag}: no horizontal overflow`, overflow.panel <= 1 && overflow.page <= 1, overflow)

        // Row action column: the whale / ••• stay square with their intrinsic glyph ratio; a narrow
        // table scrolls in its wrap instead of squeezing the hit areas.
        checks.that(`${tag}: fixture keeps one formal-report row and one no-cloud row`,
          await page.locator('.crwu-audit-tbody-row').filter({ hasText: '查看报告' }).count() >= 1
            && await page.locator('.crwu-audit-tbody-row').filter({ hasText: 'AI 审核' }).count() >= 1)
        const rowIcons = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.crwu-audit-row-actions .crwu-ui-icon-btn')).map((element) => {
            const rect = element.getBoundingClientRect()
            const svg = element.querySelector('svg')
            const svgRect = svg === null ? null : svg.getBoundingClientRect()
            return {
              width: rect.width, height: rect.height, left: rect.left, top: rect.top,
              svg: svgRect === null ? null : { width: svgRect.width, height: svgRect.height, left: svgRect.left, top: svgRect.top },
            }
          }))
        checks.that(`${tag}: row icon buttons are square (32 desktop / 44 coarse)`,
          rowIcons.length >= 3
            && rowIcons.every((item) => Math.abs(item.width - item.height) <= 1
              && (Math.abs(item.width - 32) <= 1 || Math.abs(item.width - 44) <= 1)), rowIcons)
        const whaleIcons = rowIcons.filter((item) => item.svg !== null)
        checks.that(`${tag}: whale SVG keeps the intrinsic 23.16:17.04 ratio and centers`,
          whaleIcons.length >= 1 && whaleIcons.every((item) => Math.abs(item.svg.width - 18) <= 0.5
            && Math.abs(item.svg.height - 13.24) <= 0.5
            && Math.abs((item.svg.left + item.svg.width / 2) - (item.left + item.width / 2)) <= 1
            && Math.abs((item.svg.top + item.svg.height / 2) - (item.top + item.height / 2)) <= 1),
          whaleIcons)
        const lastAction = await page.evaluate(() => {
          const wrap = document.querySelector('.crwu-audit-table-wrap')
          const formal = Array.from(document.querySelectorAll('.crwu-audit-tbody-row'))
            .find((row) => row.textContent !== null && row.textContent.includes('查看报告'))
          if (wrap === null || formal === undefined) return null
          wrap.scrollLeft = wrap.scrollWidth
          const wrapRect = wrap.getBoundingClientRect()
          const buttons = Array.from(formal.querySelectorAll('.crwu-audit-td-action .crwu-ui-btn'))
          if (buttons.length === 0) return null
          const last = buttons[buttons.length - 1]
          const rect = last.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            inside: rect.left >= wrapRect.left - 1 && rect.right <= wrapRect.right + 1,
            hitSelf: hit !== null && (hit === last || last.contains(hit)),
            last: { left: rect.left, right: rect.right, width: rect.width, height: rect.height },
            wrap: { left: wrapRect.left, right: wrapRect.right },
          }
        })
        checks.that(`${tag}: last row action is reachable after scrolling the table to the end`,
          lastAction !== null && lastAction.inside && lastAction.hitSelf, lastAction)

        // Search geometry: real SVG inset, real glyph-to-text gap, aligned field/refresh heights.
        const input = page.getByPlaceholder('输入报告流水号')
        const inputCount = await input.count()
        const geometry = inputCount === 1 ? await input.evaluate((element) => {
          const wrap = element.closest('.crwu-ui-input-wrap')
          if (wrap === null) return null
          const svg = wrap.querySelector('svg')
          const field = wrap.getBoundingClientRect()
          const glyph = svg === null ? null : svg.getBoundingClientRect()
          const style = getComputedStyle(element)
          const refresh = document.querySelector('.crwu-audit-search-action button')
          return {
            field: { left: field.left, right: field.right, top: field.top, bottom: field.bottom, height: field.height },
            glyph: glyph === null ? null : { left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom },
            glyphCenter: glyph === null ? null : glyph.top + glyph.height / 2,
            fieldCenter: field.top + field.height / 2,
            textOrigin: element.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft),
            inputBorder: Number.parseFloat(style.borderLeftWidth),
            refreshHeight: refresh === null ? null : refresh.getBoundingClientRect().height,
          }
        }) : null
        checks.that(`${tag}: search field renders once`, inputCount === 1, inputCount)
        checks.that(`${tag}: start icon inset is 10-14px`,
          geometry !== null && geometry.glyph !== null
            && geometry.glyph.left - geometry.field.left >= 10
            && geometry.glyph.left - geometry.field.left <= 14, geometry)
        checks.that(`${tag}: start icon is vertically centered`,
          geometry !== null && geometry.glyphCenter !== null
            && Math.abs(geometry.glyphCenter - geometry.fieldCenter) <= 1, geometry)
        checks.that(`${tag}: glyph-to-text gap is 6-10px`,
          geometry !== null && geometry.glyph !== null
            && geometry.textOrigin - geometry.glyph.right >= 6
            && geometry.textOrigin - geometry.glyph.right <= 10, geometry)
        checks.that(`${tag}: field and refresh heights match`,
          geometry !== null && geometry.refreshHeight !== null
            && Math.abs(geometry.field.height - geometry.refreshHeight) <= 1, geometry)
        checks.that(`${tag}: the input owns no second border`,
          geometry !== null && geometry.inputBorder === 0, geometry)

        // Focus: one interactive-blue field border, no doubled input border. The border-color has a
        // 120ms transition, so wait for the transition to actually settle instead of sampling at a
        // fixed offset (which would read a mid-transition colour and fail strict equality).
        await input.focus()
        await page.waitForFunction(() => {
          const element = document.querySelector('input[placeholder="输入报告流水号"]')
          const wrap = element === null ? null : element.closest('.crwu-ui-input-wrap')
          if (wrap === null) return false
          const scope = document.querySelector('[data-crwu-scope="workbench"]')
          const token = scope === null ? '' : getComputedStyle(scope).getPropertyValue('--crwu-interactive').trim()
          const probe = document.createElement('span')
          probe.style.color = token
          document.body.appendChild(probe)
          const resolved = getComputedStyle(probe).color
          probe.remove()
          return getComputedStyle(wrap).borderTopColor === resolved
        }, null, { timeout: 2000 }).catch(() => null)
        const focus = await input.evaluate((element) => {
          const wrap = element.closest('.crwu-ui-input-wrap')
          if (wrap === null) return null
          const style = getComputedStyle(wrap)
          const scope = document.querySelector('[data-crwu-scope="workbench"]')
          const token = scope === null ? '' : getComputedStyle(scope).getPropertyValue('--crwu-interactive').trim()
          const probe = document.createElement('span')
          probe.style.color = token
          document.body.appendChild(probe)
          const resolved = getComputedStyle(probe).color
          probe.remove()
          return { border: style.borderTopColor, shadow: style.boxShadow, resolved }
        })
        checks.that(`${tag}: focus draws the interactive border`,
          focus !== null && focus.border === focus.resolved, focus)
        checks.that(`${tag}: focus keeps a single field border`,
          focus !== null && focus.shadow !== 'none', focus)

        // Behavior: typing sends nothing; Enter queries once; refresh is a real callback;
        // clear empties the field without duplicating requests; no AI start is ever sent.
        const pendingCount = () => page.evaluate(() =>
          window.fixtureAuditCalls.filter((call) => call.op === 'pending').length)
        const beforeTyping = await pendingCount()
        await input.fill('LX10170')
        await page.waitForTimeout(200)
        checks.that(`${tag}: typing posts no pending request`,
          await pendingCount() === beforeTyping, await pendingCount())
        await input.press('Enter')
        await page.waitForTimeout(220)
        const afterEnter = await pendingCount()
        checks.that(`${tag}: Enter posts exactly one pending query`,
          afterEnter === beforeTyping + 1, { beforeTyping, afterEnter })
        checks.that(`${tag}: Enter sends the typed serial`,
          await page.evaluate(() => {
            const pending = window.fixtureAuditCalls.filter((call) => call.op === 'pending')
            return pending.length > 0 && pending[pending.length - 1].args.query === 'LX10170'
          }))

        await page.getByRole('button', { name: '刷新', exact: true }).first().click()
        await page.waitForTimeout(220)
        checks.that(`${tag}: refresh is a real pending callback`,
          await pendingCount() === afterEnter + 1, await pendingCount())

        const clearButton = page.locator('.crwu-ui-input-clear')
        const clearVisible = await clearButton.count() === 1 && await clearButton.isVisible()
        const clearInside = clearVisible && geometry !== null
          ? await clearButton.evaluate((element, field) => {
            const rect = element.getBoundingClientRect()
            return rect.left >= field.left - 1 && rect.right <= field.right + 1
          }, geometry.field)
          : false
        checks.that(`${tag}: clear button is visible inside the field`,
          clearVisible && clearInside, { clearVisible, clearInside })
        const beforeClear = await pendingCount()
        if (clearVisible) {
          await clearButton.click()
          await page.waitForTimeout(220)
        }
        checks.that(`${tag}: clear empties the field`,
          clearVisible && await input.inputValue() === '', clearVisible)
        checks.that(`${tag}: clear does not duplicate requests`,
          await pendingCount() <= beforeClear + 1, { beforeClear, after: await pendingCount() })
        checks.that(`${tag}: no audit start request is ever sent`,
          await page.evaluate(() => window.fixtureAuditCalls.filter((call) => call.op === 'audit-start').length) === 0)

        if (width === 1024 || width === 375) {
          await page.screenshot({ path: join(outDir, `audit-shell-${theme}-${width}.png`), fullPage: true })
        }
      }
    }
    // ── Environment page ─────────────────────────────────────────────────────
    // The fixture injects a loud success green; the ready-colour checks fail if any green leaks.
    const isGreen = (value) => {
      const parts = String(value ?? '').match(/[\d.]+/g)
      if (parts === null) return false
      const [red, green, blue] = parts.map(Number)
      return green > red * 1.2 && green > blue * 1.1
    }
    for (const dark of [false, true]) {
      await page.setViewportSize({ width: 1180, height: 900 })
      await goto('environment.html')
      if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await page.waitForTimeout(200)
      const theme = dark ? 'dark' : 'light'
      const info = await page.evaluate(() => {
        const pick = (selector) => {
          const element = document.querySelector(selector)
          if (element === null) return null
          const style = getComputedStyle(element)
          return { color: style.color, bg: style.backgroundColor, border: style.borderLeftColor, shadow: style.boxShadow }
        }
        return {
          mark: pick('.crwu-audit-status-mark-ok'),
          status: pick('.crwu-audit-status-ok'),
          meter: pick('.crwu-audit-meter-fill'),
          badge: pick('.crwu-audit-step-panel .crwu-audit-badge-ok'),
          step: pick('.crwu-audit-step-on'),
          meta: document.querySelector('.crwu-audit-status-meta')?.textContent ?? '',
          main: document.querySelector('.crwu-audit-step-panel')?.textContent ?? '',
          card: pick('.crwu-audit-step-panel .crwu-audit-card'),
        }
      })
      for (const [name, item, prop] of [
        ['ready mark', info.mark, 'color'], ['ready edge', info.status, 'border'],
        ['progress fill', info.meter, 'bg'], ['ready badge', info.badge, 'color'],
      ]) {
        checks.that(`environment ${theme} ${name} uses neutral/blue`, !isGreen(item?.[prop]), item)
      }
      checks.that(`environment ${theme} timestamps use compact numeric format`,
        /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(info.meta) && !/AM|PM/.test(info.meta), info.meta)
      checks.that(`environment ${theme} workspace avoids implementation prose`,
        !/\bcwd\b|subagent|API|crwu 按它/.test(info.main), info.main)
      checks.that(`environment ${theme} step content has no raised nested card`,
        info.card?.shadow === 'none', info.card)
      checks.that(`environment ${theme} step index uses neutral/blue`,
        !isGreen(info.step?.color) && !isGreen(info.step?.bg), info.step)
      // Real computed contrast: the selected step label on its soft-blue fill must stay readable.
      const stepContrast = await elementContrast(
        page, '.crwu-audit-step-on .crwu-audit-step-title', '.crwu-audit-step-on')
      checks.that(`environment ${theme} selected step title contrast >= 4.5`, stepContrast >= 4.5, stepContrast)
      await page.screenshot({ path: join(outDir, `environment-${theme}-overall.png`) })

      // Step selection survives a background re-check (manual choice is not stolen).
      await page.locator('[data-crwu-env-step="ifind"]').click()
      await page.waitForTimeout(120)
      checks.that(`environment ${theme} step selection works`,
        await page.locator('.crwu-audit-step-panel').getAttribute('data-crwu-env-step-panel') === 'ifind')
      await page.getByRole('button', { name: '重新检查', exact: true }).click()
      await page.waitForTimeout(260)
      checks.that(`environment ${theme} manual step survives refresh`,
        await page.locator('.crwu-audit-step-panel').getAttribute('data-crwu-env-step-panel') === 'ifind')

      for (const step of ['accounts', 'oss', 'ifind', 'workspace']) {
        await page.locator(`[data-crwu-env-step="${step}"]`).click()
        await page.waitForTimeout(140)
        checks.that(`environment ${theme} ${step} step renders`,
          await page.locator('.crwu-audit-step-panel').getAttribute('data-crwu-env-step-panel') === step)
        await page.locator('.crwu-audit-step-panel').screenshot({ path: join(outDir, `environment-${theme}-${step}.png`) })
      }
    }

    // Widths: no horizontal overflow, and a 500px panel inside a wide window stacks.
    for (const dark of [false, true]) {
      await goto('environment.html')
      if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      for (const width of [375, 500, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 700 })
        await page.waitForTimeout(120)
        const overflow = await page.locator('.crwu-audit-tab-panel').evaluate((element) => element.scrollWidth - element.clientWidth)
        checks.that(`environment ${dark ? 'dark' : 'light'} ${width} no horizontal overflow`, overflow <= 1, overflow)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(() => {
        const element = document.querySelector('.crwu-audit-tab-panel')
        if (element !== null) element.style.width = '500px'
      })
      await page.waitForTimeout(160)
      const columns = await page.locator('.crwu-audit-workspace').evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length)
      checks.that(`environment ${dark ? 'dark' : 'light'} narrow panel inside wide window stacks`, columns === 1, columns)
    }

    // Blocked state: warning accent, not a blue/green ready wash.
    await page.setViewportSize({ width: 1180, height: 900 })
    await goto('environment.html?state=blocked')
    await page.waitForTimeout(200)
    checks.that('environment blocked state shows the warning summary',
      await page.locator('.crwu-audit-status-bad').count() === 1
        && await page.locator('.crwu-audit-status-ok').count() === 0)
    const blockedTitle = await page.locator('.crwu-audit-status-title').innerText()
    checks.that('environment blocked state does not claim ready',
      !blockedTitle.includes('基础环境已就绪'), blockedTitle)
    await page.screenshot({ path: join(outDir, 'environment-blocked.png') })
  } catch (error) {
    checks.that('script: no unexpected exception', false, String(error?.stack ?? error))
  } finally {
    checks.that('no runtime errors', errors.length === 0, errors)
    if (browser !== null) {
      try { await browser.close() } catch (error) { checks.that('script: browser closed', false, String(error)) }
    }
    if (server !== null) {
      try { await new Promise((done) => { server.close(() => done()) }) } catch (error) {
        checks.that('script: server closed', false, String(error))
      }
    }
    const failed = checks.failed
    const report = {
      checks: checks.results.length,
      passed: checks.results.length - failed.length,
      failed: failed.map((item) => ({ name: item.name, detail: item.detail })),
      errors,
    }
    await writeFile(join(outDir, 'results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ checks: report.checks, passed: report.passed, failed: report.failed.length }, null, 2))
    if (failed.length > 0 || errors.length > 0) process.exitCode = 1
  }
}

await main()
