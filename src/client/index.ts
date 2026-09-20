/**
 * 中瑞世联工作台 · Client 半（包形态骨架）
 *
 * 与 legacy/client.js 的关系：
 *   动态形态是「沙箱里求值的函数体」，React / host / styles / slots 全靠注入，
 *   用 host.call('workbench:x') 走包私有 RPC。
 *   包形态是 tsdown 打出的浏览器模块（window.__ModuleLoader__），所以
 *   React 要**显式 import**（照 dsh-file-upload-ocr-plugin 的 src/client），
 *   RPC 换成对同源端点 fetch —— 一个 rpc() 就能把两者的调用点对上。
 *
 * 本文件只搭**最小面板**：证明链路（面板 → fetch → /api/crwu-workbench → op）通了。
 * 完整 UI（环境自检 / 报告审核表 / 停止·重启 / 云端按钮）见 PORTING.md 第 6 层。
 * 这里刻意用 React.createElement 而不是 JSX：与 legacy 同构，便于整段照搬。
 */

import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

const ROUTE = '/api/crwu-workbench'

async function rpc(op: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args }),
  })
  if (!response.ok) throw new Error(`工作台请求失败：HTTP ${response.status}`)
  return await response.json() as Record<string, unknown>
}

/** 侧栏图标：与 legacy/client.js 的 PanelIcon 同一形状。 */
function PanelIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = typeof props.size === 'number' ? props.size : 16
  const stroke = props.active === true ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    React.createElement('rect', { x: 3, y: 3.5, width: 18, height: 17, rx: 3 }),
    React.createElement('path', { d: 'M7.5 8.5h5.5' }),
    React.createElement('path', { d: 'M7.5 12.5h9' }),
    React.createElement('path', { d: 'M7.5 16.5h4' }),
  )
}

/** 最小面板：链路自检。 */
function WorkbenchPanel(): React.ReactElement {
  const [boot, setBoot] = React.useState<Record<string, unknown> | null>(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let alive = true
    rpc('boot')
      .then((r) => { if (alive) setBoot(r) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  return React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', lineHeight: 1.7 } },
    React.createElement('div', { style: { fontWeight: 600, fontSize: '15px' } }, '中瑞世联工作台'),
    React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginTop: '4px' } },
      '包形态骨架（链路自检）。完整 UI 见 PORTING.md。'),
    error !== ''
      ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: '8px' } }, error)
      : null,
    boot === null
      ? React.createElement('div', { style: { marginTop: '10px' } }, '正在读取 Host…')
      : React.createElement('pre', {
          style: { marginTop: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '11px' },
        }, JSON.stringify(boot, null, 2)),
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'crwu-workbench', order: 20, label: '中瑞世联工作台' },
    (p: { size?: number; active?: boolean }) => React.createElement(PanelIcon, p),
  )), 'crwu-workbench: sidebar entry')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'crwu-workbench' },
    () => React.createElement(WorkbenchPanel, null),
  )), 'crwu-workbench: main panel')
}
