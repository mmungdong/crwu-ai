import * as React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PanelIcon, type PanelIconProps } from './components/PanelIcon.tsx'
import { WorkbenchPanel } from './features/workbench/WorkbenchPanel.tsx'
import { installWorkbenchStyles } from './features/workbench/styles.ts'
import { zhCN } from './locales/zh-CN.ts'

/** 注册 DSH 工作台的侧栏入口和主面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(installWorkbenchStyles, 'crwu-workbench: styles')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'crwu-workbench', order: 20, label: zhCN.sidebarLabel },
    (props: PanelIconProps) => React.createElement(PanelIcon, props),
  )), 'crwu-workbench: sidebar entry')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'crwu-workbench' },
    () => React.createElement(WorkbenchPanel),
  )), 'crwu-workbench: main panel')
}
