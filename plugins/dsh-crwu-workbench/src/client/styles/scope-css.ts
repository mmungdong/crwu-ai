import {
  CRWU_SCOPE_DESCENDANT,
  scopeAlreadyOnNode,
} from './scope.ts'

/**
 * 把一份**未限定作用域**的样式文本包进插件作用域。
 *
 * 为什么不手工给 1800 行 CSS 逐个选择器加前缀：那种改法有两个必然会发生的坏结果 ——
 * ① 漏掉几条（漏掉的那几条就回到"命中整个宿主页面"）；② 以后新增规则时没人记得加。
 * 这里把它变成一条纯函数，于是"每条规则都被限定过"是可断言的。
 *
 * 规则：
 * - 普通规则的选择器列表逐条加 `:where([data-crwu-scope="workbench"]) ` 前缀（后代语义）；
 * - 已经带 `data-crwu-scope=` 的选择器**原样保留**（作用域节点自身的规则与 token 定义，
 *   见 `scopeAlreadyOnNode` 的说明）；
 * - `@media` / `@supports` / `@container` / `@layer` 递归进块内继续限定；
 * - `@keyframes`（含带厂商前缀的写法）与 `@font-face` / `@property` 整块原样保留 ——
 *   它们里面的 `from` / `to` / `50%` 不是选择器，加前缀会直接毁掉动画；
 * - `@import` / `@charset` 这类无块语句原样保留。
 *
 * 限定**不改变权重**：`:where()` 是 0 权重，所以 `:where([…]) .crwu-audit-btn` 与被替换掉的
 * `.crwu-audit-btn` 同为 (0,1,0)。
 */

/** 递归限定时会保留原样的 at-rule（块内不是选择器）。 */
const OPAQUE_AT_RULES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes', 'font-face', 'property', 'counter-style', 'page'])

/** 递归限定时会继续限定块内的 at-rule。 */
const RECURSIVE_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'document'])

/** 取出 `@media (...)` 的 at-rule 名字（小写、去掉 `@`）。 */
function atRuleName(prelude: string): string {
  const match = /^@([a-zA-Z-]+)/.exec(prelude.trim())
  return match === null ? '' : match[1].toLowerCase()
}

/** 在顶层逗号处切分选择器列表（括号 / 方括号 / 引号里的逗号不算）。 */
export function splitSelectorList(selectorList: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const char of selectorList) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** 一条选择器加作用域前缀。 */
export function scopeSelector(selector: string): string {
  const trimmed = selector.trim()
  if (trimmed === '') return trimmed
  if (scopeAlreadyOnNode(trimmed)) return trimmed
  return `${CRWU_SCOPE_DESCENDANT} ${trimmed}`
}

/**
 * 逐字符扫描，按"顶层块"处理。
 *
 * 不引 CSS 解析器：本仓的样式是自己写的、结构规整（没有嵌套 `&`、没有 CSS-in-JS 产物），
 * 一个能数括号与引号的小状态机就够，而且不会有第三方依赖的版本漂移。
 */
export function scopeCss(css: string): string {
  let out = ''
  let index = 0

  while (index < css.length) {
    // ── 顶层：注释、空白、语句 ────────────────────────────────────────────
    const commentStart = css.indexOf('/*', index)
    const braceStart = css.indexOf('{', index)
    const semiStart = css.indexOf(';', index)

    const nextBoundary = [commentStart, braceStart, semiStart]
      .filter((position) => position >= 0)
      .reduce((min, position) => Math.min(min, position), Number.POSITIVE_INFINITY)

    if (nextBoundary === Number.POSITIVE_INFINITY) { out += css.slice(index); break }

    if (nextBoundary === commentStart) {
      const commentEnd = css.indexOf('*/', commentStart + 2)
      const stop = commentEnd < 0 ? css.length : commentEnd + 2
      out += css.slice(index, stop)
      index = stop
      continue
    }

    if (nextBoundary === semiStart) {
      // 无块语句（@import / @charset / 自定义属性声明）：原样。
      out += css.slice(index, semiStart + 1)
      index = semiStart + 1
      continue
    }

    // ── 一条带块的规则 ────────────────────────────────────────────────────
    const prelude = css.slice(index, braceStart)
    const blockEnd = matchBrace(css, braceStart)
    const block = css.slice(braceStart + 1, blockEnd)
    const name = atRuleName(prelude)

    if (name !== '') {
      if (OPAQUE_AT_RULES.has(name)) {
        out += `${prelude}{${block}}`
      } else if (RECURSIVE_AT_RULES.has(name)) {
        out += `${prelude}{${scopeCss(block)}}`
      } else {
        // 不认识的 at-rule：原样搬（宁可少限定一条，也不要猜错结构毁掉它）。
        out += `${prelude}{${block}}`
      }
    } else {
      const scoped = splitSelectorList(prelude).map(scopeSelector).join(', ')
      out += `${scoped} {${block}}`
    }
    index = blockEnd + 1
  }

  return out
}

/** 从 `{` 找到配对的 `}`（跳过注释与字符串里的括号）。 */
function matchBrace(css: string, openIndex: number): number {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index]
    if (quote !== '') {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end < 0 ? css.length : end + 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return css.length
}
