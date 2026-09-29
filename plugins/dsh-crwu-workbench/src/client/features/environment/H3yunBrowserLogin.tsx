import * as React from 'react'
import { Button, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { bridgeOf, startH3yunLoginGuest, type GuestView, type LoginGuestHandle, type LoginGuestState } from './login-browser.ts'

/**
 * 氚云「内置浏览器扫码登录」卡片。
 *
 * 形状是**一块可以就地展开的访客区**：点按钮 → 面板里出现一个真正的浏览器视图 →
 * 员工用钉钉扫它显示的二维码 → 插件从页面 cookie 里读到 `h3_token` →
 * **立刻**交给 Host（`onBind` → `browser-session-bind` → `crwu h3yun session bind --token-stdin`）。
 *
 * 三条边界：
 * 1. **令牌不在客户端停留**：读到就送走，不写 state、不进日志、不落任何存储；
 *    卡片只显示状态与结论，永远不回显令牌；
 * 2. **拿不到内置浏览器就如实说**（Web profile / 旧桌面端）：不假装能扫码，
 *    由员工改用系统浏览器登录 + 既有回退路径 —— 判据来自 `bridgeOf` 的形状检查；
 * 3. **卸载即释放**：`useEffect` 的清理函数停掉驱动（摘元素 + `release(lease)`），
 *    否则切页会留下一个没人管的访客与租约。
 */
export interface H3yunBrowserLoginProps {
  /** 能不能发起（本机访问已授权 + 宿主协议一致）。false 时按钮禁用，理由由页面另行说明。 */
  enabled: boolean
  /** 把令牌交给 Host；这里只显示它的结论，不做任何本地判断。 */
  onBind: (token: string) => Promise<{ ok: boolean; error: string }>
  /** 绑定成功后的刷新（环境结论变了）。 */
  onDone?: () => void
}

/** 状态文案（**只描述状态**，不携带令牌或 code 值）。 */
export function statusTextOf(state: LoginGuestState | ''): string {
  switch (state) {
    case '': return zhCN.loginBrowserIdle
    case 'preparing': return zhCN.loginBrowserPreparing
    case 'waiting': return zhCN.loginBrowserWaiting
    case 'token': return zhCN.loginBrowserBound
    case 'code': return zhCN.loginBrowserCodeSeen
    case 'timeout': return zhCN.loginBrowserTimeout
    case 'error': return zhCN.loginBrowserError
    default: return ''
  }
}

export function H3yunBrowserLogin(props: H3yunBrowserLoginProps): React.ReactElement {
  const [state, setState] = React.useState<LoginGuestState | ''>('')
  const [message, setMessage] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [codeLocation, setCodeLocation] = React.useState('')
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const guestRef = React.useRef<LoginGuestHandle | null>(null)
  // 桥只在渲染时探一次：它是宿主形态的属性，不会在会话中途出现或消失。
  const bridge = bridgeOf((globalThis as { dshDesktop?: unknown }).dshDesktop)

  // 卸载（切页 / 关面板 / 插件释放）必须把访客和租约收掉。
  React.useEffect(() => () => { void guestRef.current?.stop() }, [])

  const start = (): void => {
    if (bridge === undefined || running) return
    setMessage('')
    setCodeLocation('')
    setRunning(true)
    setState('preparing')
    guestRef.current = startH3yunLoginGuest({
      bridge,
      createView: () => document.createElement('webview') as unknown as GuestView,
      mount: (view) => { hostRef.current?.appendChild(view as unknown as Node) },
      onState: (next) => setState(next),
      onToken: (token) => {
        // 令牌只在这一次调用里存在；不写 state、不打印、不落盘。
        void props.onBind(token).then((result) => {
          setRunning(false)
          if (result.ok) {
            setState('token')
            props.onDone?.()
            return
          }
          setState('error')
          setMessage(result.error)
        }).catch((error: unknown) => {
          setRunning(false)
          setState('error')
          setMessage(error instanceof Error ? error.message : String(error))
        })
      },
      onAuthCode: (location) => {
        // 备通道的痕迹：只记主机与路径（不含 code 值），供失败归因时判断卡在哪一步。
        setCodeLocation(location)
        setState((current) => (current === 'waiting' ? 'code' : current))
      },
    })
  }

  const active = state === 'preparing' || state === 'waiting'
  return (
    <div className={C.stack}>
      <div className={C.row}>
        <Button
          label={zhCN.loginBrowserStart}
          small
          disabled={!props.enabled || running || bridge === undefined}
          onClick={start}
        />
        <span className={C.muted}>{statusTextOf(state)}</span>
      </div>
      {/* 拿不到内置浏览器时如实说，不让员工对着一个永远不出现的窗口等。 */}
      {bridge === undefined ? <div className={C.muted}>{zhCN.loginBrowserUnavailable}</div> : null}
      {codeLocation === '' ? null : (
        <div className={C.muted}>{zhCN.loginBrowserCodeSeenHint.replace('{host}', codeLocation)}</div>
      )}
      {message === '' ? null : <Notice tone="warn">{message}</Notice>}
      {/* 访客区：只有展开时才占位（未开始时它不该在页面上留一块空白）。 */}
      <div className={`${C.loginStage}${active ? ` ${C.loginStageOn}` : ''}`} ref={hostRef} />
    </div>
  )
}
