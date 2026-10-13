/**
 * 插件样式与主题变量的**统一作用域**。
 *
 * ## 为什么需要它
 *
 * 类名前缀（`crwu-audit-`）只做到"命名不撞车"，做不到"规则不越界"：样式全部注入
 * `document.head`，一条 `.crwu-audit-btn { ... }` 会命中**任何**页面里同名的元素。
 * 一个真实的后果是：宿主侧的通用样式会继承到插件控件上（字体、盒模型、颜色），
 * 而插件的规则也能命中宿主元素 —— 两边都说不清是谁改的。
 *
 * 现在每个**独立挂载点**的根节点都带 `data-crwu-scope="workbench"`：
 *
 * - 工作台主面板（`WorkbenchPanel` 根节点）
 * - 侧栏入口（`WorkbenchSidebarEntry`）
 * - 会话头部按钮 / Cordis 运行卡片（`RunCardAction`）
 * - 抽屉、弹窗及其他浮层（它们可能脱离原节点定位）
 *
 * 主题变量定义在这个作用域上（`styles/tokens.ts`），**不**定义在 `.crwu-audit-root`：
 * 那个类还带着高度、布局与溢出规则，小组件（侧栏入口、运行卡片）套上它会被拉成整屏。
 * 主题作用域与面板布局必须是两件事。
 *
 * 也不把变量挪到 `body` / `:root`：那等于让插件去改宿主的全局主题。
 */

/** 承载插件作用域的属性名。 */
export const CRWU_SCOPE_ATTRIBUTE = 'data-crwu-scope'

/** 本插件的作用域名（同一进程里可能有别的插件也用自己的作用域）。 */
export const CRWU_SCOPE_NAME = 'workbench'

/**
 * 挂到每个挂载点根节点上的属性。
 *
 * 写成字面量而不是 `{ [CRWU_SCOPE_ATTRIBUTE]: CRWU_SCOPE_NAME }`：计算键在这里只会得到
 * 索引签名，JSX 展开时类型变宽；有一条测试比对它与上面两个常量一致，不会漂。
 */
export const CRWU_SCOPE_PROPS = { 'data-crwu-scope': 'workbench' } as const

/**
 * 作用域**后代**选择器（给普通规则用的前缀）。
 *
 * 用 `:where()` 而不是直接写属性选择器：`:where()` 的权重是 0，于是
 * `:where([data-crwu-scope="workbench"]) .crwu-audit-btn` 与原来的 `.crwu-audit-btn`
 * 权重完全一样（0,1,0）—— 加作用域不会改变原有层叠关系，也就不需要 `!important`
 * 去和"被作用域抬高了的"规则打架。
 *
 * ⚠️ 它**只匹配后代**。作用域节点自身的规则（`.crwu-audit-root` 与 token 定义）必须
 * 写成 `[data-crwu-scope="workbench"].crwu-audit-root` 这种"作用域在自身上"的形式 ——
 * 见 `scopeAlreadyOnNode()`。
 */
export const CRWU_SCOPE_DESCENDANT = `:where([${CRWU_SCOPE_ATTRIBUTE}="${CRWU_SCOPE_NAME}"])`

/** 作用域在节点自身上的完整选择器（token 与面板根节点规则用）。 */
export const CRWU_SCOPE_NODE = `[${CRWU_SCOPE_ATTRIBUTE}="${CRWU_SCOPE_NAME}"]`

/** 深色主题下作用域内的完整选择器（DSH 把主题结论写在 body 的那个属性上）。 */
export const CRWU_SCOPE_NODE_DARK = `body[data-ds-dark-theme] ${CRWU_SCOPE_NODE}`

/**
 * 这条选择器是不是**已经**被作用域限定过了（token 块与根节点规则）。
 *
 * 打包时的 `scopeCss()` 据此跳过它们：不跳过的话，作用域节点自身的规则会被改写成
 * `:where([…]) .crwu-audit-root` —— 那要求"祖先里有作用域节点"，而它自己就是那个节点，
 * 于是规则永远不命中（这是这类作用域改造最容易踩的坑）。
 */
export function scopeAlreadyOnNode(selector: string): boolean {
  return selector.includes(`${CRWU_SCOPE_ATTRIBUTE}=`)
}
