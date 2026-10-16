/**
 * UI theme token and contrast contract (src/client/styles/tokens.ts / bundle.ts).
 * Reads the exported style composition (not component source), resolves the light/dark token
 * maps, and checks the required colors, real WCAG contrast, brand red, and style ownership.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { CRWU_TOKEN_STYLE_TEXT } = await import(new URL('src/client/styles/tokens.ts', ROOT).href)
const { WORKBENCH_STYLE_TEXT, composeWorkbenchStyles, ownedStyleTexts } = await import(
  new URL('src/client/styles/bundle.ts', ROOT).href)

const LIGHT_HEADER = '[data-crwu-scope="workbench"]'
const DARK_HEADER = 'body[data-ds-dark-theme] [data-crwu-scope="workbench"]'

/** Return the body of a selector block (token blocks have no nested braces). */
function blockOf(css, header) {
  const start = css.indexOf(header)
  assert.notEqual(start, -1, `样式表里缺少 token 块：${header}`)
  const open = css.indexOf('{', start)
  assert.notEqual(open, -1, `token 块没有起始花括号：${header}`)
  const close = css.indexOf('}', open)
  assert.notEqual(close, -1, `token 块没有结束花括号：${header}`)
  return css.slice(open + 1, close)
}

/** Parse `--name: value;` declarations (comments stripped so `--x` in prose is ignored). */
function declarationsOf(body) {
  const map = new Map()
  const text = body.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim())
  }
  return map
}

let maps = null
function tokenMaps() {
  if (maps !== null) return maps
  maps = {
    light: declarationsOf(blockOf(CRWU_TOKEN_STYLE_TEXT, LIGHT_HEADER)),
    dark: declarationsOf(blockOf(CRWU_TOKEN_STYLE_TEXT, DARK_HEADER)),
  }
  return maps
}

const mapFor = (theme) => (theme === 'dark' ? tokenMaps().dark : tokenMaps().light)

// ── colors and contrast ─────────────────────────────────────────────────────

function parseHex(value) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(value).trim())
  if (match === null) return null
  const int = Number.parseInt(match[1], 16)
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff }
}

function linear(channel) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(rgb) {
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
}

/** WCAG relative contrast ratio. */
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function colorOf(map, name, theme) {
  const raw = map.get(name)
  assert.ok(raw !== undefined, `${theme} 主题缺少 token ${name}`)
  const rgb = parseHex(raw)
  assert.ok(rgb !== null, `${theme} 主题的 ${name} 必须是 #RRGGBB，实际：${raw}`)
  return rgb
}

const THEME_LABEL = { light: '浅色', dark: '深色' }

/** Fixed palette values from the approved contract, not "whatever the code currently has". */
const REQUIRED_COLORS = {
  light: {
    '--crwu-primary-bg': '#1668DC',
    '--crwu-primary-text': '#FFFFFF',
    '--crwu-interactive': '#1668DC',
    '--crwu-field-bg': '#FFFFFF',
    '--crwu-field-border': '#8A919E',
  },
  dark: {
    '--crwu-primary-bg': '#286BD6',
    '--crwu-primary-text': '#FFFFFF',
    '--crwu-interactive': '#82B7FF',
    '--crwu-field-bg': '#20242C',
    '--crwu-field-border': '#667285',
  },
}

for (const theme of ['light', 'dark']) {
  test(`${THEME_LABEL[theme]}主题：操作蓝与输入边界 token 取值符合本轮色板`, () => {
    const map = mapFor(theme)
    for (const [name, expected] of Object.entries(REQUIRED_COLORS[theme])) {
      const raw = map.get(name)
      assert.ok(raw !== undefined, `${THEME_LABEL[theme]}主题缺少 token ${name}`)
      assert.equal(raw.toUpperCase(), expected, `${THEME_LABEL[theme]}主题的 ${name} 应为 ${expected}，实际 ${raw}`)
    }
  })
}

for (const theme of ['light', 'dark']) {
  test(`${THEME_LABEL[theme]}主题：正文对比度 ≥ 4.5，必要输入边界对比度 ≥ 3`, () => {
    const map = mapFor(theme)
    const backgrounds = [
      ['--crwu-surface', colorOf(map, '--crwu-surface', theme)],
      ['--crwu-app-bg', colorOf(map, '--crwu-app-bg', theme)],
    ]
    for (const textName of ['--crwu-text-primary', '--crwu-text-secondary']) {
      for (const [bgName, bg] of backgrounds) {
        const ratio = contrast(colorOf(map, textName, theme), bg)
        assert.ok(ratio >= 4.5,
          `${THEME_LABEL[theme]}主题 ${textName} 对 ${bgName} 对比度 ${ratio.toFixed(2)} < 4.5`)
      }
    }
    const fieldRatio = contrast(
      colorOf(map, '--crwu-field-border', theme),
      colorOf(map, '--crwu-field-bg', theme),
    )
    assert.ok(fieldRatio >= 3,
      `${THEME_LABEL[theme]}主题必要输入边界对比度 ${fieldRatio.toFixed(2)} < 3`)
  })
}

test('品牌红保留在 --crwu-brand，不被普通操作蓝替换', () => {
  const raw = mapFor('light').get('--crwu-brand')
  assert.ok(raw !== undefined, '浅色主题必须声明 --crwu-brand')
  const rgb = parseHex(raw)
  assert.ok(rgb !== null, `--crwu-brand 必须是 #RRGGBB，实际：${raw}`)
  assert.equal(rgb.r > rgb.g && rgb.r > rgb.b, true, `--crwu-brand 必须仍是红色主导，实际：${raw}`)
})

// ── ownership and scope (via exported style composition) ────────────────────

test('样式所有权与作用域：token 归 styles/tokens，控件样式各有所有者', () => {
  const owners = ownedStyleTexts()
  assert.ok(owners.some((item) => item.owner === 'styles/tokens'), '缺少 styles/tokens 所有者')
  for (const kind of ['field', 'select', 'date', 'popover']) {
    assert.ok(
      owners.some((item) => item.owner.startsWith('ui/styles/') && item.owner.includes(kind)),
      `缺少共享 ${kind} 样式的所有者（建议 ui/styles/${kind}*.ts）`,
    )
  }
  assert.equal(WORKBENCH_STYLE_TEXT, composeWorkbenchStyles(), '导出的样式必须就是装配结果')
  assert.equal(/(^|\n)\s*:root\s*\{/.test(WORKBENCH_STYLE_TEXT), false, 'token 不许挂到 :root')
  assert.equal(WORKBENCH_STYLE_TEXT.includes(DARK_HEADER), true,
    '深色 token 必须限定在宿主主题属性 + 插件作用域上')
})
