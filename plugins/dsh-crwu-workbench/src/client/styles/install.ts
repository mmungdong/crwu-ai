import { composeWorkbenchStyles, WORKBENCH_STYLE_ID, WORKBENCH_STYLE_OWNER } from './bundle.ts'

/**
 * 样式注入：**单一入口 + 按 document 引用计数 + 内容始终刷新**。
 *
 * 三条要求各对应一个曾经踩过的坑：
 *
 * 1. **单一安装入口**：`apply()` 里只有一处 `ctx.effect(installWorkbenchStyles, …)`，
 *    样式节点的增删都由它拥有。别处再插一个 `<style>` 的话，卸载时没人认领那一份。
 * 2. **重复安装不产生第二个节点**：以 `WORKBENCH_STYLE_ID` 查已有节点，有就复用；
 *    同时接管"上一次实例留下的节点"（开发重载后模块状态重置，DOM 里的节点还在）。
 * 3. **内容始终刷新**：以前查到同 id 节点就直接返回空清理函数 —— 开发重载时样式内容
 *    永远停在第一次注入的那一份，改了 CSS 却看不到变化，只能整个刷新页面。现在无条件
 *    重写 `textContent`（写一次字符串，代价可忽略）。
 *
 * 状态**按 document 记账**：一个实例数只对"它注入的那个 document"有意义。测试会为每条用例
 * 换一个 document 替身，若用模块级单一计数，上一条用例留下的计数会让这一条的清理函数不生效
 *（表面症状是"样式删不掉"）。生产里只有一个 document，等价于模块级计数。
 */

interface StyleDocument {
  getElementById?: (id: string) => unknown
  createElement?: (tag: string) => unknown
  head?: { appendChild?: (node: unknown) => void } | null
}

interface StyleElement {
  id?: string
  textContent?: string
  dataset?: Record<string, string>
  parentNode?: { removeChild?: (node: unknown) => void } | null
  remove?: () => void
}

interface Ledger {
  count: number
  element: StyleElement | null
}

/** 每个 document 一份账：活跃实例数 + 本插件认领的样式节点。 */
const LEDGERS = new WeakMap<object, Ledger>()
/** 没有 `document` 时（冒烟替身）退回模块级那一份，行为与旧实现一致。 */
const FALLBACK: Ledger = { count: 0, element: null }

function ledgerOf(doc: StyleDocument | undefined): Ledger {
  if (doc === undefined) return FALLBACK
  const existing = LEDGERS.get(doc)
  if (existing !== undefined) return existing
  const created: Ledger = { count: 0, element: null }
  LEDGERS.set(doc, created)
  return created
}

function documentOf(): StyleDocument | undefined {
  return (globalThis as { document?: StyleDocument }).document
}

/** 认领样式节点：优先 DOM 里同 id 的那一个（开发重载 / 上一次实例留下的），否则新建。 */
function claim(doc: StyleDocument, ledger: Ledger): StyleElement | null {
  const found = doc.getElementById?.(WORKBENCH_STYLE_ID)
  if (found !== null && found !== undefined) {
    ledger.element = found as StyleElement
    return ledger.element
  }
  // 查不到但本账里已经注入过（宿主没有 `head`、或替身 document 不实现节点查找）：
  // 直接复用它，免得每次安装都插出第二份。
  if (ledger.element !== null) return ledger.element
  const created = doc.createElement?.('style')
  if (created === null || created === undefined) return null
  const element = created as StyleElement
  element.id = WORKBENCH_STYLE_ID
  element.dataset = { ...(element.dataset ?? {}), plugin: WORKBENCH_STYLE_OWNER }
  doc.head?.appendChild?.(element)
  ledger.element = element
  return ledger.element
}

function release(element: StyleElement): void {
  if (typeof element.remove === 'function') { element.remove(); return }
  element.parentNode?.removeChild?.(element)
}

/** 安装当前插件自己的样式；返回的清理函数在 Cordis effect 释放时调用。 */
export function installWorkbenchStyles(): () => void {
  const doc = documentOf()
  const ledger = ledgerOf(doc)
  ledger.count += 1
  const element = doc === undefined ? null : claim(doc, ledger)
  if (element !== null) {
    // 无条件重写：开发重载后改了 CSS 也要立刻看到新的那一份。
    element.textContent = composeWorkbenchStyles()
  }

  let released = false
  return () => {
    // 清理函数必须幂等：Cordis 释放与测试直接调用可能都会走到这里。
    if (released) return
    released = true
    ledger.count = Math.max(0, ledger.count - 1)
    if (ledger.count > 0) return
    if (element !== null) release(element)
    if (ledger.element === element) ledger.element = null
  }
}

/** 当前 document 上的活跃实例数（只有测试用得到 —— 生产代码不该按它分支）。 */
export function workbenchStyleInstallCount(): number {
  return ledgerOf(documentOf()).count
}
