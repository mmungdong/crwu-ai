import { zhCN } from '../locales/zh-CN.ts'
import { MODULE_META, type ModuleId } from './modules.ts'
import type { EnvironmentRequirement } from '../../shared/environment/model.ts'

/**
 * 工作台的**目录树**（一级 = 业务大类，二级 = 该业务下的功能页面）。
 *
 * ```text
 * 报告评估：一级 [估值·本身就是页面]   （无二级：资产类型在页面里选）
 * 报告审核：一级 [审核]               二级 [报告审核] [本地审核]
 * 环境信息：不在目录树里（外层门禁与修复入口）
 * ```
 *
 * ## 「估值」是一级页，不再是目录
 *
 * 2026-10-15 口径：估值直接打开**通用页面**，取消房地产二级导航 —— 资产类型由用户在下拉里主动选。
 * 所以 `valuation` 自己带 `page`、`children` 为空：`parentNodes` 把「有页面的无子项目录」照常返回，
 * 二级页签那条因为子项为空而整个不画。未实现的资产类型不再占目录位（土地 / 机器设备从目录里删除），
 * 它们由资产类型下拉承载 —— 画一个点不进去的灰标签只会让人以为"这里以后有个入口"。
 *
 * ## 一级目录**分属模块**
 *
 * 以前只有一棵混着的树：进入「报告评估」也能看到一级标签「审核」，两个入口指向同一页，
 * 用户看不出自己现在在哪个模块里。所以每个一级目录声明 `module`，`parentNodes(module)`
 * 只返回**这个模块**的一级目录 —— 评估树里不会出现审核，审核树里也不会出现估值。
 *
 * 这不是"在页面里按字符串过滤"：模块归属写在元数据上，过滤读的是那个字段。
 *
 * ## 没有内容的占位一级目录不显示
 *
 * 「其他业务」是用户点名要有的业务大类，但底下一个已配置的业务项都没有。
 * 没有子项的一级目录**根本不画**（`parentNodes` 只返回至少有 1 个子项的），
 * 而不是画一个点进去说"暂未开放"的空壳。
 *
 * ## 门禁判据只有一个来源
 *
 * 每个页面节点声明 `page`，是否需要环境与严格度**从 `MODULE_META` 派生**
 *（`requiresEnvironmentOf` / `requirementOfNode`）—— 不在这张表里再抄一份布尔量，
 * 否则「导航说能进、门禁说不能进」会再次分叉。
 */

/** 页面指向的实际页面。协议内部仍用这些 id，改标签不改协议。 */
export type PageId =
  | 'valuation'
  | 'report-audit'
  | 'local-audit'

export interface NavigationNode {
  id: string
  /** 页签上的文字。 */
  label: string
  /** 一级目录为 `null`；二级目录是所属一级目录的 id。 */
  parentId: string | null
  /** 这个一级目录属于哪个侧栏模块（只有一级目录声明；二级目录从 `page` 反推）。 */
  module?: ModuleId
  /**
   * 这个节点画哪一页；纯目录（底下挂二级页面）是 `null`。
   *
   * ⚠️ 一级目录**可以**带 `page`（「估值」就是），那时它自己既是目录项也是页面。
   */
  page: PageId | null
  /** `false` = 「开发中」：可显示、不可进入。 */
  enabled: boolean
  /** 一级目录下的二级目录顺序（一级目录才有）。 */
  children?: string[]
  /** 正文顶部那行页面标题；只有已经存在的页面才声明（不编未实现页面的标题）。 */
  title?: string
  /** 页面标题下面那句简短说明（可选）。 */
  lead?: string
  /** 页面标题下面那句更小的说明（可选）。 */
  note?: string
}

/**
 * 一级目录的**固定顺序**，按模块分组。
 *
 * 单独一张表而不是靠对象键顺序：顺序是给用户看的（业务大类从左到右），
 * 而对象键顺序在重构、合并、格式化之后会悄悄变。
 *
 * `env` 没有一级目录：环境信息是外层门禁态，不是目录树里的一页。
 */
export const PARENT_IDS_BY_MODULE: Record<ModuleId, readonly string[]> = {
  eval: ['valuation', 'other'],
  audit: ['audit'],
  env: [],
}

/** 全部一级目录 id（顺序按模块表的声明顺序）。 */
export const PARENT_IDS: readonly string[] = (Object.keys(PARENT_IDS_BY_MODULE) as ModuleId[])
  .flatMap((module) => [...PARENT_IDS_BY_MODULE[module]])

export const NAVIGATION: Record<string, NavigationNode> = {
  // 「估值」= 通用估值页，自己就是页面（不再有二级目录）。
  valuation: {
    id: 'valuation', label: zhCN.navParentValuation, parentId: null, module: 'eval',
    page: 'valuation', enabled: true,
    children: [],
    // No `title`: the tab row already names the page, and the extra large heading below it was the
    // duplicate the user reported (2026-10-16). Other nodes may still declare one.
  },

  audit: {
    id: 'audit', label: zhCN.navParentAudit, parentId: null, module: 'audit', page: null, enabled: true,
    children: ['audit.report', 'audit.local'],
  },
  'audit.report': {
    id: 'audit.report', label: zhCN.navChildReportAudit, parentId: 'audit',
    page: 'report-audit', enabled: true,
  },
  'audit.local': {
    id: 'audit.local', label: zhCN.navChildLocalAudit, parentId: 'audit',
    page: 'local-audit', enabled: true,
  },

  // 其他业务：一级目录**声明了**（用户列表里点名要有），但底下一个业务项都没配置 ——
  // `parentNodes` 只返回有子项的一级目录，所以它现在不画；等这里挂上已配置的业务项，它自己就出现。
  other: {
    id: 'other', label: zhCN.navParentOther, parentId: null, module: 'eval', page: null, enabled: true,
    children: [],
  },
}

/** 某个一级目录下**已配置**的二级目录（顺序按元数据；没有子项的返回空数组）。 */
export function childNodes(parentId: string): NavigationNode[] {
  const parent = NAVIGATION[parentId]
  if (parent?.children === undefined) return []
  return parent.children.map((id) => NAVIGATION[id]).filter((node): node is NavigationNode => node !== undefined)
}

/**
 * 某个模块的一级目录（按 `PARENT_IDS_BY_MODULE` 的顺序）。
 *
 * 出现的条件有两条，满足一条即可：**底下有已配置的二级目录**，或者**它自己就是页面**
 * （「估值」是后者）。只有空目录的「其他业务」两条都不满足，所以不画。
 */
export function parentNodes(module: ModuleId): NavigationNode[] {
  return (PARENT_IDS_BY_MODULE[module] ?? [])
    .map((id) => NAVIGATION[id])
    .filter((node): node is NavigationNode => node !== undefined
      && (childNodes(node.id).length > 0 || node.page !== null))
}

/** 一级目录所属模块；二级目录 / 不认识的 id 返回 `null`。 */
export function moduleOfParent(parentId: string): ModuleId | null {
  const node = NAVIGATION[parentId]
  if (node === undefined || node.parentId !== null) return null
  return node.module ?? null
}

/**
 * 这个一级目录自己就是一个页面（没有二级目录）。
 *
 * 「估值」是唯一一个：点它直接进通用估值页，不再先落一个二级目录。
 */
export function selfPageOf(parentId: string): NavigationNode | null {
  const parent = nodeById(parentId)
  if (parent === null || parent.parentId !== null || parent.page === null || !parent.enabled) return null
  return parent
}

/**
 * 该一级目录下**第一个可用页面** —— 用户点一级目录时默认落到它。
 *
 * 「不记忆上一次的二级页面」是明确口径（用户 2026-10-13）：每次切一级目录都从第一个可用页开始，
 * 所以这里不认识"上次选过谁"。一级目录自己就是页面时（「估值」）返回它自己。
 */
export function firstEnabledChild(parentId: string): NavigationNode | null {
  return childNodes(parentId).find((node) => node.enabled) ?? selfPageOf(parentId)
}

/** 按 id 取节点；不认识的 id 返回 `null`（不许抛、也不许编一个）。 */
export function nodeById(id: string | null): NavigationNode | null {
  if (id === null) return null
  return NAVIGATION[id] ?? null
}

/** 二级目录所属的一级目录；一级目录自己 / 不认识的 id 返回 `null`。 */
export function parentOf(nodeId: string | null): NavigationNode | null {
  const node = nodeById(nodeId)
  if (node === null || node.parentId === null) return null
  return nodeById(node.parentId)
}

/** 页面 → 模块（门禁与环境能力按模块判）。不认识的页面返回 `null`。 */
export function moduleOfPage(page: PageId | null): ModuleId | null {
  if (page === null) return null
  if (page === 'report-audit' || page === 'local-audit') return 'audit'
  if (page === 'valuation') return 'eval'
  return null
}

/**
 * 某个模块的**默认页面**（侧栏那张分组卡上的子项、以及"回到工作台"这类动作走它）。
 *
 * 「报告评估」→ 估值（通用页）；「报告审核」→ 审核 / 报告审核（既有习惯不变：
 * 环境自检通过就直接进报告审核）。找不到时返回 `null`，由调用方如实处理。
 */
export function defaultNodeOfModule(module: ModuleId): NavigationNode | null {
  for (const parent of parentNodes(module)) {
    const node = firstEnabledChild(parent.id)
    if (node !== null) return node
  }
  return null
}

/** 进入这个节点要不要先过环境门禁（派生自模块元数据，不在这张表里再抄一份）。 */
export function requiresEnvironmentOf(node: NavigationNode): boolean {
  const module = moduleOfPage(node.page)
  return module === null ? true : MODULE_META[module].requiresEnvironment === true
}

/** 这个节点需要多严的环境（同上，派生）。 */
export function requirementOfNode(node: NavigationNode): EnvironmentRequirement {
  const module = moduleOfPage(node.page)
  return module === null ? 'global' : MODULE_META[module].requirement
}

/** 键盘左右切换用的节点 id 序列（纯函数，直接测）。 */
export function childIdsOf(parentId: string): string[] {
  return childNodes(parentId).map((node) => node.id)
}

/** 一级目录 id 序列（键盘左右键在**当前模块**的目录条里循环）。 */
export function parentIdList(module: ModuleId): string[] {
  return parentNodes(module).map((node) => node.id)
}

/**
 * 键盘左右键在一条目录条里循环；Home / End 直达两端；别的键不动。
 *
 * 两级目录共用这一条纯规则（一级在 `PARENT_IDS` 里走、二级在"可用的二级目录"里走）：
 * 抄成两份的那天，两级键盘行为就会开始不一样。
 */
export function nextTabKey<T extends string>(current: T, key: string, tabs: readonly T[]): T {
  if (tabs.length === 0) return current
  const index = Math.max(0, tabs.indexOf(current))
  if (key === 'ArrowRight' || key === 'ArrowDown') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return tabs[(index - 1 + tabs.length) % tabs.length]
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  return current
}

/** 二级目录里**可进入**的那些 id（键盘循环要跳过「开发中」的子项）。 */
export function enabledChildIds(parentId: string): string[] {
  return childNodes(parentId).filter((node) => node.enabled).map((node) => node.id)
}

/** 二级目录页签的稳定 id（`aria-labelledby` 指回来）。 */
export function tabIdOf(nodeId: string): string {
  return `crwu-workbench-tab-${nodeId}`
}

/** 一级目录页签的稳定 id。 */
export function parentTabIdOf(parentId: string): string {
  return `crwu-workbench-tab-parent-${parentId}`
}

/** 正文当前落在哪里（`module-store` 快照里与"页面身份"有关的那三个字段）。 */
export interface PanelLocation {
  kind: 'node' | 'env' | 'empty'
  parent: string
  node: string | null
}

/**
 * **页面身份**：内容区外壳是**不重建**的同一个元素（切换目录时宽度与高度都不能抖），
 * 所以它的 `scrollTop` 会原样留到下一页 —— 用户切过去就落在半空中。
 *
 * 判据放在这里而不是组件里：这样"什么算换了一页"是纯函数、可直接断言
 *（组件那一侧只剩"身份变了就把 scrollTop 归零"这一句动作）。
 * 一级目录**不算**身份变化：切一级目录时二级目录会被同时换成新页，那是新身份。
 */
export function pageIdentityOf(location: PanelLocation): string {
  if (location.kind === 'node') return `node:${location.node ?? ''}`
  return `${location.kind}:${location.parent}`
}

/** 唯一的 tabpanel 元素 id：所有页签的 `aria-controls` 都指向它（它始终真实存在）。 */
export const TAB_PANEL_ID = 'crwu-workbench-tabpanel'
