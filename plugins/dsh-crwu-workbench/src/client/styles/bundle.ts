import { CRWU_BASE_STYLE_TEXT } from './base.ts'
import { CRWU_TOKEN_STYLE_TEXT } from './tokens.ts'
import { scopeCss } from './scope-css.ts'
import { CRWU_BUTTON_STYLE_TEXT } from '../ui/styles/button.ts'
import { CRWU_CARD_STYLE_TEXT } from '../ui/styles/card.ts'
import { CRWU_DIALOG_STYLE_TEXT } from '../ui/styles/dialog.ts'
import { CRWU_DRAWER_STYLE_TEXT } from '../ui/styles/drawer.ts'
import { CRWU_FIELD_STYLE_TEXT } from '../ui/styles/field.ts'
import { CRWU_SELECT_STYLE_TEXT } from '../ui/styles/select.ts'
import { CRWU_DATE_PICKER_STYLE_TEXT } from '../ui/styles/date-picker.ts'
import { CRWU_POPOVER_STYLE_TEXT } from '../ui/styles/popover.ts'
import { CRWU_LAYOUT_STYLE_TEXT } from '../shell/styles/layout.ts'
import { CRWU_NAVIGATION_STYLE_TEXT } from '../shell/styles/navigation.ts'
import { CRWU_SIDEBAR_STYLE_TEXT } from '../shell/styles/sidebar.ts'
import { ENVIRONMENT_STYLE_TEXT } from '../modules/environment/styles/pane.ts'
import { WORKSPACE_CLEANUP_STYLE_TEXT } from '../modules/environment/styles/cleanup.ts'
import { LOCAL_AUDIT_STYLE_TEXT } from '../modules/local-audit/styles/pane.ts'
import { REPORT_AUDIT_STYLE_TEXT } from '../modules/report-audit/styles/pane.ts'
import { VALUATION_STYLE_TEXT } from '../modules/report-evaluation/styles/pane.ts'
import { WORKFLOW_STYLE_TEXT } from '../modules/report-evaluation/styles/workflow.ts'
import { UPDATE_STYLE_TEXT } from '../modules/update/styles/pane.ts'

/**
 * 工作台样式表的**唯一装配点**。
 *
 * ## 为什么按"token → 基础 → 共享 UI / shell → 业务模块"分组
 *
 * 分组顺序就是层叠顺序：越靠前越基础，越靠后越具体。这份样式以前是**一个** 1800 行的
 * 模板字符串，长在 `shell/consts.ts` 里 —— 那个文件同时装着设计变量、共享组件样式和五个
 * 业务模块的样式，"这一段属于谁"没有任何强制，改一处要先在两千行里找到它。
 *
 * 现在每份文本跟着它的所有者走（`styles/`、`ui/styles/`、`shell/styles/`、
 * `modules/<模块>/styles/`），这里只声明**装配顺序**。新增一个模块 = 在这里加一行。
 *
 * ## 顺序与原来一致（除两处有意的调整）
 *
 * - token 提到最前：CSS 变量在计算值阶段解析，与书写顺序无关，放前面只是让它一眼可见；
 * - 一级 / 二级目录的样式跟着 shell 走（原来长在本地审核模块里）—— 那是归属修正，不是视觉变化。
 *
 * 其余保持原顺序，避免"只是搬了家却改了层叠结果"这种最难查的回归。
 */
const OWNED_STYLE_TEXTS: ReadonlyArray<{ owner: string; text: string }> = [
  { owner: 'styles/tokens', text: CRWU_TOKEN_STYLE_TEXT },
  { owner: 'styles/base', text: CRWU_BASE_STYLE_TEXT },
  { owner: 'shell/styles/sidebar', text: CRWU_SIDEBAR_STYLE_TEXT },
  { owner: 'ui/styles/card', text: CRWU_CARD_STYLE_TEXT },
  { owner: 'modules/report-audit/styles/pane', text: REPORT_AUDIT_STYLE_TEXT },
  { owner: 'modules/environment/styles/pane', text: ENVIRONMENT_STYLE_TEXT },
  { owner: 'ui/styles/drawer', text: CRWU_DRAWER_STYLE_TEXT },
  { owner: 'ui/styles/button', text: CRWU_BUTTON_STYLE_TEXT },
  { owner: 'ui/styles/field', text: CRWU_FIELD_STYLE_TEXT },
  { owner: 'ui/styles/select', text: CRWU_SELECT_STYLE_TEXT },
  { owner: 'ui/styles/date-picker', text: CRWU_DATE_PICKER_STYLE_TEXT },
  { owner: 'ui/styles/popover', text: CRWU_POPOVER_STYLE_TEXT },
  { owner: 'shell/styles/layout', text: CRWU_LAYOUT_STYLE_TEXT },
  { owner: 'shell/styles/navigation', text: CRWU_NAVIGATION_STYLE_TEXT },
  { owner: 'ui/styles/dialog', text: CRWU_DIALOG_STYLE_TEXT },
  { owner: 'modules/environment/styles/cleanup', text: WORKSPACE_CLEANUP_STYLE_TEXT },
  { owner: 'modules/update/styles/pane', text: UPDATE_STYLE_TEXT },
  { owner: 'modules/local-audit/styles/pane', text: LOCAL_AUDIT_STYLE_TEXT },
  { owner: 'modules/report-evaluation/styles/pane', text: VALUATION_STYLE_TEXT },
  { owner: 'modules/report-evaluation/styles/workflow', text: WORKFLOW_STYLE_TEXT },
]

/** 各所有者贡献的样式（测试据此断言"谁的规则在谁的文件里"）。 */
export function ownedStyleTexts(): ReadonlyArray<{ owner: string; text: string }> {
  return OWNED_STYLE_TEXTS
}

/**
 * 合成后的样式文本：**已限定作用域**。
 *
 * 限定在装配这一步统一做（`scopeCss`），不要求每个所有者自己记得加前缀 ——
 * 那种"记得加"的约定迟早会漏，而漏掉的那条规则就回到"命中整个宿主页面"。
 */
export function composeWorkbenchStyles(): string {
  return scopeCss(OWNED_STYLE_TEXTS.map((item) => item.text.trim()).join('\n\n'))
}

/** 单一样式节点的 id（同一进程里只有一个）。 */
export const WORKBENCH_STYLE_ID = 'crwu-audit-package-styles'

/** 样式节点上的归属标记（便于排查"这条规则是谁注入的"）。 */
export const WORKBENCH_STYLE_OWNER = 'dsh-crwu-workbench'

/**
 * 合成结果（模块求值时算一次）。
 *
 * 样式文本是常量，装配一次就够 —— 每个实例安装时重算一遍只是白白拼一万八千行字符串。
 * 开发重载会重新求值这个模块，于是拿到的也是新内容（见 `install.ts` 的无条件重写）。
 */
export const WORKBENCH_STYLE_TEXT = composeWorkbenchStyles()
