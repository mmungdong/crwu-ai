import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../../../shared/utils/value.ts'
import { packageRootFrom } from '../../../core/platform/package-root.ts'
import type { KnowledgeProbe, KnowledgeProbeResult } from './resolve.ts'
import type { KnowledgeRoute } from './route.ts'

/**
 * 本地参考文件（技能自带 `references/`）的读取与**存在性自检**。
 *
 * 为什么要有自检：路由表把"库内节点 → 本地文件"逐个写死（不能按文件名猜），
 * 于是重命名一个 reference 就会让 fallback **静默失效** —— DSW 不可达时本该降级到本地，
 * 却变成"两边都没有"进而停止估值，而错误信息只会说"缺少业务知识"。
 * `missingLocalReferences()` 把这个失败提前到自检阶段（skill 契约测试会调它）。
 *
 * 读包内文件走 `node:fs`（那是插件自己的安装目录）；案例目录里的**产物**才走 `ctx.fs`。
 */

/** 技能在包内的相对目录。 */
export const VALUATION_SKILL_DIR = join('skills', 'biz', 'crwu-biz-valuation-realestate')

/** 插件包根；解析不到时为空串。 */
export function valuationPackageRoot(): string {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)))
}

/** 某个路由对应的本地参考文件绝对路径；包根解析不到时为空串。 */
export function localReferencePath(route: KnowledgeRoute, root = valuationPackageRoot()): string {
  if (root === '') return ''
  return join(root, ...VALUATION_SKILL_DIR.split(/[\\/]+/), ...route.localReference.split(/[\\/]+/))
}

/** 路由表里**找不到文件**的本地参考（空数组 = 全部就位）。 */
export function missingLocalReferences(routes: readonly KnowledgeRoute[], root = valuationPackageRoot()): string[] {
  if (root === '') return routes.map((route) => route.localReference)
  return routes
    .filter((route) => {
      const path = localReferencePath(route, root)
      return path === '' || !existsSync(path)
    })
    .map((route) => route.localReference)
}

/** 本地参考读取器（注入给 `resolveKnowledgePlan`）。 */
export function localKnowledgeProbe(root = valuationPackageRoot()): KnowledgeProbe['local'] {
  return async (route: KnowledgeRoute): Promise<KnowledgeProbeResult> => {
    const path = localReferencePath(route, root)
    if (path === '') return { found: false, error: '解析不到插件包目录：无法读取技能自带参考文件' }
    if (!existsSync(path)) return { found: false }
    try {
      const body = await readFile(path, 'utf8')
      // 本地文件**没有**"知识库更新时间"这个概念：不拿 mtime 冒充（那会把技能发布时刻
      // 说成规范修订时刻），所以 `updatedAt` 留空。
      return body.trim() === '' ? { found: false } : { found: true, body }
    } catch (error) {
      return { found: false, error: `读取 ${route.localReference} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * 一个"两边都没有"的探针（本地审核 / 单元测试用）。
 *
 * 存在的意义是让"缺知识"这条路径可被显式构造，而不是靠一个不存在的目录去碰运气。
 */
export function emptyKnowledgeProbe(): KnowledgeProbe {
  return {
    dws: () => ({ found: false }),
    local: () => ({ found: false }),
  }
}

/** 本地参考的字节总量（自检/诊断用）。 */
export async function localReferenceBytes(routes: readonly KnowledgeRoute[], root = valuationPackageRoot()): Promise<number> {
  let total = 0
  for (const route of routes) {
    const path = localReferencePath(route, root)
    if (path === '' || !existsSync(path)) continue
    try {
      total += text(await readFile(path, 'utf8')).length
    } catch (error) {
      void error
    }
  }
  return total
}
