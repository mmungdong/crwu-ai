/**
 * 样式**作用域限定**（`src/client/styles/scope.ts` / `scope-css.ts`）。
 *
 * 这一份钉住的是 §6 里最容易做错的两条：
 *
 * 1. **每条业务规则都被限定过**：漏掉一条，那条规则就回到"能命中整个宿主页面"；
 * 2. **限定不改变权重**：`:where()` 是 0 权重，所以加作用域前后层叠关系一样 ——
 *    否则就得往后面堆 `!important` 去和"被抬高了的"规则打架。
 *
 * 另外还有几条"改了就会静默坏掉"的：`@keyframes` 块里不是选择器、作用域节点自身的规则
 * 必须写成"作用域在自身上"、`@media` 里要继续限定。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  CRWU_SCOPE_ATTRIBUTE, CRWU_SCOPE_DESCENDANT, CRWU_SCOPE_NAME, CRWU_SCOPE_NODE,
  CRWU_SCOPE_NODE_DARK, CRWU_SCOPE_PROPS, scopeAlreadyOnNode,
} = await import(new URL('src/client/styles/scope.ts', ROOT).href)
const { scopeCss, scopeSelector, splitSelectorList } = await import(
  new URL('src/client/styles/scope-css.ts', ROOT).href)

test('作用域常量一致：属性 / 名字 / JSX 展开的属性对象说的是同一件事', () => {
  assert.equal(CRWU_SCOPE_ATTRIBUTE, 'data-crwu-scope')
  assert.equal(CRWU_SCOPE_NAME, 'workbench')
  assert.deepEqual({ ...CRWU_SCOPE_PROPS }, { 'data-crwu-scope': 'workbench' })
  assert.equal(CRWU_SCOPE_PROPS[CRWU_SCOPE_ATTRIBUTE], CRWU_SCOPE_NAME)
  assert.equal(CRWU_SCOPE_DESCENDANT, ':where([data-crwu-scope="workbench"])')
  assert.equal(CRWU_SCOPE_NODE, '[data-crwu-scope="workbench"]')
  assert.equal(CRWU_SCOPE_NODE_DARK, 'body[data-ds-dark-theme] [data-crwu-scope="workbench"]')
})

test('选择器列表切分：括号 / 引号里的逗号不算分隔符', () => {
  assert.deepEqual(splitSelectorList('.a, .b'), ['.a', '.b'])
  assert.deepEqual(splitSelectorList(':is(.a, .b) .c'), [':is(.a, .b) .c'])
  assert.deepEqual(splitSelectorList('[data-x="a,b"] .c, .d'), ['[data-x="a,b"] .c', '.d'])
  assert.deepEqual(splitSelectorList('  '), [])
})

test('限定不改变权重：前缀用 :where()（0 权重），不是属性选择器', () => {
  // 权重是"加作用域之后还能不能靠原有顺序解决层叠"的判据：
  // 写成 [data-crwu-scope="workbench"] .crwu-audit-btn 会变成 (0,2,0)，
  // 于是原本靠顺序覆盖的变体全部失效，只能靠 !important 找回来。
  assert.equal(scopeSelector('.crwu-audit-btn'), ':where([data-crwu-scope="workbench"]) .crwu-audit-btn')
  assert.equal(scopeSelector('.crwu-audit-btn').includes('[data-crwu-scope="workbench"]:'), false)
})

test('每条选择器都带作用域前缀（漏一条就等于回到全页面生效）', () => {
  const out = scopeCss('.a { color: red; }\n.b, .c { color: blue; }')
  assert.equal(out.includes(':where([data-crwu-scope="workbench"]) .a {'), true)
  assert.equal(out.includes(':where([data-crwu-scope="workbench"]) .b, :where([data-crwu-scope="workbench"]) .c {'), true)
})

test('作用域节点自身的规则原样保留（否则它永远不命中）', () => {
  // `:where([…]) .crwu-audit-root` 要求"祖先里有作用域节点"，而它**自己**就是那个节点。
  const rootRule = '[data-crwu-scope="workbench"].crwu-audit-root { height: 100%; }'
  assert.equal(scopeCss(rootRule), rootRule)
  assert.equal(scopeAlreadyOnNode('.crwu-audit-root'), false)
  assert.equal(scopeAlreadyOnNode('[data-crwu-scope="workbench"].crwu-audit-root'), true)
  assert.equal(scopeAlreadyOnNode('body[data-ds-dark-theme] [data-crwu-scope="workbench"]'), true)
})

test('@keyframes 整块不限定（里面的 from / to / 百分比不是选择器）', () => {
  const css = '@keyframes crwu-audit-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }'
  assert.equal(scopeCss(css), css)
  const vendor = '@-webkit-keyframes crwu-audit-spin { to { opacity: 1; } }'
  assert.equal(scopeCss(vendor), vendor)
})

test('@media / @supports 里继续限定；无块语句与注释原样保留', () => {
  const out = scopeCss('@media (max-width: 860px) { .a { width: 1px; } }')
  assert.equal(out.includes('@media (max-width: 860px) {'), true)
  assert.equal(out.includes(':where([data-crwu-scope="workbench"]) .a {'), true)
  assert.equal(scopeCss('@import "x.css";'), '@import "x.css";')
  assert.equal(scopeCss('/* 说明 */'), '/* 说明 */')
})

test('限定过的样式文本里不残留裸选择器（body/html/:root/button/* 一类）', () => {
  const css = scopeCss('.a { color: red; }\n@keyframes k { to { opacity: 0; } }')
  for (const line of css.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('@') || trimmed.startsWith('}')) continue
    if (trimmed.includes('{')) {
      assert.equal(trimmed.includes(':where([data-crwu-scope="workbench"])'), true, `这条规则没有被限定：${trimmed}`)
    }
  }
})

// ── 作用域落到了哪些挂载点 ───────────────────────────────────────────────────

const { readFileSync } = await import('node:fs')
const { WORKBENCH_STYLE_TEXT, composeWorkbenchStyles, ownedStyleTexts } = await import(
  new URL('src/client/styles/bundle.ts', ROOT).href)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')
/** 剥掉注释：注释里提到某个类名不算"用了那个类"（否则改一句说明就会把测试弄红）。 */
const readCode = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, ' ')

test('每个独立挂载点都带插件作用域（漏一个，那一块就退回"命中整页"）', () => {
  // 四个挂载点 + 浮层：主面板、侧栏（展开态与轨道态）、会话头按钮、Cordis 运行卡片、抽屉。
  const mounts = [
    ['src/client/shell/WorkbenchPanel.tsx', '主面板'],
    ['src/client/shell/WorkbenchSidebarEntry.tsx', '侧栏入口'],
    ['src/client/shell/RunCardAction.tsx', 'Cordis 运行卡片'],
    ['src/client/modules/report-audit/ui/AuditParentButton.tsx', '会话头按钮'],
    ['src/client/ui/SideDrawer.tsx', '抽屉 / 浮层'],
  ]
  for (const [file, what] of mounts) {
    const source = read(file)
    assert.ok(source.includes('CRWU_SCOPE_PROPS'), `${what}（${file}）没有挂插件作用域`)
  }
  // 侧栏有展开 + 轨道两种形态，两个根节点都要带。
  const sidebar = read('src/client/shell/WorkbenchSidebarEntry.tsx')
  assert.ok((sidebar.match(/\{\.\.\.CRWU_SCOPE_PROPS\}/g) ?? []).length >= 2, '侧栏两种形态都要带作用域')
})

test('主题变量定义在作用域节点上，不只在 .crwu-audit-root 上', () => {
  const tokens = ownedStyleTexts().find((item) => item.owner === 'styles/tokens')
  assert.ok(tokens, '找不到 token 所有者')
  // 浅色：作用域节点自身。
  assert.match(tokens.text, /^\[data-crwu-scope="workbench"\] \{/m)
  // 深色：DSH 把主题结论写在 body 的属性上，所以读它 + 作用域节点。
  assert.match(tokens.text, /^body\[data-ds-dark-theme\] \[data-crwu-scope="workbench"\] \{/m)
  // 变量**不许**挪到 body / :root（那等于去改宿主的全局主题）。
  assert.equal(/^:root\s*\{/m.test(WORKBENCH_STYLE_TEXT), false, '不许在 :root 上定义插件变量')
  assert.equal(/^body\s*\{/m.test(WORKBENCH_STYLE_TEXT), false, '不许在裸 body 上定义插件变量')
})

test('面板布局与主题作用域分开：小组件不套 .crwu-audit-root', () => {
  // 侧栏入口 / 运行卡片 / 会话头按钮都只带作用域属性，**不带**面板那个类 ——
  // 那个类还有高度、布局与溢出规则，套上它这些小组件会被拉成整屏。
  for (const file of [
    'src/client/shell/WorkbenchSidebarEntry.tsx',
    'src/client/shell/RunCardAction.tsx',
    'src/client/modules/report-audit/ui/AuditParentButton.tsx',
  ]) {
    assert.equal(readCode(file).includes('crwu-audit-root'), false, `${file} 不该套 .crwu-audit-root`)
  }
})

test('合成后的样式表里没有裸重置规则（body/html/:root/button/input/* 一类）', () => {
  // 这类规则会改到宿主：一条 `button { font: inherit }` 就能把宿主的按钮字体改掉。
  const banned = [
    /(^|\n)\s*body\s*\{/,
    /(^|\n)\s*html\s*\{/,
    /(^|\n)\s*:root\s*\{/,
    /(^|\n)\s*button\s*\{/,
    /(^|\n)\s*input\s*\{/,
    /(^|\n)\s*textarea\s*\{/,
    /(^|\n)\s*\*\s*\{/,
  ]
  for (const pattern of banned) {
    assert.equal(pattern.test(WORKBENCH_STYLE_TEXT), false, `出现了裸重置规则：${String(pattern)}`)
  }
  // 无插件作用域的通用类（.card / .active / .button）同样不许有。
  for (const generic of ['.card', '.active', '.button', '.active-tab']) {
    assert.equal(new RegExp(`(^|\\n)\\.${generic.replace('.', '')}\\s*\\{`).test(WORKBENCH_STYLE_TEXT), false,
      `出现了无作用域的通用类 ${generic}`)
  }
})

test('模块隔离：估值模块的样式只命中估值自己的类', () => {
  const valuation = ownedStyleTexts().find((item) => item.owner.startsWith('modules/report-evaluation'))
  assert.ok(valuation, '找不到估值模块的样式所有者')
  // 它一条审核 / 环境的类都不许出现 —— 改估值不会连带改别的业务的外观。
  for (const foreign of ['crwu-audit-table', 'crwu-audit-local-', 'crwu-audit-env', 'crwu-audit-layer']) {
    assert.equal(valuation.text.includes(foreign), false, `估值样式里出现了别的业务的类：${foreign}`)
  }
})

test('一级 / 二级目录的样式归 shell，不再由本地审核模块提供', () => {
  const localAudit = ownedStyleTexts().find((item) => item.owner === 'modules/local-audit/styles/pane')
  const navigation = ownedStyleTexts().find((item) => item.owner === 'shell/styles/navigation')
  assert.ok(localAudit && navigation, '找不到本地审核 / shell 导航的样式所有者')
  for (const rule of ['.crwu-audit-tablist', '.crwu-audit-tab {', '.crwu-audit-tab-on']) {
    assert.equal(localAudit.text.includes(rule), false, `本地审核模块里不该再有导航规则 ${rule}`)
    assert.ok(navigation.text.includes(rule), `shell 导航里缺少 ${rule}`)
  }
})

test('共享按钮 / 卡片 / 抽屉归共享 UI，业务模块不得重定义它们', () => {
  const shared = ['ui/styles/button', 'ui/styles/card', 'ui/styles/drawer', 'ui/styles/dialog']
  const owners = ownedStyleTexts()
  for (const owner of shared) {
    assert.ok(owners.some((item) => item.owner === owner), `缺少共享 UI 所有者 ${owner}`)
  }
  // 业务模块不得声明共享控件的**裸规则**（主角就是那个共享类）—— 那会改到别的业务的外观。
  // 带祖先组合器的上下文调整（`.crwu-audit-td-action .crwu-audit-btn { margin: … }`）是允许的：
  // 作用域在模块自己的容器里，而且用组合选择器表达变体正是 §6.6 要求的写法。
  const sharedSubjects = ['crwu-audit-btn', 'crwu-audit-card', 'crwu-audit-side-drawer', 'crwu-audit-ghost']
  for (const item of owners.filter((one) => one.owner.startsWith('modules/'))) {
    for (const line of item.text.split('\n')) {
      const selector = line.trim()
      if (!selector.endsWith('{') || selector.startsWith('@') || selector.startsWith('/*')) continue
      for (const part of selector.slice(0, -1).split(',')) {
        const one = part.trim()
        if (one === '') continue
        // 有后代 / 子 / 兄弟组合器 → 上下文调整，不算重定义共享控件本身。
        if (/[\s>+~]/.test(one)) continue
        // 只取主角（去掉伪类 / 伪元素）再比。
        const subject = one.split(':')[0]
        for (const shared of sharedSubjects) {
          assert.notEqual(subject, `.${shared}`, `${item.owner} 用裸规则重定义了共享控件 ${shared}：${one}`)
        }
      }
    }
  }
})

// ── 宿主隔离：插件不许改到插件之外的东西 ─────────────────────────────────────

/** 从合成后的样式里取出所有规则的选择器（跳过 at-rule 与 keyframes 内部）。 */
function selectorsOf(css) {
  const out = []
  // 只取"直接挂在顶层或 @media 里"的选择器行：keyframes 内部的 `from` / `0%` 不是选择器。
  const lines = css.split('\n')
  let inKeyframes = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^@(?:-webkit-)?keyframes/.test(trimmed)) { inKeyframes = true; continue }
    if (inKeyframes) { if (trimmed === '}') inKeyframes = false; continue }
    if (!trimmed.endsWith('{')) continue
    const selector = trimmed.slice(0, -1).trim()
    if (selector === '' || selector.startsWith('@')) continue
    out.push(selector)
  }
  return out
}

test('宿主隔离：每条规则都限定在插件作用域内（插件不可能改到宿主元素）', () => {
  // 作用域是**结构性**保障：宿主元素不在 `[data-crwu-scope="workbench"]` 之内，
  // 所以只要每条选择器都带这个前缀，宿主普通按钮 / 输入框 / 文字就不受插件影响。
  const unscoped = selectorsOf(WORKBENCH_STYLE_TEXT).filter((selector) => !selector.includes('data-crwu-scope'))
  assert.deepEqual(unscoped, [], `这些规则没有作用域限制：\n${unscoped.join('\n')}`)
})

test('宿主隔离：插件规则不靠裸元素选择器命中宿主（button / input / a / p 一类）', () => {
  // 在作用域之内用元素选择器是允许的（例如 `.crwu-x > button`），但**主角**不许是裸元素：
  // 那种写法迟早会被复制到作用域之外，而且它表达的是"页面上所有按钮"，不是"插件里的按钮"。
  const bare = selectorsOf(WORKBENCH_STYLE_TEXT).filter((selector) => selector.split(',').some((one) => {
    const scoped = one.trim().replace(/^:where\(\[data-crwu-scope="workbench"\]\)\s*/, '')
    return /^(button|input|textarea|select|a|p|ul|li|h[1-6]|\*)([.:\s]|$)/.test(scoped)
  }))
  assert.deepEqual(bare, [], `这些规则的主角是裸元素：\n${bare.join('\n')}`)
})

test('宿主隔离：插件不声明全局变量（:root / body 上不许有插件 token）', () => {
  const css = WORKBENCH_STYLE_TEXT
  // `:root { --crwu-* }` 或 `body { --crwu-* }` 都会改到宿主；
  // 允许的形态只有 `body[data-ds-dark-theme] [data-crwu-scope="workbench"]`（主题结论 + 作用域）。
  assert.equal(/(^|\n)\s*:root\s*\{/.test(css), false)
  assert.equal(/(^|\n)\s*body\s*\{[^}]*--crwu-/.test(css), false)
  const darkRule = /body\[data-ds-dark-theme\]\s+([^{]+)\{/.exec(css)
  assert.ok(darkRule, '深色 token 块要在（它读的是宿主写在 body 上的主题结论）')
  assert.match(darkRule[1], /\[data-crwu-scope="workbench"\]/, '深色块也必须限定在插件作用域内')
})

test('插件控件自带盒模型与字体（作用域挡不住宿主**继承**）', () => {
  // 作用域只限制"插件的规则命中谁"，挡不住宿主样式**继承**到插件控件上。所以：
  // ① 作用域节点自己给一个确定的盒模型基线（任何挂载点都不依赖宿主的 box-sizing）；
  // ② 面板那一层显式声明字体 / 字号 / 颜色（不靠继承宿主）；
  // ③ 带 padding + border 的控件显式声明 box-sizing。
  // 作用域节点上可能有多条规则（token 块 + 盒模型基线），找**带 box-sizing 的那一条**。
  const scopeBlocks = [...WORKBENCH_STYLE_TEXT.matchAll(/\[data-crwu-scope="workbench"\] \{([^}]*)\}/g)]
    .map((match) => match[1])
  assert.ok(scopeBlocks.length > 0, '作用域节点要有自己的规则')
  assert.ok(scopeBlocks.some((block) => /box-sizing:\s*border-box/.test(block)),
    '作用域节点要有确定的盒模型基线（任何挂载点都不依赖宿主的 box-sizing）')

  const rootRule = WORKBENCH_STYLE_TEXT.slice(
    WORKBENCH_STYLE_TEXT.indexOf('[data-crwu-scope="workbench"].crwu-audit-root {'),
    WORKBENCH_STYLE_TEXT.indexOf('}', WORKBENCH_STYLE_TEXT.indexOf('[data-crwu-scope="workbench"].crwu-audit-root {')),
  )
  for (const decl of ['font-family:', 'font-size:', 'color:']) {
    assert.ok(rootRule.includes(decl), `面板根节点要显式声明 ${decl}（不靠继承宿主）`)
  }

  for (const selector of [
    ':where([data-crwu-scope="workbench"]) .crwu-valuation-btn {',
    ':where([data-crwu-scope="workbench"]) .crwu-audit-btn {',
  ]) {
    const index = WORKBENCH_STYLE_TEXT.indexOf(selector)
    assert.ok(index >= 0, `找不到 ${selector}`)
    const block = WORKBENCH_STYLE_TEXT.slice(index, WORKBENCH_STYLE_TEXT.indexOf('}', index))
    assert.match(block, /box-sizing:\s*border-box/, `${selector} 要显式声明盒模型`)
  }
})

/**
 * 挂载点根节点**自己的**类，规则必须写成"作用域在自身上"。
 *
 * 这是本轮被真实用户发现的那一类 bug：`{...CRWU_SCOPE_PROPS}` 与组件的样式类挂在
 * **同一个元素**上，而 `scopeCss()` 给裸选择器加的是**后代**前缀 ——
 * `.crwu-audit-side-card` 于是变成 `:where([…]) .crwu-audit-side-card`，
 * 要求"祖先里有作用域节点"，而它自己就是那个节点 → 规则**永远不命中**，
 * 侧栏那张分组卡直接掉样式（背景、圆角、内边距全没）。
 *
 * 这里不硬编码类名清单：从源码里把"和作用域属性写在同一处 JSX 上的类"抠出来，
 * 再去合成后的样式表里逐条核对。新增挂载点时这条断言自动跟着管。
 */
test('挂载点根节点自身的类，规则必须是"作用域在自身上"（后代形式永远不命中）', () => {
  const consts = new Map()
  for (const file of ['src/client/shell/consts.ts']) {
    const source = read(file)
    for (const match of source.matchAll(/^\s{2}(\w+):\s*'([\w-]+)'/gm)) {
      consts.set(match[1], match[2])
    }
  }
  assert.ok(consts.size > 50, `常量表没读出来（${String(consts.size)} 条）`)

  const mounts = [
    'src/client/shell/WorkbenchPanel.tsx',
    'src/client/shell/WorkbenchSidebarEntry.tsx',
    'src/client/ui/SideDrawer.tsx',
    'src/client/modules/report-audit/ui/AuditParentButton.tsx',
  ]
  const selfClasses = new Set()
  for (const file of mounts) {
    const source = read(file)
    for (const hit of source.matchAll(/\{\.\.\.CRWU_SCOPE_PROPS\}/g)) {
      // 同一个 JSX 元素里，作用域属性之后直到下一个 `>` 之间的类引用。
      const window = source.slice(hit.index, hit.index + 420).split('\n\n')[0]
      const head = window.slice(0, window.indexOf('>') < 0 ? window.length : window.indexOf('>'))
      for (const ref of head.matchAll(/\bC\.(\w+)/g)) {
        const cls = consts.get(ref[1])
        if (cls !== undefined) selfClasses.add(cls)
      }
      for (const literal of head.matchAll(/'([\w-]*crwu-audit-[\w-]+)'/g)) selfClasses.add(literal[1])
    }
  }
  assert.ok(selfClasses.size >= 4, `没抠出挂载点自身的类（${String(selfClasses.size)} 个）：${[...selfClasses].join('、')}`)

  const css = composeWorkbenchStyles()
  const broken = []
  for (const cls of selfClasses) {
    const rules = [...css.matchAll(new RegExp(`[^\\n{}]*\\.${cls}(?![\\w-])[^\\n{}]*\\{`, 'g'))]
      .map((match) => match[0].split('*/').pop().trim())
    for (const rule of rules) {
      // 后代前缀 + 类名 → 不命中自身。正确写法是 `<作用域节点>.类名` 或 `X.类名` 起头。
      const selectorText = rule.slice(0, rule.lastIndexOf('{')).trim()
      for (const one of selectorText.split(',').map((part) => part.trim())) {
        if (one.includes(`.${cls}`) && /^:where\(\[data-crwu-scope/.test(one)
            && !one.includes(`].${cls}`)) {
          broken.push(`${cls} → ${one}`)
        }
      }
    }
  }
  assert.deepEqual(broken, [],
    '这些规则要求"祖先里有作用域节点"，而那个类就在作用域节点自身上 —— 规则永远不命中，'
    + '元素会掉样式。改成 `[data-crwu-scope="workbench"].类名` 形式。')
})
