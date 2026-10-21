/**
 * Real-source cleanup layout acceptance, using the existing lightweight test renderer.
 * React lifecycle, callbacks, and cleanup safety are covered by the client unit tests.
 * This script checks native layout, disclosure, focus visibility, and scrolling in Chromium.
 * Requires external test-only Playwright and an explicit browser path, on macOS or Windows.
 * Usage: node install/workspace-cleanup-browser-check.mjs --playwright <node_modules>
 *        --browser <executable> --out <new directory>
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerTsxLoader } from '../tests/helpers/tsx-loader.mjs'
import { render } from '../tests/helpers/render.mjs'
import { cleanupUiState } from '../tests/helpers/workspace-cleanup-ui-fixture.mjs'

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1]
for (const name of ['playwright', 'browser', 'out']) {
  assert.ok(process.argv.includes(`--${name}`) && arg(name), `missing --${name}`)
}
const browserPath = resolve(arg('browser'))
const playwrightPath = join(resolve(arg('playwright')), 'playwright-core', 'index.mjs')
assert.ok(existsSync(browserPath), 'browser executable is absent on this platform; supply --browser')
assert.ok(existsSync(playwrightPath), 'Playwright is absent from --playwright; supply its test runtime')
const out = resolve(arg('out'))
await mkdir(out, { recursive: false })
registerTsxLoader()
const { WorkspaceCleanupDialog } = await import('../src/client/modules/environment/ui/WorkspaceCleanupDialog.tsx')
const { WorkspaceCard } = await import('../src/client/shell/WorkspaceCard.tsx')
const { WORKBENCH_STYLE_TEXT } = await import('../src/client/styles/bundle.ts')
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const voids = new Set(['input', 'br', 'hr', 'img'])
function html(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return escape(node)
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node.type !== 'string') return html(node.props.children)
  const attrs = Object.entries(node.props).flatMap(([key, value]) => {
    if (key === 'children' || key === 'ref' || key.startsWith('on') || value === undefined || value === null) return []
    if (key === 'style') {
      const css = Object.entries(value).map(([prop, one]) =>
        `${prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${one}`).join(';')
      return [`style="${escape(css)}"`]
    }
    const name = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex' }[key] ?? key
    if (typeof value === 'boolean' && !key.startsWith('aria-') && !key.startsWith('data-')) return value ? [name] : []
    return [`${name}="${escape(value)}"`]
  }).join(' ')
  return `<${node.type} ${attrs}>${voids.has(node.type) ? '' : `${html(node.props.children)}</${node.type}>`}`
}

const noop = () => {}
const handlers = { onConfirmName: noop, onToggleDeleteSessionLogs: noop, onApply: noop, onRescan: noop, onClose: noop }
const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition, detail })
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`)
}
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  for (const dark of [false, true]) {
    for (const width of [375, 768, 1024, 1440]) {
      for (const kind of ['ready', 'long']) {
        const state = cleanupUiState(kind)
        const card = render(WorkspaceCard, {
          workspace: { chosen: true, path: state.plan.workspace.path, source: 'user' },
          services: {}, busy: false, message: '', collapsed: true,
          onBusy: noop, onMessage: noop, onRefresh: noop,
          cleanup: { allowed: true, reason: '', onOpen: noop },
        }).tree
        const tree = render(WorkspaceCleanupDialog, { state, ...handlers }).tree
        await page.setViewportSize({ width, height: 760 })
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${WORKBENCH_STYLE_TEXT}</style>
          <style>html,body{margin:0;height:100%}[data-crwu-scope]{--dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          --dsw-alias-state-error-primary:var(--crwu-brand);--dsw-alias-state-warn-primary:var(--crwu-brand);
          --dsw-alias-label-primary:var(--crwu-text-primary)}</style></head>
          <body ${dark ? 'data-ds-dark-theme' : ''}><main data-crwu-scope="workbench" class="crwu-audit-root">
          <div class="crwu-audit-tab-panel"><div class="crwu-environment-page"><h2>环境信息</h2>${html(card)}
          ${html(tree)}</div></div></main></body></html>`)
        const name = `${dark ? 'dark' : 'light'}-${width}-${kind}`
        const layout = await page.evaluate(() => {
          const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
          const dialog = document.querySelector('[role="dialog"]')
          const body = document.querySelector('.crwu-environment-cleanup-body')
          const checkbox = rect('input[type="checkbox"]')
          const label = rect('label[for$="-logs"]')
          const footer = rect('.crwu-environment-cleanup-footer')
          const buttons = [...document.querySelectorAll('footer button')].map((node) => node.getBoundingClientRect())
          const box = dialog.getBoundingClientRect()
          return {
            fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            overflow: dialog.scrollWidth - dialog.clientWidth,
            bodyOverflow: body.scrollWidth - body.clientWidth,
            aligned: Math.abs(checkbox.top - label.top) <= 3 && label.left > checkbox.right,
            separated: buttons.every((one, index) => index === 0 || one.left >= buttons[index - 1].right + 6),
            footerVisible: footer.bottom <= box.bottom && footer.top >= box.top,
            colorScheme: getComputedStyle(dialog).colorScheme,
            keep: document.querySelector('[data-crwu-cleanup-keep]').textContent,
          }
        })
        check(`${name} fits viewport`, layout.fits && layout.footerVisible, layout)
        check(`${name} no horizontal overflow`, layout.overflow <= 1 && layout.bodyOverflow <= 1, layout)
        check(`${name} checkbox aligned and actions separated`, layout.aligned && layout.separated, layout)
        check(`${name} native controls follow app theme`, layout.colorScheme === (dark ? 'dark' : 'light'), layout.colorScheme)
        check(`${name} keep description excludes recycle bin`, !layout.keep.includes('回收站'), layout.keep)
        const details = page.locator('details')
        check(`${name} limitations initially collapsed`, await details.getAttribute('open') === null)
        await details.locator('summary').click()
        check(`${name} limitations expand`, await details.getAttribute('open') !== null)
        await details.locator('summary').click()
        await page.locator('.crwu-environment-cleanup-body').evaluate((element) => { element.scrollTop = element.scrollHeight })
        await page.locator('input[type="text"]').focus()
        check(`${name} confirmation stays reachable`, await page.locator('input[type="text"]').isVisible())
        if (kind === 'ready') {
          await page.locator('.crwu-environment-cleanup-body').evaluate((element) => { element.scrollTop = 0 })
          await page.locator('input[type="text"]').blur()
          await page.screenshot({ path: join(out, `cleanup-${name}.png`) })
          if (width === 1024) await page.locator('[role="dialog"]').screenshot({
            path: join(out, `cleanup-${dark ? 'dark' : 'light'}-dialog.png`),
          })
        }
      }
    }
  }
} finally {
  await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2))
  await browser.close()
}
console.log(`workspace-cleanup-browser-check: ${checks.length} checks passed; ${out}`)
