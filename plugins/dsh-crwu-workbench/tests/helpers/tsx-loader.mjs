/**
 * 让 `node --test` 能直接加载 `src/**\/*.tsx`。
 *
 * 为什么需要它：Node 22.19+/24 原生**剥离类型**，但不转换 JSX，所以 `import ... from
 * '../features/workbench/WorkbenchPanel.tsx'` 会直接语法报错。本仓因此长期只能靠
 * 别的形态的注入式渲染器间接覆盖包形态 Client —— 而包形态是长期维护的
 * 那一半，不能一直不被直接测。
 *
 * 这里用 `node:module` 的 `registerHooks`（进程内、同步）：
 *   - `.ts`  → 剥离类型
 *   - `.tsx` → 剥离类型 + 转换 JSX（`jsx: ReactJSX`，与 tsconfig 一致）
 *
 * 编辑器里的 `typescript` 已经装在 devDependencies 里，所以不引入 esbuild / vitest 等新框架。
 * 只影响测试进程，不参与交付产物（交付仍由 tsdown 打包）。
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import ts from 'typescript'

const REWRITE = /\.(ts|tsx|mts|cts)$/

/**
 * React 替身：把 `react` 与 `react/jsx-runtime` 都指向它。
 *
 * 用替身而不是真的 React，是为了**不引入 react-dom / jsdom**：本仓要断言的是「面板在什么
 * 状态下渲染出什么」，不是 diff 算法。同一个替身同时供测试文件直接调用（`fakeReact`）。
 */
export const fakeReact = {
  createElement(type, rawProps, ...children) {
    const props = { ...(rawProps || {}) }
    delete props.key
    props.children = children.length <= 1 ? children[0] : children
    return { type, props }
  },
  Fragment: Symbol.for('crwu.test.fragment'),
  useState(initial) {
    const instance = currentInstance()
    const index = instance.cursor++
    if (!(index in instance.state)) instance.state[index] = typeof initial === 'function' ? initial() : initial
    return [instance.state[index], (next) => {
      instance.state[index] = typeof next === 'function' ? next(instance.state[index]) : next
    }]
  },
  useEffect(callback) {
    currentInstance().effects.push({ callback })
  },
  useRef(initial) {
    const instance = currentInstance()
    const index = instance.cursor++
    if (!(index in instance.refs)) instance.refs[index] = { current: initial }
    return instance.refs[index]
  },
  useMemo(factory) {
    currentInstance().cursor += 1
    return factory()
  },
  useCallback(callback) {
    currentInstance().cursor += 1
    return callback
  },
}

/** 当前正在渲染的组件实例；由测试的 render 设置。 */
function currentInstance() {
  const instance = globalThis.__crwuTestInstance
  if (!instance) throw new Error('React 替身只能在 render() 期间调用 hook')
  return instance
}

// 合成模块在求值时从 global 取替身，所以这里必须先挂上。
globalThis.__crwuTestReact = fakeReact

const FAKE_REACT_MODULE = `export default globalThis.__crwuTestReact
export const createElement = globalThis.__crwuTestReact.createElement
export const Fragment = globalThis.__crwuTestReact.Fragment
export const useState = globalThis.__crwuTestReact.useState
export const useEffect = globalThis.__crwuTestReact.useEffect
export const useRef = globalThis.__crwuTestReact.useRef
export const useMemo = globalThis.__crwuTestReact.useMemo
export const useCallback = globalThis.__crwuTestReact.useCallback
`

/** JSX 运行时替身：`jsx`/`jsxs` 直接产出同一个元素形状。 */
const FAKE_JSX_RUNTIME = `const create = (type, props, key) => globalThis.__crwuTestReact.createElement(type, props, ...[])
const jsx = (type, config, key) => {
  const { children, ...rest } = config || {}
  return globalThis.__crwuTestReact.createElement(type, rest, children)
}
export { jsx, jsx as jsxs, jsx as jsxDEV }
export const Fragment = globalThis.__crwuTestReact.Fragment
export default { jsx, jsxs: jsx, Fragment: globalThis.__crwuTestReact.Fragment }
`

let registered = false

/** 幂等注册；测试文件在动态 import src 之前调用一次即可。 */
export function registerTsxLoader() {
  if (registered) return
  registered = true

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 把 react 与 JSX 运行时换成替身；其余（含 node: 内建）原样交给 Node。
      if (specifier === 'react') {
        return { url: 'crwu-test:react', format: 'module', shortCircuit: true }
      }
      if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
        return { url: `crwu-test:${specifier}`, format: 'module', shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'crwu-test:react') {
        return { format: 'module', shortCircuit: true, source: FAKE_REACT_MODULE }
      }
      if (url.startsWith('crwu-test:react/')) {
        return { format: 'module', shortCircuit: true, source: FAKE_JSX_RUNTIME }
      }
      if (!url.startsWith('file:')) return nextLoad(url, context)
      // **必须用 `fileURLToPath`，不能用 `new URL(url).pathname`**：Windows 上 `file:` URL 的
      // pathname 是 `/C:/Users/…`（带前导斜杠、正斜杠），拿它去 `readFileSync` 直接 ENOENT ——
      // CI 的 windows 上整个 `client-package.test.mjs` 加载失败（411−340 = 71 条一条没跑）
      // 就是这个原因，而 macOS / Linux 上永远看不到。
      const filename = fileURLToPath(url)
      if (!REWRITE.test(filename)) return nextLoad(url, context)
      const source = readFileSync(filename, 'utf8')
      const transpiled = ts.transpileModule(source, {
        fileName: filename.endsWith('.tsx') ? 'module.tsx' : 'module.ts',
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          // 源码是给 tsdown/tsc 看的，测试只要能跑：类型由 typecheck 负责把关。
          isolatedModules: true,
          esModuleInterop: true,
          sourceMap: true,
          inlineSources: true,
        },
      })
      return {
        format: 'module',
        shortCircuit: true,
        source: transpiled.outputText,
      }
    },
  })
}

/** 供测试断言用的错误信息清理（栈里可能带颜色/绝对路径噪音）。 */
export function tidy(message) {
  return stripVTControlCharacters(String(message))
}
