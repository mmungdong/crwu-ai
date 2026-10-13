/**
 * 客户端组件的**极简渲染替身**（共享）。
 *
 * 本仓不引入 react-dom：不需要 diff 算法，只要能把函数组件展开成宿主元素树，
 * 以便对"屏幕上是什么"下断言。这个替身此前长在 `client-package.test.mjs` 内部，
 * 估值页的用例也需要同一套东西 —— 复制一份的后果是两处渲染语义会各自漂移
 *（比如 hook 游标怎么复位），于是同一份组件在两份用例里表现不同。
 *
 * 契约：
 * - `render` 展开函数组件并把实例留在 `globalThis.__crwuTestInstance`；
 * - `rerender` 复用同一实例（保留 state、重置 hook 游标、不重跑 effect），
 *   用来断言"effect 跑完、state 写入之后屏幕上是什么"；
 * - `find` / `findAll` / `textOf` 只认宿主元素与文本，不认识 React 内部结构。
 */
import { fakeReact, registerTsxLoader } from './tsx-loader.mjs'

registerTsxLoader()

export const React = fakeReact

/** 展开函数组件，保留宿主元素形状。 */
export function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
    globalThis.__crwuTestInstance = instance
    try {
      return resolve(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

/** 渲染一个函数组件，返回元素树与它的 hook 状态；实例留在 global 上供 rerender 使用。 */
export function render(component, props = {}) {
  const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
  globalThis.__crwuTestInstance = instance
  return { tree: resolve(component(props)), instance }
}

/** 对**同一实例**重渲染：保留 state、重置 hook 游标、不重跑 effect。 */
export function rerender(component, props = {}) {
  const instance = globalThis.__crwuTestInstance
  if (instance === undefined) throw new Error('rerender 必须在 render() 之后使用')
  instance.cursor = 0
  instance.effects = []
  return resolve(component(props))
}

/** 收集所有命中的节点（前序），用来钉「恰好三行、顺序固定」这种结构断言。 */
export function findAll(node, predicate) {
  const hits = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (predicate(current)) hits.push(current)
    walk(current.props.children)
  }
  walk(node)
  return hits
}

export function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.props.children, predicate)
}

export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props.children)
}
