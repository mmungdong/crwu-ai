import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 从某个目录往上找带 `package.json` 的那一层；最多四层，避免顺着文件系统一路爬。找不到返回空串。
 *
 * 为什么不能写死相对层数：同一份逻辑要同时服务两种加载形态 —— 构建产物 `lib/index.js`
 * （距包根 1 层）与测试直接 import 的源码 `src/host/<域>/*.ts`（距包根 3 层）。
 */
export function packageRootFrom(start: string): string {
  let current = start
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}
