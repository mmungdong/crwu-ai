import * as React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AuditParentButton } from './features/workbench/AuditParentButton.tsx'
import { RunCardAction } from './features/workbench/RunCardAction.tsx'
import { WorkbenchPanel } from './features/workbench/WorkbenchPanel.tsx'
import { WorkbenchSidebarEntry, WORKBENCH_PANEL_KEY } from './features/workbench/WorkbenchSidebarEntry.tsx'
import { createBuildStore } from './features/workbench/build-store.ts'
import { createModuleStore } from './features/workbench/module-store.ts'
import { createEnvStatusStore } from './features/environment/status.ts'
import { updateApi } from './features/update/api.ts'
import { createUpdateDialogStore } from './features/update/dialog-store.ts'
import { createUpdateStore } from './features/update/update-store.ts'
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
 * ## 入口位置（2026-09-22 用户当面确认的口径）
 *
 * 工作台**常驻在左侧栏底部、Settings 上方**（`sidebar.footer.action`），工作区（会话列表）
 * 留在它上方。原来的两处入口都撤掉了：
 *
 * - `sidebar.panellist`（侧栏顶部的图标入口）—— 与底部入口重复，且顶部那排是全局面板导航，
 *   工作台不是「另一个全局页」而是常驻工具；
 * - `conversation.session.header.utilities` 里的环境指示灯 —— 环境结论已经由底部入口右侧
 *   那枚标记（通过 = 绿勾）常驻表达，再在会话头挂一颗就是同一件事说两遍。
 *
 * 会话头里**保留**「登记为子会话父级」按钮：它是发起审核的必要条件（只有它能把手上的会话 id
 * 交给我们），和入口位置无关。
 */
export function apply(ctx: ClientContext): void {
  // 样式元素是插件自己的副作用，寿命必须由 effect 管。
  ctx.effect(installWorkbenchStyles, 'crwu-workbench: styles')

  // 浏览器侧的可选服务（目录选择器 / 工作空间注册表）：在 apply 里读一次、随 props 传下去，
  // 不放在模块顶层（那是「与插件实例相关的可变状态」，仓规不允许）。
  const services = readClientServices(ctx)
  // 环境状态 store 同理：侧栏底部入口与面板必须看到**同一份**自检结论，所以在这里创建、
  // 由 props 下发；模块级单例会在插件卸载后残留。
  const envStatus = createEnvStatusStore()
  // 「现在跑的是哪一份插件」（dev / 装好的包 + 版本）同理：侧栏入口与面板头部必须显示同一枚标签，
  // 也共用一个 store —— 各自 `boot()` 会同时打两次请求，还会出现「标签是新的、门禁说旧的」这种画面。
  const buildStore = createBuildStore()
  // 模块状态（报告评估 / 报告审核 / 环境信息）同理必须**只有一份**：侧栏那张分组卡上
  // 的三个子项与面板里的三页是同一件事，各存一份就会出现「侧栏高亮报告审核、面板显示环境信息」。
  const modules = createModuleStore()
  // 自助更新同理，而且这条是**硬要求**：侧栏那枚版本徽标与面板里的更新面板必须共用
  // 唯一一份更新状态（各自建 store 就会各发一次 status/check，还会出现"徽标说有更新、
  // 面板说已是最新"）。开关状态也挂在实例上（侧栏徽标要能打开面板里的那只 Dialog）。
  const updateStore = createUpdateStore({ api: updateApi })
  const updateDialog = createUpdateDialogStore()
  // 更新状态里挂着轮询定时器、开关状态里挂着监听器：寿命必须由 effect 管。
  ctx.effect(() => () => {
    updateStore.dispose()
    updateDialog.dispose()
  }, 'crwu-workbench: update state')
  // 平台只在装配时读一次（重启说明要不要给 macOS 的"退出"指引）。
  const platform: 'mac' | 'other' = /Mac|iPhone|iPad/i.test(globalThis.navigator?.userAgent ?? '') ? 'mac' : 'other'

  // 打开工作台面板。`services.layout` **在点击时现读**，不在 apply() 里快照：客户端服务的
  // 注册有先后，我们的插件可能比提供 layout 的插件先激活 —— 快照下来就是「永远拿不到
  // selectPanel」，表现为「点了跳转没反应」（`sessions` 就是这么丢过一次的）。
  const openPanel = (): void => {
    const target = services.layout
    if (target?.selectPanel !== undefined) target.selectPanel(WORKBENCH_PANEL_KEY)
  }

  // 侧栏底部入口（Settings 行上方）。`wide` 与标准席位 hook `usePanelInfo` 由侧栏席位注入；
  // store 与跳转动作由这里闭包下发 —— 入口自己不认识 cordis。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'crwu-workbench', order: 20, label: zhCN.sidebarLabel },
    (props: { wide?: boolean; usePanelInfo?: (sel: (info: { activePanelId: string | null }) => boolean) => boolean }) => {
      return React.createElement(WorkbenchSidebarEntry, {
        store: envStatus,
        build: buildStore,
        modules,
        update: updateStore,
        updateDialog,
        wide: props.wide !== false,
        ...(props.usePanelInfo === undefined ? {} : { usePanelInfo: props.usePanelInfo }),
        // 点卡头 = 打开面板（回到当前子项）；点子项 = 切模块 + 打开面板，两件事一起做
        // （切换动作在入口内部完成：它自己就是那个 store 的读者，不需要外面再接一手）。
        onOpen: openPanel,
      })
    },
  ))

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: WORKBENCH_PANEL_KEY },
    () => React.createElement(WorkbenchPanel, {
      services,
      envStatus,
      build: buildStore,
      modules,
      update: updateStore,
      updateDialog,
      platform,
    }),
  ))

  // Cordis 运行卡片里的动作区：顺带登记父级 + 跳转到面板。
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

  // 会话头：**只留**「登记为子会话父级」按钮。
  // 它是发起审核的必要条件 —— 只有它能把当前会话 id 交给我们，而 `audit-start` 要求父级已登记。
  // 少了这个注册，界面上没有任何办法开始审核。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'crwu-audit-parent', order: 5, label: zhCN.bindParent },
    (props: { sessionId?: string }) => React.createElement(AuditParentButton, props),
  ))
}
