import * as React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PanelIcon, type PanelIconProps } from './components/PanelIcon.tsx'
import { AuditParentButton } from './features/workbench/AuditParentButton.tsx'
import { RunCardAction } from './features/workbench/RunCardAction.tsx'
import { WorkbenchPanel } from './features/workbench/WorkbenchPanel.tsx'
import { EnvironmentStatusIcon } from './features/environment/EnvironmentStatusIcon.tsx'
import { createEnvStatusStore } from './features/environment/status.ts'
import { readClientServices } from './features/workbench/services.ts'
import { installWorkbenchStyles } from './features/workbench/styles.ts'
import { zhCN } from './locales/zh-CN.ts'

/**
 * 注册 DSH 工作台的侧栏入口和主面板。
 *
 * **`ctx.slots.inject(...)` 必须直接调用，不要再套一层 `ctx.effect`。**
 * 这不是风格问题：
 *
 * - DSH 自带的客户端插件全都是这么写的（`dsh-client-ui-jobs` / `-goal` / `-skill` / `-plan`），
 *   只有 `ctx.locale.register` 才包 `effect`；
 * - 槽位注入的**寿命由 slots 服务自己管**（`slots.register` 返回一个解除注册的函数，
 *   由 `inject` 负责在插件释放时调用），外面再包一层等于重复持有；
 * - 而 Cordis 的 `effect` 对回调返回值是**有要求的**：函数会被收集成 disposer，`null`/`undefined`
 *   放过，**其余非空、非 thenable、非可迭代的值直接抛 `TypeError("Invalid effect")`**。
 *   也就是说：如果哪天 `slots.inject` 改成返回一个登记对象（而不是解除函数或 undefined），
 *   这个包装会让 `apply()` 在**激活阶段就抛错**，表现是「插件装上了但面板不出现」。
 *
 * 样式不同：它是插件自己往 `document.head` 插的元素，必须由 `effect` 负责移除。
 *
 * 同一个槽位注册多个条目时，`inject` 的回调返回**解除函数数组**（`inject` 的签名显式支持
 * `Iterable<() => void>`，它会按逆序释放）—— 会话头那个槽位就同时挂了环境指示灯与
 * 「子会话父级」按钮。
 */
export function apply(ctx: ClientContext): void {
  // 样式元素是插件自己的副作用，寿命必须由 effect 管。
  ctx.effect(installWorkbenchStyles, 'crwu-workbench: styles')

  // 浏览器侧的可选服务（目录选择器 / 工作空间注册表）：在 apply 里读一次、随 props 传下去，
  // 不放在模块顶层（那是「与插件实例相关的可变状态」，仓规不允许）。
  const services = readClientServices(ctx)
  // 环境状态 store 同理：会话头的指示灯与面板必须看到**同一份**自检结论，所以在这里创建、
  // 由 props 下发；模块级单例会在插件卸载后残留。
  const envStatus = createEnvStatusStore()

  // 侧栏入口：`label` 给字符串即可 —— 侧栏读的是 options.label，
  // 且 resolveSlotLabel 对字符串原样返回（对函数才调用）。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'crwu-workbench', order: 20, label: zhCN.sidebarLabel },
    (props: PanelIconProps) => React.createElement(PanelIcon, props),
  ))

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'crwu-workbench' },
    () => React.createElement(WorkbenchPanel, { services, envStatus }),
  ))

  // Cordis 运行卡片里的动作区：顺带登记父级 + 跳转到面板。
  //
  // `services.layout` **在渲染时现读**，不在 apply() 里快照：客户端服务的注册有先后，
  // 我们的插件可能比提供 layout 的插件先激活 —— 快照下来就是「永远拿不到 selectPanel」，
  // 表现为「点了跳转没反应」（`sessions` 就是这么丢过一次的）。
  ctx.slots.inject('tool.view.cordis', () => ctx.slots.register(
    { name: 'tool.view.cordis', key: 'self' },
    (props: { sessionId?: string }) => {
      const layout = services.layout
      return React.createElement(RunCardAction, {
        sessionId: props.sessionId,
        ...(layout?.selectPanel === undefined ? {} : { selectPanel: layout.selectPanel.bind(layout) }),
      })
    },
  ))

  // 页面右上角：环境自检指示灯（绿=通过 / 红=不通过 / 黄=自检中）。
  // 它和会话头按钮挤在同一个 list 槽位里，所以两条注册由**一次 inject** 返回的解除函数数组
  // 一起管理 —— 顺序上 order 6 排在 order 5 的「子会话父级」右侧，正好落在最右边。
  ctx.slots.inject('conversation.session.header.utilities', () => [
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'crwu-env-status', order: 6, label: zhCN.envLampLabel },
      () => {
        const layout = services.layout
        return React.createElement(EnvironmentStatusIcon, {
          store: envStatus,
          compact: true,
          ...(layout?.selectPanel === undefined ? {} : { selectPanel: layout.selectPanel.bind(layout) }),
        })
      },
    ),
    // **会话头按钮是发起审核的必要条件**：只有它能把当前会话 id 交给我们，而
    // `audit-start` 要求父级已登记。少了这个注册，界面上没有任何办法开始审核。
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'crwu-audit-parent', order: 5, label: zhCN.bindParent },
      (props: { sessionId?: string }) => React.createElement(AuditParentButton, props),
    ),
  ])
}
