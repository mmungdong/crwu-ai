import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 从某个目录往上找带 `package.json` 的那一层；最多六层，避免顺着文件系统一路爬。找不到返回空串。
 *
 * 为什么不能写死相对层数：同一份逻辑要同时服务多种加载形态 —— 构建产物 `lib/index.js`
 * （距包根 1 层）、测试直接 import 的源码 `src/host/<域>/*.ts`（距包根 3 层）、
 * 以及更深的分域模块 `src/host/domains/<域>/<子域>/*.ts`（距包根 5 层）。
 * 上限是**有界的**保护，不是布局约定：找到第一个 `package.json` 就停。
 */
export function packageRootFrom(start: string): string {
  let current = start
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}
